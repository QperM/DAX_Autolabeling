"""
DepthRepair API Service

将 RGB + 稀疏/噪声深度输入修复为更完整的深度输出。
当前实现基于 `depthrepair-service/lingbot-depth`（MDMModel），提供“路径模式”的推理接口。

说明：
- 模型权重不在此服务内下载；优先使用环境变量 DEPTHREPAIR_MODEL_PATH 指向本地 model.pt。
- 若未设置该变量，会尝试 fallback 到当前服务目录下 `lingbot-depth/model.pt`。
"""

from __future__ import annotations

import os
import json
import sys
import time
import warnings
import contextlib
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import cv2
import numpy as np
import torch
import traceback
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# Prefer local vendored lingbot-depth source under this service directory.
_HERE = Path(__file__).resolve().parent
_LOCAL_LINGBOT = _HERE / "lingbot-depth"
if _LOCAL_LINGBOT.exists() and str(_LOCAL_LINGBOT) not in sys.path:
    sys.path.insert(0, str(_LOCAL_LINGBOT))

_DEBUG_SETTINGS_PATH = _HERE.parent / "data" / "debug_settings.json"


def _is_depthrepair_kind_enabled(kind: str) -> bool:
    """
    Import-time noise gating.
    This service prints some xformers/triton import diagnostics to stdout/stderr.
    We suppress them unless admin explicitly enables the matching debug kind.
    """
    try:
        if not _DEBUG_SETTINGS_PATH.exists():
            return False
        raw = json.loads(_DEBUG_SETTINGS_PATH.read_text(encoding="utf-8"))
        services = raw.get("services", {}) if isinstance(raw, dict) else {}
        enabled = services.get("depthRepair", []) if isinstance(services, dict) else []
        return isinstance(enabled, list) and kind in enabled
    except Exception:
        return False


_DEPTHREPAIR_VERBOSE_IMPORT = _is_depthrepair_kind_enabled("depthRepairXformersTritonWarnings")

# FastAPI deprecation noise (printed during module import)
if not _DEPTHREPAIR_VERBOSE_IMPORT:
    warnings.filterwarnings(
        "ignore",
        category=DeprecationWarning,
        message=".*on_event is deprecated, use lifespan event handlers instead.*",
    )


# Import lingbot-depth package (from local source or installed env)
try:
    if _DEPTHREPAIR_VERBOSE_IMPORT:
        from mdm.model.v2 import MDMModel  # type: ignore
    else:
        with contextlib.ExitStack() as stack:
            devnull = open(os.devnull, "w", encoding="utf-8")
            stack.callback(devnull.close)
            stack.enter_context(contextlib.redirect_stdout(devnull))
            stack.enter_context(contextlib.redirect_stderr(devnull))
            with warnings.catch_warnings():
                warnings.filterwarnings("ignore", category=DeprecationWarning)
                from mdm.model.v2 import MDMModel  # type: ignore
except Exception as e:  # pragma: no cover
    MDMModel = None
    _IMPORT_ERR = e
else:
    _IMPORT_ERR = None


