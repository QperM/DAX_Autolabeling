"""
SAM2 API Service
提供仅基于 SAM2 Automatic Mask Generator 的自动图像标注服务
"""

from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn
from PIL import Image
import io
import numpy as np
import os
import json
import time
import logging
import warnings
from pathlib import Path
from typing import List, Optional
from skimage import measure

try:
    import torch
except ImportError:
    torch = None

    build_sam2 = None
    SAM2AutomaticMaskGenerator = None

# ---- Early startup logger fallback ----
# 这个文件在“尝试导入 sam2 模块”阶段就会调用 _log。
# 原始实现中 _log 的完整定义出现在更靠后的位置，会导致 NameError。
def _log(kind: str, *args, **kwargs) -> None:
    try:
        print(*args, **kwargs)
    except Exception:
        pass

for module_name, attr_name in [
    ("sam2.build_sam", "build_sam2"),
    ("sam2.automatic_mask_generator", "SAM2AutomaticMaskGenerator"),
]:
    # NOTE: 这里早期导入阶段就会用到 _log。
    #       原始代码中 _log 的完整实现定义在更后面，导致启动时 NameError。
    #       给一个兜底实现，后续文件继续会用更完整版本覆盖该函数。
    try:
        module = __import__(module_name, fromlist=[attr_name])
        attr = getattr(module, attr_name)
        if attr_name == "build_sam2":
            build_sam2 = attr
        else:
            SAM2AutomaticMaskGenerator = attr
        _log("startup", f"[SAM2服务] ✅ 成功导入 {module_name}.{attr_name}")
    except ImportError as e:
        _log("startup", f"[SAM2服务] ⚠️  无法导入 {module_name}.{attr_name}: {e}")
    except Exception as e:
        _log("startup", f"[SAM2服务] ⚠️  导入 {module_name}.{attr_name} 时出错: {type(e).__name__}: {e}")

if build_sam2 is None or SAM2AutomaticMaskGenerator is None:
    _log("startup", "[SAM2服务] ⚠️  SAM2 标准导入路径失败，尝试其他路径...")
    try:
        import sam2

        _log("startup", f"[SAM2服务] ✅ 成功导入 sam2 模块，位置: {sam2.__file__}")
        if hasattr(sam2, "build_sam") and hasattr(sam2.build_sam, "build_sam2"):
            build_sam2 = sam2.build_sam.build_sam2
            _log("startup", "[SAM2服务] ✅ 找到 build_sam2")
        if hasattr(sam2, "automatic_mask_generator") and hasattr(
            sam2.automatic_mask_generator, "SAM2AutomaticMaskGenerator"
        ):
            SAM2AutomaticMaskGenerator = sam2.automatic_mask_generator.SAM2AutomaticMaskGenerator
            _log("startup", "[SAM2服务] ✅ 找到 SAM2AutomaticMaskGenerator")
    except ImportError as e:
        _log("startup", f"[SAM2服务] ❌ 无法导入 sam2 模块: {e}")
        _log("startup", "[SAM2服务] 提示: 请确保在 conda 环境 sam2 中安装了 SAM2")
        _log("startup", "[SAM2服务] 安装方法:")
        _log("startup", "[SAM2服务]   1. conda activate sam2")
        _log("startup", "[SAM2服务]   2. pip install git+https://github.com/facebookresearch/segment-anything-2.git")
    except Exception as e:
        _log("startup", f"[SAM2服务] ❌ 检查 sam2 模块时出错: {type(e).__name__}: {e}")

if build_sam2 is not None and SAM2AutomaticMaskGenerator is not None:
    _log("startup", "[SAM2服务] ✅ SAM2 模块导入成功，可以使用 sam2_amg")
else:
    _log("startup", "[SAM2服务] ⚠️  SAM2 模块未完全导入，服务将不可用")

