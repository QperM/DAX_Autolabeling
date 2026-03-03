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

@app.on_event("startup")
async def startup_event():
    """应用启动时执行"""
    print("[SAM2服务] ========================================")
    print("[SAM2服务] 服务启动中...")
    print("[SAM2服务] GPU 可用性检查...")
    try:
        import torch
        if torch.cuda.is_available():
            print(f"[SAM2服务] ✅ CUDA 可用，设备: {torch.cuda.get_device_name(0)}")
        else:
            print("[SAM2服务] ⚠️  CUDA 不可用，将使用 CPU（性能较慢）")
    except ImportError:
        print("[SAM2服务] ⚠️  PyTorch 未安装，无法使用 GPU")
    except Exception as e:
        print(f"[SAM2服务] ⚠️  无法检查 CUDA 状态: {str(e)}")
    
    # 尝试加载模型（如果已实现）
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
        "gpu_available": gpu_available
    }

@app.post("/api/auto-label")
async def auto_label(
    image: UploadFile = File(..., description="要标注的图片文件"),
    text_prompt: Optional[str] = Form(None, description="文本提示词（可选）"),
    prompt: Optional[str] = Form(None, description="提示词别名（可选）"),
    base_score_thresh: float = Form(0.5, description="初始置信度阈值（默认 0.5）"),
    lower_score_thresh: float = Form(0.3, description="兜底置信度下限（默认 0.3）"),
    max_detections: int = Form(50, description="每张图片最多检测目标数（默认 50）"),
    mask_threshold: float = Form(0.5, description="Mask 二值化阈值（影响轮廓紧/松，默认 0.5）"),
    max_polygon_points: int = Form(80, description="轮廓最大点数（越大越精细，默认 80）"),
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
        print(
            f"  - 模型参数: base_score_thresh={base_score_thresh}, "
            f"lower_score_thresh={lower_score_thresh}, max_detections={max_detections}, "
            f"mask_threshold={mask_threshold}, max_polygon_points={max_polygon_points}"
        )

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
                max_polygon_points_clamped = int(max(10, min(2000, max_polygon_points)))
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
        }

        print(
            f"[SAM2服务] ✅ 返回模拟结果: {len(mock_result['masks'])} 个 masks, {len(mock_result['segments'])} 个 segments"
        )
        return JSONResponse(content=mock_result)
        
    except Exception as e:
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
