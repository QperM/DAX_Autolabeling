# 智能图像标注系统

**版本：V2.4**  
**最后更新：2026年3月21日**

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
- ✅ ZIP 解压进度条：上传后显示"上传进度 + 解压进度"，解压完成自动进入"已上传图片"
- ✅ 图片按项目分类管理
- ✅ 已加载图片缩略图网格展示
- ✅ 图片预览和选择功能
- ✅ 图片删除功能（数据库和物理文件同步删除）
- ✅ 图片信息展示（文件名、大小、上传时间）
- ✅ **标注数据导入导出**：支持将项目标注数据导出为 JSON 格式，并可导入 JSON 文件恢复标注（按图片名称匹配）

#### 2. 模块化首页设计
- ✅ 2D Bbox/Mask标注模块选择
- ✅ 9D Pose标注模块入口（已开始开发）
- ✅ 项目选择和管理入口
- ✅ 当前项目信息展示

#### 2.1 9D Pose（开发中）
- ✅ Mesh（OBJ）导入与管理：支持按项目上传/列表展示
- ✅ Mesh 资源包兼容：解析 OBJ 内 `mtllib`，并加载同目录 MTL/贴图资源
- ✅ 3D 预览：基于 Three.js 的交互预览（OrbitControls、光照/网格、自动居中与缩放）
- ✅ Mesh 缩略图：列表中静态截图预览（自动取景 + 可调视角偏移/拉远）
- ✅ **Mesh 上传器优化**：拆分为 Mesh 和 Depth 两个独立上传模块，不同背景色区分
- ✅ **Diff-DOPE 6D 姿态接入（单 Mesh / 批量）**：
  - Pose 入口页支持单图触发 `AI 6D姿态标注`
  - 支持 `🤖 批量AI标注`：按图片顺序逐张执行，单图 5 分钟超时后自动跳过并继续
  - 批量流程提供实时进度条（当前进度、成功/失败/超时计数）
  - 两阶段参数可独立调节（第一轮粗定位、第二轮精修），并按项目保存
  - 第二轮支持质量门槛（超阈值判定失败，不写入结果/拟合图）
  - 第二轮支持学习率调节（`base_lr` / `lr_decay`）与可选 RGB 纹理约束
  - 拟合结果图采用固定命名覆盖写入（同 image+mesh 不产生重复文件）
  - Pose 预览区支持左上角切换 `原图 / 拟合图` 进行结果比对
- ✅ **深度数据管理**：支持 PNG/TIFF/NPY 格式深度数据上传和管理

#### 3. 标注工作界面
- ✅ 实时图像预览窗口
- ✅ 专业标注工具栏
- ✅ 标注画布区域
- ✅ 项目图片列表展示
- ✅ **图层切换功能**：支持背景图层 / 标注图层（Mask+BoundingBox） / 仅 BoundingBox 图层三种模式切换
- ✅ AI 分割 Mask 图层切换展示（背景图层 / 标注图层）
- ✅ **图层切换优化**：
  - 切换图片时自动加载当前图片对应的图层数据
  - Mask 图层切换时正确加载和显示 2D 标注数据
  - 修复图层切换时的数据加载竞态问题

#### 4. 标注工具
- ✅ 画笔工具：绘制标注区域（预留接口）
- ✅ 橡皮擦工具：通过可调半径的圆形笔刷挤压 Mask 顶点，实现精细擦除
- ✅ 多边形工具：精确标注
- ✅ 撤销/重做功能
- ✅ 笔刷大小调节（橡皮擦半径支持快捷下拉调节）
- ✅ 支持 Grounded SAM2 生成的 Mask 在前端画布中叠加预览
- ✅ Mask 顶点级编辑：选择工具下支持拖动顶点、删除顶点（Delete）、插入新顶点（I），顶点高亮可视化
- ✅ 整块 Mask 选择：点击/框选高亮，Delete 批量删除，R 批量重命名并按项目保持「标签-颜色」一致
- ✅ 新建 Mask：类似 labelme 的逐点点击闭合生成（默认灰色"未分配"，后续可用选择+R 命名并自动分配颜色）
- ✅ **BoundingBox 图层独立显示**：支持单独查看 BoundingBox 标注，便于快速检查边界框标注质量
- ✅ **重命名下拉框优化**：
  - 下拉框背景色动态显示当前选中标签的颜色
  - 选项列表按最近使用顺序排序，最近使用的标签优先显示
  - 项目级标签-颜色映射自动同步，导入数据后立即显示所有标签