app = FastAPI(
    title="SAM2 API Service",
    description="提供仅基于 SAM2 AMG 的自动图像标注服务",
    version="1.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

device = "cpu"
sam2_model = None
sam2_loaded = False


_ROOT = Path(__file__).resolve().parent
_DEBUG_SETTINGS_PATH = _ROOT.parent / "data" / "debug_settings.json"
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
    enabled = services.get("sam2", []) if isinstance(services, dict) else []
    if not isinstance(enabled, list):
        return False
    return kind in enabled


def _log(kind: str, *args, **kwargs) -> None:
    if _should_log(kind):
        print(*args, **kwargs)


class Sam2AccessLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            return _should_log("sam2AccessLog")
        except Exception:
            return False


_ORIGINAL_SHOWWARNING = warnings.showwarning


def _warning_is_sam2_attention_related(message: object) -> bool:
    try:
        s = str(message)
    except Exception:
        return False
    if "scaled_dot_product_attention" in s:
        return True
    if "Flash attention" in s or "flash attention" in s:
        return True
    if "Memory Efficient attention" in s or "Memory efficient kernel" in s:
        return True
    if "CuDNN attention" in s or "cudnn attention" in s:
        return True
    if "Expected query, key and value" in s and "dtype" in s:
        return True
    return False


def _sam2_showwarning(message, category, filename, lineno, file=None, line=None):
    try:
        if _warning_is_sam2_attention_related(message):
            if not _should_log("sam2TorchAttentionWarnings"):
                return
    except Exception:
        pass
    return _ORIGINAL_SHOWWARNING(message, category, filename, lineno, file=file, line=line)


warnings.showwarning = _sam2_showwarning


def _bbox_iou_xyxy(a: List[float], b: List[float]) -> float:
    try:
        ax1, ay1, ax2, ay2 = [float(x) for x in a]
        bx1, by1, bx2, by2 = [float(x) for x in b]
    except Exception:
        return 0.0
    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)
    iw = max(0.0, ix2 - ix1)
    ih = max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0.0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    if union <= 0.0:
        return 0.0
    return float(inter / union)


def _bbox_gap_xyxy(a: List[float], b: List[float]) -> float:
    try:
        ax1, ay1, ax2, ay2 = [float(x) for x in a]
        bx1, by1, bx2, by2 = [float(x) for x in b]
    except Exception:
        return 1e9
    dx = max(ax1 - bx2, bx1 - ax2, 0.0)
    dy = max(ay1 - by2, by1 - ay2, 0.0)
    return float(max(dx, dy))


def _merge_candidates_by_gap(candidates: List[dict], merge_gap_px: float) -> List[dict]:
    if not candidates:
        return []
    if merge_gap_px <= 0:
        return candidates

    n = len(candidates)
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for i in range(n):
        bi = candidates[i].get("bbox_xyxy", None)
        if not isinstance(bi, list) or len(bi) != 4:
            continue
        for j in range(i + 1, n):
            bj = candidates[j].get("bbox_xyxy", None)
            if not isinstance(bj, list) or len(bj) != 4:
                continue
            if _bbox_gap_xyxy(bi, bj) <= float(merge_gap_px):
                union(i, j)

    groups: dict = {}
    for idx in range(n):
        root = find(idx)
        groups.setdefault(root, []).append(idx)

    merged: List[dict] = []
    for indices in groups.values():
        if len(indices) == 1:
            merged.append(candidates[indices[0]])
            continue

        binaries = []
        bboxes = []
        max_score = 0.0
        for k in indices:
            it = candidates[k]
            b = it.get("binary_proc", None)
            bb = it.get("bbox_xyxy", None)
            if isinstance(b, np.ndarray):
                binaries.append(b.astype(bool))
            if isinstance(bb, list) and len(bb) == 4:
                bboxes.append(bb)
            try:
                max_score = max(max_score, float(it.get("score", 0.0) or 0.0))
            except Exception:
                pass

        if not binaries or not bboxes:
            merged.append(candidates[indices[0]])
            continue

        merged_binary = np.logical_or.reduce(binaries)
        x1 = min(float(bb[0]) for bb in bboxes)
        y1 = min(float(bb[1]) for bb in bboxes)
        x2 = max(float(bb[2]) for bb in bboxes)
        y2 = max(float(bb[3]) for bb in bboxes)

        merged.append(
            {
                "binary_proc": merged_binary.astype(float),
                "bbox_xyxy": [x1, y1, x2, y2],
                "score": max_score,
                "area": max(0.0, (x2 - x1) * (y2 - y1)),
            }
        )
    return merged


