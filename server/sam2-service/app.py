"""
Grounded SAM2 API Service
提供自动图像标注服务的 FastAPI 应用
集成在 Node.js 后端项目中，为后端提供 AI 标注能力
"""

from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn
from PIL import Image
import io
import numpy as np
import os
from typing import Optional, List
import sys
from skimage import measure

# 尝试导入 PyTorch / torchvision（用于真实模型推理）
try:
    import torch
    from torchvision.models.detection import (
        maskrcnn_resnet50_fpn,
        MaskRCNN_ResNet50_FPN_Weights,
    )
    from torchvision import transforms
except ImportError:
    torch = None
    maskrcnn_resnet50_fpn = None
    MaskRCNN_ResNet50_FPN_Weights = None
    transforms = None

# YOLO-Seg（ultralytics）为可选依赖：按需加载
try:
    from ultralytics import YOLO  # type: ignore
except Exception:
    YOLO = None

# SAM2（可选依赖）：按需加载。不同实现的 import 路径可能不同，这里做最常见的一种尝试
try:
    from sam2.build_sam import build_sam2  # type: ignore
    from sam2.automatic_mask_generator import SAM2AutomaticMaskGenerator  # type: ignore
except Exception:
    build_sam2 = None
    SAM2AutomaticMaskGenerator = None

app = FastAPI(
    title="Grounded SAM2 API Service",
    description="提供基于 Grounded SAM2（当前使用 Mask R-CNN 作为基础模型）的自动图像标注服务",
    version="1.0.0"
)

# 配置 CORS（允许 Node.js 后端跨域访问）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 生产环境应限制为具体域名
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 全局变量：存储模型实例（初始化后填充）
model = None
model_loaded = False
device = "cpu"
image_transform = None
COCO_CATEGORIES = []

# YOLO-Seg / SAM2 采用惰性加载：只有在 model_backend 选择后才加载，避免启动过慢/占显存
yolo_model = None
yolo_loaded = False

sam2_model = None
sam2_amg = None
sam2_loaded = False

def load_model():
    """
    加载真实检测/分割模型
    当前实现：使用 torchvision 的 Mask R-CNN COCO 预训练模型
    说明：这是一个“能真实工作”的基础模型，后续可以替换为 Grounded SAM2
    """
    global model, model_loaded, device, image_transform, COCO_CATEGORIES

    if model_loaded:
        return

    try:
        if torch is None or maskrcnn_resnet50_fpn is None or MaskRCNN_ResNet50_FPN_Weights is None:
            print("[SAM2服务] ⚠️  未找到 torch/torchvision，无法加载真实模型，将继续使用模拟数据")
            model_loaded = False
            return

        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"[SAM2服务] 正在加载 Mask R-CNN 预训练模型到设备: {device}")

        weights = MaskRCNN_ResNet50_FPN_Weights.DEFAULT
        COCO_CATEGORIES = weights.meta.get("categories", [])

        model = maskrcnn_resnet50_fpn(weights=weights)
        model.to(device)
        model.eval()

        image_transform = transforms.Compose([
            transforms.ToTensor(),
        ])

        model_loaded = True
        print("[SAM2服务] ✅ Mask R-CNN 模型加载完成，将用于真实自动标注（暂时代替 Grounded SAM2）")

    except Exception as e:
        print(f"[SAM2服务] 模型加载失败: {str(e)}")
        model_loaded = False


def load_yolo_seg():
    """惰性加载 YOLO-Seg（ultralytics）。权重通过环境变量 YOLO_SEG_WEIGHTS 指定。"""
    global yolo_model, yolo_loaded
    if yolo_loaded and yolo_model is not None:
        return

    if YOLO is None:
        raise RuntimeError(
            "ultralytics 未安装，无法使用 YOLO-Seg。请在 sam2 环境中安装：pip install ultralytics"
        )

    weights = os.environ.get("YOLO_SEG_WEIGHTS", "yolov8n-seg.pt")
    print(f"[SAM2服务] 正在加载 YOLO-Seg 权重: {weights}")
    yolo_model = YOLO(weights)
    yolo_loaded = True
    print("[SAM2服务] ✅ YOLO-Seg 加载完成")


