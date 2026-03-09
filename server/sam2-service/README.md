# SAM2 API Service

基于 FastAPI 的 **SAM2 Automatic Mask Generator（AMG）** 自动图像标注服务，集成在 Node.js 后端项目中。

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
  - `max_polygon_points` (可选): 轮廓最大点数（影响轮廓精细度，默认 80）
  - `sam2_points_per_side` (可选): points_per_side（默认 32）
  - `sam2_pred_iou_thresh` (可选): pred_iou_thresh（默认 0.88）
  - `sam2_stability_score_thresh` (可选): stability_score_thresh（默认 0.95）
  - `sam2_box_nms_thresh` (可选): box_nms_thresh（默认 0.7）
  - `sam2_min_mask_region_area` (可选): min_mask_region_area（默认 0）

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
- 服务不可用时，Node 后端会直接返回错误（不再回退到模拟数据，避免“乱画”）

## 当前状态

✅ **当前服务仅支持 SAM2（AMG）**：需要你在 `sam2` conda 环境中安装 SAM2 并配置权重路径。

### 必需环境变量

- `SAM2_CHECKPOINT`: checkpoint 文件路径
- `SAM2_MODEL_CFG`: cfg 名称/路径（默认 `configs/sam2/sam2_hiera_l.yaml`；如果你使用本项目自带的 `grounded-sam2` 目录，脚本会自动指向对应文件）

## 注意事项

- 确保端口 7860 未被占用
- GPU 内存使用情况需监控（RTX 4080 通常足够）
- 生产环境应限制 CORS 允许的域名
- 模型权重文件较大，建议使用 `.gitignore` 排除
