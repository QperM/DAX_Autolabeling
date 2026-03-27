import base64
import gc
import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
import torch
import uvicorn
import logging
from fastapi import FastAPI
from pydantic import BaseModel, Field
from omegaconf import OmegaConf

ROOT = Path(__file__).resolve().parent
DIFFDOPE_ROOT = ROOT / "diff-dope"
if str(DIFFDOPE_ROOT) not in sys.path:
    sys.path.insert(0, str(DIFFDOPE_ROOT))

import diffdope as dd  # noqa: E402

app = FastAPI(title="pose-service", version="1.0.0")
_LOCK = threading.Lock()


def _get_data_root_dir() -> Path:
    configured = os.environ.get("DATA_ROOT") or os.environ.get("DAX_DATA_DIR")
    if configured and str(configured).strip():
        return Path(str(configured).strip()).resolve()
    # server/pose-service/app.py -> server/pose-service -> server -> repo root
    return ROOT.parent.parent / "dax-autolabel-data"


def _get_uploads_root_dir() -> Path:
    return _get_data_root_dir() / "uploads"

# -----------------------------------------------------------------------------
# 调试种类门控（管理员配置）：按 server/data/debug_settings.json 勾选的 kind 输出
# service id：diffdope（对应客户端/管理员弹窗中的“姿态标注服务”）
# -----------------------------------------------------------------------------
_DEBUG_SETTINGS_PATH = ROOT.parent / "data" / "debug_settings.json"
_DEBUG_CACHE: dict = {"ts": 0.0, "data": None}
_DEBUG_CACHE_TTL_SEC = 2.0


def _get_debug_settings() -> dict:
    now = time.time()
    cached = _DEBUG_CACHE.get("data")
    if cached is not None and now - float(_DEBUG_CACHE.get("ts", 0.0)) < _DEBUG_CACHE_TTL_SEC:
        return cached

    data = None
    try:
        if _DEBUG_SETTINGS_PATH.exists():
            data = json.loads(_DEBUG_SETTINGS_PATH.read_text(encoding="utf-8"))
    except Exception:
        data = None

    if not isinstance(data, dict):
        data = {}

    _DEBUG_CACHE["ts"] = now
    _DEBUG_CACHE["data"] = data
    return data


def _should_log(kind: str) -> bool:
    settings = _get_debug_settings()
    services = settings.get("services", {}) if isinstance(settings, dict) else {}
    enabled = services.get("diffdope", []) if isinstance(services, dict) else []
    if not isinstance(enabled, list):
        return False
    return kind in enabled


def _log(kind: str, *args, **kwargs) -> None:
    if _should_log(kind):
        print(*args, **kwargs)


class DiffDopeAccessLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            return _should_log("diffdopeAccessLog")
        except Exception:
            return False

# -----------------------------------------------------------------------------
# 两阶段超参数：请求体字段为 None 时的唯一回落表（与前端 DEFAULT_DIFFDOPE_PARAMS 语义应对齐）
# -----------------------------------------------------------------------------
DIFFDOPE_DEFAULTS: Dict[str, Any] = {
    "s1_iters": 80,
    "s2_iters": 120,
    "s1_base_lr": 20.0,
    "s1_lr_decay": 0.1,
    "s2_base_lr": 8.0,
    "s2_lr_decay": 0.1,
    "s1_w_mask": 1.0,
    "s1_w_rgb": 0.7,
    "s2_w_mask": 1.0,
    "s2_w_depth": 1.0,
    "s2_w_rgb": 1.0,
}


def _resolve_two_stage_params(req: "Estimate6DRequest") -> Dict[str, Any]:
    """解析第一轮/第二轮的迭代次数、学习率、衰减、权重与开关；禁止在 estimate6d 内再写散落魔法数。"""
    D = DIFFDOPE_DEFAULTS

    s1_iters = int(max(1, min(500, req.stage1Iters if req.stage1Iters is not None else D["s1_iters"])))
    s2_iters = int(max(1, min(500, req.stage2Iters if req.stage2Iters is not None else D["s2_iters"])))

    s1_base_lr = float(max(0.01, min(200.0, req.stage1BaseLr if req.stage1BaseLr is not None else D["s1_base_lr"])))
    s1_lr_decay = float(max(0.001, min(1.0, req.stage1LrDecay if req.stage1LrDecay is not None else D["s1_lr_decay"])))
    s2_base_lr = float(max(0.01, min(200.0, req.stage2BaseLr if req.stage2BaseLr is not None else D["s2_base_lr"])))
    s2_lr_decay = float(max(0.001, min(1.0, req.stage2LrDecay if req.stage2LrDecay is not None else D["s2_lr_decay"])))

    s1_w_mask = float(max(0.0, req.stage1WeightMask if req.stage1WeightMask is not None else D["s1_w_mask"]))
    s1_w_rgb = float(max(0.0, req.stage1WeightRgb if req.stage1WeightRgb is not None else D["s1_w_rgb"]))
    s2_w_mask = float(max(0.0, req.stage2WeightMask if req.stage2WeightMask is not None else D["s2_w_mask"]))
    s2_w_depth = float(max(0.0, req.stage2WeightDepth if req.stage2WeightDepth is not None else D["s2_w_depth"]))
    # 第二轮 RGB：stage2WeightRgb → 遗留 weightRgb（仅旧客户端会传）→ DIFFDOPE_DEFAULTS
    if req.stage2WeightRgb is not None:
        s2_w_rgb = float(max(0.0, req.stage2WeightRgb))
    elif req.weightRgb is not None:
        s2_w_rgb = float(max(0.0, req.weightRgb))
    else:
        s2_w_rgb = float(max(0.0, D["s2_w_rgb"]))

    s1_use_mask = bool(req.stage1UseMask)
    s1_use_rgb = bool(req.stage1UseRgb)
    s1_use_depth = False  # 第一轮固定无 depth loss
    s2_use_mask = bool(req.stage2UseMask)
    s2_use_rgb = bool(req.stage2UseRgb)
    s2_use_depth = bool(req.stage2UseDepth)

    s1_early = (
        float(req.stage1EarlyStopLoss)
        if req.stage1EarlyStopLoss is not None and float(req.stage1EarlyStopLoss) > 0
        else None
    )
    s2_early = (
        float(req.stage2EarlyStopLoss)
        if req.stage2EarlyStopLoss is not None and float(req.stage2EarlyStopLoss) > 0
        else None
    )

    return {
        "s1_iters": s1_iters,
        "s2_iters": s2_iters,
        "s1_base_lr": s1_base_lr,
        "s1_lr_decay": s1_lr_decay,
        "s2_base_lr": s2_base_lr,
        "s2_lr_decay": s2_lr_decay,
        "s1_w_mask": s1_w_mask,
        "s1_w_rgb": s1_w_rgb,
        "s2_w_mask": s2_w_mask,
        "s2_w_depth": s2_w_depth,
        "s2_w_rgb": s2_w_rgb,
        "s1_use_mask": s1_use_mask,
        "s1_use_rgb": s1_use_rgb,
        "s1_use_depth": s1_use_depth,
        "s2_use_mask": s2_use_mask,
        "s2_use_rgb": s2_use_rgb,
        "s2_use_depth": s2_use_depth,
        "s1_early": s1_early,
        "s2_early": s2_early,
    }