def _dedupe_candidates_by_bbox_iou(candidates: List[dict], iou_thresh: float = 0.92) -> List[dict]:
    """
    对 SAM2 候选做二次去重：
    - 按 score 降序优先保留高置信；
    - 若与已保留候选 bbox IoU 极高（默认 >=0.92），判定为重复，丢弃。
    """
    if not candidates:
        return []
    ordered = sorted(
        candidates,
        key=lambda x: (float(x.get("score", 0.0) or 0.0), float(x.get("area", 0.0) or 0.0)),
        reverse=True,
    )
    kept: List[dict] = []
    for cand in ordered:
        bbox = cand.get("bbox_xyxy", None)
        if not isinstance(bbox, list) or len(bbox) != 4:
            kept.append(cand)
            continue
        duplicated = False
        for prev in kept:
            pb = prev.get("bbox_xyxy", None)
            if not isinstance(pb, list) or len(pb) != 4:
                continue
            if _bbox_iou_xyxy(bbox, pb) >= iou_thresh:
                duplicated = True
                break
        if not duplicated:
            kept.append(cand)
    return kept


def load_sam2_model():
    """惰性加载 SAM2 主模型。"""
    global sam2_model, sam2_loaded
    if sam2_loaded and sam2_model is not None:
        return

    if build_sam2 is None or SAM2AutomaticMaskGenerator is None:
        raise RuntimeError(
            "SAM2 依赖未安装（找不到 sam2.build_sam / sam2.automatic_mask_generator）。"
        )

    ckpt = os.environ.get("SAM2_CHECKPOINT", "").strip()
    if not ckpt or not os.path.exists(ckpt):
        base_dir = os.path.dirname(os.path.abspath(__file__))
        fallback_ckpt = os.path.join(base_dir, "grounded-sam2", "checkpoints", "sam2_hiera_large.pt")
        if os.path.exists(fallback_ckpt):
            ckpt = fallback_ckpt
            os.environ["SAM2_CHECKPOINT"] = ckpt
            _log("startup", f"[SAM2服务] ⚠️ 未正确配置 SAM2_CHECKPOINT，已自动使用本地 checkpoint: {ckpt}")
        else:
            raise RuntimeError(
                "未配置 SAM2_CHECKPOINT 或文件不存在。请设置环境变量 SAM2_CHECKPOINT 指向 checkpoint 文件。"
                f"\n- 已尝试 fallback: {fallback_ckpt}"
            )

    # SAM2_MODEL_CFG 使用 Hydra 的“配置名”，例如 "configs/sam2/sam2_hiera_l.yaml"。
    # 注意：这不是文件路径，不应该用 os.path.exists 去判断；build_sam2 内部会通过 Hydra 搜索路径加载。
    #
    # 如果用户错误地传入了绝对路径（以 "/" 开头），我们将其转换为相对配置名：
    #   "/xxx/sam2_hiera_l.yaml" -> "configs/sam2/sam2_hiera_l.yaml"
    raw_cfg = os.environ.get("SAM2_MODEL_CFG", "configs/sam2/sam2_hiera_l.yaml").strip()
    if raw_cfg.startswith("/"):
        base = os.path.splitext(os.path.basename(raw_cfg))[0]
        cfg = f"configs/sam2/{base}.yaml"
        _log("startup", f"[SAM2服务] ⚠️ SAM2_MODEL_CFG 是绝对路径，已转换为配置名: {raw_cfg} -> {cfg}")
    else:
        cfg = raw_cfg or "configs/sam2/sam2_hiera_l.yaml"

    _log("startup", f"[SAM2服务] 正在加载 SAM2 模型: cfg={cfg}, ckpt={ckpt}, device={device}")
    sam2_model = build_sam2(cfg, ckpt, device=device)
    sam2_loaded = True
    _log("startup", "[SAM2服务] ✅ SAM2 模型加载完成")


