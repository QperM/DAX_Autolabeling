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
from typing import List
from skimage import measure

try:
    import torch
except ImportError:
    torch = None

    build_sam2 = None
    SAM2AutomaticMaskGenerator = None

for module_name, attr_name in [
    ("sam2.build_sam", "build_sam2"),
    ("sam2.automatic_mask_generator", "SAM2AutomaticMaskGenerator"),
]:
    try:
        module = __import__(module_name, fromlist=[attr_name])
        attr = getattr(module, attr_name)
        if attr_name == "build_sam2":
            build_sam2 = attr
        else:
            SAM2AutomaticMaskGenerator = attr
        print(f"[SAM2服务] ✅ 成功导入 {module_name}.{attr_name}")
    except ImportError as e:
        print(f"[SAM2服务] ⚠️  无法导入 {module_name}.{attr_name}: {e}")
    except Exception as e:
        print(f"[SAM2服务] ⚠️  导入 {module_name}.{attr_name} 时出错: {type(e).__name__}: {e}")

if build_sam2 is None or SAM2AutomaticMaskGenerator is None:
    print("[SAM2服务] ⚠️  SAM2 标准导入路径失败，尝试其他路径...")
    try:
        import sam2

        print(f"[SAM2服务] ✅ 成功导入 sam2 模块，位置: {sam2.__file__}")
        if hasattr(sam2, "build_sam") and hasattr(sam2.build_sam, "build_sam2"):
            build_sam2 = sam2.build_sam.build_sam2
            print("[SAM2服务] ✅ 找到 build_sam2")
        if hasattr(sam2, "automatic_mask_generator") and hasattr(
            sam2.automatic_mask_generator, "SAM2AutomaticMaskGenerator"
        ):
            SAM2AutomaticMaskGenerator = sam2.automatic_mask_generator.SAM2AutomaticMaskGenerator
            print("[SAM2服务] ✅ 找到 SAM2AutomaticMaskGenerator")
    except ImportError as e:
        print(f"[SAM2服务] ❌ 无法导入 sam2 模块: {e}")
        print("[SAM2服务] 提示: 请确保在 conda 环境 sam2 中安装了 SAM2")
        print("[SAM2服务] 安装方法:")
        print("[SAM2服务]   1. conda activate sam2")
        print("[SAM2服务]   2. pip install git+https://github.com/facebookresearch/segment-anything-2.git")
    except Exception as e:
        print(f"[SAM2服务] ❌ 检查 sam2 模块时出错: {type(e).__name__}: {e}")

if build_sam2 is not None and SAM2AutomaticMaskGenerator is not None:
    print("[SAM2服务] ✅ SAM2 模块导入成功，可以使用 sam2_amg")
else:
    print("[SAM2服务] ⚠️  SAM2 模块未完全导入，服务将不可用")

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
            print(f"[SAM2服务] ⚠️ 未正确配置 SAM2_CHECKPOINT，已自动使用本地 checkpoint: {ckpt}")
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
        print(f"[SAM2服务] ⚠️ SAM2_MODEL_CFG 是绝对路径，已转换为配置名: {raw_cfg} -> {cfg}")
    else:
        cfg = raw_cfg or "configs/sam2/sam2_hiera_l.yaml"

    print(f"[SAM2服务] 正在加载 SAM2 模型: cfg={cfg}, ckpt={ckpt}, device={device}")
    sam2_model = build_sam2(cfg, ckpt, device=device)
    sam2_loaded = True
    print("[SAM2服务] ✅ SAM2 模型加载完成")


