# Grounded SAM2 API Service

基于 FastAPI 的 Grounded SAM2 自动图像标注服务，集成在 Node.js 后端项目中。

## 位置

本服务位于 `server/sam2-service/` 目录下，与 Node.js 后端（`server/index.js`）在同一项目中。

## 环境要求

- Python 3.10+
- CUDA 12.1+（用于 GPU 加速，RTX 4080）
- Conda（推荐）

## 安装步骤

### 🚀 快速开始（推荐）

**首次使用，运行一键安装脚本：**
```bash
cd server/sam2-service
setup.bat
```

这个脚本会自动：
1. 检查 conda 是否安装
2. 创建 conda 环境 `sam2` (Python 3.10)
3. 安装所有 Python 依赖
4. 安装 PyTorch (CUDA 12.1)
5. 验证安装结果

### 📝 手动安装（可选）

如果你想手动安装，可以按照以下步骤：

#### 1. 创建 Conda 环境

```bash
conda create -n sam2 python=3.10 -y
conda activate sam2
```

#### 2. 安装依赖

```bash
cd server/sam2-service
pip install -r requirements.txt
```

#### 3. 安装 PyTorch（CUDA 12.1）

**使用 Conda（推荐）：**
```bash
conda install pytorch torchvision torchaudio pytorch-cuda=12.1 -c pytorch -c nvidia
```

**或使用 pip：**
```bash
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
```

#### 4. 验证安装

```bash
python -c "import torch; print(f'PyTorch: {torch.__version__}, CUDA: {torch.cuda.is_available()}')"
```

应该显示 CUDA 可用。

## 启动服务

### 方式一：使用项目启动脚本（推荐）

在项目根目录运行：
```bash
start.bat
```

这会同时启动：
- Node.js 后端（端口 3001）
- Python SAM2 服务（端口 7860）
- React 前端（端口 5173）

### 方式二：手动启动

```bash
conda activate sam2
cd server/sam2-service
python app.py
```

服务将在 `http://localhost:7860` 启动。

## API 端点

### GET /health
健康检查端点，返回服务状态和模型加载状态。

### POST /api/auto-label
自动标注接口。

**请求格式：**
- Content-Type: `multipart/form-data`
- 参数：
  - `image`: 图片文件（必需）
  - `text_prompt` (可选): 文本提示词，例如 "person", "car", "dog"
  - `prompt` (可选): 提示词别名，与 text_prompt 功能相同
  - `model_backend` (可选): 推理后端选择（默认 `maskrcnn`）
    - `maskrcnn`: torchvision Mask R-CNN（当前默认）
    - `yolo_seg`: YOLOv8/YOLO11 Seg（全自动实例分割）
    - `sam2_amg`: SAM2 Automatic Mask Generator（全自动分割）
  - `base_score_thresh` (可选): 初始置信度阈值（默认 0.5）
  - `lower_score_thresh` (可选): 兜底置信度下限（默认 0.3）
  - `max_detections` (可选): 最多检测目标数（默认 50）
  - `mask_threshold` (可选): Mask 二值化阈值（影响轮廓紧/松，默认 0.5）
  - `max_polygon_points` (可选): 轮廓最大点数（影响轮廓精细度，默认 80）
  - `yolo_conf` / `yolo_iou` / `yolo_imgsz` / `yolo_max_det` (可选): 仅 `model_backend=yolo_seg` 生效
  - `sam2_points_per_side` / `sam2_pred_iou_thresh` / `sam2_stability_score_thresh` / `sam2_box_nms_thresh` / `sam2_min_mask_region_area` (可选): 仅 `model_backend=sam2_amg` 生效

**响应格式：**
```json
{
  "masks": [
    {
      "id": "mask-1",
      "points": [x1, y1, x2, y2, ...],
      "label": "object",
      "class": "object"
    }
  ],
  "segments": [
    {
      "id": "segment-1",
      "bbox": [x, y, width, height],
      "x": x,
      "y": y,
      "width": width,
      "height": height,
      "points": [x1, y1, x2, y2, ...],
      "contour": [x1, y1, x2, y2, ...],
      "label": "object",
      "class": "object"
    }
  ]
}
```

## 与 Node.js 后端对接

Node.js 后端（`server/index.js`）已配置为连接此服务：

- 默认地址：`http://localhost:7860/api/auto-label`
- 可通过环境变量 `GROUNDED_SAM2_API_URL` 修改
- 如果服务不可用，后端会自动回退到模拟数据

## 当前状态

✅ **当前已接入 torchvision 的 Mask R-CNN（COCO 预训练）**，用于检测与实例分割，并将 mask 轮廓转为多边形点返回给前端。

✅ **已支持可切换后端（同一接口）**
- `maskrcnn`: 现有实现（默认）
- `yolo_seg`: YOLO-Seg（需要额外安装 `ultralytics`）
- `sam2_amg`: 真实 SAM2（需要你本地安装 SAM2 并配置权重路径）

提示：
- 该服务目前不是“原版 Grounded SAM2 权重”，而是以 Mask R-CNN 作为可用的检测/分割后端，保持接口一致，便于后续替换为真正的 Grounded SAM2。
- `mask_threshold` 与 `max_polygon_points` 会直接影响返回轮廓的贴边程度与点数密度，可用于“更保守/更激进”的描边调参。

## 下一步：集成 Grounded SAM2 模型

1. **选择合适的 Grounded SAM2 实现**
   - 推荐：https://github.com/IDEA-Research/Grounded-Segment-Anything-2
   - 或其他社区实现

2. **下载模型权重**
   - SAM2 检查点文件
   - Grounding DINO 检查点文件（如果需要）

3. **在 `app.py` 中实现：**
   - `load_model()` 函数：加载模型权重
   - `auto_label()` 函数中的真实推理逻辑
   - 删除模拟数据代码

## 可选：启用 YOLO-Seg（推荐先试）

1. 安装依赖：

```bash
conda activate sam2
cd server/sam2-service
pip install -r requirements-yolo.txt
```

2. （可选）指定权重：

- 默认会尝试加载 `yolov8n-seg.pt`（ultralytics 可能会自动下载）
- 你也可以设置环境变量 `YOLO_SEG_WEIGHTS` 指向本地权重文件

## 可选：启用真实 SAM2（AMG）

由于不同 SAM2 实现的安装方式不同，本项目采用“按需可选集成”。

- 安装完成后请设置：
  - `SAM2_CHECKPOINT`: checkpoint 文件路径
  - `SAM2_MODEL_CFG`: cfg 名称/路径（默认 `sam2_hiera_l.yaml`，按你安装的 SAM2 实现为准）

4. **测试真实标注效果**

## 注意事项

- 确保端口 7860 未被占用
- GPU 内存使用情况需监控（RTX 4080 通常足够）
- 生产环境应限制 CORS 允许的域名
- 模型权重文件较大，建议使用 `.gitignore` 排除