def load_sam2_amg():
    """
    惰性加载 SAM2 Automatic Mask Generator（AMG）。

    依赖：sam2（通常需要从官方/社区 repo 安装）
    环境变量：
      - SAM2_CHECKPOINT: SAM2 checkpoint 文件路径
      - SAM2_MODEL_CFG:  模型 cfg 名称或路径（默认 sam2_hiera_l.yaml，按你的安装而定）
    """
    global sam2_model, sam2_amg, sam2_loaded
    if sam2_loaded and sam2_amg is not None:
        return

    if build_sam2 is None or SAM2AutomaticMaskGenerator is None:
        raise RuntimeError(
            "SAM2 依赖未安装（找不到 sam2.build_sam / sam2.automatic_mask_generator）。"
            "请先安装 SAM2 后再使用 model_backend=sam2_amg。"
        )

    ckpt = os.environ.get("SAM2_CHECKPOINT", "").strip()
    if not ckpt or not os.path.exists(ckpt):
        raise RuntimeError(
            "未配置 SAM2_CHECKPOINT 或文件不存在。请设置环境变量 SAM2_CHECKPOINT 指向 checkpoint 文件。"
        )

    # 注意：SAM2 使用 Hydra 的 config_module="sam2"，这里的 config_name 需要是包内路径
    # Grounded-SAM-2 仓库默认提供的配置在：sam2/configs/sam2/sam2_hiera_l.yaml
    cfg = os.environ.get("SAM2_MODEL_CFG", "configs/sam2/sam2_hiera_l.yaml").strip()
    print(f"[SAM2服务] 正在加载 SAM2 模型: cfg={cfg}, ckpt={ckpt}, device={device}")
    # build_sam2 的具体签名依赖安装的 SAM2 版本；此处按常见实现调用
    sam2_model = build_sam2(cfg, ckpt, device=device)
    sam2_loaded = True
    print("[SAM2服务] ✅ SAM2 模型加载完成（AMG 将按请求参数初始化）")

@app.on_event("startup")
async def startup_event():
    """应用启动时执行"""
    global device
    print("[SAM2服务] ========================================")
    print("[SAM2服务] 服务启动中...")
    print("[SAM2服务] GPU 可用性检查...")
    try:
        if torch is not None and torch.cuda.is_available():
            device = "cuda"
            print(f"[SAM2服务] ✅ CUDA 可用，设备: {torch.cuda.get_device_name(0)}")
        else:
            device = "cpu"
            print("[SAM2服务] ⚠️  CUDA 不可用，将使用 CPU（性能较慢）")
    except ImportError:
        print("[SAM2服务] ⚠️  PyTorch 未安装，无法使用 GPU")
    except Exception as e:
        print(f"[SAM2服务] ⚠️  无法检查 CUDA 状态: {str(e)}")
    
    # Mask R-CNN 采用惰性加载：只有在 model_backend=maskrcnn 时才加载，避免与 SAM2 同时占用大量显存
    if os.environ.get("LOAD_MASKRCNN_ON_STARTUP", "0").strip() in ["1", "true", "True", "yes", "Y"]:
        load_model()
    print("[SAM2服务] ✅ 服务启动完成，监听端口 7860")
    print("[SAM2服务] ========================================")

@app.get("/")
async def root():
    """根路径"""
    return {
        "service": "Grounded SAM2 API",
        "status": "running",
        "model_loaded": model_loaded,
        "endpoints": {
            "health": "/health",
            "auto_label": "/api/auto-label"
        }
    }

@app.get("/health")
async def health_check():
    """健康检查端点"""
    gpu_available = False
    try:
        import torch
        gpu_available = torch.cuda.is_available()
    except:
        pass
    
    return {
        "status": "ok",
        "service": "Grounded SAM2 API",
        "model_loaded": model_loaded,
        "gpu_available": gpu_available,
        "backends": {
            "maskrcnn": bool(model_loaded and model is not None),
            "yolo_seg": bool(yolo_loaded and yolo_model is not None),
            "sam2_amg": bool(sam2_loaded and sam2_amg is not None),
        },
    }

