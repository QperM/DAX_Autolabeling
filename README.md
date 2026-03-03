# 智能图像标注系统

**版本：V1.6**  
**最后更新：2026年3月3日**

## 项目概述

本项目是一套基于Web的智能图像标注系统，采用React + Node.js技术栈开发。系统提供直观的用户界面和完整的标注工作流程，支持项目管理、图像上传管理、实时预览、标注工具和数据持久化等功能。

## 核心功能

### 项目管理功能

#### 1. 项目管理系统
- ✅ 项目创建、查看、编辑、删除
- ✅ 项目列表展示和管理
- ✅ 项目与图片数据集关联
- ✅ 不同项目对应不同的图片数据集
- ✅ 项目信息持久化存储

#### 2. 项目选择界面
- ✅ 项目列表弹窗展示
- ✅ 项目详情查看（ID、创建时间、更新时间）
- ✅ 快速切换项目
- ✅ 项目删除确认机制

### 前端功能模块

#### 1. 图像加载与管理
- ✅ 单张/批量图片上传（支持拖拽上传）
- ✅ ZIP 压缩包批量上传：自动解压导入多张图片
- ✅ ZIP 解压进度条：上传后显示“上传进度 + 解压进度”，解压完成自动进入“已上传图片”
- ✅ 图片按项目分类管理
- ✅ 已加载图片缩略图网格展示
- ✅ 图片预览和选择功能
- ✅ 图片删除功能（数据库和物理文件同步删除）
- ✅ 图片信息展示（文件名、大小、上传时间）

#### 2. 模块化首页设计
- ✅ 2D Bbox/Mask标注模块选择
- ✅ 9D Pose标注模块预留
- ✅ 项目选择和管理入口
- ✅ 当前项目信息展示

#### 3. 标注工作界面
- ✅ 实时图像预览窗口
- ✅ 专业标注工具栏
- ✅ 标注画布区域
- ✅ 项目图片列表展示
- ✅ AI 分割 Mask 图层切换展示（背景图层 / 标注图层）

#### 4. 标注工具
- ✅ 画笔工具：绘制标注区域（预留接口）
- ✅ 橡皮擦工具：通过可调半径的圆形笔刷挤压 Mask 顶点，实现精细擦除
- ✅ 多边形工具：精确标注
- ✅ 撤销/重做功能
- ✅ 笔刷大小调节（橡皮擦半径支持快捷下拉调节）
- ✅ 支持 Grounded SAM2 生成的 Mask 在前端画布中叠加预览
- ✅ Mask 顶点级编辑：选择工具下支持拖动顶点、删除顶点（Delete）、插入新顶点（I），顶点高亮可视化
- ✅ 整块 Mask 选择：点击/框选高亮，Delete 批量删除，R 批量重命名并按项目保持「标签-颜色」一致
- ✅ 新建 Mask：类似 labelme 的逐点点击闭合生成（默认灰色“未分配”，后续可用选择+R 命名并自动分配颜色）
- ✅ 自动保存：切换图片前可选自动保存当前标注
- ✅ 图片导航：头部按钮与键盘左右方向键切换图片

### 后端功能模块

#### 1. 文件服务
- ✅ 图片文件上传和存储
- ✅ 静态文件服务
- ✅ 文件删除（数据库记录和物理文件同步删除）

#### 2. 数据管理
- ✅ SQLite数据库存储
- ✅ 项目数据管理（projects表）
- ✅ 图片元数据管理（images表，自增ID）
- ✅ 项目-图片关联表（project_images表）
- ✅ 标注数据持久化（annotations表）
- ✅ 外键约束和级联删除
- ✅ RESTful API接口

#### 3. API接口
- ✅ 项目管理API（CRUD操作）
- ✅ 图片上传API（支持项目关联）
- ✅ 图片查询API（支持按项目筛选）
- ✅ 图片删除API（同步删除数据库和文件）
- ✅ 标注数据API（保存、查询、更新）
- ✅ AI 自动标注参数透传：前端滑杆（按项目保存）→ Node → Python 服务（真实生效）

## 技术架构

### 前端技术栈
- **框架**: React 19 + TypeScript
- **构建工具**: Vite 7
- **状态管理**: Redux Toolkit
- **UI组件**: 原生CSS + React组件
- **文件上传**: React Dropzone
- **路由**: React Router DOM 7
- **画布渲染**: Konva + React Konva
- **HTTP客户端**: Axios