@app.on_event("startup")
async def startup_event():
    """应用启动时执行。"""
    global device
    print("[SAM2服务] ========================================")
    print("[SAM2服务] 服务启动中...")
    print("[SAM2服务] GPU 可用性检查...")
    try:
        if torch is not None and torch.cuda.is_available():
            # Print detailed CUDA enumeration to avoid host-side "GPU0/GPU1" confusion.
            print("[SAM2服务] CUDA 环境信息:")
            try:
                print(f"[SAM2服务]   - torch.__version__={getattr(torch, '__version__', 'unknown')}")
                print(f"[SAM2服务]   - torch.version.cuda={getattr(getattr(torch, 'version', None), 'cuda', None)}")
            except Exception:
                pass

            cuda_visible = os.environ.get("CUDA_VISIBLE_DEVICES", "").strip()
            nvidia_visible = os.environ.get("NVIDIA_VISIBLE_DEVICES", "").strip()
            cuda_order = os.environ.get("CUDA_DEVICE_ORDER", "").strip()
            if cuda_order:
                print(f"[SAM2服务]   - CUDA_DEVICE_ORDER={cuda_order}")
            if cuda_visible:
                print(f"[SAM2服务]   - CUDA_VISIBLE_DEVICES={cuda_visible}")
            if nvidia_visible:
                print(f"[SAM2服务]   - NVIDIA_VISIBLE_DEVICES={nvidia_visible}")

            try:
                count = int(torch.cuda.device_count())
            except Exception:
                count = -1
            print(f"[SAM2服务]   - torch.cuda.device_count()={count}")
            if count > 0:
                for i in range(count):
                    try:
                        name = torch.cuda.get_device_name(i)
                        cap = torch.cuda.get_device_capability(i)
                        print(f"[SAM2服务]   - cuda:{i} name={name}, capability={cap}")
                    except Exception as e:
                        print(f"[SAM2服务]   - cuda:{i} 查询失败: {type(e).__name__}: {e}")

            # Be explicit: use cuda:0
            device = "cuda:0"
            print(f"[SAM2服务] ✅ CUDA 可用，选择设备: {device}")
        else:
            device = "cpu"
            print("[SAM2服务] ⚠️  CUDA 不可用，将使用 CPU（性能较慢）")
    except Exception as e:
        print(f"[SAM2服务] ⚠️  无法检查 CUDA 状态: {str(e)}")
    
    print("[SAM2服务] ✅ 服务启动完成，监听端口 7860")
    print("[SAM2服务] ========================================")


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
    max_polygon_points: int = Form(60, description="轮廓最大点数（默认 60）"),
    sam2_points_per_side: int = Form(20, description="SAM2 AMG points_per_side（默认 20）"),
    sam2_pred_iou_thresh: float = Form(0.88, description="SAM2 AMG pred_iou_thresh（默认 0.88）"),
    sam2_stability_score_thresh: float = Form(0.95, description="SAM2 AMG stability_score_thresh（默认 0.95）"),
    sam2_box_nms_thresh: float = Form(0.55, description="SAM2 AMG box_nms_thresh（默认 0.55）"),
    sam2_min_mask_region_area: int = Form(6000, description="SAM2 AMG min_mask_region_area（默认 6000）"),
):
    try:
        image_bytes = await image.read()
        pil_image = Image.open(io.BytesIO(image_bytes))
        if pil_image.mode != "RGB":
            pil_image = pil_image.convert("RGB")

        width, height = pil_image.size

        print("[SAM2服务] 收到标注请求:")
        print(f"  - 图片: {image.filename} ({width}x{height})")
        print("  - 后端: sam2_amg")
        print(
            "  - SAM2 AMG 参数: "
                f"sam2_points_per_side={sam2_points_per_side}, "
                f"sam2_pred_iou_thresh={sam2_pred_iou_thresh}, "
                f"sam2_stability_score_thresh={sam2_stability_score_thresh}, "
                f"sam2_box_nms_thresh={sam2_box_nms_thresh}, "
                f"sam2_min_mask_region_area={sam2_min_mask_region_area}, "
                f"max_polygon_points={max_polygon_points}"
            )

        load_sam2_model()

        max_polygon_points_clamped = int(max(10, min(2000, max_polygon_points)))
        pps = int(max(4, min(128, sam2_points_per_side)))
        pred_iou = float(max(0.01, min(0.99, sam2_pred_iou_thresh)))
        stab = float(max(0.01, min(0.99, sam2_stability_score_thresh)))
        nms = float(max(0.01, min(0.99, sam2_box_nms_thresh)))
        min_area = int(max(0, min(10_000_000, sam2_min_mask_region_area)))

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
            print(f"[SAM2服务] SAM2 输入缩放: {width}x{height} -> {proc_w}x{proc_h} (max_side={max_side})")

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

        result_masks = []
        result_segments = []

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

            contours = measure.find_contours(binary, 0.5)
            polygon_points: List[float] = []
            if contours:
                contour = max(contours, key=lambda c: c.shape[0])
                step = max(1, len(contour) // max_polygon_points_clamped)
                for row, col in contour[::step]:
                    polygon_points.extend([float(col * sx), float(row * sy)])

            bbox = mask_item.get("bbox", None)
            if bbox and len(bbox) == 4:
                x, y, w_box, h_box = map(float, bbox)
                x1, y1, x2, y2 = (x * sx), (y * sy), ((x + w_box) * sx), ((y + h_box) * sy)
            else:
                x1 = y1 = 0.0
                x2 = float(width)
                y2 = float(height)

            if not polygon_points:
                polygon_points = [x1, y1, x2, y1, x2, y2, x1, y2]

            score = float(mask_item.get("predicted_iou", 1.0) or 1.0)
            result_masks.append(
                {
                    "id": f"sam2-mask-{i}",
                    "points": polygon_points,
                    "label": "object",
                    "score": score,
                }
            )
            result_segments.append(
                {
                    "id": f"sam2-seg-{i}",
                    "bbox": [x1, y1, x2, y2],
                    "points": polygon_points,
                    "label": "object",
                    "score": score,
                }
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
        print(f"[SAM2服务] SAM2 AMG 推理失败: {str(e)}")
        raise HTTPException(status_code=500, detail=f"SAM2 AMG 推理失败: {str(e)}")


if __name__ == "__main__":
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=7860,
        log_level="info",
    )