- ✅ **颜色扩展**：标签颜色调色板从 8 种扩展到 30 种，支持更多标签的区分
- ✅ 自动保存：切换图片前可选自动保存当前标注（默认开启）
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
- **AI 标注服务**: Python FastAPI + **SAM2 AMG** 自动分割服务（仅保留 SAM2），集成在 `server/sam2-service/`，并通过 Node 转发统一为 `/api/annotate/auto`

## 项目结构

```
DAX_Autolabeling/
├── client/                 # 前端React应用
│   ├── src/
│   │   ├── components/    # 组件目录
│   │   │   ├── AnnotationCanvas.tsx  # 标注画布组件
│   │   │   ├── AnnotationPage.tsx     # 标注页面组件
│   │   │   ├── PoseAnnotationPage.tsx # 9D Pose 标注页面（Mesh/图片预览）
│   │   │   ├── ImageList.tsx         # 图像列表组件
│   │   │   ├── ImageUploader.tsx     # 图像上传组件
│   │   │   ├── LandingPage.tsx       # 首页导览组件
│   │   │   ├── ManualAnnotation.tsx  # 手动标注组件
│   │   │   ├── DepthUploader.tsx     # Depth 上传组件
│   │   │   ├── MeshUploader.tsx      # Mesh 上传组件（OBJ/资源）
│   │   │   ├── MeshPreview3D.tsx     # 3D Mesh 预览组件（Three.js）
│   │   │   ├── MeshThumbnail.tsx     # Mesh 缩略图组件（静态截图）
│   │   │   └── *.css                 # 样式文件
│   │   ├── services/      # API服务
│   │   │   └── api.ts                # 后端API接口
│   │   ├── poseAutoOpen3D.ts       # Pose 页面状态辅助工具
│   │   ├── store/         # 状态管理
│   │   │   ├── annotationSlice.ts    # 标注状态切片
│   │   │   └── index.ts              # Store配置
│   │   ├── types/         # 类型定义
│   │   │   └── index.ts              # TypeScript类型
│   │   ├── App.tsx        # 主应用组件
│   │   ├── App.css        # 样式文件
│   │   └── main.tsx       # 入口文件
├── server/                # 后端服务
│   ├── index.js           # 路由注册中心（Express）
│   ├── bootstrap.js       # 启动/初始化入口（等待 DB schema 完成）
│   ├── package.json       # 后端依赖配置
│   ├── uploads/           # 上传文件存储目录
│   ├── db/                # SQLite 连接 + schema 初始化 + repo 层
│   ├── middleware/        # 权限校验中间件
│   ├── routes/            # 业务路由集合（projects/uploads/images/pose/...）
│   ├── utils/             # 工具函数（uploads/depth naming/OBJ bbox 等）
│   ├── sam2-service/      # Grounded SAM2 API 服务（Python FastAPI）
│   │   ├── app.py         # FastAPI 服务主文件
│   │   ├── requirements.txt # Python 依赖
│   │   ├── README.md      # SAM2 服务说明
│   │   └── setup.bat      # SAM2 服务启动/安装脚本
│   ├── pose-service/      # 6D/姿态服务（例如 Diff-DOPE 相关）
│   └── nodemon.json       # 开发模式热重载配置
├── database/              # 数据库文件目录
│   └── annotations.db     # SQLite数据库文件
└── README.md              # 项目说明文档
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

（当前仓库已移除 `start.bat`，请按“方式一”分别启动后端与前端，Grounded SAM2 按需单独启动/运行。）

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
  "modelParams": {
    "maxPolygonPoints": 120,
    "sam2PointsPerSide": 32,
    "sam2PredIouThresh": 0.5,
    "sam2StabilityScoreThresh": 0.8,
    "sam2BoxNmsThresh": 0.6,
    "sam2MinMaskRegionArea": 100
  }
}
```

说明：
- 当前后端自动标注接口使用 `imageId + modelParams`（`prompt` 字段暂未使用，可忽略）
- `modelParams` 会在前端按项目保存（`localStorage` 的 `modelParams:<projectId>`）
- 主要控制：轮廓精细度（`maxPolygonPoints`）与 SAM2 掩码筛选阈值（`sam2*Thresh`）

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

## 更新记录

详细的版本/功能更新记录见 `UPDATES.md`。

## 注意事项

1. **数据库管理**：代码只负责创建表结构，不会自动删除表。如需清理数据，请手动删除数据库文件或使用SQL命令。

2. **文件存储**：上传的图片文件存储在 `server/uploads/` 目录下，请确保该目录有写入权限。

3. **外键约束**：系统已启用SQLite外键约束，删除项目或图片时会自动级联删除关联数据。

4. **调试信息**：系统在关键操作点都添加了详细的调试日志，便于排查问题。

## 许可证

本项目仅供学习和研究使用。

## 联系方式

如有问题或建议，请提交Issue或Pull Request。