app = FastAPI(title="depthrepair-service", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class RepairDepthRequest(BaseModel):
    rgbPath: str = Field(..., description="RGB 图片路径（png/jpg）")
    depthPath: str = Field(..., description="输入深度路径（.npy float32 meters 或 16-bit PNG 毫米）")
    intrinsicsPath: str = Field(..., description="相机内参路径（txt 3x3 或 json {fx,fy,cx,cy,depth_scale?}）")

    outputDepthNpyPath: str = Field(..., description="输出修复深度 npy 路径（float32 meters）")
    outputDepthPngPath: Optional[str] = Field(None, description="输出修复深度可视化 png 路径（8-bit colormap）")

    imageId: Optional[int] = Field(None, description="上游传入：与 UI 的 imageId 对应（用于 debug 关联）")
    imageOriginalName: Optional[str] = Field(None, description="上游传入：与 UI 显示的图片原名对应（用于 debug 关联）")

    device: str = Field("auto", description="auto/cuda/cpu")
    noMask: bool = Field(False, description="true 时不对无效区域做 mask")

    # depth png 输入单位缩放：默认 1000 表示 16-bit mm -> meters
    depthPngScale: float = Field(1000.0, description="当 depthPath 是 PNG 时用于换算 meters（默认 1000）")


_device: str = "cpu"
_model: Optional[Any] = None
_model_loaded: bool = False


_ROOT = Path(__file__).resolve().parent
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
    enabled = services.get("depthRepair", []) if isinstance(services, dict) else []
    if not isinstance(enabled, list):
        return False
    return kind in enabled


def _log(kind: str, *args, **kwargs) -> None:
    if _should_log(kind):
        print(*args, **kwargs)


def _pick_device(req_device: str) -> str:
    d = (req_device or "auto").strip().lower()
    if d == "cuda":
        return "cuda:0" if torch.cuda.is_available() else "cpu"
    if d == "cpu":
        return "cpu"
    # auto
    return "cuda:0" if torch.cuda.is_available() else "cpu"


def _default_model_path() -> Optional[str]:
    # 1) explicit env
    p = os.environ.get("DEPTHREPAIR_MODEL_PATH", "").strip()
    if p and Path(p).exists():
        return p
    # 2) fallback to local vendored model under this service
    local_fallback = (_HERE / "lingbot-depth" / "model.pt").resolve()
    if local_fallback.exists():
        return str(local_fallback)
    return None


def _load_model() -> None:
    global _model, _model_loaded
    if _model_loaded and _model is not None:
        return
    if MDMModel is None:
        raise RuntimeError(f"无法导入 mdm/lingbot-depth 依赖: {_IMPORT_ERR}")
    ckpt = _default_model_path()
    if not ckpt:
        raise RuntimeError(
            "未配置 DEPTHREPAIR_MODEL_PATH 且未找到仓库内 fallback model.pt。"
            "请设置 DEPTHREPAIR_MODEL_PATH 指向权重文件。"
        )
    t0 = time.time()
    _model = MDMModel.from_pretrained(ckpt)
    _model_loaded = True
    dt = time.time() - t0
    _log("startup", f"[depthrepair] model loaded: {ckpt} ({dt:.2f}s)")


def _read_rgb(rgb_path: str) -> Tuple[np.ndarray, torch.Tensor]:
    p = Path(rgb_path)
    if not p.exists():
        raise FileNotFoundError(f"RGB not found: {rgb_path}")
    bgr = cv2.imread(str(p), cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError(f"Failed to read RGB: {rgb_path}")
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    t = torch.tensor(rgb / 255.0, dtype=torch.float32).permute(2, 0, 1).unsqueeze(0)
    return rgb, t


def _read_depth(depth_path: str, png_scale: float) -> torch.Tensor:
    p = Path(depth_path)
    if not p.exists():
        raise FileNotFoundError(f"Depth not found: {depth_path}")
    ext = p.suffix.lower()
    if ext == ".npy":
        arr = np.load(str(p)).astype(np.float32)
        if arr.ndim == 3 and arr.shape[0] == 1:
            arr = arr[0]
        if arr.ndim != 2:
            raise ValueError(f"depth npy shape invalid: {arr.shape}")
        arr = np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0)
        return torch.tensor(arr, dtype=torch.float32).unsqueeze(0)
    # assume png
    d = cv2.imread(str(p), cv2.IMREAD_UNCHANGED)
    if d is None:
        raise ValueError(f"Failed to read depth png: {depth_path}")
    d = d.astype(np.float32) / float(png_scale or 1000.0)
    d = np.nan_to_num(d, nan=0.0, posinf=0.0, neginf=0.0)
    return torch.tensor(d, dtype=torch.float32).unsqueeze(0)


def _read_intrinsics(intr_path: str, width: int, height: int) -> torch.Tensor:
    p = Path(intr_path)
    if not p.exists():
        raise FileNotFoundError(f"Intrinsics not found: {intr_path}")
    if p.suffix.lower() == ".json":
        import json

        raw = json.loads(p.read_text(encoding="utf-8"))
        fx = float(raw.get("fx", 0) or 0)
        fy = float(raw.get("fy", 0) or 0)
        cx = float(raw.get("cx", width / 2) or (width / 2))
        cy = float(raw.get("cy", height / 2) or (height / 2))
        K = np.array([[fx, 0.0, cx], [0.0, fy, cy], [0.0, 0.0, 1.0]], dtype=np.float32)
    else:
        K = np.loadtxt(str(p), dtype=np.float32)
        if K.shape != (3, 3):
            raise ValueError(f"intrinsics txt must be 3x3, got {K.shape}")

    # normalize by w/h as in official example
    Kn = K.copy()
    Kn[0, 0] /= float(width)
    Kn[0, 2] /= float(width)
    Kn[1, 1] /= float(height)
    Kn[1, 2] /= float(height)
    return torch.tensor(Kn, dtype=torch.float32).unsqueeze(0)


def _save_depth_vis(depth_m: np.ndarray) -> np.ndarray:
    # simple visualization: map valid depth to turbo colormap
    d = depth_m.astype(np.float32)
    valid = np.isfinite(d) & (d > 0)
    if not np.any(valid):
        out = np.zeros((d.shape[0], d.shape[1], 3), dtype=np.uint8)
        return out
    lo = float(np.percentile(d[valid], 2))
    hi = float(np.percentile(d[valid], 98))
    if not np.isfinite(lo) or not np.isfinite(hi) or hi <= lo:
        lo, hi = 0.0, float(np.max(d[valid]))
        if hi <= 0:
            hi = 1.0
    n = np.clip((d - lo) / (hi - lo + 1e-6), 0, 1)
    gray = (n * 255.0).astype(np.uint8)
    color = cv2.applyColorMap(gray, cv2.COLORMAP_TURBO)
    color[~valid] = 0
    return color


@app.on_event("startup")
async def startup_event() -> None:
    global _device
    _log("startup", "[depthrepair] ========================================")
    _log("startup", "[depthrepair] service starting...")
    _device = _pick_device(os.environ.get("DEPTHREPAIR_DEVICE", "auto"))
    _log("startup", f"[depthrepair] device={_device} (torch.cuda.is_available={torch.cuda.is_available()})")
    _log("startup", "[depthrepair] listening on port 7870")
    _log("startup", "[depthrepair] ========================================")


@app.get("/")
async def root() -> Dict[str, Any]:
    return {
        "service": "depthrepair-service",
        "status": "running",
        "endpoints": {"health": "/health", "repair": "/api/repair-depth"},
    }


@app.get("/health")
async def health() -> Dict[str, Any]:
    gpu = False
    try:
        gpu = bool(torch.cuda.is_available())
    except Exception:
        gpu = False
    return {
        "status": "ok",
        "gpu_available": gpu,
        "model_import_ok": MDMModel is not None,
        "model_loaded": bool(_model_loaded and _model is not None),
        "model_import_error": (str(_IMPORT_ERR) if _IMPORT_ERR else None),
    }


@app.post("/api/repair-depth")
async def repair_depth(req: RepairDepthRequest) -> Dict[str, Any]:
    try:
        _load_model()

        device = _pick_device(req.device)
        assert _model is not None
        model = _model.to(device)
        model.eval()
        # NOTE:
        # Do NOT force PyTorch native SDPA here.
        # LingBot-Depth may pass xformers BlockDiagonalMask into attention;
        # forcing native SDPA can raise:
        #   TypeError: scaled_dot_product_attention attn_mask must be Tensor, not BlockDiagonalMask

        rgb_np, rgb_t = _read_rgb(req.rgbPath)
        h, w = rgb_np.shape[:2]
        depth_t = _read_depth(req.depthPath, req.depthPngScale).to(device)
        rgb_t = rgb_t.to(device)
        intr_t = _read_intrinsics(req.intrinsicsPath, w, h).to(device)

        t0 = time.time()
        with torch.inference_mode():
            out = model.infer(
                rgb_t,
                depth_in=depth_t,
                apply_mask=not bool(req.noMask),
                intrinsics=intr_t,
            )
        dt = time.time() - t0

        depth_reg = out.get("depth", None)
        if depth_reg is None:
            depth_reg = out.get("depth_reg", None)
        if depth_reg is None:
            raise RuntimeError("model output missing depth/depth_reg")

        depth_m = depth_reg.squeeze().detach().float().cpu().numpy().astype(np.float32)
        depth_m = np.nan_to_num(depth_m, nan=0.0, posinf=0.0, neginf=0.0)

        out_npy = Path(req.outputDepthNpyPath)
        out_npy.parent.mkdir(parents=True, exist_ok=True)
        np.save(str(out_npy), depth_m)

        out_png_path = None
        if req.outputDepthPngPath:
            out_png = Path(req.outputDepthPngPath)
            out_png.parent.mkdir(parents=True, exist_ok=True)
            vis = _save_depth_vis(depth_m)
            cv2.imwrite(str(out_png), vis)
            out_png_path = str(out_png)

        _log(
            "depthRepairRepairDepthResult",
            "[depthrepair] ✅ /api/repair-depth 处理成功",
            {
                "imageId": req.imageId,
                "imageOriginalName": req.imageOriginalName,
                "rgbPath": req.rgbPath,
                "outputDepthNpyPath": req.outputDepthNpyPath,
                "outputDepthPngPath": req.outputDepthPngPath,
                "timingSec": float(dt),
                "stats": {
                    "h": int(h),
                    "w": int(w),
                    "validDepthCount": int(np.isfinite(depth_m).sum()),
                    "positiveDepthCount": int((depth_m > 0).sum()),
                },
            },
        )

        return {
            "success": True,
            "device": device,
            "timingSec": float(dt),
            "outputDepthNpyPath": str(out_npy),
            "outputDepthPngPath": out_png_path,
            "stats": {
                "h": int(h),
                "w": int(w),
                "validDepthCount": int(np.isfinite(depth_m).sum()),
                "positiveDepthCount": int((depth_m > 0).sum()),
                "depthMin": float(depth_m[depth_m > 0].min()) if np.any(depth_m > 0) else 0.0,
                "depthMax": float(depth_m.max()) if depth_m.size else 0.0,
            },
        }
    except FileNotFoundError as e:
        _log(
            "depthRepairRepairDepthResult",
            "[depthrepair] ❌ /api/repair-depth 输入文件缺失",
            {"error": str(e), "rgbPath": req.rgbPath, "imageId": req.imageId, "imageOriginalName": req.imageOriginalName},
        )
        traceback.print_exc()
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        _log(
            "depthRepairRepairDepthResult",
            "[depthrepair] ❌ /api/repair-depth 处理失败",
            {"error": f"{type(e).__name__}: {e}", "rgbPath": req.rgbPath, "imageId": req.imageId, "imageOriginalName": req.imageOriginalName},
        )
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    import uvicorn
    import logging

    # Uvicorn access log 是独立的 logging 产物，不走本文件的 _log()。
    # 这里给 `uvicorn.access` 增加动态过滤器：每条访问日志输出前都读取 debug_settings.json。
    class DepthRepairAccessLogFilter(logging.Filter):
        def filter(self, record: logging.LogRecord) -> bool:
            return _should_log("depthRepairAccessLog")

    logging.getLogger("uvicorn.access").addFilter(DepthRepairAccessLogFilter())

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=int(os.environ.get("DEPTHREPAIR_PORT", "7870")),
        # 访问日志是否打印由上面的 Filter 实时控制
        log_level="warning",
        access_log=True,
    )

