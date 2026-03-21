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
    iters: int = 60
    batchSize: int = 8
    lrLow: float = 0.01
    lrHigh: float = 100.0
    baseLr: float = 20.0
    lrDecay: float = 0.1
    useMaskLoss: bool = True
    useRgbLoss: bool = False
    useDepthLoss: bool = True
    weightMask: float = 1.0
    weightRgb: float = 0.7
    weightDepth: float = 1.0
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

            depth_cm = _load_depth_cm(depth_path, intr)
            valid_depth = depth_cm[mask > 0]
            valid_depth = valid_depth[valid_depth > 0]
            z_cm = float(np.median(valid_depth)) if len(valid_depth) > 0 else 80.0

            # 严格对齐 run_mine_demo_no_video.py：
            # 初始化总是来自 mask + depth 反投影，不走外部 init。
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
                print(f"median depth z_cm={z_cm}")
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
            cfg.hyperparameters.batchsize = 8

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
            # Stage-1: mask 粗定位
            # Stage-2: mask + depth 精修
            stage1_iters = 80
            stage2_iters = 120

            ddope.cfg.losses.l1_mask = True
            ddope.cfg.losses.weight_mask = 1.0
            ddope.cfg.losses.l1_depth_with_mask = False
            ddope.cfg.losses.l1_rgb_with_mask = False
            ddope.cfg.hyperparameters.nb_iterations = stage1_iters
            ddope.loss_functions = [dd.l1_mask]
            ddope.run_optimization()

            ddope.cfg.losses.l1_mask = True
            ddope.cfg.losses.weight_mask = 0.5
            ddope.cfg.losses.l1_depth_with_mask = True
            ddope.cfg.losses.weight_depth = 1.0
            ddope.cfg.losses.l1_rgb_with_mask = False
            ddope.cfg.hyperparameters.nb_iterations = stage2_iters
            ddope.loss_functions = [dd.l1_mask, dd.l1_depth_with_mask]
            ddope.run_optimization()

            argmin = int(ddope.get_argmin())
            pose44 = ddope.get_pose(batch_index=argmin).tolist()
            overlay = ddope.render_img(batch_index=argmin, render_selection="rgb")
            overlay_b64 = _as_png_b64(overlay) if req.returnDebugImages else None

            fit_overlay_rel_path: Optional[str] = None
            if overlay is not None and req.projectId:
                fit_dir = ROOT.parent / "uploads" / f"project_{int(req.projectId)}" / "pose-fit-overlays"
                fit_dir.mkdir(parents=True, exist_ok=True)
                ts = int(time.time() * 1000)
                img_id = int(req.imageId or 0)
                mesh_id = int(req.meshId or 0)
                filename = f"fit_image_{img_id}_mesh_{mesh_id}_{ts}.png"
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
                    },
                    "stages": {
                        "stage1": {"name": "mask-coarse", "iterations": stage1_iters},
                        "stage2": {
                            "name": "mask-depth-refine",
                            "iterations": stage2_iters,
                            "useDepthLoss": True,
                            "useRgbLoss": False,
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