### 后端技术栈
- **框架**: Node.js + Express 4
- **数据库**: SQLite3（带外键约束）
- **文件处理**: Multer + adm-zip（ZIP 解压）
- **跨域支持**: CORS
- **图片处理**: image-size
- **AI 标注服务**: Python FastAPI + Grounded SAM2 服务框架（当前接入 torchvision Mask R-CNN COCO 预训练模型作为检测/分割后端，集成在 `server/sam2-service/`）

## 项目结构

```
DAXautolabeling/
├── client/                 # 前端React应用
│   ├── src/
│   │   ├── components/    # 组件目录
│   │   │   ├── AnnotationCanvas.tsx  # 标注画布组件
│   │   │   ├── AnnotationPage.tsx     # 标注页面组件
│   │   │   ├── ImageList.tsx         # 图像列表组件
│   │   │   ├── ImageUploader.tsx     # 图像上传组件
│   │   │   ├── LandingPage.tsx       # 首页导览组件
│   │   │   ├── ManualAnnotation.tsx  # 手动标注组件
│   │   │   └── *.css                 # 样式文件
│   │   ├── services/      # API服务
│   │   │   └── api.ts                # 后端API接口
│   │   ├── store/         # 状态管理
│   │   │   ├── annotationSlice.ts    # 标注状态切片
│   │   │   └── index.ts              # Store配置
│   │   ├── types/         # 类型定义
│   │   │   └── index.ts              # TypeScript类型
│   │   ├── App.tsx        # 主应用组件
│   │   ├── App.css        # 样式文件
│   │   └── main.tsx       # 入口文件
├── server/                # 后端服务
│   ├── index.js           # Node.js 服务器入口
│   ├── database.js        # 数据库操作
│   ├── package.json       # 后端依赖配置
│   ├── uploads/           # 上传文件存储目录
│   ├── sam2-service/      # Grounded SAM2 API 服务（Python）
│   │   ├── app.py         # FastAPI 服务主文件
│   │   ├── requirements.txt # Python 依赖
│   │   ├── README.md      # SAM2 服务说明
│   │   └── start_sam2.bat # SAM2 服务启动脚本
│   └── *.js               # 工具脚本
├── database/              # 数据库文件目录
│   └── annotations.db     # SQLite数据库文件
├── README.md              # 项目说明文档
└── start.bat             # 一键启动脚本
```

## 数据库设计

### 表结构

#### projects 表
- `id`: INTEGER PRIMARY KEY AUTOINCREMENT（项目ID）
- `name`: TEXT NOT NULL UNIQUE（项目名称）
- `description`: TEXT（项目描述）
- `created_at`: DATETIME（创建时间）
- `updated_at`: DATETIME（更新时间）

#### images 表
- `id`: INTEGER PRIMARY KEY AUTOINCREMENT（图片ID）
- `filename`: TEXT NOT NULL（存储文件名）
- `original_name`: TEXT NOT NULL（原始文件名）
- `file_path`: TEXT NOT NULL（文件路径）
- `file_size`: INTEGER（文件大小）
- `upload_time`: TEXT NOT NULL（上传时间）

#### project_images 表（关联表）
- `id`: INTEGER PRIMARY KEY AUTOINCREMENT
- `project_id`: INTEGER NOT NULL（项目ID，外键）
- `image_id`: INTEGER NOT NULL（图片ID，外键）
- `added_at`: DATETIME（关联时间）
- UNIQUE(project_id, image_id)

#### annotations 表
- `id`: TEXT PRIMARY KEY（标注ID）
- `image_id`: INTEGER NOT NULL（图片ID，外键，级联删除）
- `mask_data`: TEXT（Mask数据，JSON格式）
- `bbox_data`: TEXT（边界框数据，JSON格式）
- `polygon_data`: TEXT（多边形数据，JSON格式）
- `labels`: TEXT（标签信息，JSON格式）
- `created_at`: TEXT（创建时间）
- `updated_at`: TEXT（更新时间）

## 快速开始

### 环境要求
- Node.js 16+ 
- npm 8+

### 安装与运行

1. **克隆项目**
```bash
git clone <repository-url>
cd DAXautolabeling
```

2. **安装后端依赖**
```bash
cd server
npm install
```

3. **安装前端依赖**
```bash
cd ../client
npm install
```