@app.on_event("startup")
async def startup_event():
    """应用启动时执行。"""
    global device
    _log("startup", "[SAM2服务] ========================================")
    _log("startup", "[SAM2服务] 服务启动中...")
    _log("startup", "[SAM2服务] GPU 可用性检查...")
    try:
        if torch is not None and torch.cuda.is_available():
            # Print detailed CUDA enumeration to avoid host-side "GPU0/GPU1" confusion.
            _log("cuda", "[SAM2服务] CUDA 环境信息:")
            try:
                _log("cuda", f"[SAM2服务]   - torch.__version__={getattr(torch, '__version__', 'unknown')}")
                _log(
                    "cuda",
                    f"[SAM2服务]   - torch.version.cuda={getattr(getattr(torch, 'version', None), 'cuda', None)}",
                )
            except Exception:
                pass

            cuda_visible = os.environ.get("CUDA_VISIBLE_DEVICES", "").strip()
            nvidia_visible = os.environ.get("NVIDIA_VISIBLE_DEVICES", "").strip()
            cuda_order = os.environ.get("CUDA_DEVICE_ORDER", "").strip()
            if cuda_order:
                _log("cuda", f"[SAM2服务]   - CUDA_DEVICE_ORDER={cuda_order}")
            if cuda_visible:
                _log("cuda", f"[SAM2服务]   - CUDA_VISIBLE_DEVICES={cuda_visible}")
            if nvidia_visible:
                _log("cuda", f"[SAM2服务]   - NVIDIA_VISIBLE_DEVICES={nvidia_visible}")

            try:
                count = int(torch.cuda.device_count())
            except Exception:
                count = -1
            _log("cuda", f"[SAM2服务]   - torch.cuda.device_count()={count}")
            if count > 0:
                for i in range(count):
                    try:
                        name = torch.cuda.get_device_name(i)
                        cap = torch.cuda.get_device_capability(i)
                        _log("cuda", f"[SAM2服务]   - cuda:{i} name={name}, capability={cap}")
                    except Exception as e:
                        _log("cuda", f"[SAM2服务]   - cuda:{i} 查询失败: {type(e).__name__}: {e}")

            # Be explicit: use cuda:0
            device = "cuda:0"
            _log("cuda", f"[SAM2服务] ✅ CUDA 可用，选择设备: {device}")
        else:
            device = "cpu"
            _log("cuda", "[SAM2服务] ⚠️  CUDA 不可用，将使用 CPU（性能较慢）")
    except Exception as e:
        _log("cuda", f"[SAM2服务] ⚠️  无法检查 CUDA 状态: {str(e)}")
    
    _log("startup", "[SAM2服务] ✅ 服务启动完成，监听端口 7860")
    _log("startup", "[SAM2服务] ========================================")


@app.get("/")
async def root():
    return {
        "service": "SAM2 API",
        "status": "running",
        "endpoints": {
            "health": "/health",
            "auto_label": "/api/auto-label",
        },
    }


@app.get("/health")
async def health_check():
    gpu_available = False
    try:
        if torch is not None:
            gpu_available = torch.cuda.is_available()
    except Exception:
        pass
    
    return {
        "status": "ok",
        "service": "SAM2 API",
        "gpu_available": gpu_available,
        "backends": {
            "sam2_amg": bool(sam2_loaded and sam2_model is not None),
        },
    }


