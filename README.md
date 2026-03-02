# 智能图像标注系统

**版本：V1.1**  
**最后更新：2026年3月2日**

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

#### 4. 标注工具
- ✅ 画笔工具：绘制标注区域
- ✅ 橡皮擦工具：清除标注
- ✅ 多边形工具：精确标注
- ✅ 撤销/重做功能
- ✅ 笔刷大小调节

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
- **文件处理**: Multer
- **跨域支持**: CORS
- **图片处理**: image-size

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
│   ├── index.js           # 服务器入口
│   ├── database.js        # 数据库操作
│   ├── package.json       # 后端依赖配置
│   ├── uploads/           # 上传文件存储目录
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

4. **启动服务**

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

- `POST /api/upload` - 上传图片（支持多文件，可关联项目）
- `GET /api/images` - 获取图片列表（支持按项目筛选：?projectId=xxx）
- `DELETE /api/images/:id` - 删除图片（同步删除数据库记录和物理文件）

### 标注数据接口

- `POST /api/annotations/:imageId` - 保存标注数据
- `GET /api/annotations/:imageId` - 获取标注数据
- `PUT /api/annotations/:imageId` - 更新标注数据
- `POST /api/annotate/auto` - 自动标注（预留接口）

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

### V1.1 最新功能（2026年3月2日）
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
- [ ] 自动化标注算法集成（SAM3等）
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
