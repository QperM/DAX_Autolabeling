import base64
import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import cv2
import numpy as np
import torch
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


class InitPose(BaseModel):
    position: List[float] = Field(default_factory=lambda: [0.0, 0.0, 80.0])  # cm
    quat_xyzw: List[float] = Field(default_factory=lambda: [0.0, 0.0, 0.0, 1.0])


class Estimate6DRequest(BaseModel):
    projectId: Optional[int] = None
    imageId: Optional[int] = None
    meshId: Optional[int] = None
    rgbPath: str
    depthPath: str
    intrinsicsPath: str
    meshPath: str
    maskFlatPoints: List[float]
    init: Optional[InitPose] = None
    stage1Iters: Optional[int] = None
    stage2Iters: Optional[int] = None
    iters: int = 60
    batchSize: int = 8
    lrLow: float = 0.01
    lrHigh: float = 100.0
    baseLr: float = 20.0
    lrDecay: float = 0.1
    useMaskLoss: bool = True
    useRgbLoss: bool = False
    useDepthLoss: bool = True
    stage1UseMask: bool = True
    stage1UseRgb: bool = True
    stage2UseMask: bool = True
    stage2UseRgb: bool = True
    stage2UseDepth: bool = True
    weightMask: float = 1.0
    weightRgb: float = 0.7
    weightDepth: float = 1.0
    stage1WeightMask: Optional[float] = None
    stage1WeightRgb: Optional[float] = None
    stage2WeightMask: Optional[float] = None
    stage2WeightDepth: Optional[float] = None
    stage1EarlyStopLoss: Optional[float] = None
    stage2EarlyStopLoss: Optional[float] = None
    stage1BaseLr: Optional[float] = None
    stage1LrDecay: Optional[float] = None
    stage2BaseLr: Optional[float] = None
    stage2LrDecay: Optional[float] = None
    maxAllowedFinalLoss: Optional[float] = None
    returnDebugImages: bool = True
    debug: bool = False


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


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/diffdope/estimate6d")
def estimate6d(req: Estimate6DRequest):
    t0 = time.time()
    with _LOCK:
        try:
            rgb_path = Path(req.rgbPath)
            depth_path = Path(req.depthPath)
            intr_path = Path(req.intrinsicsPath)
            mesh_path = Path(req.meshPath)
            for p in [rgb_path, depth_path, intr_path, mesh_path]:
                if not p.exists():
                    raise RuntimeError(f"文件不存在: {p}")

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

            if req.debug:
                print("=== DEBUG INIT (pose-service) ===")
                print(f"rgbPath={rgb_path}")
                print(f"depthPath={depth_path}")
                print(f"intrinsicsPath={intr_path}")
                print(f"meshPath={mesh_path}")
                print(f"camera fx/fy/cx/cy=({fx}, {fy}, {cx}, {cy})")
                print(f"mask center (u,v)=({u}, {v}), mask pixels={int(len(xs))}")
                print(f"median depth z_cm={z_cm} (mask 内有效深度点数={len(valid_depth)})")
                print(f"init xyz(cm)={init_xyz}")
                print(f"init quat(xyzw)={init_quat}")

            cfg = OmegaConf.load(str(DIFFDOPE_ROOT / "configs" / "diffdope.yaml"))
            cfg.camera.fx = fx
            cfg.camera.fy = fy
            cfg.camera.cx = cx
            cfg.camera.cy = cy
            cfg.camera.im_width = int(intr.get("width", w))
            cfg.camera.im_height = int(intr.get("height", h))
            cfg.scene.path_img = str(rgb_path)
            cfg.scene.path_depth = None
            cfg.scene.path_segmentation = None
            cfg.scene.image_resize = 1.0
            cfg.render_images.crop_around_mask = False

            cfg.object3d.model_path = str(mesh_path)
            cfg.object3d.scale = 100.0  # m -> cm
            cfg.object3d.position = init_xyz
            cfg.object3d.rotation = init_quat

            # 严格对齐 demo：默认 8 batch / 两轮 80 + 120 次
            cfg.hyperparameters.nb_iterations = 80
            cfg.hyperparameters.batchsize = int(max(1, min(64, req.batchSize or 8)))

            cfg.losses.l1_mask = bool(req.useMaskLoss)
            cfg.losses.l1_depth_with_mask = bool(req.useDepthLoss)
            cfg.losses.l1_rgb_with_mask = bool(req.useRgbLoss)
            cfg.losses.weight_mask = float(max(0.0, req.weightMask))
            cfg.losses.weight_depth = float(max(0.0, req.weightDepth))
            cfg.losses.weight_rgb = float(max(0.0, req.weightRgb))

            ddope = dd.DiffDope(cfg=cfg)
            scene = dd.Scene(path_img=str(rgb_path), path_depth=None, path_segmentation=None, image_resize=1.0)
            scene.cuda()
            mesh = dd.Mesh(str(mesh_path), scale=100.0)
            mesh.cuda()
            obj = dd.Object3D(
                position=init_xyz,
                rotation=init_quat,
                batchsize=cfg.hyperparameters.batchsize,
                opencv2opengl=True,
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

            # 两阶段优化（严格对齐 run_mine_demo_no_video.py）：
            # Stage-1: 仅 mask + RGB（不使用 depth loss）
            # Stage-2: mask +（可选 depth）+（可选 RGB）
            stage1_iters = int(max(1, min(500, req.stage1Iters if req.stage1Iters is not None else 80)))
            stage2_iters = int(max(1, min(500, req.stage2Iters if req.stage2Iters is not None else 120)))
            stage1_weight_mask = float(max(0.0, req.stage1WeightMask if req.stage1WeightMask is not None else 1.0))
            stage1_weight_rgb = float(max(0.0, req.stage1WeightRgb if req.stage1WeightRgb is not None else 0.7))
            stage2_weight_mask = float(max(0.0, req.stage2WeightMask if req.stage2WeightMask is not None else 0.5))
            stage2_weight_depth = float(max(0.0, req.stage2WeightDepth if req.stage2WeightDepth is not None else 1.0))
            stage2_weight_rgb = float(max(0.0, req.weightRgb))
            stage1_use_mask = bool(req.stage1UseMask)
            stage1_use_rgb = bool(req.stage1UseRgb)
            stage2_use_mask = bool(req.stage2UseMask)
            stage2_use_rgb = bool(req.stage2UseRgb)
            stage2_use_depth = bool(req.stage2UseDepth)
            stage1_base_lr = float(max(0.01, min(200.0, req.stage1BaseLr if req.stage1BaseLr is not None else 20.0)))
            stage1_lr_decay = float(max(0.001, min(1.0, req.stage1LrDecay if req.stage1LrDecay is not None else 0.1)))
            stage2_base_lr = float(max(0.01, min(200.0, req.stage2BaseLr if req.stage2BaseLr is not None else 20.0)))
            stage2_lr_decay = float(max(0.001, min(1.0, req.stage2LrDecay if req.stage2LrDecay is not None else 0.1)))
            stage1_early_stop = (
                float(req.stage1EarlyStopLoss)
                if req.stage1EarlyStopLoss is not None and float(req.stage1EarlyStopLoss) > 0
                else None
            )
            stage2_early_stop = (
                float(req.stage2EarlyStopLoss)
                if req.stage2EarlyStopLoss is not None and float(req.stage2EarlyStopLoss) > 0
                else None
            )

            ddope.cfg.hyperparameters.nb_iterations = stage1_iters
            ddope.cfg.hyperparameters.early_stop_loss = stage1_early_stop
            ddope.cfg.hyperparameters.base_lr = stage1_base_lr
            ddope.cfg.hyperparameters.lr_decay = stage1_lr_decay
            _configure_stage_losses(
                ddope,
                use_mask=stage1_use_mask,
                use_depth=False,
                use_rgb=stage1_use_rgb,
                weight_mask=stage1_weight_mask,
                weight_depth=0.0,
                weight_rgb=stage1_weight_rgb,
            )
            ddope.run_optimization()

            ddope.cfg.hyperparameters.nb_iterations = stage2_iters
            ddope.cfg.hyperparameters.early_stop_loss = stage2_early_stop
            ddope.cfg.hyperparameters.base_lr = stage2_base_lr
            ddope.cfg.hyperparameters.lr_decay = stage2_lr_decay
            _configure_stage_losses(
                ddope,
                use_mask=stage2_use_mask,
                use_depth=stage2_use_depth,
                use_rgb=stage2_use_rgb,
                weight_mask=stage2_weight_mask,
                weight_depth=stage2_weight_depth,
                weight_rgb=stage2_weight_rgb,
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
            # 始终打印质量门槛诊断，便于排查“为何没有报错”
            print(
                "[pose-service][quality-gate]",
                {
                    "imageId": req.imageId,
                    "meshId": req.meshId,
                    "stage2ScalarLoss": stage2_scalar_loss,
                    "stage2BatchMeanLoss": stage2_batch_mean_loss,
                    "finalArgminLoss": final_total_loss_argmin,
                    "maxAllowedFinalLoss": max_allowed_final_loss,
                    "passed": quality_gate_passed,
                    "lossTermsBatchMean": final_batch_mean_terms_by_key,
                    "lossTermsArgmin": final_argmin_terms_by_key,
                },
            )
            if (
                max_allowed_final_loss is not None
                and stage2_scalar_loss is not None
                and stage2_scalar_loss > max_allowed_final_loss
            ):
                # 质量门槛未通过时，主动清理对应 overlay，避免前端看到历史旧图误判为“本次成功产物”。
                if req.projectId and req.imageId and req.meshId:
                    stale_overlay = (
                        ROOT.parent
                        / "uploads"
                        / f"project_{int(req.projectId)}"
                        / "pose-fit-overlays"
                        / f"fit_image_{int(req.imageId)}_mesh_{int(req.meshId)}.png"
                    )
                    try:
                        if stale_overlay.exists():
                            stale_overlay.unlink()
                    except Exception:
                        pass
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

            fit_overlay_rel_path: Optional[str] = None
            if overlay is not None and req.projectId:
                fit_dir = ROOT.parent / "uploads" / f"project_{int(req.projectId)}" / "pose-fit-overlays"
                fit_dir.mkdir(parents=True, exist_ok=True)
                img_id = int(req.imageId or 0)
                mesh_id = int(req.meshId or 0)
                # 固定命名：同一 imageId + meshId 重复推理时覆盖旧文件，避免目录膨胀
                filename = f"fit_image_{img_id}_mesh_{mesh_id}.png"
                abs_path = fit_dir / filename
                cv2.imwrite(str(abs_path), overlay)
                fit_overlay_rel_path = f"/uploads/project_{int(req.projectId)}/pose-fit-overlays/{filename}"

            debug_paths: Dict[str, Optional[str]] = {"mask": None, "overlay": None}
            if req.debug:
                debug_root = ROOT / "debug_outputs"
                debug_root.mkdir(parents=True, exist_ok=True)
                run_dir = debug_root / f"api_{int(time.time() * 1000)}_{os.getpid()}"
                run_dir.mkdir(parents=True, exist_ok=True)
                mask_path = run_dir / "mask_api.png"
                overlay_path = run_dir / "overlay_api.png"
                cv2.imwrite(str(mask_path), mask)
                if overlay is not None:
                    cv2.imwrite(str(overlay_path), overlay)
                debug_paths["mask"] = str(mask_path)
                debug_paths["overlay"] = str(overlay_path) if overlay is not None else None
                print("=== DEBUG ARTIFACTS (pose-service) ===")
                print(f"mask saved: {debug_paths['mask']}")
                print(f"overlay saved: {debug_paths['overlay']}")

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
                        "initDepthPolicy": "median_depth_in_mask_cm_fallback_80",
                        "initZCm": z_cm,
                        "initDepthValidPixelsInMask": int(len(valid_depth)),
                    },
                    "stages": {
                        "stage1": {
                            "name": "stage1-refine",
                            "iterations": stage1_iters,
                            "useMask": stage1_use_mask,
                            "useDepth": False,
                            "useRgb": stage1_use_rgb,
                        },
                        "stage2": {
                            "name": "stage2-refine",
                            "iterations": stage2_iters,
                            "useMask": stage2_use_mask,
                            "useDepth": stage2_use_depth,
                            "useRgb": stage2_use_rgb,
                        },
                        "weights": {
                            "stage1Mask": stage1_weight_mask if stage1_use_mask else None,
                            "stage1Rgb": stage1_weight_rgb if stage1_use_rgb else None,
                            "stage2Mask": stage2_weight_mask if stage2_use_mask else None,
                            "stage2Depth": stage2_weight_depth if stage2_use_depth else None,
                            "stage2Rgb": stage2_weight_rgb if stage2_use_rgb else None,
                        },
                        "learningRate": {
                            "stage1BaseLr": stage1_base_lr,
                            "stage1LrDecay": stage1_lr_decay,
                            "stage2BaseLr": stage2_base_lr,
                            "stage2LrDecay": stage2_lr_decay,
                        },
                        "earlyStopLoss": {
                            "stage1": stage1_early_stop,
                            "stage2": stage2_early_stop,
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
                    "debugArtifacts": debug_paths if req.debug else None,
                },
            }
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "timingSec": round(float(time.time() - t0), 4),
            }