4. **配置 Python 环境（用于 Grounded SAM2 AI 标注服务）**
```bash
# 创建 conda 环境
conda create -n sam2 python=3.10 -y
conda activate sam2

# 安装 Python 依赖
cd server/sam2-service
pip install -r requirements.txt

# 安装 PyTorch（CUDA 12.1，支持 RTX 4080）
conda install pytorch torchvision torchaudio pytorch-cuda=12.1 -c pytorch -c nvidia

# 验证安装
python -c "import torch; print(f'PyTorch: {torch.__version__}, CUDA: {torch.cuda.is_available()}')"
```

5. **启动服务**

**方式一：分别启动**
```bash
# 终端1：启动后端服务
cd server
npm run dev
# 后端服务将运行在 http://localhost:3001

# 终端2：启动前端应用
cd client
npm run dev
# 前端应用将运行在 http://localhost:5173
```

**方式二：使用批处理文件一键启动（Windows）**
```bash
start.bat
```
这会同时启动：
- Node.js 后端服务（端口 3001）
- Grounded SAM2 API 服务（端口 7860）
- React 前端应用（端口 5173）

**注意：首次使用需要配置 Python 环境**
```bash
# 1. 创建 conda 环境
conda create -n sam2 python=3.10 -y
conda activate sam2

# 2. 安装 Python 依赖
cd server/sam2-service
pip install -r requirements.txt

# 3. 安装 PyTorch（CUDA 12.1，支持 RTX 4080）
conda install pytorch torchvision torchaudio pytorch-cuda=12.1 -c pytorch -c nvidia
```

### 数据库初始化

数据库会在首次运行时自动创建。如果数据库文件不存在，系统会自动：
- 创建 `database/annotations.db` 数据库文件
- 创建所有必要的表结构
- 启用外键约束

### 使用流程

1. **访问首页** (`http://localhost:5173`)
2. **创建或选择项目**
   - 点击"新建项目"创建新项目
   - 或点击"选择项目"从现有项目中选择
3. **选择标注模块**（2D Bbox/Mask标注）
4. **点击"开始标注工作"**进入主界面
5. **上传图片文件**（支持拖拽上传）
   - 图片会自动关联到当前项目
6. **在预览区域查看和选择图片**
7. **使用标注工具进行标注操作**
8. **实时预览标注效果**

## API接口文档

### 项目管理接口

- `GET /api/projects` - 获取所有项目列表
- `POST /api/projects` - 创建新项目
- `GET /api/projects/:id` - 获取项目详情
- `PUT /api/projects/:id` - 更新项目信息
- `DELETE /api/projects/:id` - 删除项目（级联删除关联数据）

### 图片管理接口

- `POST /api/upload` - 上传图片/ZIP（支持多文件，可关联项目；ZIP 将异步解压导入图片并返回 jobId）
- `GET /api/upload-jobs/:jobId` - 查询 ZIP 解压进度与结果（completed 时返回解压出的图片列表）
- `GET /api/images` - 获取图片列表（支持按项目筛选：?projectId=xxx）
- `DELETE /api/images/:id` - 删除图片（同步删除数据库记录和物理文件）

### 标注数据接口

- `POST /api/annotations/:imageId` - 保存标注数据
- `GET /api/annotations/:imageId` - 获取标注数据
- `PUT /api/annotations/:imageId` - 更新标注数据
- `POST /api/annotate/auto` - 自动标注（已接入 Python AI 服务，可选传参）

#### `POST /api/annotate/auto` 请求示例

```json
{
  "imageId": 123,
  "prompt": "person, dog",
  "modelParams": {
    "baseScoreThresh": 0.5,
    "lowerScoreThresh": 0.3,
    "maxDetections": 50,
    "maskThreshold": 0.5,
    "maxPolygonPoints": 80
  }
}
```

说明：
- `prompt` 为空则尝试识别常见目标
- `modelParams` 会在前端按项目保存（`localStorage` 的 `modelParams:<projectId>`）
- `maskThreshold` 会影响轮廓“更紧/更松”，`maxPolygonPoints` 影响轮廓精细度（点数越多越贴边但更重）

## 功能特性

### 项目管理
- 多项目支持，不同项目对应不同的图片数据集
- 项目信息持久化存储
- 项目切换和快速访问
- 项目删除时自动清理关联数据

### 数据管理
- 自增数字ID，避免ID冲突
- 外键约束保证数据完整性
- 级联删除确保数据一致性
- 图片删除时同步删除物理文件

### 用户体验
- 响应式设计，适配不同屏幕尺寸
- 直观的拖拽上传体验
- 专业的界面布局
- 实时预览标注效果
- 流畅的操作反馈
- 详细的调试日志