class InitPose(BaseModel):
    pose44: Optional[List[List[float]]] = None
    position: List[float] = Field(default_factory=lambda: [0.0, 0.0, 80.0])  # cm
    quat_xyzw: List[float] = Field(default_factory=lambda: [0.0, 0.0, 0.0, 1.0])


class Estimate6DRequest(BaseModel):
    """POST /diffdope/estimate6d 请求体。

    两轮各自的迭代次数、学习率、衰减、权重、开关均由 `stage1*` / `stage2*` 表达；
    数值缺省回落见模块常量 `DIFFDOPE_DEFAULTS`，解析入口为 `_resolve_two_stage_params()`。
    """

    # --- 可选：业务 ID ---
    projectId: Optional[int] = None
    imageId: Optional[int] = None
    meshId: Optional[int] = None
    imageOriginalName: Optional[str] = None
    meshOriginalName: Optional[str] = None
    meshSkuLabel: Optional[str] = None

    # --- 必选：路径与 mask ---
    rgbPath: str
    depthPath: str
    intrinsicsPath: str
    meshPath: str
    maskFlatPoints: List[float]
    init: Optional[InitPose] = None
    skipStage1: bool = False

    # --- 全局（仅 batch，两轮共用）---
    batchSize: int = 8  # 默认 8；clamp [1, 64]

    # --- 第一轮：与 DIFFDOPE_DEFAULTS 对应键 s1_* ---
    stage1Iters: Optional[int] = None  # None → s1_iters
    stage1EarlyStopLoss: Optional[float] = None  # None 或 ≤0 → 不关早停
    stage1BaseLr: Optional[float] = None  # None → s1_base_lr
    stage1LrDecay: Optional[float] = None  # None → s1_lr_decay
    stage1UseMask: bool = True
    stage1UseRgb: bool = True
    stage1UseDepth: bool = False  # 请求可带，解析层固定第一轮不用 depth
    stage1WeightMask: Optional[float] = None  # None → s1_w_mask
    stage1WeightRgb: Optional[float] = None  # None → s1_w_rgb
    stage1WeightDepth: Optional[float] = None  # 不参与第一轮

    # --- 第二轮：与 DIFFDOPE_DEFAULTS 对应键 s2_*（与第一轮完全独立）---
    stage2Iters: Optional[int] = None  # None → s2_iters
    stage2EarlyStopLoss: Optional[float] = None
    stage2BaseLr: Optional[float] = None  # None → s2_base_lr
    stage2LrDecay: Optional[float] = None  # None → s2_lr_decay
    stage2UseMask: bool = True
    stage2UseRgb: bool = False
    stage2UseDepth: bool = True
    stage2WeightMask: Optional[float] = None  # None → s2_w_mask
    stage2WeightDepth: Optional[float] = None  # None → s2_w_depth
    stage2WeightRgb: Optional[float] = None  # None → 再用遗留 weightRgb → s2_w_rgb

    # --- 质量与输出 ---
    maxAllowedFinalLoss: Optional[float] = None
    returnDebugImages: bool = True
    debug: bool = False

    # --- 遗留字段（旧客户端）；不参与 _resolve 内阶段逻辑，仅作 stage2WeightRgb 的回退 ---
    iters: int = 60
    lrLow: float = 0.01
    lrHigh: float = 100.0
    baseLr: float = 20.0
    lrDecay: float = 0.1
    useMaskLoss: bool = True
    useRgbLoss: bool = False
    useDepthLoss: bool = True
    weightMask: float = 1.0
    weightRgb: Optional[float] = None  # 旧客户端第二轮 RGB 权重；与 stage2WeightRgb 二选一即可
    weightDepth: float = 1.0


def _as_png_b64(img_bgr: np.ndarray) -> Optional[str]:
    if img_bgr is None:
        return None
    ok, buf = cv2.imencode(".png", img_bgr)
    if not ok:
        return None
    return base64.b64encode(buf.tobytes()).decode("ascii")


