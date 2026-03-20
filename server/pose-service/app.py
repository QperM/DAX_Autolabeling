from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import numpy as np
import json
import os
import sys
import base64
from typing import Any, Dict, List, Optional, Tuple
from concurrent.futures import ThreadPoolExecutor
import time
import logging
from scipy.spatial import cKDTree
from scipy.spatial import ConvexHull
from scipy.spatial import Delaunay
from PIL import Image as PILImage
from PIL import ImageDraw

try:
    import torch
    import torch.nn.functional as F
except Exception:  # pragma: no cover
    torch = None
    F = None

try:
    from omegaconf import OmegaConf
except Exception:  # pragma: no cover
    OmegaConf = None

# Make local diff-dope importable (repo-vendored).
_HERE = os.path.dirname(os.path.abspath(__file__))
_DIFFDOPE_ROOT = os.path.join(_HERE, "diff-dope")
if os.path.isdir(_DIFFDOPE_ROOT) and _DIFFDOPE_ROOT not in sys.path:
    sys.path.insert(0, _DIFFDOPE_ROOT)

try:
    import diffdope as diffdope_lib
except Exception:  # pragma: no cover
    diffdope_lib = None


app = FastAPI(
    title="Pose Solve Service",
    description="Solve 9D pose helpers: fit rotation from 2D mask, and solve translation+scale from depth_raw + intrinsics + mask given rotation (Unity axes).",
    version="0.1.0",
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("pose-service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SolveOptions(BaseModel):
    stride: int = Field(3, description="Pixel stride when sampling inside mask")
    voxel_mm: float = Field(6.0, description="Voxel size for downsampling (mm)")
    max_points: int = Field(30000, description="Cap observed point count")
    trim_ratio: float = Field(0.8, description="Keep this fraction of smallest residuals each iteration")
    iters: int = Field(20, description="Iterations for fixed-R scale+translation solve")
    scale_min: float = Field(0.3, description="Clamp scale lower bound")
    scale_max: float = Field(3.0, description="Clamp scale upper bound")


class SolveRequest(BaseModel):
    depthRawPath: str
    intrinsicsPath: str
    meshObjPath: str
    maskFlatPoints: List[float]
    rotationDeg: Dict[str, float]  # Unity axes: X right, Y up, Z forward
    options: Optional[SolveOptions] = None


class FitSearch(BaseModel):
    zMin: float = -40
    zMax: float = 40
    zStep: float = 10
    xMin: float = 0
    xMax: float = 0
    xStep: float = 10
    yMin: float = 0
    yMax: float = 0
    yStep: float = 10


class FitRotationRequest(BaseModel):
    meshObjPath: str
    maskFlatPoints: List[float]
    imageWidth: Optional[float] = None
    imageHeight: Optional[float] = None
    initialRotationDeg: Optional[Dict[str, float]] = None
    search: Optional[FitSearch] = None
    rasterSize: int = 256
    mode: str = "z"  # "z" | "xyz"
    projectionDetail: str = "balanced"  # "fast" | "balanced" | "high"
    debug: Optional[bool] = None


class DiffDopePoseInit(BaseModel):
    # OpenCV camera convention pose (x right, y down, z forward).
    # If not provided, the service estimates translation from depth+mask centroid and uses identity rotation.
    position: Optional[List[float]] = None  # meters (3)
    quat_xyzw: Optional[List[float]] = None  # (4)


class DiffDopeEstimate6DRequest(BaseModel):
    rgbPath: str
    depthPath: str
    intrinsicsPath: str
    meshPath: str
    maskFlatPoints: List[float]
    init: Optional[DiffDopePoseInit] = None
    iters: int = Field(60, ge=1, le=500)
    batchSize: int = Field(8, ge=1, le=64)
    lrLow: float = Field(0.01, gt=0)
    lrHigh: float = Field(100.0, gt=0)
    baseLr: float = Field(20.0, gt=0)
    lrDecay: float = Field(0.1, gt=0)
    # loss toggles
    useMaskLoss: bool = True
    useRgbLoss: bool = False
    useDepthLoss: bool = True
    weightMask: float = 1.0
    weightRgb: float = 0.7
    weightDepth: float = 1.0
    # debug outputs
    returnDebugImages: bool = True
    # verbose logging + extra response meta for debugging
    debug: bool = False


def _load_intrinsics_json(path: str) -> Dict[str, float]:
    with open(path, "r", encoding="utf-8") as f:
        js = json.load(f)
    fx = float(js["fx"])
    fy = float(js["fy"])
    cx = float(js.get("ppx", js.get("cx")))
    cy = float(js.get("ppy", js.get("cy")))
    w = int(js.get("width") or js.get("w") or js.get("image_width") or 0)
    h = int(js.get("height") or js.get("h") or js.get("image_height") or 0)
    if not np.isfinite([fx, fy, cx, cy]).all() or fx <= 0 or fy <= 0:
        raise ValueError("Invalid intrinsics fx/fy/ppx/ppy")
    return {"fx": fx, "fy": fy, "cx": cx, "cy": cy, "width": float(w), "height": float(h)}


def _decode_poly_from_flat(flat: List[float]) -> np.ndarray:
    arr = np.asarray(flat, dtype=np.float32)
    if arr.size % 2 != 0:
        arr = arr[:-1]
    pts = arr.reshape(-1, 2)
    return pts


def _compute_centroid_px(poly_xy: np.ndarray) -> Tuple[float, float]:
    if poly_xy is None or poly_xy.shape[0] < 3:
        raise ValueError("mask polygon invalid")
    x = poly_xy[:, 0].astype(np.float64)
    y = poly_xy[:, 1].astype(np.float64)
    # area-weighted centroid
    x1 = np.roll(x, -1)
    y1 = np.roll(y, -1)
    a = x * y1 - x1 * y
    signed_area2 = float(np.sum(a))
    if abs(signed_area2) > 1e-9:
        cx = float(np.sum((x + x1) * a) / (3.0 * signed_area2))
        cy = float(np.sum((y + y1) * a) / (3.0 * signed_area2))
        if np.isfinite([cx, cy]).all():
            return cx, cy
    # fallback mean
    return float(np.mean(x)), float(np.mean(y))


def _polygon_mask_image(poly_xy: np.ndarray, w: int, h: int) -> np.ndarray:
    img = PILImage.new("L", (int(w), int(h)), 0)
    draw = ImageDraw.Draw(img)
    draw.polygon([(float(x), float(y)) for x, y in poly_xy], fill=255)
    return np.asarray(img, dtype=np.uint8)


def _to_b64_png(img_bgr_or_rgb: np.ndarray) -> str:
    import cv2  # local import to keep startup lighter

    if img_bgr_or_rgb is None:
        return ""
    arr = img_bgr_or_rgb
    if arr.dtype != np.uint8:
        arr = np.clip(arr, 0, 255).astype(np.uint8)
    ok, buf = cv2.imencode(".png", arr)
    if not ok:
        return ""
    return base64.b64encode(buf.tobytes()).decode("ascii")


def _blend_overlay_fullframe(
    rgb_bgr: np.ndarray,
    render_rgb_float: np.ndarray,
    *,
    alpha: float = 0.7,
    flip_render_y: bool = True,
) -> np.ndarray:
    """
    Build a full-frame overlay image with the SAME resolution as the input rgb.
    This avoids diff-dope's grid/resize helpers which can distort the preview in the UI.

    rgb_bgr: uint8 (H,W,3) from cv2.imread
    render_rgb_float: float tensor dump (H,W,3) in [0,1] on black background (best-effort)
    """
    if rgb_bgr is None or rgb_bgr.ndim != 3:
        return rgb_bgr
    bg = rgb_bgr.astype(np.float32)

    fg = render_rgb_float
    if fg is None:
        return rgb_bgr
    fg = np.asarray(fg)
    if fg.ndim != 3:
        return rgb_bgr

    if flip_render_y:
        try:
            fg = fg[::-1, :, :]
        except Exception:
            pass

    # Ensure same resolution (last-resort resize)
    h, w = bg.shape[:2]
    if fg.shape[0] != h or fg.shape[1] != w:
        try:
            import cv2

            fg = cv2.resize(fg, (w, h), interpolation=cv2.INTER_LINEAR)
        except Exception:
            return rgb_bgr

    # Render is typically in RGB; convert to BGR for blending with cv2 background.
    # If it already looks BGR, this only affects colors, not geometry.
    fg_u8 = np.clip(fg * 255.0, 0, 255).astype(np.uint8)
    fg_bgr = fg_u8[:, :, ::-1]

    # alpha mask: where render is non-black
    m = (np.max(fg_bgr, axis=2) > 3).astype(np.float32)[:, :, None]
    a = float(np.clip(alpha, 0.0, 1.0))
    out = bg * (1.0 - m * a) + fg_bgr.astype(np.float32) * (m * a)
    return np.clip(out, 0, 255).astype(np.uint8)


@app.post("/diffdope/estimate6d")
def diffdope_estimate6d(req: DiffDopeEstimate6DRequest):
    if diffdope_lib is None or torch is None or OmegaConf is None:
        raise HTTPException(
            status_code=501,
            detail="diff-dope service unavailable: missing dependencies (diffdope/torch/omegaconf). Install required deps (torch + nvdiffrast) and ensure server/pose-service/diff-dope is present.",
        )

    import cv2

    if not os.path.exists(req.rgbPath):
        raise HTTPException(status_code=400, detail=f"rgbPath not found: {req.rgbPath}")
    if not os.path.exists(req.depthPath):
        raise HTTPException(status_code=400, detail=f"depthPath not found: {req.depthPath}")
    if not os.path.exists(req.intrinsicsPath):
        raise HTTPException(status_code=400, detail=f"intrinsicsPath not found: {req.intrinsicsPath}")
    if not os.path.exists(req.meshPath):
        raise HTTPException(status_code=400, detail=f"meshPath not found: {req.meshPath}")

    intr = _load_intrinsics_json(req.intrinsicsPath)
    fx, fy, cx, cy = intr["fx"], intr["fy"], intr["cx"], intr["cy"]

    rgb_bgr = cv2.imread(req.rgbPath, cv2.IMREAD_COLOR)
    if rgb_bgr is None:
        raise HTTPException(status_code=400, detail="failed to read rgb image")
    rgb = cv2.cvtColor(rgb_bgr, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0

    depth_raw = cv2.imread(req.depthPath, cv2.IMREAD_UNCHANGED)
    if depth_raw is None:
        raise HTTPException(status_code=400, detail="failed to read depth image")
    # Diff-DOPE expects a single-channel metric depth map.
    # Our pipeline may store depth_png as 3-channel visualization; force to 1 channel.
    if depth_raw.ndim == 3:
        # Prefer the first channel (cheap, deterministic). If it's actually a colormap, depth losses won't be meaningful,
        # but this avoids shape crashes and lets mask-only optimization run.
        depth_raw = depth_raw[:, :, 0]
    # Assume uint16 depth in millimeters by default. Convert to meters.
    depth_dtype = str(depth_raw.dtype)
    depth_shape = list(depth_raw.shape) if hasattr(depth_raw, "shape") else None
    depth_mm_assumed = bool(depth_raw.dtype == np.uint16)
    if depth_raw.dtype == np.uint16:
        depth_m = depth_raw.astype(np.float32) * 0.001
    else:
        depth_m = depth_raw.astype(np.float32)

    # Heuristic: some pipelines save metric depth as float/other integer types but still in millimeters.
    # If we treat those values as meters, translation will blow up by ~1000x (e.g., 400000mm instead of 400mm).
    # Rule: if median valid depth is clearly too large for meters (e.g., > 30m), assume it's millimeters and convert.
    depth_unit_fix = None
    try:
        _valid = depth_m[np.isfinite(depth_m) & (depth_m > 0)]
        _med = float(np.median(_valid)) if _valid.size > 0 else float("nan")
        if (not depth_mm_assumed) and np.isfinite(_med):
            if _med > 30.0 and _med < 1e7:
                depth_m = depth_m * 0.001
                depth_unit_fix = {"applied": True, "reason": "medianDepthTooLargeAssumeMm", "medianBefore": _med}
            else:
                depth_unit_fix = {"applied": False, "median": _med}
    except Exception:
        depth_unit_fix = {"applied": False, "error": "medianEvalFailed"}

    h, w = rgb.shape[:2]
    poly = _decode_poly_from_flat(req.maskFlatPoints)
    mask_u8 = _polygon_mask_image(poly, w=w, h=h)
    seg = (mask_u8.astype(np.float32) / 255.0)
    seg3 = np.stack([seg, seg, seg], axis=-1)

    # Diff-DOPE expects flipped images (y axis). We flip here to keep consistent.
    rgb = cv2.flip(rgb, 0)
    depth_m = cv2.flip(depth_m, 0)
    seg3 = cv2.flip(seg3, 0)

    # Init pose: estimate translation from mask centroid + depth median if not provided.
    init_pos = req.init.position if req.init and req.init.position and len(req.init.position) == 3 else None
    init_quat = req.init.quat_xyzw if req.init and req.init.quat_xyzw and len(req.init.quat_xyzw) == 4 else None

    # Compute centroid in original (non-flipped) pixel coords for init; then map to flipped coords.
    cx_px, cy_px = _compute_centroid_px(poly)
    cx_px_f = float(cx_px)
    cy_px_f = float((h - 1) - cy_px)  # because we flipped images vertically

    if init_pos is None:
        # median depth inside mask
        depth_masked = depth_m[mask_u8[::-1, :] > 0]  # mask_u8 is unflipped; depth_m is flipped, so reverse rows
        depth_masked = depth_masked[np.isfinite(depth_masked) & (depth_masked > 0)]
        z = float(np.median(depth_masked)) if depth_masked.size > 0 else float(np.median(depth_m[np.isfinite(depth_m) & (depth_m > 0)]))
        if not np.isfinite(z) or z <= 0:
            z = 0.6
        X = ((cx_px_f - cx) / fx) * z
        Y = ((cy_px_f - cy) / fy) * z
        init_pos = [float(X), float(Y), float(z)]

    if init_quat is None:
        init_quat = [0.0, 0.0, 0.0, 1.0]

    cfg = OmegaConf.create(
        {
            "camera": {
                "fx": float(fx),
                "fy": float(fy),
                "cx": float(cx),
                "cy": float(cy),
                "im_width": int(w),
                "im_height": int(h),
                "znear": 0.01,
                "zfar": 20.0,
            },
            "scene": {
                "path_img": None,
                "path_depth": None,
                "path_segmentation": None,
                "image_resize": 1.0,
            },
            "object3d": {
                "position": init_pos,
                "rotation": init_quat,
                "batchsize": int(req.batchSize),
                "opencv2opengl": True,
                "model_path": req.meshPath,
                "scale": 1.0,
            },
            "losses": {
                "l1_rgb_with_mask": bool(req.useRgbLoss),
                "weight_rgb": float(req.weightRgb),
                "l1_depth_with_mask": bool(req.useDepthLoss),
                "weight_depth": float(req.weightDepth),
                "l1_mask": bool(req.useMaskLoss),
                "weight_mask": float(req.weightMask),
            },
            "hyperparameters": {
                "nb_iterations": int(req.iters),
                "batchsize": int(req.batchSize),
                "base_lr": float(req.baseLr),
                "learning_rates_bound": [float(req.lrLow), float(req.lrHigh)],
                "learning_rate_base": 1.0,
                "lr_decay": float(req.lrDecay),
            },
            "render_images": {
                "nrow": 4,
                "final_width_batch": 1400,
                "add_background": True,
                "alpha_overlay": 0.7,
                "add_countour": True,
                "color_countour": [0.46, 0.73, 0],
                "flip_result": True,
                # For UI overlay we need full-frame output (no crop), otherwise the cropped patch
                # will be scaled to full preview and look like it "covers" the whole image.
                "crop_around_mask": False,
            },
        }
    )

    if req.debug:
        try:
            mbb = _mask_bbox_from_flat_points(req.maskFlatPoints)
        except Exception:
            mbb = None
        try:
            dm = depth_m
            dm_valid = dm[np.isfinite(dm) & (dm > 0)]
            depth_stats = {
                "min": float(np.min(dm_valid)) if dm_valid.size > 0 else None,
                "max": float(np.max(dm_valid)) if dm_valid.size > 0 else None,
                "median": float(np.median(dm_valid)) if dm_valid.size > 0 else None,
                "validPx": int(dm_valid.size),
            }
        except Exception:
            depth_stats = None

        logger.info(
            "[diffdope][debug] request summary: rgbPath=%s depthPath=%s intrinsicsPath=%s meshPath=%s iters=%s bs=%s losses(mask=%s,rgb=%s,depth=%s) weights(mask=%s,rgb=%s,depth=%s) lr(base=%s,low=%s,high=%s,decay=%s) returnDebugImages=%s",
            req.rgbPath,
            req.depthPath,
            req.intrinsicsPath,
            req.meshPath,
            req.iters,
            req.batchSize,
            req.useMaskLoss,
            req.useRgbLoss,
            req.useDepthLoss,
            req.weightMask,
            req.weightRgb,
            req.weightDepth,
            req.baseLr,
            req.lrLow,
            req.lrHigh,
            req.lrDecay,
            req.returnDebugImages,
        )
        logger.info(
            "[diffdope][debug] intrinsics: fx=%.4f fy=%.4f cx=%.4f cy=%.4f img(w=%d,h=%d) depth(dtype=%s,shape=%s,mm_assumed=%s) depthStats(m)=%s mask(bboxPx)=%s initPos(m)=%s initQuat=%s",
            float(fx),
            float(fy),
            float(cx),
            float(cy),
            int(w),
            int(h),
            depth_dtype,
            str(depth_shape),
            str(depth_mm_assumed),
            str(depth_stats),
            str(mbb),
            str(init_pos),
            str(init_quat),
        )
        if depth_unit_fix is not None:
            logger.info("[diffdope][debug] depth unit fix: %s", str(depth_unit_fix))

    # Build tensors
    rgb_t = torch.tensor(rgb).float()
    depth_t = torch.tensor(depth_m).float()
    seg_t = torch.tensor(seg3).float()


    
    # Use in-memory scene.
    # IMPORTANT: diffdope.Scene.__post_init__ only loads from path_*; it does not populate tensors
    # from constructor kwargs reliably across versions. We set tensor_* explicitly after init.
    scene = diffdope_lib.Scene(
        path_img=None,
        path_depth=None,
        path_segmentation=None,
        image_resize=1.0,
    )
    scene.tensor_rgb = diffdope_lib.Image(img_tensor=rgb_t, img_resize=1.0, flip_img=False, depth=False)
    scene.tensor_depth = diffdope_lib.Image(img_tensor=depth_t, img_resize=1.0, flip_img=False, depth=True)
    scene.tensor_segmentation = diffdope_lib.Image(img_tensor=seg_t, img_resize=1.0, flip_img=False, depth=False)

    camera = diffdope_lib.Camera(
        fx=float(fx),
        fy=float(fy),
        cx=float(cx),
        cy=float(cy),
        im_width=int(w),
        im_height=int(h),
        znear=0.01,
        zfar=20.0,
    )
    obj = diffdope_lib.Object3D(
        position=init_pos,
        rotation=init_quat,
        batchsize=int(req.batchSize),
        opencv2opengl=True,
        model_path=req.meshPath,
        scale=1.0,
    )

    ddope = diffdope_lib.DiffDope(cfg=cfg, camera=camera, object3d=obj, scene=scene)
    # Ensure rasterizer resolution is valid (H,W). Otherwise nvdiffrast receives (None,None).
    ddope.resolution = [int(h), int(w)]
    try:
        # Keep scene.get_resolution consistent if diffdope re-queries it.
        ddope.scene.get_resolution = lambda: [int(h), int(w)]
    except Exception:
        pass

    # IMPORTANT: We are using in-memory tensors (path_* are None). diffdope.Scene.set_batchsize/cuda()
    # only act when path_* are provided, so we must handle batch + device manually.
    bs = int(req.batchSize)
    if ddope.scene.tensor_rgb is None or ddope.scene.tensor_depth is None or ddope.scene.tensor_segmentation is None:
        raise HTTPException(status_code=500, detail="internal error: scene tensors not set")

    # Batchify GT tensors
    ddope.scene.tensor_rgb.set_batchsize(bs)
    ddope.scene.tensor_depth.set_batchsize(bs)
    ddope.scene.tensor_segmentation.set_batchsize(bs)

    # Move to CUDA to match nvdiffrast renders (Object3D is on cuda by default).
    if torch.cuda.is_available():
        ddope.scene.tensor_rgb.cuda()
        ddope.scene.tensor_depth.cuda()
        ddope.scene.tensor_segmentation.cuda()

    # Sync gt_tensors used by loss functions
    ddope.gt_tensors["rgb"] = ddope.scene.tensor_rgb.img_tensor
    ddope.gt_tensors["depth"] = ddope.scene.tensor_depth.img_tensor
    ddope.gt_tensors["segmentation"] = ddope.scene.tensor_segmentation.img_tensor

    t0 = time.time()
    ddope.run_optimization()
    t1 = time.time()

    argmin = int(ddope.get_argmin().item()) if hasattr(ddope.get_argmin(), "item") else int(ddope.get_argmin())
    pose44 = ddope.get_pose(batch_index=argmin).tolist()

    out: Dict[str, Any] = {
        "success": True,
        "argmin": argmin,
        "pose44": pose44,
        "timingSec": float(t1 - t0),
        "init": {"position": init_pos, "quat_xyzw": init_quat, "centroidPxFlipped": [cx_px_f, cy_px_f]},
        "meta": {"w": int(w), "h": int(h), "meshPath": req.meshPath},
    }

    if req.debug:
        try:
            out["meta"]["debug"] = {
                "intrinsics": {"fx": float(fx), "fy": float(fy), "cx": float(cx), "cy": float(cy)},
                "depth": {"dtype": depth_dtype, "shape": depth_shape, "mm_assumed": depth_mm_assumed},
                "depthUnitFix": depth_unit_fix,
                "hyperparameters": {
                    "nb_iterations": int(req.iters),
                    "batchsize": int(req.batchSize),
                    "base_lr": float(req.baseLr),
                    "learning_rates_bound": [float(req.lrLow), float(req.lrHigh)],
                    "learning_rate_base": 1.0,
                    "lr_decay": float(req.lrDecay),
                },
                "losses": {
                    "l1_rgb_with_mask": bool(req.useRgbLoss),
                    "weight_rgb": float(req.weightRgb),
                    "l1_depth_with_mask": bool(req.useDepthLoss),
                    "weight_depth": float(req.weightDepth),
                    "l1_mask": bool(req.useMaskLoss),
                    "weight_mask": float(req.weightMask),
                },
                "render_images": {
                    "alpha_overlay": 0.7,
                    "crop_around_mask": False,
                    "flip_result": True,
                },
                "maskFlatPointsLen": int(len(req.maskFlatPoints) if isinstance(req.maskFlatPoints, list) else 0),
            }
        except Exception:
            pass

    if req.returnDebugImages:
        dbg: Dict[str, Any] = {}
        errs: List[str] = []

        # 1) RGB overlay is the most important visualization for humans.
        try:
            # Prefer a true full-frame overlay (same resolution as original RGB) for the web UI.
            # ddope.render_img() returns a resized "grid" image which may look like it "shrinks" the RGB in the preview.
            try:
                render_rgb = ddope.optimization_results[-1]["rgb"][argmin].detach().cpu().numpy()
            except Exception:
                # fallback: use last render output if optimization_results structure differs
                render_rgb = None

            overlay_full = _blend_overlay_fullframe(
                rgb_bgr=rgb_bgr,
                render_rgb_float=render_rgb,
                alpha=float(cfg.render_images.get("alpha_overlay", 0.7)) if hasattr(cfg, "render_images") else 0.7,
                flip_render_y=True,
            )
            dbg["overlayRgbPngB64"] = _to_b64_png(overlay_full)
        except Exception as e:
            errs.append(f"overlayRgb failed: {e}")

        # 2) Loss plot (always safe if optimization ran).
        try:
            losses_plot = ddope.plot_losses(batch_index=argmin)
            dbg["lossPlotPngB64"] = _to_b64_png(losses_plot)
        except Exception as e:
            errs.append(f"lossPlot failed: {e}")

        # 3) Depth overlay: diff-dope's helper assumes 4D image tensors; our depth is often (B,H,W).
        # We skip it by default to avoid permute-dims crashes. If you need it later, we can add a
        # dedicated depth visualizer that expands to 3 channels + colormap.
        dbg["overlayDepthPngB64"] = ""

        if errs:
            dbg["error"] = " | ".join(errs)
        out["debugImages"] = dbg

    return out

def _normalize_projection_detail(v: Any) -> str:
    s = str(v or "balanced").strip().lower()
    return s if s in ("fast", "balanced", "high") else "balanced"


def _now_ms() -> float:
    return time.perf_counter() * 1000.0


def _bbox_of_points_2d(pts: np.ndarray) -> Optional[Dict[str, float]]:
    if pts.size == 0:
        return None
    x = pts[:, 0]
    y = pts[:, 1]
    if x.size == 0:
        return None
    min_x = float(np.min(x))
    max_x = float(np.max(x))
    min_y = float(np.min(y))
    max_y = float(np.max(y))
    if not np.isfinite([min_x, max_x, min_y, max_y]).all():
        return None
    w = max_x - min_x
    h = max_y - min_y
    return {"minX": min_x, "minY": min_y, "maxX": max_x, "maxY": max_y, "w": w, "h": h, "cx": (min_x + max_x) / 2.0, "cy": (min_y + max_y) / 2.0}


def _mask_bbox_from_flat_points(flat: List[float]) -> Optional[Dict[str, float]]:
    if not isinstance(flat, list) or len(flat) < 6:
        return None
    arr = np.asarray(flat, dtype=np.float32)
    if arr.size < 6:
        return None
    if arr.size % 2 != 0:
        arr = arr[:-1]
    pts = arr.reshape(-1, 2)
    return _bbox_of_points_2d(pts)


def _fit_points_to_bbox_uniform(pts2: np.ndarray, target_bbox: Dict[str, float]) -> Optional[np.ndarray]:
    bb = _bbox_of_points_2d(pts2)
    if not bb or not target_bbox:
        return None
    eps = 1e-9
    sx = float(target_bbox.get("w", 1.0)) / max(eps, float(bb.get("w", eps)))
    sy = float(target_bbox.get("h", 1.0)) / max(eps, float(bb.get("h", eps)))
    s = min(sx, sy)
    if not np.isfinite(s) or s <= 0:
        return None
    out = np.empty_like(pts2, dtype=np.float32)
    out[:, 0] = (pts2[:, 0] - float(bb["cx"])) * s + float(target_bbox["cx"])
    out[:, 1] = (pts2[:, 1] - float(bb["cy"])) * s + float(target_bbox["cy"])
    return out


def _range_inclusive(a: float, b: float, step: float) -> np.ndarray:
    s = abs(float(step)) if np.isfinite(step) else 1.0
    if s <= 0:
        return np.array([float(a)], dtype=np.float32)
    start = float(a) if np.isfinite(a) else 0.0
    end = float(b) if np.isfinite(b) else 0.0
    n = int(np.floor(abs(end - start) / s + 1e-9)) + 1
    if n > 2000:
        n = 2000
    if start <= end:
        vals = start + np.arange(n, dtype=np.float32) * s
    else:
        vals = start - np.arange(n, dtype=np.float32) * s
    return vals.astype(np.float32)


def _rot_matrix_xyz_torch_deg(rot_deg: torch.Tensor) -> torch.Tensor:
    """
    rot_deg: (B,3) in degrees (x,y,z). Returns (B,3,3).
    """
    rad = rot_deg * (np.pi / 180.0)
    cx, cy, cz = torch.cos(rad[:, 0]), torch.cos(rad[:, 1]), torch.cos(rad[:, 2])
    sx, sy, sz = torch.sin(rad[:, 0]), torch.sin(rad[:, 1]), torch.sin(rad[:, 2])

    # Rx
    Rx = torch.zeros((rot_deg.shape[0], 3, 3), device=rot_deg.device, dtype=rot_deg.dtype)
    Rx[:, 0, 0] = 1
    Rx[:, 1, 1] = cx
    Rx[:, 1, 2] = -sx
    Rx[:, 2, 1] = sx
    Rx[:, 2, 2] = cx

    # Ry
    Ry = torch.zeros((rot_deg.shape[0], 3, 3), device=rot_deg.device, dtype=rot_deg.dtype)
    Ry[:, 1, 1] = 1
    Ry[:, 0, 0] = cy
    Ry[:, 0, 2] = sy
    Ry[:, 2, 0] = -sy
    Ry[:, 2, 2] = cy

    # Rz
    Rz = torch.zeros((rot_deg.shape[0], 3, 3), device=rot_deg.device, dtype=rot_deg.dtype)
    Rz[:, 2, 2] = 1
    Rz[:, 0, 0] = cz
    Rz[:, 0, 1] = -sz
    Rz[:, 1, 0] = sz
    Rz[:, 1, 1] = cz

    return Rz @ Ry @ Rx


def _rasterize_polygon_mask(poly_xy: np.ndarray, rs: int) -> np.ndarray:
    """
    Rasterize polygon into a boolean mask of shape (rs, rs) using ray casting.
    poly_xy is in raster coordinates (same scale as grid), float32 (N,2).
    """
    if poly_xy is None or poly_xy.shape[0] < 3:
        return np.zeros((rs, rs), dtype=np.uint8)
    x = poly_xy[:, 0].astype(np.float32)
    y = poly_xy[:, 1].astype(np.float32)
    # close polygon
    x2 = np.roll(x, -1)
    y2 = np.roll(y, -1)

    # grid of pixel centers
    gx = (np.arange(rs, dtype=np.float32) + 0.5)[None, :].repeat(rs, axis=0)
    gy = (np.arange(rs, dtype=np.float32) + 0.5)[:, None].repeat(rs, axis=1)

    inside = np.zeros((rs, rs), dtype=bool)
    # vectorized across edges; loop edges to keep memory bounded
    for xi, yi, xj, yj in zip(x, y, x2, y2):
        # test edge crossing
        cond = ((yi > gy) != (yj > gy))
        denom = (yj - yi)
        denom = denom if abs(float(denom)) > 1e-12 else 1e-12
        x_int = (xj - xi) * (gy - yi) / denom + xi
        inside ^= cond & (gx < x_int)
    return inside.astype(np.uint8)


def _torch_best_rotation_by_point_raster_iou(
    vertices: np.ndarray,
    mask_poly_r: np.ndarray,
    mask_bbox: Dict[str, float],
    rs: int,
    base_rot: Dict[str, float],
    deltas: List[Tuple[float, float, float]],
    projection_detail: str,
) -> Tuple[float, Dict[str, float]]:
    """
    GPU/torch scoring path:
    - rotate vertices in batches
    - project to 2D, fit uniformly to mask bbox
    - splat points to raster grid
    - apply morphological closing to approximate filled silhouette
    - compute IoU with rasterized mask polygon
    Returns (best_score, best_rot)
    """
    if torch is None:
        raise RuntimeError("torch is not installed")

    detail = _normalize_projection_detail(projection_detail)
    device = torch.device("cuda") if torch.cuda.is_available() else torch.device("cpu")

    t0 = _now_ms()
    # Rasterize target mask polygon once on CPU, then move to torch.
    target = _rasterize_polygon_mask(mask_poly_r, rs)
    t_raster_mask = _now_ms()
    target_t = torch.from_numpy(target).to(device=device, dtype=torch.float32)[None, None, :, :]
    if device.type == "cuda":
        torch.cuda.synchronize()
    t_target_to_device = _now_ms()
    target_sum = float(target.sum())
    if target_sum <= 0:
        return -1.0, dict(base_rot)

    v = torch.from_numpy(vertices.astype(np.float32)).to(device=device)  # (V,3)
    if device.type == "cuda":
        torch.cuda.synchronize()
    t_vertices_to_device = _now_ms()

    # Detail controls: point subsampling + morphology kernel size.
    # IMPORTANT: keep a hard cap on points to avoid huge GPU scatter cost.
    if detail == "fast":
        stride = 6
        k = 3
        iters = 1
        max_pts = 12000
    elif detail == "balanced":
        stride = 3
        k = 5
        iters = 1
        max_pts = 30000
    else:  # high
        stride = 1
        k = 7
        iters = 2
        max_pts = 60000

    if stride > 1 and v.shape[0] > 2000:
        v = v[::stride, :]
    if v.shape[0] > max_pts:
        # uniform subsample without RNG (stable & cheap)
        step = int(np.ceil(float(v.shape[0]) / float(max_pts)))
        v = v[:: max(1, step), :]

    # constants for bbox fitting
    bb_w = float(mask_bbox.get("w", 1.0))
    bb_h = float(mask_bbox.get("h", 1.0))
    bb_cx = float(mask_bbox.get("cx", 0.0))
    bb_cy = float(mask_bbox.get("cy", 0.0))
    eps = 1e-6

    # Pre-compute image->raster scale using mask bbox mapping (avoid recomputing inside batch loop).
    mpbb = _bbox_of_points_2d(mask_poly_r.astype(np.float32))
    if not mpbb or mpbb["w"] <= 0 or mpbb["h"] <= 0 or bb_w <= 0 or bb_h <= 0:
        return -1.0, dict(base_rot)
    sx = float(mpbb["w"]) / max(1e-6, bb_w)
    sy = float(mpbb["h"]) / max(1e-6, bb_h)

    best_score = -1.0
    best_rot = dict(base_rot)

    batch = 128 if device.type == "cuda" else 64
    deltas_arr = np.asarray(deltas, dtype=np.float32)
    base = np.array([float(base_rot["x"]), float(base_rot["y"]), float(base_rot["z"])], dtype=np.float32)

    with torch.no_grad():
        t_loop0 = _now_ms()
        for i in range(0, deltas_arr.shape[0], batch):
            d = deltas_arr[i : i + batch]
            rot = torch.from_numpy(d + base[None, :]).to(device=device)
            R = _rot_matrix_xyz_torch_deg(rot)  # (B,3,3)
            # rotate: (B,V,3)
            vr = torch.einsum("bij,vj->bvi", R, v)
            pts2 = vr[:, :, :2]  # (B,V,2)

            # Fit uniformly into target bbox (same as _fit_points_to_bbox_uniform but batched)
            min_xy = pts2.amin(dim=1)
            max_xy = pts2.amax(dim=1)
            cx = (min_xy[:, 0] + max_xy[:, 0]) * 0.5
            cy = (min_xy[:, 1] + max_xy[:, 1]) * 0.5
            w = (max_xy[:, 0] - min_xy[:, 0]).clamp_min(eps)
            h = (max_xy[:, 1] - min_xy[:, 1]).clamp_min(eps)
            s = torch.minimum(torch.tensor(bb_w, device=device) / w, torch.tensor(bb_h, device=device) / h)

            fitted_x = (pts2[:, :, 0] - cx[:, None]) * s[:, None] + bb_cx
            fitted_y = (pts2[:, :, 1] - cy[:, None]) * s[:, None] + bb_cy

            xi = torch.clamp((fitted_x * sx).round().to(torch.int64), 0, rs - 1)
            yi = torch.clamp((fitted_y * sy).round().to(torch.int64), 0, rs - 1)

            B = xi.shape[0]
            img = torch.zeros((B, 1, rs, rs), device=device, dtype=torch.float32)
            # scatter points (vectorized, memory-friendly)
            # Flatten to 1D indices: idx = b*(rs*rs) + y*rs + x
            rs2 = rs * rs
            b = torch.arange(B, device=device, dtype=torch.int64)[:, None]
            idx = (b * rs2 + yi * rs + xi).reshape(-1)
            img_flat = img.view(-1)
            img_flat[idx] = 1.0

            # Morphological closing: dilate then erode (approx filled silhouette)
            for _ in range(iters):
                img = F.max_pool2d(img, kernel_size=k, stride=1, padding=k // 2)
                img = -F.max_pool2d(-img, kernel_size=k, stride=1, padding=k // 2)

            # binarize
            pred = (img > 0.5).to(torch.float32)
            inter = (pred * target_t).sum(dim=(1, 2, 3))
            union = (pred + target_t - pred * target_t).sum(dim=(1, 2, 3)).clamp_min(1.0)
            iou = inter / union

            # apply same penalties using raster polys? penalties expect polygons; here we only have rasters.
            # keep score as IoU; penalties are minor and can be added later if needed.
            scores = iou
            m = torch.argmax(scores)
            top = float(scores[m].item())
            if top > best_score:
                best_score = top
                best_rot = {"x": float(rot[m, 0].item()), "y": float(rot[m, 1].item()), "z": float(rot[m, 2].item())}
        if device.type == "cuda":
            torch.cuda.synchronize()
        t_loop1 = _now_ms()

    # Stash debug timings on the function for caller retrieval (no global state elsewhere).
    _torch_best_rotation_by_point_raster_iou._last_diag = {  # type: ignore[attr-defined]
        "device": "cuda" if device.type == "cuda" else "cpu",
        "detail": detail,
        "rs": int(rs),
        "candidates": int(deltas_arr.shape[0]),
        "batch": int(batch),
        "timingsMs": {
            "total": float(_now_ms() - t0),
            "rasterMaskCpu": float(t_raster_mask - t0),
            "targetToDevice": float(t_target_to_device - t_raster_mask),
            "verticesToDevice": float(t_vertices_to_device - t_target_to_device),
            "batchLoop": float(t_loop1 - t_loop0),
        },
    }
    return float(best_score), best_rot


def _svg_points_from_poly(poly: np.ndarray) -> str:
    if poly is None or poly.shape[0] < 3:
        return ""
    return " ".join([f"{float(x):.2f},{float(y):.2f}" for x, y in poly])


def _raster_iou(poly_a: np.ndarray, poly_b: np.ndarray, size: int) -> float:
    if poly_a is None or poly_b is None or poly_a.shape[0] < 3 or poly_b.shape[0] < 3:
        return 0.0
    s = int(np.clip(int(size) if size is not None else 256, 32, 512))
    xs = (np.arange(s, dtype=np.float32) + 0.5)
    ys = (np.arange(s, dtype=np.float32) + 0.5)
    yy, xx = np.meshgrid(ys, xs, indexing="ij")
    x = xx.ravel()
    y = yy.ravel()
    a = _points_in_poly(x, y, poly_a)
    b = _points_in_poly(x, y, poly_b)
    uni = np.count_nonzero(a | b)
    if uni <= 0:
        return 0.0
    inter = np.count_nonzero(a & b)
    return float(inter) / float(uni)


def _poly_bbox(poly: np.ndarray) -> Optional[Dict[str, float]]:
    if poly is None or poly.shape[0] < 3:
        return None
    return _bbox_of_points_2d(poly)


def _boundary_band_width(poly: np.ndarray, band: str = "top", band_frac: float = 0.18) -> Optional[float]:
    bb = _poly_bbox(poly)
    if not bb or float(bb["h"]) <= 1e-9:
        return None
    frac = float(np.clip(float(band_frac) if np.isfinite(band_frac) else 0.18, 0.05, 0.45))
    band_h = max(1e-6, float(bb["h"]) * frac)
    if band == "top":
        y0 = float(bb["minY"])
        y1 = float(bb["minY"]) + band_h
    else:
        y0 = float(bb["maxY"]) - band_h
        y1 = float(bb["maxY"])
    y = poly[:, 1]
    m = (y >= y0) & (y <= y1)
    if np.count_nonzero(m) < 2:
        return None
    xs = poly[m, 0]
    return float(max(0.0, np.max(xs) - np.min(xs)))


def _top_bottom_ratio(poly: np.ndarray) -> Optional[float]:
    top_w = _boundary_band_width(poly, "top")
    bot_w = _boundary_band_width(poly, "bottom")
    if top_w is None or bot_w is None:
        return None
    eps = 1e-6
    return float(top_w) / max(eps, float(bot_w))


def _band_centroid_x(poly: np.ndarray, band: str = "top", band_frac: float = 0.22) -> Optional[float]:
    bb = _poly_bbox(poly)
    if not bb or float(bb["h"]) <= 1e-9:
        return None
    frac = float(np.clip(float(band_frac) if np.isfinite(band_frac) else 0.22, 0.05, 0.45))
    band_h = max(1e-6, float(bb["h"]) * frac)
    if band == "top":
        y0 = float(bb["minY"])
        y1 = float(bb["minY"]) + band_h
    else:
        y0 = float(bb["maxY"]) - band_h
        y1 = float(bb["maxY"])
    y = poly[:, 1]
    m = (y >= y0) & (y <= y1)
    if np.count_nonzero(m) < 2:
        return None
    return float(np.mean(poly[m, 0]))


def _top_minus_bottom_centroid_x(poly: np.ndarray) -> Optional[float]:
    top_x = _band_centroid_x(poly, "top")
    bot_x = _band_centroid_x(poly, "bottom")
    if top_x is None or bot_x is None:
        return None
    return float(top_x - bot_x)


def _upright_penalty_factor(mask_poly_r: np.ndarray, hull_poly_r: np.ndarray) -> float:
    mr = _top_bottom_ratio(mask_poly_r)
    hr = _top_bottom_ratio(hull_poly_r)
    if mr is None or hr is None:
        return 1.0
    if (0.90 < mr < 1.10) or (0.90 < hr < 1.10):
        return 1.0
    mask_top_narrow = mr < 1.0
    hull_top_narrow = hr < 1.0
    if mask_top_narrow != hull_top_narrow:
        return 0.82
    return 1.0


def _left_right_penalty_factor(mask_poly_r: np.ndarray, hull_poly_r: np.ndarray) -> float:
    mdx = _top_minus_bottom_centroid_x(mask_poly_r)
    hdx = _top_minus_bottom_centroid_x(hull_poly_r)
    if mdx is None or hdx is None:
        return 1.0
    if abs(mdx) < 2.0 or abs(hdx) < 2.0:
        return 1.0
    sm = 1 if mdx > 0 else -1
    sh = 1 if hdx > 0 else -1
    if sm != sh:
        return 0.85
    return 1.0


def _convex_hull_2d(points: np.ndarray) -> Optional[np.ndarray]:
    if points is None or points.shape[0] < 3:
        return None
    pts = points.astype(np.float32)
    if pts.shape[0] <= 3:
        return pts
    try:
        hull = ConvexHull(pts)
        poly = pts[hull.vertices]
        return poly.astype(np.float32)
    except Exception:
        return None


def _alpha_shape_boundary_2d(points: np.ndarray, alpha: float) -> Optional[np.ndarray]:
    """
    Concave hull (alpha shape) boundary for a 2D point set.
    Returns ordered boundary points, or None on failure.
    """
    if points is None or points.shape[0] < 4:
        return _convex_hull_2d(points)

    pts = np.asarray(points, dtype=np.float64)
    if not np.isfinite(pts).all():
        return None
    alpha = float(alpha)
    if not np.isfinite(alpha) or alpha <= 0:
        return _convex_hull_2d(points)

    try:
        tri = Delaunay(pts)
    except Exception:
        return _convex_hull_2d(points)

    simplices = tri.simplices
    if simplices is None or simplices.size == 0:
        return _convex_hull_2d(points)

    # Keep triangles whose circumradius is small enough.
    # Convention: keep if circumradius < 1/alpha.
    keep = []
    inv_alpha = 1.0 / alpha
    for a, b, c in simplices:
        pa = pts[a]
        pb = pts[b]
        pc = pts[c]
        # side lengths
        lab = float(np.linalg.norm(pa - pb))
        lbc = float(np.linalg.norm(pb - pc))
        lca = float(np.linalg.norm(pc - pa))
        s = 0.5 * (lab + lbc + lca)
        area2 = s * (s - lab) * (s - lbc) * (s - lca)
        if area2 <= 1e-18:
            continue
        area = float(np.sqrt(area2))
        # circumradius R = abc / (4A)
        R = (lab * lbc * lca) / max(1e-12, 4.0 * area)
        if R < inv_alpha:
            keep.append((int(a), int(b), int(c)))

    if not keep:
        return _convex_hull_2d(points)

    # Boundary edges are edges used by exactly one kept triangle.
    edge_count: Dict[Tuple[int, int], int] = {}
    for a, b, c in keep:
        for u, v in ((a, b), (b, c), (c, a)):
            e = (u, v) if u < v else (v, u)
            edge_count[e] = edge_count.get(e, 0) + 1

    boundary_edges = [e for e, cnt in edge_count.items() if cnt == 1]
    if len(boundary_edges) < 3:
        return _convex_hull_2d(points)

    # Build adjacency for traversal.
    adj: Dict[int, List[int]] = {}
    for u, v in boundary_edges:
        adj.setdefault(u, []).append(v)
        adj.setdefault(v, []).append(u)

    # Find a loop by walking until we return to start. If multiple components exist,
    # pick the component with the most vertices (usually the outer boundary).
    visited: set[int] = set()
    best_loop: Optional[List[int]] = None

    for start in list(adj.keys()):
        if start in visited:
            continue
        loop = [start]
        visited.add(start)
        prev = None
        cur = start
        # walk greedily
        for _ in range(len(adj) + 5):
            nbrs = adj.get(cur, [])
            if not nbrs:
                break
            # choose next not equal prev if possible
            nxt = None
            if prev is None:
                nxt = nbrs[0]
            else:
                for cand in nbrs:
                    if cand != prev:
                        nxt = cand
                        break
                if nxt is None:
                    nxt = nbrs[0]

            if nxt == start:
                loop.append(nxt)
                break
            loop.append(nxt)
            visited.add(nxt)
            prev, cur = cur, nxt

        # valid closed loop needs at least 4 points incl repeated start
        if len(loop) >= 4 and loop[-1] == start:
            if best_loop is None or len(loop) > len(best_loop):
                best_loop = loop

    if not best_loop:
        # fallback: order boundary vertices by angle around centroid
        uniq = sorted(set([u for e in boundary_edges for u in e]))
        bpts = pts[uniq]
        c = np.mean(bpts, axis=0)
        ang = np.arctan2(bpts[:, 1] - c[1], bpts[:, 0] - c[0])
        order = np.argsort(ang)
        poly = bpts[order].astype(np.float32)
        return poly

    # Drop the repeated last index.
    inds = best_loop[:-1]
    poly = pts[inds].astype(np.float32)
    return poly


def _outline_from_points_2d(points: np.ndarray, projection_detail: str) -> Optional[np.ndarray]:
    """
    Produce a 2D outline polygon from 2D point cloud.
    - fast: convex hull (very stable, but loses concavity/asymmetry cues)
    - balanced/high: alpha-shape concave hull with different tightness
    """
    if points is None or points.shape[0] < 3:
        return None

    detail = _normalize_projection_detail(projection_detail)
    if detail == "fast":
        return _convex_hull_2d(points)

    pts = np.asarray(points, dtype=np.float32)
    if pts.shape[0] < 8:
        return _convex_hull_2d(points)

    # Estimate a reasonable alpha from point spacing (kNN median distance).
    try:
        tree = cKDTree(pts.astype(np.float64))
        # k=6 gives local spacing; ignore self at k=1.
        dists, _ = tree.query(pts.astype(np.float64), k=min(6, pts.shape[0]))
        if dists.ndim == 2 and dists.shape[1] >= 2:
            nn = dists[:, 1:]
            med = float(np.median(nn[np.isfinite(nn)]))
        else:
            med = float(np.median(dists[np.isfinite(dists)]))
    except Exception:
        med = 0.0

    # Larger alpha => looser (more convex); smaller alpha => tighter (more concave).
    # We use 1/alpha as radius threshold, so alpha roughly scales with 1/spacing.
    if not np.isfinite(med) or med <= 1e-6:
        base_alpha = 1.0
    else:
        base_alpha = 1.0 / med

    if detail == "balanced":
        alpha = float(base_alpha * 0.7)
    else:  # high
        alpha = float(base_alpha * 0.45)

    poly = _alpha_shape_boundary_2d(pts, alpha=alpha)
    if poly is None or poly.shape[0] < 3:
        return _convex_hull_2d(points)
    return poly.astype(np.float32)


def _normalize_search_defaults(search: Optional[FitSearch], mode: str) -> FitSearch:
    s = search or FitSearch()
    do_xyz = mode == "xyz"
    return FitSearch(
        zMin=float(s.zMin if np.isfinite(s.zMin) else -40),
        zMax=float(s.zMax if np.isfinite(s.zMax) else 40),
        zStep=float(max(2.0, abs(s.zStep)) if np.isfinite(s.zStep) else 10),
        xMin=float(s.xMin if np.isfinite(s.xMin) else (-15 if do_xyz else 0)),
        xMax=float(s.xMax if np.isfinite(s.xMax) else (15 if do_xyz else 0)),
        xStep=float(max(5.0, abs(s.xStep)) if np.isfinite(s.xStep) else (10 if do_xyz else 10)),
        yMin=float(s.yMin if np.isfinite(s.yMin) else (-15 if do_xyz else 0)),
        yMax=float(s.yMax if np.isfinite(s.yMax) else (15 if do_xyz else 0)),
        yStep=float(max(5.0, abs(s.yStep)) if np.isfinite(s.yStep) else (10 if do_xyz else 10)),
    )


def _refine_window_around(best_deg: float, step: float) -> Tuple[float, float, float]:
    s = max(0.5, abs(float(step) if np.isfinite(step) else 1.0))
    return (-s, s, s / 2.0)


def _fit_rotation_to_mask(
    vertices: np.ndarray,
    mask_flat_points: List[float],
    image_w: float,
    image_h: float,
    initial_rot: Dict[str, float],
    search: FitSearch,
    raster_size: int,
    mode: str,
    projection_detail: str,
) -> Dict[str, Any]:
    t0 = _now_ms()
    mask_bbox = _mask_bbox_from_flat_points(mask_flat_points)
    if not mask_bbox:
        raise ValueError("mask points invalid (cannot compute bbox)")
    flat = np.asarray(mask_flat_points, dtype=np.float32)
    if flat.size % 2 != 0:
        flat = flat[:-1]
    mask_poly = flat.reshape(-1, 2)
    if mask_poly.shape[0] < 3:
        raise ValueError("mask polygon invalid")

    w = float(image_w if (image_w is not None and np.isfinite(image_w) and image_w > 0) else (mask_bbox["maxX"] + 1))
    h = float(image_h if (image_h is not None and np.isfinite(image_h) and image_h > 0) else (mask_bbox["maxY"] + 1))

    detail = _normalize_projection_detail(projection_detail)
    rs_max = 512 if detail == "high" else 256
    rs = int(np.clip(int(raster_size) if raster_size is not None else 192, 32, rs_max))
    sx = float(rs) / max(1.0, w)
    sy = float(rs) / max(1.0, h)
    mask_poly_r = (mask_poly * np.array([sx, sy], dtype=np.float32)).astype(np.float32)

    do_xyz = mode == "xyz"
    xs = _range_inclusive(search.xMin, search.xMax, search.xStep) if do_xyz else np.array([0.0], dtype=np.float32)
    ys = _range_inclusive(search.yMin, search.yMax, search.yStep) if do_xyz else np.array([0.0], dtype=np.float32)
    zs = _range_inclusive(search.zMin, search.zMax, search.zStep)

    # Hard cap on total search combinations to avoid minute-long runs on CPU.
    max_combos = 4000
    combos = int(xs.size) * int(ys.size) * int(zs.size)
    if combos > max_combos:
        scale = (combos / max_combos) ** 0.5
        # Increase steps proportionally to shrink search grid.
        if do_xyz:
            search.xStep = search.xStep * scale
            search.yStep = search.yStep * scale
            xs = _range_inclusive(search.xMin, search.xMax, search.xStep)
            ys = _range_inclusive(search.yMin, search.yMax, search.yStep)
        search.zStep = search.zStep * scale
        zs = _range_inclusive(search.zMin, search.zMax, search.zStep)

    best_score = -1.0
    best_rot = {"x": float(initial_rot.get("x", 0.0)), "y": float(initial_rot.get("y", 0.0)), "z": float(initial_rot.get("z", 0.0))}
    best_hull = None

    combos_list: List[Tuple[float, float, float]] = [(float(dx), float(dy), float(dz)) for dx in xs for dy in ys for dz in zs]
    diag: Dict[str, Any] = {
        "path": None,
        "mode": mode,
        "detail": detail,
        "rs": int(rs),
        "candidates": int(len(combos_list)),
        "timingsMs": {},
    }
    diag["timingsMs"]["prep"] = float(_now_ms() - t0)

    # Torch GPU path (when available) to accelerate scoring.
    use_torch = torch is not None and (torch.cuda.is_available() or os.environ.get("POSE_TORCH_CPU", "0") == "1")
    if use_torch and len(combos_list) > 0:
        try:
            t_torch0 = _now_ms()
            best_score, best_rot = _torch_best_rotation_by_point_raster_iou(
                vertices=vertices,
                mask_poly_r=mask_poly_r,
                mask_bbox=mask_bbox,
                rs=rs,
                base_rot=best_rot,
                deltas=combos_list,
                projection_detail=detail,
            )
            diag["path"] = "torch"
            diag["timingsMs"]["torchTotal"] = float(_now_ms() - t_torch0)
            diag["torch"] = getattr(_torch_best_rotation_by_point_raster_iou, "_last_diag", None)
            # For overlay, compute a lightweight hull on CPU for the selected best rotation.
            t_overlay0 = _now_ms()
            Rb = _rot_matrix_xyz_deg(best_rot)
            vrb = v @ Rb.T
            fitted_b = _fit_points_to_bbox_uniform(vrb[:, :2], mask_bbox)
            if fitted_b is not None:
                best_hull = _convex_hull_2d(fitted_b) or np.zeros((0, 2), dtype=np.float32)
            else:
                best_hull = np.zeros((0, 2), dtype=np.float32)
            diag["timingsMs"]["overlayHullCpu"] = float(_now_ms() - t_overlay0)
        except Exception:
            # Fall back to CPU path below
            best_score = -1.0
            best_hull = None

    # CPU fallback (parallel threads).
    if best_hull is None:
        diag["path"] = "cpu"
        t_cpu0 = _now_ms()
        v = vertices.astype(np.float32)

        def _eval_single_rotation(delta: Tuple[float, float, float]) -> Tuple[float, Dict[str, float], Optional[np.ndarray]]:
            ddx, ddy, ddz = delta
            rot = {"x": best_rot["x"] + ddx, "y": best_rot["y"] + ddy, "z": best_rot["z"] + ddz}
            R = _rot_matrix_xyz_deg(rot)
            vr = v @ R.T
            pts2 = vr[:, :2]
            fitted = _fit_points_to_bbox_uniform(pts2, mask_bbox)
            if fitted is None:
                return -1.0, rot, None
            hull = _outline_from_points_2d(fitted, detail)
            if hull is None or hull.shape[0] < 3:
                return -1.0, rot, None
            hull_r = (hull * np.array([sx, sy], dtype=np.float32)).astype(np.float32)
            iou = _raster_iou(hull_r, mask_poly_r, rs)
            score = iou * _upright_penalty_factor(mask_poly_r, hull_r) * _left_right_penalty_factor(mask_poly_r, hull_r)
            return float(score), rot, hull

        if len(combos_list) <= 16:
            for delta in combos_list:
                score, rot, hull = _eval_single_rotation(delta)
                if hull is None or score <= best_score:
                    continue
                best_score = score
                best_rot = rot
                best_hull = hull
        else:
            workers = max(2, min(8, os.cpu_count() or 4))
            with ThreadPoolExecutor(max_workers=workers) as ex:
                for score, rot, hull in ex.map(_eval_single_rotation, combos_list):
                    if hull is None or score <= best_score:
                        continue
                    best_score = score
                    best_rot = rot
                    best_hull = hull
        diag["timingsMs"]["cpuSearchTotal"] = float(_now_ms() - t_cpu0)
        diag["cpu"] = {"workers": int(workers if len(combos_list) > 16 else 1)}

    if best_hull is None:
        diag["timingsMs"]["total"] = float(_now_ms() - t0)
        return {"score": -1.0, "rotationDeg": best_rot, "hull": np.zeros((0, 2), dtype=np.float32), "diagnostics": diag}

    def eval_rotation(rot_deg: Dict[str, float]) -> Optional[Tuple[float, np.ndarray, float]]:
        R = _rot_matrix_xyz_deg(rot_deg)
        vr = v @ R.T
        pts2 = vr[:, :2]
        fitted = _fit_points_to_bbox_uniform(pts2, mask_bbox)
        if fitted is None:
            return None
        hull = _outline_from_points_2d(fitted, detail)
        if hull is None or hull.shape[0] < 3:
            return None
        hull_r = (hull * np.array([sx, sy], dtype=np.float32)).astype(np.float32)
        iou = _raster_iou(hull_r, mask_poly_r, rs)
        score = iou * _upright_penalty_factor(mask_poly_r, hull_r) * _left_right_penalty_factor(mask_poly_r, hull_r)
        return float(score), hull, float(iou)

    base = eval_rotation(best_rot)
    cands = [base]
    cands.append(eval_rotation({"x": best_rot["x"] + 180.0, "y": best_rot["y"], "z": best_rot["z"]}))
    cands.append(eval_rotation({"x": best_rot["x"], "y": best_rot["y"] + 180.0, "z": best_rot["z"]}))
    cands = [c for c in cands if c is not None]
    cands.sort(key=lambda t: t[0], reverse=True)
    top = cands[0] if cands else base
    if top is None:
        diag["timingsMs"]["total"] = float(_now_ms() - t0)
        return {"score": best_score, "rotationDeg": best_rot, "hull": best_hull, "diagnostics": diag}
    top_score, top_hull, _ = top
    if top_score >= best_score:
        # Determine which rotation produced top_hull (re-evaluate tie-break by comparing hull identity is hard; accept base/best)
        # We only apply flips that improved score; pick the corresponding rotation by checking scores again.
        # This keeps behavior close to JS implementation.
        best_score = top_score
        # Choose rot among evaluated candidates with same score
        # recompute
        best_pick = best_rot
        for r in [best_rot, {"x": best_rot["x"] + 180.0, "y": best_rot["y"], "z": best_rot["z"]}, {"x": best_rot["x"], "y": best_rot["y"] + 180.0, "z": best_rot["z"]}]:
            ev = eval_rotation(r)
            if ev and abs(ev[0] - top_score) < 1e-9:
                best_pick = r
                best_hull = ev[1]
                break
        best_rot = best_pick

    diag["timingsMs"]["total"] = float(_now_ms() - t0)
    return {"score": float(best_score), "rotationDeg": best_rot, "hull": best_hull, "diagnostics": diag}


def _fit_rotation_to_mask_coarse_to_fine(
    vertices: np.ndarray,
    mask_flat_points: List[float],
    image_w: float,
    image_h: float,
    initial_rot: Dict[str, float],
    search: FitSearch,
    raster_size: int,
    mode: str,
    projection_detail: str,
) -> Dict[str, Any]:
    init = {"x": float(initial_rot.get("x", 0.0)), "y": float(initial_rot.get("y", 0.0)), "z": float(initial_rot.get("z", 0.0))}

    def add_rot(a: Dict[str, float], b: Dict[str, float]) -> Dict[str, float]:
        return {"x": float(a.get("x", 0.0)) + float(b.get("x", 0.0)), "y": float(a.get("y", 0.0)) + float(b.get("y", 0.0)), "z": float(a.get("z", 0.0)) + float(b.get("z", 0.0))}

    seeds = [init, add_rot(init, {"x": 180, "y": 0, "z": 0}), add_rot(init, {"x": 0, "y": 180, "z": 0})]
    detail = _normalize_projection_detail(projection_detail)
    rs_max = 512 if detail == "high" else 256
    rs_full = int(np.clip(int(raster_size) if raster_size is not None else 192, 32, rs_max))
    rs_coarse = int(np.clip(int(round(rs_full * 0.5)), 48, rs_full))

    best_all = None
    for seed in seeds:
        best1 = _fit_rotation_to_mask(vertices, mask_flat_points, image_w, image_h, seed, search, rs_coarse, mode, detail)
        if not best1 or "rotationDeg" not in best1:
            continue
        s = _normalize_search_defaults(search, mode)
        wz = _refine_window_around(float(best1["rotationDeg"].get("z", 0.0)), s.zStep)
        wx = _refine_window_around(float(best1["rotationDeg"].get("x", 0.0)), s.xStep)
        wy = _refine_window_around(float(best1["rotationDeg"].get("y", 0.0)), s.yStep)
        refine = FitSearch(
            zMin=float(best1["rotationDeg"].get("z", 0.0) + wz[0]),
            zMax=float(best1["rotationDeg"].get("z", 0.0) + wz[1]),
            zStep=float(wz[2]),
            xMin=float(best1["rotationDeg"].get("x", 0.0) + wx[0]),
            xMax=float(best1["rotationDeg"].get("x", 0.0) + wx[1]),
            xStep=float(wx[2]),
            yMin=float(best1["rotationDeg"].get("y", 0.0) + wy[0]),
            yMax=float(best1["rotationDeg"].get("y", 0.0) + wy[1]),
            yStep=float(wy[2]),
        )
        best2 = _fit_rotation_to_mask(vertices, mask_flat_points, image_w, image_h, {"x": 0, "y": 0, "z": 0}, refine, rs_full, mode, detail)
        pick = best2 if (best2 and best2.get("score", -1) >= best1.get("score", -1)) else best1
        if best_all is None or pick.get("score", -1) > best_all.get("score", -1):
            best_all = pick
    return best_all or {"score": -1.0, "rotationDeg": init, "hull": np.zeros((0, 2), dtype=np.float32)}


def _load_intrinsics(path: str) -> Tuple[float, float, float, float]:
    with open(path, "r", encoding="utf-8") as f:
        js = json.load(f)
    fx = float(js["fx"])
    fy = float(js["fy"])
    cx = float(js.get("ppx", js.get("cx")))
    cy = float(js.get("ppy", js.get("cy")))
    if not all(np.isfinite([fx, fy, cx, cy])) or fx <= 0 or fy <= 0:
        raise ValueError("Invalid intrinsics fx/fy/ppx/ppy")
    return fx, fy, cx, cy


def _points_in_poly(x: np.ndarray, y: np.ndarray, poly_xy: np.ndarray) -> np.ndarray:
    """
    Vectorized ray casting test for points in polygon.
    x,y: shape (M,)
    poly_xy: shape (N,2), closed or open.
    Returns: inside mask shape (M,)
    """
    poly = np.asarray(poly_xy, dtype=np.float32)
    if poly.shape[0] < 3:
        return np.zeros((x.shape[0],), dtype=bool)
    # ensure open polygon (no duplicate last point needed)
    xi = poly[:, 0]
    yi = poly[:, 1]
    xj = np.roll(xi, -1)
    yj = np.roll(yi, -1)

    # Broadcast edges (N,1) against points (1,M)
    xi2 = xi[:, None]
    yi2 = yi[:, None]
    xj2 = xj[:, None]
    yj2 = yj[:, None]
    px = x[None, :]
    py = y[None, :]

    # edge intersects ray to +inf x?
    cond = (yi2 > py) != (yj2 > py)
    xints = (xj2 - xi2) * (py - yi2) / (yj2 - yi2 + 1e-12) + xi2
    hit = cond & (px < xints)
    inside = np.logical_xor.reduce(hit, axis=0)
    return inside


def _backproject_unity(depth_mm: np.ndarray, poly_xy: np.ndarray, fx: float, fy: float, cx: float, cy: float, stride: int) -> np.ndarray:
    h, w = depth_mm.shape[:2]
    stride = max(1, int(stride))
    ys = np.arange(0, h, stride, dtype=np.int32)
    xs = np.arange(0, w, stride, dtype=np.int32)
    yy, xx = np.meshgrid(ys, xs, indexing="ij")

    u_all = xx.ravel().astype(np.float32)
    v_all = yy.ravel().astype(np.float32)
    m = _points_in_poly(u_all, v_all, poly_xy).reshape(xx.shape)
    z = depth_mm[yy, xx].astype(np.float32)
    valid = m & np.isfinite(z) & (z > 1)  # mm
    if not np.any(valid):
        return np.zeros((0, 3), dtype=np.float32)

    u = xx[valid].astype(np.float32)
    v = yy[valid].astype(np.float32)
    Z = z[valid]
    X = (u - cx) * Z / fx
    Ycv = (v - cy) * Z / fy
    # Unity axes: X right, Y up, Z forward
    Y = -Ycv
    pts = np.stack([X, Y, Z], axis=1)
    return pts


def _voxel_downsample(points: np.ndarray, voxel_mm: float, max_points: int) -> np.ndarray:
    if points.shape[0] == 0:
        return points
    v = float(voxel_mm)
    if not np.isfinite(v) or v <= 0:
        v = 0.0
    if v > 0:
        keys = np.floor(points / v).astype(np.int32)
        _, idx = np.unique(keys, axis=0, return_index=True)
        points = points[idx]
    if points.shape[0] > int(max_points):
        # random subsample (deterministic-ish)
        rng = np.random.default_rng(0)
        idx = rng.choice(points.shape[0], size=int(max_points), replace=False)
        points = points[idx]
    return points.astype(np.float32)


def _parse_obj_vertices(obj_path: str) -> np.ndarray:
    verts: List[List[float]] = []
    with open(obj_path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            if not line or not line.startswith("v"):
                continue
            if not line.startswith("v "):
                continue
            parts = line.strip().split()
            if len(parts) < 4:
                continue
            try:
                x = float(parts[1])
                y = float(parts[2])
                z = float(parts[3])
            except Exception:
                continue
            if np.isfinite([x, y, z]).all():
                verts.append([x, y, z])
    if not verts:
        return np.zeros((0, 3), dtype=np.float32)
    return np.asarray(verts, dtype=np.float32)


def _rot_matrix_xyz_deg(rot: Dict[str, float]) -> np.ndarray:
    # Unity axes, using intrinsic XYZ euler in degrees (matches existing server/poseFit rotateXYZ)
    rx = np.deg2rad(float(rot.get("x", 0.0)))
    ry = np.deg2rad(float(rot.get("y", 0.0)))
    rz = np.deg2rad(float(rot.get("z", 0.0)))

    cx, sx = np.cos(rx), np.sin(rx)
    cy, sy = np.cos(ry), np.sin(ry)
    cz, sz = np.cos(rz), np.sin(rz)

    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]], dtype=np.float32)
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], dtype=np.float32)
    Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]], dtype=np.float32)
    # Same order as rotateXYZ: apply Rx then Ry then Rz => R = Rz*Ry*Rx when multiplying column vectors
    return (Rz @ Ry @ Rx).astype(np.float32)