@app.post("/api/auto-label")
async def auto_label(
    image: UploadFile = File(..., description="要标注的图片文件"),
    imageId: Optional[int] = Form(None, description="上游传入的 imageId（用于 debug 关联 UI）"),
    imageOriginalName: Optional[str] = Form(None, description="上游传入的图片原名（用于 debug 关联 UI）"),
    max_polygon_points: int = Form(60, description="轮廓最大点数（默认 60）"),
    sam2_points_per_side: int = Form(20, description="SAM2 AMG points_per_side（默认 20）"),
    sam2_pred_iou_thresh: float = Form(0.88, description="SAM2 AMG pred_iou_thresh（默认 0.88）"),
    sam2_stability_score_thresh: float = Form(0.95, description="SAM2 AMG stability_score_thresh（默认 0.95）"),
    sam2_box_nms_thresh: float = Form(0.35, description="SAM2 AMG box_nms_thresh（默认 0.35）"),
    sam2_min_mask_region_area: int = Form(6000, description="SAM2 AMG min_mask_region_area（默认 6000）"),
    sam2_merge_gap_px: int = Form(0, description="SAM2 后处理合并阈值（像素）"),
):
    try:
        image_bytes = await image.read()
        pil_image = Image.open(io.BytesIO(image_bytes))
        if pil_image.mode != "RGB":
            pil_image = pil_image.convert("RGB")

        width, height = pil_image.size

        _log("request", "[SAM2服务] 收到标注请求:")
        _log("request", f"  - 图片: {image.filename} ({width}x{height})")
        _log("request", f"  - imageId: {imageId}, imageOriginalName: {imageOriginalName}")
        _log("request", "  - 后端: sam2_amg")
        _log(
            "params",
            "  - SAM2 AMG 参数: "
            f"sam2_points_per_side={sam2_points_per_side}, "
            f"sam2_pred_iou_thresh={sam2_pred_iou_thresh}, "
            f"sam2_stability_score_thresh={sam2_stability_score_thresh}, "
            f"sam2_box_nms_thresh={sam2_box_nms_thresh}, "
            f"sam2_min_mask_region_area={sam2_min_mask_region_area}, "
            f"sam2_merge_gap_px={sam2_merge_gap_px}, "
            f"max_polygon_points={max_polygon_points}",
        )

        load_sam2_model()

        max_polygon_points_clamped = int(max(10, min(2000, max_polygon_points)))
        pps = int(max(4, min(128, sam2_points_per_side)))
        pred_iou = float(max(0.01, min(0.99, sam2_pred_iou_thresh)))
        stab = float(max(0.01, min(0.99, sam2_stability_score_thresh)))
        nms = float(max(0.01, min(0.99, sam2_box_nms_thresh)))
        min_area = int(max(0, min(10_000_000, sam2_min_mask_region_area)))
        merge_gap_px = int(max(0, min(200, sam2_merge_gap_px)))

        try:
            ppb_env = int(os.environ.get("SAM2_POINTS_PER_BATCH", "16"))
        except Exception:
            ppb_env = 16
        points_per_batch = int(max(1, min(256, ppb_env)))

        try:
            max_side_env = int(os.environ.get("SAM2_MAX_SIDE", "1280"))
        except Exception:
            max_side_env = 1280
        max_side = int(max(0, min(8192, max_side_env)))

        np_image = np.array(pil_image)
        np_image_for_sam2 = np_image
        proc_w, proc_h = width, height
        sx = sy = 1.0

        if max_side > 0 and max(width, height) > max_side:
            ratio = float(max_side) / float(max(width, height))
            proc_w = max(1, int(round(width * ratio)))
            proc_h = max(1, int(round(height * ratio)))
            try:
                resized = pil_image.resize((proc_w, proc_h), Image.Resampling.LANCZOS)
            except Exception:
                resized = pil_image.resize((proc_w, proc_h))
            np_image_for_sam2 = np.array(resized)
            sx = float(width) / float(proc_w)
            sy = float(height) / float(proc_h)
            _log(
                "params",
                f"[SAM2服务] SAM2 输入缩放: {width}x{height} -> {proc_w}x{proc_h} (max_side={max_side})",
            )

        sam2_amg = SAM2AutomaticMaskGenerator(
            sam2_model,
            points_per_side=pps,
            points_per_batch=points_per_batch,
            pred_iou_thresh=pred_iou,
            stability_score_thresh=stab,
            box_nms_thresh=nms,
            min_mask_region_area=min_area,
            output_mode=os.environ.get("SAM2_OUTPUT_MODE", "uncompressed_rle").strip() or "uncompressed_rle",
        )

        if torch is not None and device == "cuda":
            amp_dtype = os.environ.get("SAM2_AMP_DTYPE", "bf16").strip().lower()
            use_dtype = torch.bfloat16 if amp_dtype in ["bf16", "bfloat16"] else torch.float16
            with torch.inference_mode():
                with torch.autocast(device_type="cuda", dtype=use_dtype):
                    masks_out = sam2_amg.generate(np_image_for_sam2)
        else:
            masks_out = sam2_amg.generate(np_image_for_sam2)

        candidates: List[dict] = []

        for i, mask_item in enumerate(masks_out or []):
            seg = mask_item.get("segmentation", None)
            if seg is None:
                continue

            binary = None
            if isinstance(seg, dict) and "counts" in seg and "size" in seg:
                try:
                    from sam2.utils.amg import rle_to_mask  # type: ignore

                    binary = np.asarray(rle_to_mask(seg)).astype(float)
                except Exception:
                    binary = None

            if binary is None:
                binary = np.asarray(seg).astype(float)

            bbox = mask_item.get("bbox", None)
            if bbox and len(bbox) == 4:
                x, y, w_box, h_box = map(float, bbox)
                x1, y1, x2, y2 = (x * sx), (y * sy), ((x + w_box) * sx), ((y + h_box) * sy)
            else:
                x1 = y1 = 0.0
                x2 = float(width)
                y2 = float(height)

            score = float(mask_item.get("predicted_iou", 1.0) or 1.0)
            candidates.append(
                {
                    "binary_proc": binary,
                    "bbox_xyxy": [x1, y1, x2, y2],
                    "score": score,
                    "area": max(0.0, (x2 - x1) * (y2 - y1)),
                }
            )

        merged_candidates = _merge_candidates_by_gap(candidates, merge_gap_px=merge_gap_px)
        merge_removed_count = max(0, len(candidates) - len(merged_candidates))
        dedup_iou_thresh = float(max(0.5, min(0.99, float(os.environ.get("SAM2_DEDUP_BBOX_IOU", "0.92")))))
        deduped = _dedupe_candidates_by_bbox_iou(merged_candidates, iou_thresh=dedup_iou_thresh)
        dedup_removed_count = max(0, len(merged_candidates) - len(deduped))

        result_masks = []
        result_segments = []
        for i, item in enumerate(deduped):
            x1, y1, x2, y2 = item["bbox_xyxy"]
            binary = np.asarray(item.get("binary_proc")).astype(float) if item.get("binary_proc") is not None else None
            polygon_points: List[float] = []
            if isinstance(binary, np.ndarray):
                contours = measure.find_contours(binary, 0.5)
                if contours:
                    contour = max(contours, key=lambda c: c.shape[0])
                    step = max(1, len(contour) // max_polygon_points_clamped)
                    for row, col in contour[::step]:
                        polygon_points.extend([float(col * sx), float(row * sy)])
            if not polygon_points:
                polygon_points = [x1, y1, x2, y1, x2, y2, x1, y2]
            result_masks.append(
                {
                    "id": f"sam2-mask-{i}",
                    "points": polygon_points,
                    "label": "object",
                    "score": float(item.get("score", 1.0) or 1.0),
                }
            )
            result_segments.append(
                {
                    "id": f"sam2-seg-{i}",
                    "bbox": [x1, y1, x2, y2],
                    "points": polygon_points,
                    "label": "object",
                    "score": float(item.get("score", 1.0) or 1.0),
                }
            )

        _log(
            "sam2AutoLabelResult",
            "[SAM2服务] ✅ 自动标注成功（按 kind 开启才会显示）",
            {
                "imageId": imageId,
                "imageOriginalName": imageOriginalName,
                "filename": getattr(image, "filename", None),
                "masks": int(len(result_masks)),
                "segments": int(len(result_segments)),
                "merge_removed": int(merge_removed_count),
                "merge_gap_px": int(merge_gap_px),
                "dedup_removed": int(dedup_removed_count),
                "dedup_iou_thresh": float(dedup_iou_thresh),
                "image_size": {"width": int(width), "height": int(height)},
            },
        )

        return JSONResponse(
            content={
                "masks": result_masks,
                "segments": result_segments,
                "image_size": {"width": width, "height": height},
                "backend": "sam2_amg",
            }
        )
    except HTTPException:
        raise
    except Exception as e:
        _log(
            "sam2AutoLabelResult",
            "[SAM2服务] ❌ 自动标注处理失败（按 kind 开启才会显示）",
            {
                "imageId": imageId,
                "imageOriginalName": imageOriginalName,
                "filename": getattr(image, "filename", None),
                "error": str(e),
            },
        )
        print(f"[SAM2服务] SAM2 AMG 推理失败: {str(e)}")
        raise HTTPException(status_code=500, detail=f"SAM2 AMG 推理失败: {str(e)}")


if __name__ == "__main__":
    # Dynamically gate Uvicorn access logs via DebugSettingsModal (services.sam2).
    try:
        access_logger = logging.getLogger("uvicorn.access")
        access_logger.addFilter(Sam2AccessLogFilter())
    except Exception:
        pass

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=7860,
        log_level="info",
        access_log=True,
    )