def _load_intrinsics(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        js = json.load(f)
    return js


def _load_depth_cm(depth_path: Path, intr: Dict[str, Any]) -> np.ndarray:
    suffix = depth_path.suffix.lower()
    if suffix == ".npy":
        depth_raw = np.load(str(depth_path))
    else:
        depth_raw = cv2.imread(str(depth_path), cv2.IMREAD_UNCHANGED)
    if depth_raw is None:
        raise RuntimeError(f"无法加载深度文件: {depth_path}")

    if depth_raw.ndim == 3:
        if depth_raw.shape[2] == 1:
            depth_raw = depth_raw[:, :, 0]
        else:
            if np.array_equal(depth_raw[:, :, 0], depth_raw[:, :, 1]) and np.array_equal(depth_raw[:, :, 1], depth_raw[:, :, 2]):
                depth_raw = depth_raw[:, :, 0]
            else:
                ranges = [float(depth_raw[:, :, c].max() - depth_raw[:, :, c].min()) for c in range(depth_raw.shape[2])]
                depth_raw = depth_raw[:, :, int(np.argmax(ranges))]

    depth_raw = depth_raw.astype(np.float32)
    depth_scale = float(intr.get("depth_scale", intr.get("depthScale", intr.get("depthscale", 0.001))))

    if suffix == ".npy" and np.issubdtype(depth_raw.dtype, np.floating):
        positive = depth_raw[depth_raw > 0]
        p50 = float(np.median(positive)) if positive.size > 0 else 0.0
        p99 = float(np.percentile(positive, 99)) if positive.size > 0 else 0.0
        if p99 <= 20.0 and p50 > 0.0:
            return depth_raw * 100.0  # m -> cm
    return depth_raw * depth_scale * 100.0


def _loss_function_labels(ddope: Any) -> List[str]:
    """便于日志确认当前阶段实际挂了哪些 loss。"""
    labels: List[str] = []
    for fn in getattr(ddope, "loss_functions", None) or []:
        name = getattr(fn, "__name__", None)
        if isinstance(name, str) and name:
            labels.append(name)
        else:
            labels.append(type(fn).__name__ + "/" + str(fn)[:80])
    return labels


def _summarize_gl_pose44(m44: Any) -> Dict[str, Any]:
    """get_pose() 返回的 4×4 为渲染用 GL 系；顺带给出对应的 OpenCV 平移 C·t_gl（与 Node 存库 pose44 的 t 一致）。"""
    M = np.asarray(m44, dtype=np.float64)
    if M.shape[0] < 4 or M.shape[1] < 4:
        return {"error": "bad_shape", "shape": list(M.shape)}
    R = M[:3, :3]
    t_gl = M[:3, 3].astype(np.float64)
    C = np.diag([1.0, -1.0, -1.0])
    t_cv = (C @ t_gl).reshape(3)
    det_r = float(np.linalg.det(R))
    return {
        "t_gl": [float(t_gl[0]), float(t_gl[1]), float(t_gl[2])],
        "t_gl_norm": float(np.linalg.norm(t_gl)),
        "t_cv_cm": [float(t_cv[0]), float(t_cv[1]), float(t_cv[2])],
        "t_cv_norm": float(np.linalg.norm(t_cv)),
        "det_R": det_r,
        "trace_R": float(np.trace(R)),
        "fro_R": float(np.linalg.norm(R, ord="fro")),
    }


def _object3d_param_snapshot(ddope: Any, batch_index: int = 0) -> Dict[str, float]:
    o = ddope.object3d
    bi = int(batch_index)
    return {
        "x": float(o.x[bi].item()),
        "y": float(o.y[bi].item()),
        "z": float(o.z[bi].item()),
        "qx": float(o.qx[bi].item()),
        "qy": float(o.qy[bi].item()),
        "qz": float(o.qz[bi].item()),
        "qw": float(o.qw[bi].item()),
    }


def _configure_stage_losses(
    ddope,
    *,
    use_mask: bool,
    use_depth: bool,
    use_rgb: bool,
    weight_mask: float,
    weight_depth: float,
    weight_rgb: float,
) -> None:
    """按开关组装当前阶段的 loss 列表；至少一项为 True。"""
    ddope.cfg.losses.l1_mask = use_mask
    ddope.cfg.losses.weight_mask = weight_mask if use_mask else 0.0
    ddope.cfg.losses.l1_depth_with_mask = use_depth
    ddope.cfg.losses.weight_depth = weight_depth if use_depth else 0.0
    ddope.cfg.losses.l1_rgb_with_mask = use_rgb
    ddope.cfg.losses.weight_rgb = weight_rgb if use_rgb else 0.0
    fns: List[Any] = []
    if use_mask:
        fns.append(dd.l1_mask)
    if use_depth:
        fns.append(dd.l1_depth_with_mask)
    if use_rgb:
        fns.append(dd.l1_rgb_with_mask)
    if not fns:
        raise RuntimeError("每一轮优化至少需要启用 Mask、Depth、RGB 中的一项")
    ddope.loss_functions = fns


def _mask_from_flat_points(flat: List[float], h: int, w: int) -> np.ndarray:
    if not isinstance(flat, list) or len(flat) < 6:
        raise RuntimeError("maskFlatPoints 非法，至少需要 3 个点")
    arr = np.asarray(flat, dtype=np.float32).reshape(-1, 2)
    arr[:, 0] = np.clip(arr[:, 0], 0, max(0, w - 1))
    arr[:, 1] = np.clip(arr[:, 1], 0, max(0, h - 1))
    m = np.zeros((h, w), dtype=np.uint8)
    cv2.fillPoly(m, [arr.astype(np.int32)], 255)
    return m


def _save_fit_overlay(overlay_bgr: Optional[np.ndarray], project_id: Optional[int], image_id: Optional[int], mesh_id: Optional[int], *, suffix: str = "") -> Optional[str]:
    """统一落盘拟合图并返回相对路径。"""
    if overlay_bgr is None or not project_id:
        return None
    fit_dir = _get_uploads_root_dir() / f"project_{int(project_id)}" / "pose-fit-overlays"
    fit_dir.mkdir(parents=True, exist_ok=True)
    img_id = int(image_id or 0)
    if suffix:
        filename = f"fit_image_{img_id}_{suffix}.png"
    else:
        filename = f"fit_image_{img_id}_mesh_{int(mesh_id or 0)}.png"
    abs_path = fit_dir / filename
    cv2.imwrite(str(abs_path), overlay_bgr)
    return f"/uploads/project_{int(project_id)}/pose-fit-overlays/{filename}"


def _overlay_non_black(base_bgr: np.ndarray, fg_bgr: np.ndarray) -> np.ndarray:
    """将前景渲染叠加到底图（黑底视为透明）。"""
    out = base_bgr.copy()
    if fg_bgr is None:
        return out
    if fg_bgr.shape[:2] != out.shape[:2]:
        fg_bgr = cv2.resize(fg_bgr, (out.shape[1], out.shape[0]), interpolation=cv2.INTER_LINEAR)
    mask = np.any(fg_bgr > 3, axis=2)
    out[mask] = fg_bgr[mask]
    return out


def _cv_pose44_to_gl_rt(pose44: List[List[float]]) -> tuple[list[float], list[float]]:
    """DB pose44 为 OpenCV 系（与 Node `convertPose44OpenGLToOpenCV` 输出一致）→ diffdope 渲染用的 GL 平移 + 行主序 3×3。

    与 Object3D(..., opencv2opengl=True) 内建变换同型：C=diag(1,-1,-1)，R_gl=C·R_cv·C，t_gl=C·t_cv。
    """
    M = np.asarray(pose44, dtype=np.float32)
    if M.shape[0] < 4 or M.shape[1] < 4:
        raise RuntimeError("pose44 维度非法")
    R_cv = M[:3, :3]
    t_cv = M[:3, 3]
    C = np.diag([1.0, -1.0, -1.0]).astype(np.float32)
    R_gl = C @ R_cv @ C
    t_gl = C @ t_cv
    rot9 = [
        float(R_gl[0, 0]), float(R_gl[0, 1]), float(R_gl[0, 2]),
        float(R_gl[1, 0]), float(R_gl[1, 1]), float(R_gl[1, 2]),
        float(R_gl[2, 0]), float(R_gl[2, 1]), float(R_gl[2, 2]),
    ]
    pos3 = [float(t_gl[0]), float(t_gl[1]), float(t_gl[2])]
    return pos3, rot9


def _quat_xyzw_to_rotmat33(q_xyzw: List[float]) -> np.ndarray:
    """xyzw 四元数 -> 3x3 旋转矩阵（OpenCV语义）。"""
    q = np.asarray(q_xyzw, dtype=np.float64).reshape(-1)
    if q.shape[0] != 4:
        raise RuntimeError("quat_xyzw 维度非法")
    x, y, z, w = [float(v) for v in q]
    n = x * x + y * y + z * z + w * w
    if n < 1e-12:
        return np.eye(3, dtype=np.float64)
    s = 2.0 / n
    xx = x * x * s
    yy = y * y * s
    zz = z * z * s
    xy = x * y * s
    xz = x * z * s
    yz = y * z * s
    wx = w * x * s
    wy = w * y * s
    wz = w * z * s
    return np.array(
        [
            [1.0 - (yy + zz), xy - wz, xz + wy],
            [xy + wz, 1.0 - (xx + zz), yz - wx],
            [xz - wy, yz + wx, 1.0 - (xx + yy)],
        ],
        dtype=np.float64,
    )


def _build_cv_pose44_from_rt(
    t_cv_xyz_cm: List[float],
    quat_xyzw: Optional[List[float]] = None,
) -> List[List[float]]:
    """以 OpenCV 坐标语义构造 pose44（默认单位旋转）。"""
    if quat_xyzw is None:
        R = np.eye(3, dtype=np.float64)
    else:
        R = _quat_xyzw_to_rotmat33(quat_xyzw)
    t = np.asarray(t_cv_xyz_cm, dtype=np.float64).reshape(-1)
    if t.shape[0] != 3:
        raise RuntimeError("position 维度非法")
    M = np.eye(4, dtype=np.float64)
    M[:3, :3] = R
    M[:3, 3] = t
    return M.tolist()


def _diffdope_cfg_fresh() -> Any:
    """每次请求/每个物体独立一份 yaml，避免循环内改字段互相污染。"""
    base = OmegaConf.load(str(DIFFDOPE_ROOT / "configs" / "diffdope.yaml"))
    return OmegaConf.create(OmegaConf.to_container(base, resolve=True))


def _apply_camera_scene_intrinsics(cfg: Any, intr: Dict[str, Any], w: int, h: int, rgb_path: str) -> None:
    cfg.camera.fx = float(intr["fx"])
    cfg.camera.fy = float(intr["fy"])
    cfg.camera.cx = float(intr.get("cx", intr.get("ppx")))
    cfg.camera.cy = float(intr.get("cy", intr.get("ppy")))
    cfg.camera.im_width = int(intr.get("width", w))
    cfg.camera.im_height = int(intr.get("height", h))
    cfg.scene.path_img = rgb_path
    cfg.scene.path_depth = None
    cfg.scene.path_segmentation = None
    cfg.scene.image_resize = 1.0
    cfg.render_images.crop_around_mask = False


def _release_ddope_gpu(ddope: Optional[Any]) -> None:
    if ddope is not None:
        try:
            ddope.optimization_results = []
        except Exception:
            pass
        try:
            ddope.losses_values = {}
        except Exception:
            pass
        try:
            ddope.loss_history_scalar = []
        except Exception:
            pass
        try:
            if hasattr(ddope, "renders"):
                ddope.renders = None
        except Exception:
            pass
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        try:
            torch.cuda.ipc_collect()
        except Exception:
            pass


def _forward_render_rgb(ddope: Any, result: Dict[str, Any]) -> Tuple[Any, Any]:
    """单次 object3d() 前向 + texture 渲染；返回 (renders, mtx_gu)。"""
    mtx_gu = dd.matrix_batch_44_from_position_quat(p=result["trans"], q=result["quat"])
    mesh = ddope.object3d.mesh
    common = {
        "glctx": ddope.glctx,
        "proj_cam": ddope.camera.cam_proj,
        "mtx": mtx_gu,
        "pos": result["pos"],
        "pos_idx": result["pos_idx"],
        "resolution": ddope.resolution,
    }
    if not mesh.has_textured_map:
        renders = dd.render_texture_batch(vtx_color=result["vtx_color"], **common)
    else:
        renders = dd.render_texture_batch(
            uv=result["uv"],
            uv_idx=result["uv_idx"],
            tex=result["tex"],
            **common,
        )
    return renders, mtx_gu


class RenderFitObject(BaseModel):
    meshId: Optional[int] = None
    meshPath: str
    meshOriginalName: Optional[str] = None
    meshSkuLabel: Optional[str] = None
    pose44: List[List[float]]


class RenderFitOverlayRequest(BaseModel):
    projectId: Optional[int] = None
    imageId: Optional[int] = None
    imageOriginalName: Optional[str] = None
    rgbPath: str
    depthPath: Optional[str] = None
    intrinsicsPath: str
    objects: List[RenderFitObject]
    debug: bool = False


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/diffdope/render-fit-overlay")
def render_fit_overlay(req: RenderFitOverlayRequest):
    """根据给定的 pose44 列表重渲染并合成单张拟合图层。"""
    t0 = time.time()
    with _LOCK:
        ddope = None
        scene = None
        mesh = None
        obj = None
        try:
            rgb_path = Path(req.rgbPath)
            intr_path = Path(req.intrinsicsPath)
            if not rgb_path.exists():
                raise RuntimeError(f"文件不存在: {rgb_path}")
            if not intr_path.exists():
                raise RuntimeError(f"文件不存在: {intr_path}")
            intr = _load_intrinsics(intr_path)
            base_rgb = cv2.imread(str(rgb_path))
            if base_rgb is None:
                raise RuntimeError(f"无法读取 RGB 图像: {rgb_path}")
            h, w = base_rgb.shape[:2]
            fx = float(intr["fx"])
            fy = float(intr["fy"])
            cx = float(intr.get("cx", intr.get("ppx")))
            cy = float(intr.get("cy", intr.get("ppy")))

            composed = base_rgb.copy()
            rendered = 0
            failed = 0
            rgb_s = str(rgb_path)
            for item in req.objects:
                mesh_path = Path(item.meshPath)
                meshId = item.meshId
                meshName = item.meshOriginalName
                meshSku = item.meshSkuLabel

                try:
                    if not mesh_path.exists():
                        failed += 1
                        if _should_log("renderFitOverlay"):
                            print(
                                "[pose-service][render-fit-overlay]",
                                "❌",
                                {
                                    "projectId": req.projectId,
                                    "imageId": req.imageId,
                                    "imageOriginalName": req.imageOriginalName,
                                    "meshId": meshId,
                                    "meshOriginalName": meshName,
                                    "meshSkuLabel": meshSku,
                                    "reason": "meshPath not exists",
                                },
                            )
                        continue

                    pose44 = item.pose44
                    if (
                        not isinstance(pose44, list)
                        or len(pose44) < 4
                        or any((not isinstance(r, list) or len(r) < 4) for r in pose44[:4])
                    ):
                        failed += 1
                        if _should_log("renderFitOverlay"):
                            print(
                                "[pose-service][render-fit-overlay]",
                                "❌",
                                {
                                    "projectId": req.projectId,
                                    "imageId": req.imageId,
                                    "imageOriginalName": req.imageOriginalName,
                                    "meshId": meshId,
                                    "meshOriginalName": meshName,
                                    "meshSkuLabel": meshSku,
                                    "reason": "invalid pose44",
                                },
                            )
                        continue

                    pos_gl, rot_gl = _cv_pose44_to_gl_rt(pose44)

                    # Extra debug numbers (only when enabled), shown in render-fit-overlay per-item logs.
                    t_cv = None
                    tr_Rcv = None
                    if _should_log("renderFitOverlay"):
                        Mdbg = np.asarray(pose44, dtype=np.float64)
                        t_cv = Mdbg[:3, 3].tolist()
                        tr_Rcv = float(np.trace(Mdbg[:3, :3]))

                    cfg = _diffdope_cfg_fresh()
                    _apply_camera_scene_intrinsics(cfg, intr, w, h, rgb_s)
                # 勿覆盖 diffdope.yaml 的 render_images.flip_result：须与 estimate6d 的 render_img 一致（Scene 竖翻 + make_grid 再翻回磁盘行序）。
                    cfg.render_images.add_background = False
                    cfg.render_images.add_countour = True
                    cfg.hyperparameters.batchsize = 1
                    cfg.hyperparameters.nb_iterations = 1
                    cfg.hyperparameters.base_lr = 0.0
                    cfg.hyperparameters.lr_decay = 1.0
                    cfg.losses.l1_mask = False
                    cfg.losses.l1_depth_with_mask = False
                    cfg.losses.l1_rgb_with_mask = True
                    cfg.losses.weight_mask = 0.0
                    cfg.losses.weight_depth = 0.0
                    cfg.losses.weight_rgb = 1.0
                    cfg.object3d.model_path = str(mesh_path)
                    cfg.object3d.scale = 100.0

                    ddope = dd.DiffDope(cfg=cfg)
                    scene = dd.Scene(path_img=rgb_s, path_depth=None, path_segmentation=None, image_resize=1.0)
                    scene.cuda()
                    mesh = dd.Mesh(str(mesh_path), scale=100.0)
                    mesh.cuda()
                    obj = dd.Object3D(
                        position=pos_gl,
                        rotation=rot_gl,
                        batchsize=1,
                        opencv2opengl=False,
                        scale=1.0,
                    )
                    obj.mesh = mesh
                    obj.mesh.set_batchsize(1)
                    obj.cuda()

                    ddope.scene = scene
                    ddope.object3d = obj
                    ddope.set_batchsize(1)
                    with torch.no_grad():
                        result = ddope.object3d()
                        renders, mtx_gu = _forward_render_rgb(ddope, result)
                        ddope.optimization_results = [{
                            "rgb": renders["rgb"].detach().cpu(),
                            "depth": renders["depth"].detach().cpu(),
                            "mtx": mtx_gu.detach().cpu(),
                        }]

                    fg = ddope.render_img(batch_index=0, render_selection="rgb")
                    if fg is not None:
                        composed = _overlay_non_black(composed, fg)
                        rendered += 1
                        if _should_log("renderFitOverlay"):
                            print(
                                "[pose-service][render-fit-overlay]",
                                "✅",
                                {
                                    "projectId": req.projectId,
                                    "imageId": req.imageId,
                                    "imageOriginalName": req.imageOriginalName,
                                    "meshId": meshId,
                                    "meshOriginalName": meshName,
                                    "meshSkuLabel": meshSku,
                                    "result": "rendered",
                                    "t_cv": t_cv,
                                    "tr_Rcv": tr_Rcv,
                                },
                            )
                    else:
                        failed += 1
                        if _should_log("renderFitOverlay"):
                            print(
                                "[pose-service][render-fit-overlay]",
                                "❌",
                                {
                                    "projectId": req.projectId,
                                    "imageId": req.imageId,
                                    "imageOriginalName": req.imageOriginalName,
                                    "meshId": meshId,
                                    "meshOriginalName": meshName,
                                    "meshSkuLabel": meshSku,
                                    "reason": "render_img returned None",
                                    "t_cv": t_cv,
                                    "tr_Rcv": tr_Rcv,
                                },
                            )
                except Exception as e:
                    failed += 1
                    if _should_log("renderFitOverlay"):
                        print(
                            "[pose-service][render-fit-overlay]",
                            "❌",
                            {
                                "projectId": req.projectId,
                                "imageId": req.imageId,
                                "imageOriginalName": req.imageOriginalName,
                                "meshId": meshId,
                                "meshOriginalName": meshName,
                                "meshSkuLabel": meshSku,
                                "error": str(e),
                            },
                        )
                    continue

            fit_overlay_rel_path = _save_fit_overlay(composed, req.projectId, req.imageId, None, suffix="composite")
            if _should_log("renderFitOverlay"):
                # Render phase: treat everything as either "rendered" or "failed".
                overall_symbol = "✅" if rendered > 0 and failed == 0 else "❌"
                print(
                    "[pose-service][render-fit-overlay]",
                    overall_symbol,
                    {
                        "projectId": req.projectId,
                        "imageId": req.imageId,
                        "imageOriginalName": req.imageOriginalName,
                        "objectsCount": len(req.objects),
                        "renderedCount": rendered,
                        "failedCount": failed,
                        "fitOverlayPath": fit_overlay_rel_path,
                        "timingSec": round(float(time.time() - t0), 4),
                    },
                )
            return {
                "success": rendered > 0 and failed == 0,
                "fitOverlayPath": fit_overlay_rel_path,
                "renderedCount": int(rendered),
                "failedCount": int(failed),
                "timingSec": round(float(time.time() - t0), 4),
            }
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "timingSec": round(float(time.time() - t0), 4),
            }
        finally:
            try:
                _release_ddope_gpu(ddope)
                ddope = None
                scene = None
                mesh = None
                obj = None
            except Exception:
                pass


