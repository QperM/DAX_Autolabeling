# Grounded SAM2 服务集成说明

## 集成状态

✅ **已完成基础框架集成**

Grounded SAM2 API 服务已成功集成到现有项目中，位于 `server/sam2-service/` 目录。

## 当前功能

### ✅ 已实现

1. **FastAPI 服务框架**
   - 服务监听在 `http://localhost:7860`
   - 提供健康检查端点 `/health`
   - 提供自动标注端点 `/api/auto-label`

2. **与 Node.js 后端对接**
   - Node.js 后端已配置默认连接地址：`http://localhost:7860/api/auto-label`
   - 支持通过环境变量 `GROUNDED_SAM2_API_URL` 自定义地址
   - 如果服务不可用，后端自动回退到模拟数据

3. **统一启动脚本**
   - `start.bat` 已更新，可同时启动：
     - Node.js 后端（端口 3001）
     - Python SAM2 服务（端口 7860）
     - React 前端（端口 5173）

4. **返回数据格式**
   - 符合 Node.js 后端解析要求
   - 包含 `masks` 和 `segments` 数组
   - 支持多种响应格式解析

### ⚠️ 待完成

1. **模型集成**
   - 当前返回模拟数据
   - 需要集成真实的 Grounded SAM2 模型
   - 需要实现模型加载和推理逻辑

## 项目结构

```
server/
├── index.js              # Node.js 后端（已配置连接 SAM2 服务）
├── sam2-service/         # Python FastAPI 服务
│   ├── app.py           # FastAPI 主文件
│   ├── requirements.txt # Python 依赖
│   ├── README.md        # 服务说明
│   ├── start_sam2.bat  # 独立启动脚本
│   └── INTEGRATION.md  # 本文件
└── ...
```

## 对接关系

### Node.js 后端 → Python SAM2 服务

**调用位置：** `server/index.js` 第 282 行
```javascript
const GROUNDED_SAM2_API_URL = process.env.GROUNDED_SAM2_API_URL || 'http://localhost:7860/api/auto-label';
```

**调用方式：**
- HTTP POST 请求
- multipart/form-data
- 字段：`image`（文件）、`text_prompt`（可选）

**返回格式要求：**
- `masks`: 数组，包含 `points` 和 `label`
- `segments`: 数组，包含 `bbox`、`points`、`label`

### 错误处理

- 如果 SAM2 服务不可用（ECONNREFUSED、ETIMEDOUT），Node.js 后端会：
  1. 记录详细错误日志
  2. 自动回退到模拟数据
  3. 返回标注结果（使用模拟数据）

## 下一步工作

### 1. 安装 Python 环境

```bash
conda create -n sam2 python=3.10 -y
conda activate sam2
cd server/sam2-service
pip install -r requirements.txt
conda install pytorch torchvision torchaudio pytorch-cuda=12.1 -c pytorch -c nvidia
```

### 2. 测试当前集成

```bash
# 启动所有服务
start.bat

# 在前端点击"开始AI标注"
# 应该能看到：
# - Node.js 后端调用 SAM2 服务
# - SAM2 服务返回模拟数据
# - 前端显示标注结果
```

### 3. 集成真实模型

1. 选择合适的 Grounded SAM2 实现
2. 下载模型权重
3. 在 `app.py` 的 `load_model()` 中实现模型加载
4. 在 `auto_label()` 中实现真实推理
5. 删除模拟数据代码

## 测试验证

### 健康检查
```bash
curl http://localhost:7860/health
```

### 标注接口测试
使用 PowerShell：
```powershell
$imagePath = "server\uploads\images-1772422443126-869128005.png"
$formData = @{
    image = Get-Item $imagePath
    text_prompt = "person"
}
Invoke-RestMethod -Uri "http://localhost:7860/api/auto-label" -Method Post -Form $formData
```

## 注意事项

1. **端口冲突**：确保 7860 端口未被占用
2. **环境变量**：如需修改服务地址，设置 `GROUNDED_SAM2_API_URL`
3. **GPU 支持**：确保 CUDA 可用，否则性能会大幅下降
4. **模型权重**：模型文件较大，建议使用 `.gitignore` 排除

## 相关文档

- `server/sam2-service/README.md` - 服务详细说明
- `README.md` - 项目主文档
- `server/index.js` - Node.js 后端对接代码