### 技术特色
- 基于Redux Toolkit的状态管理
- TypeScript类型安全
- RESTful API设计
- SQLite轻量级数据库存储
- 外键约束和级联删除
- 完整的错误处理和日志记录

## 开发进展

### V1.4 最新功能（2026年3月2日）
- [x] 在人工标注页面接入统一的标注画布组件 `AnnotationCanvas`，支持在原图上叠加显示分割 Mask / 边界框 / 多边形
- [x] 新增“背景图层 / 标注图层”切换逻辑，可一键隐藏/显示 SAM2 生成的 Mask 图层
- [x] 保持与 AI 标注预览弹窗的坐标与缩放一致，确保 Mask 轮廓与实际目标位置精准对齐
- [x] 橡皮擦重构：支持可视化圆形笔刷、拖拽擦除，并通过悬浮下拉调节半径
- [x] Mask 顶点编辑：在选择工具下支持顶点高亮、拖动微调、键盘 Delete 删除顶点、键盘 I 在相邻顶点之间插入新顶点

### V1.5 最新功能（2026年3月3日）
- [x] ZIP 压缩包批量上传：上传后自动解压导入多张图片并写入数据库
- [x] ZIP 解压进度条：前端展示“上传进度 + 解压进度”，解压完成自动进入“已上传图片”
- [x] 新增解压 job 查询接口：`GET /api/upload-jobs/:jobId`
- [x] 已上传图片缩略图虚拟滚动：类似 Windows 文件管理器，仅渲染视口范围缩略图
- [x] 缩略图 Mask 预览开关（默认关闭），开启后会预加载视口内缩略图的 Mask
- [x] 项目级「标签-颜色」一致性：同一标签在同一项目中保持同色（前端 `localStorage` 持久化）
- [x] AI 模型参数弹窗：支持调节检测阈值/目标数，并新增 `maskThreshold`（描边紧/松）、`maxPolygonPoints`（轮廓精细度）

### V1.3 最新功能（2026年3月2日）
- [x] 在 Python AI 服务中接入真实检测/分割模型（torchvision Mask R-CNN COCO 预训练），替代纯模拟多边形
- [x] 支持通过提示词（prompt）过滤类别（例如：person, car 等），并打通前端提示词输入框 → Node → Python 全链路
- [x] 批量 AI 标注改为调用真实模型推理，自动保存结果到数据库（同一图片多次批量标注会覆盖上一版 AI 结果）
- [x] 为模型输出增加置信度阈值、多轮筛选和兜底逻辑，在难图像上尽量保证至少返回一个合理目标

### V1.2 最新功能（2026年3月2日）
- [x] 集成 Grounded SAM2 API 服务（Python FastAPI）
- [x] 统一启动脚本（Node.js + Python + React）
- [x] AI 自动标注服务框架（当前返回模拟数据，待模型集成）

### V1.1 功能（2026年3月2日）
- [x] 项目管理系统（创建、查看、编辑、删除）
- [x] 项目与图片数据集关联
- [x] 图片按项目分类管理
- [x] 图片删除功能（数据库和文件同步删除）
- [x] 自增数字ID系统
- [x] 外键约束和级联删除
- [x] 详细的调试日志系统
- [x] UI优化和布局调整

### V1.0 基础功能
- [x] 基础图像上传和管理
- [x] 模块化首页设计
- [x] 图片预览和选择功能
- [x] 基础标注工具（画笔、橡皮擦、多边形）
- [x] 撤销/重做功能
- [x] 状态管理和数据持久化

### 待完善功能
- [ ] 集成真正的 Grounded SAM2 模型与权重（当前使用 Mask R-CNN 作为基础检测/分割后端）
- [ ] 9D Pose标注模块开发
- [ ] 9D Pose标注模块开发
- [ ] 标注数据导出功能（JSON、COCO格式等）
- [ ] 更丰富的标注工具
- [ ] 批量操作功能
- [ ] 用户权限管理系统
- [ ] 标注数据版本管理

## 注意事项

1. **数据库管理**：代码只负责创建表结构，不会自动删除表。如需清理数据，请手动删除数据库文件或使用SQL命令。

2. **文件存储**：上传的图片文件存储在 `server/uploads/` 目录下，请确保该目录有写入权限。

3. **外键约束**：系统已启用SQLite外键约束，删除项目或图片时会自动级联删除关联数据。

4. **调试信息**：系统在关键操作点都添加了详细的调试日志，便于排查问题。

## 许可证

本项目仅供学习和研究使用。

## 联系方式

如有问题或建议，请提交Issue或Pull Request。