if __name__ == "__main__":
    host = os.getenv("POSE_SERVICE_HOST", "0.0.0.0")
    port = int(os.getenv("POSE_SERVICE_PORT", "7900"))
    reload_flag = os.getenv("POSE_SERVICE_RELOAD", "0").lower() in {"1", "true", "yes", "on"}
    # Access log is dynamically gated by DebugSettingsModal (services.diffdope).
    try:
        logging.getLogger("uvicorn.access").addFilter(DiffDopeAccessLogFilter())
    except Exception:
        pass
    uvicorn.run("app:app", host=host, port=port, reload=reload_flag, access_log=True, log_level="info")


@app.post("/diffdope/estimate6d")
def estimate6d(req: Estimate6DRequest):
    t0 = time.time()
    with _LOCK:
        # 显式初始化：用于 finally 中释放大对象/触发 gc/清空 torch 缓存
        ddope = None
        scene = None
        mesh = None
        obj = None
        seg = None
        depth_img = None
        m_batch = None
        d_batch = None
        overlay = None
        mask = None
        rgb = None
        depth_cm = None
        valid_depth = None

        try:
            rgb_path = Path(req.rgbPath)
            depth_path = Path(req.depthPath)
            intr_path = Path(req.intrinsicsPath)
            mesh_path = Path(req.meshPath)
            for _path in [rgb_path, depth_path, intr_path, mesh_path]:
                if not _path.exists():
                    raise RuntimeError(f"文件不存在: {_path}")

            intr = _load_intrinsics(intr_path)
            rgb = cv2.imread(str(rgb_path))
            if rgb is None:
                raise RuntimeError(f"无法读取 RGB 图像: {rgb_path}")
            h, w = rgb.shape[:2]

            fx = float(intr["fx"])
            fy = float(intr["fy"])
            cx = float(intr.get("cx", intr.get("ppx")))
            cy = float(intr.get("cy", intr.get("ppy")))

            mask = _mask_from_flat_points(req.maskFlatPoints, h, w)
            ys, xs = np.where(mask > 0)
            if len(xs) == 0:
                raise RuntimeError("mask 区域为空")

            # 初始位姿：mask 质心像素 + mask 内深度**中位数**（cm）反投影；无有效深度时回退 80cm。
            depth_cm = _load_depth_cm(depth_path, intr)
            valid_depth = depth_cm[mask > 0]
            valid_depth = valid_depth[valid_depth > 0]
            z_cm = float(np.median(valid_depth)) if len(valid_depth) > 0 else 80.0

            u = float(np.median(xs))
            v = float(np.median(ys))
            x_cm = (u - cx) * z_cm / max(1e-6, fx)
            y_cm = (v - cy) * z_cm / max(1e-6, fy)
            init_xyz = [x_cm, y_cm, z_cm]
            init_quat = [0.0, 0.0, 0.0, 1.0]
            # 统一链路（最稳）：无论是否有初始位姿，都先构造 OpenCV pose44，再显式转换到 GL。
            # 避免无初始位姿路径走 diffdope 内部 opencv2opengl=True 的 legacy 分支。
            default_cv_pose44 = _build_cv_pose44_from_rt(init_xyz, init_quat)
            obj_position, obj_rotation = _cv_pose44_to_gl_rt(default_cv_pose44)
            obj_opencv2opengl = False
            used_initial_pose = False
            initial_pose_source = "depth-mask-auto"
            if req.init is not None:
                pose44_init = getattr(req.init, "pose44", None)
                pose44_valid = (
                    isinstance(pose44_init, list)
                    and len(pose44_init) >= 4
                    and all((isinstance(r, list) and len(r) >= 4) for r in pose44_init[:4])
                )
                if pose44_valid:
                    pos_gl, rot_gl = _cv_pose44_to_gl_rt(pose44_init)  # DB/前端为 OpenCV pose44
                    obj_position = pos_gl
                    obj_rotation = rot_gl
                    obj_opencv2opengl = False
                    used_initial_pose = True
                    initial_pose_source = "request-init-pose44-cv"
                else:
                    pos_in = getattr(req.init, "position", None)
                    quat_in = getattr(req.init, "quat_xyzw", None)
                    pos_ok = isinstance(pos_in, list) and len(pos_in) == 3 and all(np.isfinite(float(v)) for v in pos_in)
                    quat_ok = isinstance(quat_in, list) and len(quat_in) == 4 and all(np.isfinite(float(v)) for v in quat_in)
                    if pos_ok and quat_ok:
                        cv_pose44_from_pos_quat = _build_cv_pose44_from_rt(
                            [float(pos_in[0]), float(pos_in[1]), float(pos_in[2])],
                            [float(quat_in[0]), float(quat_in[1]), float(quat_in[2]), float(quat_in[3])],
                        )
                        obj_position, obj_rotation = _cv_pose44_to_gl_rt(cv_pose44_from_pos_quat)
                        obj_opencv2opengl = False
                        used_initial_pose = True
                        initial_pose_source = "request-init-pos-quat-cv"
            skip_stage1 = bool(req.skipStage1 and used_initial_pose)

            cfg = _diffdope_cfg_fresh()
            _apply_camera_scene_intrinsics(cfg, intr, w, h, str(rgb_path))

            cfg.object3d.model_path = str(mesh_path)
            cfg.object3d.scale = 100.0  # m -> cm
            cfg.object3d.position = obj_position
            cfg.object3d.rotation = obj_rotation

            cfg.hyperparameters.batchsize = int(max(1, min(64, req.batchSize or 8)))
            p = _resolve_two_stage_params(req)
            if _should_log("estimate6d_lossPbar"):
                # Help correlate the tqdm loss lines with the current image/mesh.
                print(
                    "[pose-service][estimate6d][loss-pbar]",
                    "▶️",
                    {
                        "projectId": req.projectId,
                        "imageId": req.imageId,
                        "imageOriginalName": req.imageOriginalName,
                        "meshId": req.meshId,
                        "meshOriginalName": req.meshOriginalName,
                        "meshSkuLabel": req.meshSkuLabel,
                        "skipStage1": bool(req.skipStage1),
                        "s1Iters": p.get("s1_iters", None),
                        "s2Iters": p.get("s2_iters", None),
                        "batchSize": req.batchSize,
                    },
                )
            # 初始模板与第一轮一致（实例化 DiffDope 前写入，避免与遗留 iters/use*Loss 混用）
            cfg.hyperparameters.nb_iterations = p["s1_iters"]
            cfg.losses.l1_mask = p["s1_use_mask"]
            cfg.losses.l1_depth_with_mask = False
            cfg.losses.l1_rgb_with_mask = p["s1_use_rgb"]
            cfg.losses.weight_mask = p["s1_w_mask"]
            cfg.losses.weight_depth = 0.0
            cfg.losses.weight_rgb = p["s1_w_rgb"]

            ddope = dd.DiffDope(cfg=cfg)
            scene = dd.Scene(path_img=str(rgb_path), path_depth=None, path_segmentation=None, image_resize=1.0)
            scene.cuda()
            mesh = dd.Mesh(str(mesh_path), scale=100.0)
            mesh.cuda()
            obj = dd.Object3D(
                position=obj_position,
                rotation=obj_rotation,
                batchsize=cfg.hyperparameters.batchsize,
                opencv2opengl=obj_opencv2opengl,
                scale=1.0,
            )
            obj.mesh = mesh
            obj.mesh.set_batchsize(cfg.hyperparameters.batchsize)
            obj.cuda()

            m = cv2.flip(mask, 0).astype(np.float32) / 255.0
            m3 = np.stack([m, m, m], axis=-1)
            m_batch = torch.tensor(np.stack([m3] * cfg.hyperparameters.batchsize, axis=0), dtype=torch.float32).cuda()
            seg = dd.Image(img_tensor=m_batch, flip_img=False)
            seg._batchsize_set = True
            scene.tensor_segmentation = seg

            d = cv2.flip(depth_cm, 0).astype(np.float32)
            d_batch = torch.tensor(np.stack([d] * cfg.hyperparameters.batchsize, axis=0), dtype=torch.float32).cuda()
            depth_img = dd.Image(img_tensor=d_batch, flip_img=False, depth=True)
            depth_img._batchsize_set = True
            scene.tensor_depth = depth_img

            ddope.scene = scene
            ddope.object3d = obj
            ddope.set_batchsize(cfg.hyperparameters.batchsize)
            # 禁止每迭代缓存整帧 CPU 渲染（batch×分辨率×迭代次数 可达数十 GB）；仅需最后一帧给 get_pose/render_img。
            try:
                ddope.cfg.hyperparameters.store_all_optimization_renders = False
            except Exception:
                pass

            # 两阶段优化（超参数仅来自 p = _resolve_two_stage_params）
            if not skip_stage1:
                ddope.cfg.hyperparameters.nb_iterations = p["s1_iters"]
                ddope.cfg.hyperparameters.early_stop_loss = p["s1_early"]
                ddope.cfg.hyperparameters.base_lr = p["s1_base_lr"]
                ddope.cfg.hyperparameters.lr_decay = p["s1_lr_decay"]
                _configure_stage_losses(
                    ddope,
                    use_mask=p["s1_use_mask"],
                    use_depth=p["s1_use_depth"],
                    use_rgb=p["s1_use_rgb"],
                    weight_mask=p["s1_w_mask"],
                    weight_depth=0.0,
                    weight_rgb=p["s1_w_rgb"],
                )
                ddope.run_optimization()
            

            ddope.cfg.hyperparameters.nb_iterations = p["s2_iters"]
            ddope.cfg.hyperparameters.early_stop_loss = p["s2_early"]
            ddope.cfg.hyperparameters.base_lr = p["s2_base_lr"]
            ddope.cfg.hyperparameters.lr_decay = p["s2_lr_decay"]
            _configure_stage_losses(
                ddope,
                use_mask=p["s2_use_mask"],
                use_depth=p["s2_use_depth"],
                use_rgb=p["s2_use_rgb"],
                weight_mask=p["s2_w_mask"],
                weight_depth=p["s2_w_depth"],
                weight_rgb=p["s2_w_rgb"],
            )
            ddope.run_optimization()
            stage2_scalar_loss = (
                float(ddope.final_loss_scalar)
                if getattr(ddope, "final_loss_scalar", None) is not None
                else None
            )

            argmin = int(ddope.get_argmin())
            # 第二阶段最终 loss 统计（三套口径）：
            # 0) stage2ScalarLoss：优化循环真实标量 loss（与进度条完全同口径，quality gate 用这个）
            # 1) argminLoss：最优候选的最终 loss（用于诊断）
            # 2) stage2BatchMeanLoss：全 batch 最终均值 loss 之和（与进度条/“是否爆炸”更一致）
            final_argmin_terms: List[float] = []
            final_argmin_terms_by_key: Dict[str, float] = {}
            final_batch_mean_terms: List[float] = []
            final_batch_mean_terms_by_key: Dict[str, float] = {}
            for key, tensor in ddope.losses_values.items():
                try:
                    v_argmin = float(tensor[-1][argmin].item())
                    final_argmin_terms.append(v_argmin)
                    final_argmin_terms_by_key[str(key)] = v_argmin
                except Exception:
                    pass
                try:
                    v_batch_mean = float(torch.mean(tensor[-1]).item())
                    final_batch_mean_terms.append(v_batch_mean)
                    final_batch_mean_terms_by_key[str(key)] = v_batch_mean
                except Exception:
                    pass
            final_total_loss_argmin = float(np.sum(final_argmin_terms)) if final_argmin_terms else None
            stage2_batch_mean_loss = float(np.sum(final_batch_mean_terms)) if final_batch_mean_terms else None
            max_allowed_final_loss = (
                float(req.maxAllowedFinalLoss)
                if req.maxAllowedFinalLoss is not None and float(req.maxAllowedFinalLoss) > 0
                else None
            )
            quality_gate_passed = (
                True
                if (max_allowed_final_loss is None or stage2_scalar_loss is None)
                else (stage2_scalar_loss <= max_allowed_final_loss)
            )
            if (
                max_allowed_final_loss is not None
                and stage2_scalar_loss is not None
                and stage2_scalar_loss > max_allowed_final_loss
            ):
                # 质量门槛未通过时，主动清理对应 overlay，避免前端看到历史旧图误判为“本次成功产物”。
                if req.projectId and req.imageId and req.meshId:
                    stale_overlay = (
                        _get_uploads_root_dir()
                        / f"project_{int(req.projectId)}"
                        / "pose-fit-overlays"
                        / f"fit_image_{int(req.imageId)}_mesh_{int(req.meshId)}.png"
                    )
                    try:
                        if stale_overlay.exists():
                            stale_overlay.unlink()
                    except Exception:
                        pass

                if _should_log("estimate6dResult"):
                    print(
                        "[pose-service][estimate6d][result]",
                        {
                            "projectId": req.projectId,
                            "imageId": req.imageId,
                            "imageOriginalName": req.imageOriginalName,
                            "meshId": req.meshId,
                            "meshOriginalName": req.meshOriginalName,
                            "meshSkuLabel": req.meshSkuLabel,
                            "success": False,
                            "error": "LOSS_EXCEEDS_THRESHOLD",
                            "stage2ScalarLoss": stage2_scalar_loss,
                            "maxAllowedFinalLoss": max_allowed_final_loss,
                            "qualityGatePassed": False,
                            "timingSec": round(float(time.time() - t0), 4),
                        },
                    )
                return {
                    "success": False,
                    "error": f"第二阶段 loss={stage2_scalar_loss:.4f} 超过阈值 {max_allowed_final_loss:.4f}",
                    "code": "LOSS_EXCEEDS_THRESHOLD",
                    "timingSec": round(float(time.time() - t0), 4),
                    "meta": {
                        "stage2ScalarLoss": stage2_scalar_loss,
                        "stage2BatchMeanLoss": stage2_batch_mean_loss,
                        "finalArgminLoss": final_total_loss_argmin,
                        "maxAllowedFinalLoss": max_allowed_final_loss,
                        "passed": False,
                        "lossTermsBatchMean": final_batch_mean_terms_by_key,
                        "lossTermsArgmin": final_argmin_terms_by_key,
                    },
                }
            pose44 = ddope.get_pose(batch_index=argmin).tolist()
            overlay = ddope.render_img(batch_index=argmin, render_selection="rgb")
            overlay_b64 = _as_png_b64(overlay) if req.returnDebugImages else None

            # 单 mesh 推理阶段不再落盘独立 overlay（避免形成 image+mesh 级路径）。
            # 统一由 Node 层按 image 聚合所有 pose44 后调用 /diffdope/render-fit-overlay 生成单图。
            fit_overlay_rel_path: Optional[str] = None

            if _should_log("estimate6dResult"):
                # A compact summary for each /diffdope/estimate6d call (useful for batch status debugging).
                print(
                    "[pose-service][estimate6d][result]",
                    {
                        "projectId": req.projectId,
                        "imageId": req.imageId,
                        "imageOriginalName": req.imageOriginalName,
                        "meshId": req.meshId,
                        "meshOriginalName": req.meshOriginalName,
                        "meshSkuLabel": req.meshSkuLabel,
                        "success": True,
                        "qualityGatePassed": bool(quality_gate_passed),
                        "stage2ScalarLoss": stage2_scalar_loss,
                        "maxAllowedFinalLoss": max_allowed_final_loss,
                        "timingSec": round(float(time.time() - t0), 4),
                    },
                )

            return {
                "success": True,
                "pose44": pose44,
                "argmin": argmin,
                "timingSec": round(float(time.time() - t0), 4),
                "debugImages": {
                    "overlayRgbPngB64": overlay_b64,
                } if req.returnDebugImages else None,
                "fitOverlayPath": fit_overlay_rel_path,
                "meta": {
                    "poseDiagnostics": {
                        "initPositionCm": init_xyz,
                        "initQuatXyzw": init_quat,
                            "usedInitialPose": used_initial_pose,
                            "initialPoseSource": initial_pose_source,
                            "skipStage1Requested": bool(req.skipStage1),
                            "skipStage1Applied": skip_stage1,
                        "initDepthPolicy": "median_depth_in_mask_cm_fallback_80",
                        "initZCm": z_cm,
                        "initDepthValidPixelsInMask": int(len(valid_depth)),
                    },
                    "stages": {
                        "stage1": {
                            "name": "stage1-refine",
                            "iterations": p["s1_iters"],
                            "useMask": p["s1_use_mask"],
                            "useDepth": p["s1_use_depth"],
                            "useRgb": p["s1_use_rgb"],
                        },
                        "stage2": {
                            "name": "stage2-refine",
                            "iterations": p["s2_iters"],
                            "useMask": p["s2_use_mask"],
                            "useDepth": p["s2_use_depth"],
                            "useRgb": p["s2_use_rgb"],
                        },
                        "weights": {
                            "stage1Mask": p["s1_w_mask"] if p["s1_use_mask"] else None,
                            "stage1Depth": None,
                            "stage1Rgb": p["s1_w_rgb"] if p["s1_use_rgb"] else None,
                            "stage2Mask": p["s2_w_mask"] if p["s2_use_mask"] else None,
                            "stage2Depth": p["s2_w_depth"] if p["s2_use_depth"] else None,
                            "stage2Rgb": p["s2_w_rgb"] if p["s2_use_rgb"] else None,
                        },
                        "learningRate": {
                            "stage1BaseLr": p["s1_base_lr"],
                            "stage1LrDecay": p["s1_lr_decay"],
                            "stage2BaseLr": p["s2_base_lr"],
                            "stage2LrDecay": p["s2_lr_decay"],
                        },
                        "earlyStopLoss": {
                            "stage1": p["s1_early"],
                            "stage2": p["s2_early"],
                        },
                        "qualityGate": {
                            "stage2ScalarLoss": stage2_scalar_loss,
                            "stage2BatchMeanLoss": stage2_batch_mean_loss,
                            "finalArgminLoss": final_total_loss_argmin,
                            "maxAllowedFinalLoss": max_allowed_final_loss,
                            "passed": quality_gate_passed,
                            "lossTermsBatchMean": final_batch_mean_terms_by_key,
                            "lossTermsArgmin": final_argmin_terms_by_key,
                        },
                    },
                },
            }
        except Exception as e:
            if _should_log("estimate6dResult"):
                print(
                    "[pose-service][estimate6d][result]",
                    {
                        "projectId": getattr(req, "projectId", None),
                        "imageId": getattr(req, "imageId", None),
                        "imageOriginalName": getattr(req, "imageOriginalName", None),
                        "meshId": getattr(req, "meshId", None),
                        "meshOriginalName": getattr(req, "meshOriginalName", None),
                        "meshSkuLabel": getattr(req, "meshSkuLabel", None),
                        "success": False,
                        "error": str(e),
                        "timingSec": round(float(time.time() - t0), 4),
                    },
                )
            return {
                "success": False,
                "error": str(e),
                "timingSec": round(float(time.time() - t0), 4),
            }
        finally:
            try:
                _release_ddope_gpu(ddope)
                ddope = None
                scene = None
                mesh = None
                obj = None
                seg = None
                depth_img = None
                m_batch = None
                d_batch = None
                overlay = None
                mask = None
                rgb = None
                depth_cm = None
                valid_depth = None
            except Exception:
                pass