@app.post("/api/auto-label")
async def auto_label(
    image: UploadFile = File(..., description="要标注的图片文件"),
    text_prompt: Optional[str] = Form(None, description="文本提示词（可选）"),
    prompt: Optional[str] = Form(None, description="提示词别名（可选）"),
    model_backend: str = Form("maskrcnn", description="推理后端：maskrcnn / yolo_seg / sam2_amg"),
    base_score_thresh: float = Form(0.5, description="初始置信度阈值（默认 0.5）"),
    lower_score_thresh: float = Form(0.3, description="兜底置信度下限（默认 0.3）"),
    max_detections: int = Form(50, description="每张图片最多检测目标数（默认 50）"),
    mask_threshold: float = Form(0.5, description="Mask 二值化阈值（影响轮廓紧/松，默认 0.5）"),
    max_polygon_points: int = Form(80, description="轮廓最大点数（越大越精细，默认 80）"),
    # YOLO-Seg
    yolo_conf: float = Form(0.25, description="YOLO 置信度阈值（默认 0.25）"),
    yolo_iou: float = Form(0.7, description="YOLO NMS IoU 阈值（默认 0.7）"),
    yolo_imgsz: int = Form(640, description="YOLO 输入尺寸 imgsz（默认 640）"),
    yolo_max_det: int = Form(300, description="YOLO 最大检测数（默认 300）"),
    # SAM2 AMG
    sam2_points_per_side: int = Form(32, description="SAM2 AMG points_per_side（默认 32）"),
    sam2_pred_iou_thresh: float = Form(0.88, description="SAM2 AMG pred_iou_thresh（默认 0.88）"),
    sam2_stability_score_thresh: float = Form(0.95, description="SAM2 AMG stability_score_thresh（默认 0.95）"),
    sam2_box_nms_thresh: float = Form(0.7, description="SAM2 AMG box_nms_thresh（默认 0.7）"),
    sam2_min_mask_region_area: int = Form(0, description="SAM2 AMG min_mask_region_area（默认 0）"),
):
    """
    自动标注接口
    
    参数:
    - image: 图片文件（multipart/form-data）
    - text_prompt: 文本提示词（可选，例如："person", "car", "dog"）
    - prompt: 提示词别名（可选，与 text_prompt 功能相同）
    
    返回:
    - masks: Mask 标注数组
    - segments: 分段标注数组（包含 bbox 和 points）
    """
    try:
        # 读取图片
        image_bytes = await image.read()
        pil_image = Image.open(io.BytesIO(image_bytes))

        # 转换为 RGB（处理 RGBA 等情况）
        if pil_image.mode != 'RGB':
            pil_image = pil_image.convert('RGB')

        width, height = pil_image.size

        # 获取提示词
        prompt_text = (text_prompt or prompt or "").strip()

        print(f"[SAM2服务] 收到标注请求:")
        print(f"  - 图片: {image.filename} ({width}x{height})")
        print(f"  - 提示词: {prompt_text or '（空，使用所有类别）'}")
        print(f"  - 后端: {model_backend}")
        print(
            f"  - 模型参数: base_score_thresh={base_score_thresh}, "
            f"lower_score_thresh={lower_score_thresh}, max_detections={max_detections}, "
            f"mask_threshold={mask_threshold}, max_polygon_points={max_polygon_points}"
        )

        backend = (model_backend or "maskrcnn").strip().lower()

        # 防御性截断，避免非法值（各后端共用）
        max_polygon_points_clamped = int(max(10, min(2000, max_polygon_points)))

        # 转 numpy（RGB）
        np_image = np.array(pil_image)  # HWC, RGB

        # ------------------------ YOLO-Seg 后端 ------------------------
        if backend in ["yolo", "yolo_seg", "yolov8_seg", "yolov11_seg"]:
            try:
                load_yolo_seg()

                conf_c = float(max(0.01, min(0.99, yolo_conf)))
                iou_c = float(max(0.01, min(0.99, yolo_iou)))
                imgsz_c = int(max(320, min(2048, yolo_imgsz)))
                max_det_c = int(max(1, min(2000, yolo_max_det)))

                # ultralytics 自动选择设备；如果你希望强制 GPU，可通过环境变量 ULTRALYTICS_DEVICE 控制
                results = yolo_model.predict(
                    source=np_image,
                    conf=conf_c,
                    iou=iou_c,
                    imgsz=imgsz_c,
                    max_det=max_det_c,
                    verbose=False,
                )
                r0 = results[0] if results else None
                if r0 is None or r0.masks is None or r0.boxes is None:
                    return JSONResponse(
                        content={
                            "masks": [],
                            "segments": [],
                            "image_size": {"width": width, "height": height},
                            "prompt": prompt_text,
                            "backend": "yolo_seg",
                        }
                    )

                masks_xy = getattr(r0.masks, "xy", None)
                boxes_xyxy = getattr(r0.boxes, "xyxy", None)
                confs = getattr(r0.boxes, "conf", None)
                clss = getattr(r0.boxes, "cls", None)
                names = getattr(yolo_model, "names", {}) or {}

                if hasattr(boxes_xyxy, "cpu"):
                    boxes_xyxy = boxes_xyxy.cpu().numpy()
                if hasattr(confs, "cpu"):
                    confs = confs.cpu().numpy()
                if hasattr(clss, "cpu"):
                    clss = clss.cpu().numpy()

                result_masks = []
                result_segments = []

                for i in range(len(boxes_xyxy)):
                    x1, y1, x2, y2 = map(float, boxes_xyxy[i])
                    score = float(confs[i]) if confs is not None and i < len(confs) else 1.0
                    cls_id = int(clss[i]) if clss is not None and i < len(clss) else -1
                    label_name = str(names.get(cls_id, "object"))

                    polygon_points: List[float] = []
                    if masks_xy is not None and i < len(masks_xy):
                        poly = masks_xy[i]
                        # poly: Nx2
                        if hasattr(poly, "shape") and len(poly) > 0:
                            step = max(1, int(len(poly) // max_polygon_points_clamped))
                            for (px, py) in poly[::step]:
                                polygon_points.extend([float(px), float(py)])

                    if not polygon_points:
                        polygon_points = [x1, y1, x2, y1, x2, y2, x1, y2]

                    result_masks.append(
                        {
                            "id": f"yolo-mask-{i}",
                            "points": polygon_points,
                            "label": label_name,
                            "score": score,
                        }
                    )
                    result_segments.append(
                        {
                            "id": f"yolo-seg-{i}",
                            "bbox": [x1, y1, x2, y2],
                            "points": polygon_points,
                            "label": label_name,
                            "score": score,
                        }
                    )

                return JSONResponse(
                    content={
                        "masks": result_masks,
                        "segments": result_segments,
                        "image_size": {"width": width, "height": height},
                        "prompt": prompt_text,
                        "backend": "yolo_seg",
                    }
                )

            except Exception as e:
                print(f"[SAM2服务] YOLO-Seg 推理失败: {str(e)}")
                raise HTTPException(status_code=500, detail=f"YOLO-Seg 推理失败: {str(e)}")

        # ------------------------ SAM2 AMG 后端 ------------------------
        if backend in ["sam2", "sam2_amg"]:
            try:
                load_sam2_amg()

                pps = int(max(4, min(128, sam2_points_per_side)))
                pred_iou = float(max(0.01, min(0.99, sam2_pred_iou_thresh)))
                stab = float(max(0.01, min(0.99, sam2_stability_score_thresh)))
                nms = float(max(0.01, min(0.99, sam2_box_nms_thresh)))
                min_area = int(max(0, min(10_000_000, sam2_min_mask_region_area)))
                # points_per_batch 越大越快但越吃显存；4K 图很容易爆显存，保守默认 16
                try:
                    ppb_env = int(os.environ.get("SAM2_POINTS_PER_BATCH", "16"))
                except Exception:
                    ppb_env = 16
                points_per_batch = int(max(1, min(256, ppb_env)))

                # 大分辨率（如 4096x3072）直接跑 AMG 会占用极高显存（尤其 output_mode=binary_mask）。
                # 这里默认对输入做缩放以控制显存；缩放后再把 polygon/bbox 按比例映射回原图坐标。
                try:
                    max_side_env = int(os.environ.get("SAM2_MAX_SIDE", "1280"))
                except Exception:
                    max_side_env = 1280
                max_side = int(max(0, min(8192, max_side_env)))

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

                # 每次请求按参数创建 AMG（避免全局共享参数导致前端调参无效）
                global sam2_amg
                sam2_amg = SAM2AutomaticMaskGenerator(
                    sam2_model,
                    points_per_side=pps,
                    points_per_batch=points_per_batch,
                    pred_iou_thresh=pred_iou,
                    stability_score_thresh=stab,
                    box_nms_thresh=nms,
                    min_mask_region_area=min_area,
                    # binary_mask 在大分辨率下会非常吃内存；用 RLE 降低峰值显存
                    output_mode=os.environ.get("SAM2_OUTPUT_MODE", "uncompressed_rle").strip() or "uncompressed_rle",
                )

                # 推理阶段：使用 inference_mode + autocast（BF16/FP16）可以显著减少显存与提速
                # 同时避免 scaled_dot_product_attention 的 dtype 警告（float32 会退回到更慢的 kernel）。
                masks_out = None
                if torch is not None and device == "cuda":
                    amp_dtype = os.environ.get("SAM2_AMP_DTYPE", "bf16").strip().lower()
                    use_dtype = torch.bfloat16 if amp_dtype in ["bf16", "bfloat16"] else torch.float16
                    with torch.inference_mode():
                        with torch.autocast(device_type="cuda", dtype=use_dtype):
                            masks_out = sam2_amg.generate(np_image_for_sam2)
                else:
                    # CPU 或 torch 不可用时退回普通推理
                    masks_out = sam2_amg.generate(np_image_for_sam2)
                result_masks = []
                result_segments = []

                for i, m in enumerate(masks_out or []):
                    seg = m.get("segmentation", None)
                    if seg is None:
                        continue
                    # seg: HxW bool/0-1
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
                        for (row, col) in contour[::step]:
                            polygon_points.extend([float(col * sx), float(row * sy)])

                    # bbox: SAM 常见格式为 [x, y, w, h]（XYWH）
                    bbox = m.get("bbox", None)
                    if bbox and len(bbox) == 4:
                        x, y, w_, h_ = map(float, bbox)
                        x1, y1, x2, y2 = (x * sx), (y * sy), ((x + w_) * sx), ((y + h_) * sy)
                    else:
                        # fallback：用轮廓 bbox
                        x1 = y1 = 0.0
                        x2 = float(width)
                        y2 = float(height)

                    if not polygon_points:
                        polygon_points = [x1, y1, x2, y1, x2, y2, x1, y2]

                    score = float(m.get("predicted_iou", 1.0) or 1.0)
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
                        "prompt": prompt_text,
                        "backend": "sam2_amg",
                    }
                )

            except Exception as e:
                print(f"[SAM2服务] SAM2 AMG 推理失败: {str(e)}")
                raise HTTPException(status_code=500, detail=f"SAM2 AMG 推理失败: {str(e)}")

        # ------------------------ Mask R-CNN 后端 ------------------------
        # 惰性加载：仅当选择 maskrcnn 时加载（否则不占用显存）
        if backend in ["maskrcnn", "mask_rcnn", "rcnn", "mask-rcnn"]:
            load_model()

        # 如果模型已加载，使用真实推理
        if model_loaded and model is not None and image_transform is not None and torch is not None:
            try:
                model_device = device
                img_tensor = image_transform(pil_image).to(model_device)

                with torch.no_grad():
                    outputs = model([img_tensor])[0]

                boxes = outputs.get("boxes", [])
                labels = outputs.get("labels", [])
                scores = outputs.get("scores", [])
                masks_prob = outputs.get("masks", None)

                if hasattr(boxes, "cpu"):
                    boxes = boxes.cpu().numpy()
                if hasattr(labels, "cpu"):
                    labels = labels.cpu().numpy()
                if hasattr(scores, "cpu"):
                    scores = scores.cpu().numpy()
                masks_np = None
                if masks_prob is not None:
                    if hasattr(masks_prob, "cpu"):
                        masks_prob = masks_prob.cpu().numpy()
                    # 形状通常是 [N, 1, H, W] 或 [N, H, W]
                    masks_np = masks_prob

                # 评分阈值（可通过前端调整，默认 0.5 / 0.3）
                # 防御性截断，避免非法值
                base_score_thresh_clamped = float(max(0.01, min(0.99, base_score_thresh)))
                lower_score_thresh_clamped = float(max(0.01, min(0.99, lower_score_thresh)))
                max_detections_clamped = int(max(1, min(500, max_detections)))
                mask_threshold_clamped = float(max(0.01, min(0.99, mask_threshold)))
                prompt_tokens = [t.strip().lower() for t in prompt_text.split(",") if t.strip()] if prompt_text else []

                result_masks = []
                result_segments = []

                def collect_segments(score_thresh: float, use_prompt_filter: bool) -> None:
                    """根据阈值和是否按提示词过滤，收集检测结果到 result_masks/result_segments 中"""
                    for i in range(len(boxes)):
                        if len(result_segments) >= max_detections_clamped:
                            break
                        score = float(scores[i])
                        if score < score_thresh:
                            continue

                        box = boxes[i]
                        x1, y1, x2, y2 = map(float, box)

                        label_idx = int(labels[i]) if i < len(labels) else -1
                        if 0 <= label_idx - 1 < len(COCO_CATEGORIES):
                            label_name = COCO_CATEGORIES[label_idx - 1]
                        else:
                            label_name = f"class_{label_idx}"

                        if use_prompt_filter and prompt_tokens:
                            name_lower = (label_name or "").lower()
                            if not any(tok in name_lower for tok in prompt_tokens):
                                continue

                        # 优先根据 mask 生成更精细的多边形轮廓；如果没有 mask，则退回矩形
                        polygon_points: List[float] = []
                        if masks_np is not None and len(masks_np) > i:
                            mask_i = masks_np[i]
                            # [1, H, W] -> [H, W]
                            if mask_i.ndim == 3:
                                mask_i = mask_i[0]
                            binary = (mask_i >= mask_threshold_clamped).astype(float)
                            contours = measure.find_contours(binary, 0.5)
                            if contours:
                                # 取点数最多的一条轮廓，并适当抽样，避免点太密
                                contour = max(contours, key=lambda c: c.shape[0])
                                step = max(1, len(contour) // max_polygon_points_clamped)  # 控制点数上限
                                for (row, col) in contour[::step]:
                                    # 注意 find_contours 返回 (row, col) = (y, x)
                                    polygon_points.extend([float(col), float(row)])

                        # 如果没拿到轮廓，多边形退回成矩形四个点
                        if not polygon_points:
                            polygon_points = [
                                x1, y1,
                                x2, y1,
                                x2, y2,
                                x1, y2,
                            ]

                        mask_id = f"mask-{i}"
                        seg_id = f"segment-{i}"

                        result_masks.append(
                            {
                                "id": mask_id,
                                "points": polygon_points,
                                "label": label_name,
                                "score": score,
                            }
                        )
                        result_segments.append(
                            {
                                "id": seg_id,
                                "bbox": [x1, y1, x2, y2],
                                "points": polygon_points,
                                "label": label_name,
                                "score": score,
                            }
                        )

                # 1) 先用较高阈值 + 提示词过滤
                collect_segments(base_score_thresh_clamped, use_prompt_filter=True)

                # 2) 如果用户给了提示词但一个都没匹配上：忽略提示词，只按分数筛
                if prompt_tokens and not result_segments:
                    print("[SAM2服务] 提示词过滤后没有检测到对象，尝试忽略提示词仅按分数筛选")
                    collect_segments(base_score_thresh_clamped, use_prompt_filter=False)

                # 3) 如果仍然为空：降一点阈值，再尝试一次
                if not result_segments:
                    print(
                        f"[SAM2服务] score_thresh={base_score_thresh_clamped} 下仍未检测到对象，"
                        f"尝试降低阈值到 {lower_score_thresh_clamped}"
                    )
                    collect_segments(lower_score_thresh_clamped, use_prompt_filter=False)

                # 4) 如果还是空，兜底：直接取最高分的那个框，保证至少有 1 个结果
                if not result_segments and len(boxes) > 0:
                    print("[SAM2服务] 仍未检测到对象，兜底返回最高分的一个检测框")
                    # 找最高分索引
                    best_idx = int(np.argmax(scores))
                    best_score = float(scores[best_idx])
                    box = boxes[best_idx]
                    x1, y1, x2, y2 = map(float, box)

                    label_idx = int(labels[best_idx]) if best_idx < len(labels) else -1
                    if 0 <= label_idx - 1 < len(COCO_CATEGORIES):
                        label_name = COCO_CATEGORIES[label_idx - 1]
                    else:
                        label_name = f"class_{label_idx}"

                    polygon_points: List[float] = []
                    if masks_np is not None and len(masks_np) > best_idx:
                        mask_i = masks_np[best_idx]
                        if mask_i.ndim == 3:
                            mask_i = mask_i[0]
                        binary = (mask_i >= mask_threshold_clamped).astype(float)
                        contours = measure.find_contours(binary, 0.5)
                        if contours:
                            contour = max(contours, key=lambda c: c.shape[0])
                            step = max(1, len(contour) // max_polygon_points_clamped)
                            for (row, col) in contour[::step]:
                                polygon_points.extend([float(col), float(row)])

                    if not polygon_points:
                        polygon_points = [
                            x1, y1,
                            x2, y1,
                            x2, y2,
                            x1, y2,
                        ]

                    result_masks.append(
                        {
                            "id": "mask-best",
                            "points": polygon_points,
                            "label": label_name,
                            "score": best_score,
                        }
                    )
                    result_segments.append(
                        {
                            "id": "segment-best",
                            "bbox": [x1, y1, x2, y2],
                            "points": polygon_points,
                            "label": label_name,
                            "score": best_score,
                        }
                    )

                print(f"[SAM2服务] ✅ 真实模型检测到 {len(result_segments)} 个对象")

                result = {
                    "masks": result_masks,
                    "segments": result_segments,
                    "image_size": {"width": width, "height": height},
                    "prompt": prompt_text,
                    "backend": "maskrcnn",
                }
                return JSONResponse(content=result)

            except Exception as e:
                print(f"[SAM2服务] 模型推理失败: {str(e)}")
                raise HTTPException(status_code=500, detail=f"模型推理失败: {str(e)}")

        # 如果模型未成功加载，则退回到简单的模拟数据
        print("[SAM2服务] ⚠️  模型未加载成功，退回使用模拟数据")

        cx = width * 0.5
        cy = height * 0.5
        w = width * 0.3
        h = height * 0.5

        mock_label = prompt_text or "object"

        mock_result = {
            "masks": [
                {
                    "id": "mask-1",
                    "points": [
                        cx - w / 2,
                        cy - h / 2,
                        cx + w / 2,
                        cy - h / 2,
                        cx + w / 2,
                        cy + h / 2,
                        cx - w / 2,
                        cy + h / 2,
                    ],
                    "label": mock_label,
                    "class": mock_label,
                }
            ],
            "segments": [
                {
                    "id": "segment-1",
                    "bbox": [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2],
                    "x": cx - w / 2,
                    "y": cy - h / 2,
                    "width": w,
                    "height": h,
                    "label": mock_label,
                    "class": mock_label,
                    "points": [
                        cx - w / 2,
                        cy - h / 2,
                        cx + w / 2,
                        cy - h / 2,
                        cx + w / 2,
                        cy + h / 2,
                        cx - w / 2,
                        cy + h / 2,
                    ],
                    "contour": [
                        cx - w / 2,
                        cy - h / 2,
                        cx + w / 2,
                        cy - h / 2,
                        cx + w / 2,
                        cy + h / 2,
                        cx - w / 2,
                        cy + h / 2,
                    ],
                }
            ],
            "image_size": {"width": width, "height": height},
            "prompt": prompt_text,
            "backend": "mock",
        }

        print(
            f"[SAM2服务] ✅ 返回模拟结果: {len(mock_result['masks'])} 个 masks, {len(mock_result['segments'])} 个 segments"
        )
        return JSONResponse(content=mock_result)
        
    except HTTPException:
        # 已经是带有明确 detail 的 HTTP 错误（例如 “SAM2 AMG 推理失败: ...”），直接向上抛出
        raise
    except Exception as e:
        # 其他未预料的异常，统一记录 traceback 并包装为 500
        print(f"[SAM2服务] ❌ 处理失败: {str(e)}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"处理失败: {str(e)}")

if __name__ == "__main__":
    # 启动服务
    # host="0.0.0.0" 允许外部访问
    # port=7860 与 Node.js 后端配置的端口一致
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=7860,
        log_level="info"
    )