def solve_scale_translation_fixed_R(P: np.ndarray, Q: np.ndarray, R: np.ndarray, opts: SolveOptions) -> Tuple[float, np.ndarray, Dict[str, Any]]:
    if P.shape[0] < 10 or Q.shape[0] < 50:
        raise ValueError("Too few points for solve")

    tree = cKDTree(Q)
    s = 1.0
    # init t using centroids
    p_mean = P.mean(axis=0)
    q_mean = Q.mean(axis=0)
    t = q_mean - s * (R @ p_mean)

    trim = float(opts.trim_ratio)
    trim = min(0.95, max(0.5, trim))
    iters = max(1, int(opts.iters))

    diag: Dict[str, Any] = {}

    for k in range(iters):
        P_trans = (s * (P @ R.T)) + t  # row vectors; equivalent to s*R*P + t
        dists, idx = tree.query(P_trans, k=1, workers=-1)
        dists = dists.astype(np.float32)
        idx = idx.astype(np.int32)

        # trimming
        n_keep = max(20, int(len(dists) * trim))
        keep_idx = np.argpartition(dists, n_keep - 1)[:n_keep]
        Pk = P[keep_idx]
        Qk = Q[idx[keep_idx]]

        # closed-form update for s,t with fixed R
        pbar = Pk.mean(axis=0)
        qbar = Qk.mean(axis=0)
        P0 = Pk - pbar
        Q0 = Qk - qbar
        RP0 = P0 @ R.T  # row vectors rotated

        denom = float(np.sum(P0 * P0)) + 1e-9
        numer = float(np.sum(RP0 * Q0))
        s_new = numer / denom
        s_new = float(np.clip(s_new, float(opts.scale_min), float(opts.scale_max)))
        t_new = qbar - s_new * (R @ pbar)

        s = s_new
        t = t_new

        if k == iters - 1:
            rmse = float(np.sqrt(np.mean(dists[keep_idx] ** 2)))
            diag = {
                "iters": iters,
                "trim_ratio": trim,
                "inliers": int(n_keep),
                "model_points": int(P.shape[0]),
                "obs_points": int(Q.shape[0]),
                "rmseMm": rmse,
            }

    return s, t.astype(np.float32), diag


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/pose/solve")
def pose_solve(req: SolveRequest):
    # Legacy pose backend has been retired; this endpoint is kept only as a stub
    # so that the API shape stays stable while we migrate to diffdope.
    raise HTTPException(
        status_code=501,
        detail="pose/solve disabled: legacy backend removed, waiting for diffdope integration",
    )


@app.post("/pose/fit-rotation")
def pose_fit_rotation(req: FitRotationRequest):
    # Legacy pose backend has been retired; this endpoint is kept only as a stub
    # so that the API shape stays stable while we migrate to diffdope.
    raise HTTPException(
        status_code=501,
        detail="pose/fit-rotation disabled: legacy backend removed, waiting for diffdope integration",
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("POSE_SOLVER_PORT", "7900")))

