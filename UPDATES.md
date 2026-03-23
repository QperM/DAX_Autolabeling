# 更新记录

## 开发进展

### V2.7 最新进展（2026年3月23日）
- [x] **仓库卫生与文档**：
  - 更新根目录 `.gitignore`：Python `__pycache__`/venv、pose-service `debug_outputs`、`diff-dope` 本地 `outputs`/`multirun`、`tempfile/` 等，减少误提交
  - `README.md` 升至 **V2.7**，补充同图多 Mesh **合成拟合图层**（`render-fit-overlay` + `fit_image_*_composite.png`）说明
- [x] **pose-service（`app.py`）**：
  - 合成回渲与 `estimate6d` 共用内参/场景配置辅助函数；`render_images.flip_result` 以 `diffdope.yaml` 为准，避免与磁盘 RGB 行序不一致
  - 仅渲染路径保留唯一 OpenCV→GL 位姿转换 `_cv_pose44_to_gl_rt`，与 Node 存库的 `pose44` 约定一致

### V2.3 最新进展（2026年3月22日）
- [x] **成功接入 Diff-DOPE（单 Mesh 6D 姿态）**：
  - Pose 页面新增 `AI 6D姿态标注` 入口，支持对当前图片执行 6D 姿态推理
  - 采用与本地验证脚本一致的两阶段优化流程（粗定位 + 精修）
  - 拟合结果图落盘到 `server/uploads/project_<id>/pose-fit-overlays/`
  - 数据库存储拟合图相对路径，并在人工标注页“拟合图层”读取展示
- [x] **人工标注显示一致性优化**：
  - RGB / 深度 / 拟合图层统一按 RGB 显示区域渲染，缩放比例保持一致
  - 拟合图层拆分为独立组件 `PoseFitLayer.tsx`
- [x] **点云预览与多 Mesh 交互增强**：
  - Pose 人工标注页恢复并完善“点云图层”，支持在 3D 点云中叠加 Mesh
  - 新增 `添加 Mesh` 弹窗：可在同一张图片中连续导入多个 Mesh 到场景，不再互相覆盖
  - 新增真实贴图开关：`真实贴图`（ON）与骨架线框（OFF）快速切换，便于观察模型结构
  - 支持矩阵面板拖拽与交互修复：拖拽坐标系改为容器坐标，消除“拖动起跳”
  - 保存入口统一到右侧属性面板：`保存位置` 按钮写回当前激活 Mesh 的 pose44 到数据库
  - 图层互斥逻辑更新：开启点云图层自动关闭 RGB/Mask/深度/拟合；开启任一 2D 图层自动关闭点云

### V2.2 最新进展（2026年3月21日）
- [x] **9D Pose 页面功能收敛（按当前验收范围精简）**：
  - 删除 Pose 入口页的“确定初始位姿”与“6D姿态推测”按钮及其前端调用链
  - 删除 Pose 入口页中的“Pose 预览（后续将支持：mesh 渲染、深度叠加、姿态结果）”占位文案
  - 删除人工标注页“拟合图层”“点云图层”入口及其关联状态/副作用逻辑
  - 人工标注页当前仅保留 RGB / Mask / 深度 三类图层
- [x] **组件与死代码清理**：
  - 删除 `PoseInitialPoseButton.tsx`
  - 删除 `Pose6dEstimateButton.tsx`
  - 删除 `PoseFitOverlay.tsx`
  - 删除 `PointCloudPreview3D.tsx`
  - 删除 `PointCloudMeshInteraction.tsx`
- [x] **文档同步**：
  - `README.md` 升级为 `V2.2`，并同步当前可用功能与目录结构

### V2.1 最新进展（2026年3月20日）
- [x] **9D Pose 标注功能完善**：
  - Mesh 上传器拆分为 Mesh 和 Depth 两个独立模块，不同背景色区分
  - 修复 Mesh 缩略图显示为黑色的问题（使用 MeshBasicMaterial 和 LoadingManager）
  - 实现多 Mesh 9D Pose 标注：支持在同一图片中标注多个 Mesh 的位置、旋转、缩放
  - 9D Pose 数据按图片和 Mesh 正确保存和加载，切换图片时自动恢复对应 Mesh 位置
  - 支持在 3D 预览中点击选择 Mesh，并绑定 TransformControls 进行编辑
  - 修复 TransformControls 在 translate 模式下 scale 异常变化的问题
  - 修复切换 Mesh 时位置重叠的问题（通过 meshUrl 正确关联 transform）
  - 移除调试日志，添加手动保存成功提示
  - 修复 WebGL 上下文警告（Too many active WebGL contexts）
- [x] **图层切换功能优化**：
  - 修复点云图层切换问题：切换图片时自动加载对应深度数据并选择第一个 depth_raw (.npy)
  - 修复 Mask 图层显示问题：正确解析 API 响应结构（`resp.annotation.masks`）和 SVG polygon points 格式
  - 移除"当前 2D 标注：Mask ..."显示文本，简化界面
  - 修复深度图层和 Mask 图层切换时的数据加载竞态问题（使用 requestId 防串台）
- [x] **代码解耦合（可维护性增强）**：
  - 后端将数据库层抽离到 `server/db/`（connection/schema + repo），并通过 `server/bootstrap.js` 等待 schema 初始化完成后再对外提供服务
  - 将路由注册从原本的单入口逻辑中拆出：`server/index.js` 仅负责统一注册各业务路由（`server/routes/*`），权限校验放到 `server/middleware/`
  - 统一把工具逻辑收敛到 `server/utils/`（如 uploads 路径、depth 命名解析、OBJ bbox 计算等），减少跨模块重复
  - 前端将 6D/9D Pose 的关键流程继续组件化：Depth/Mesh 上传拆为 `DepthUploader`/`MeshUploader`，6D 推测拆为 `Pose6dEstimateButton`，初始位姿拆为 `PoseInitialPoseButton`
  - 3D 交互与 overlay 渲染逻辑进一步解耦：点云/mesh 交互抽离为 `PointCloudMeshInteraction` hook，overlay 缓存与自动打开封装为 `diffdopeOverlayCache` / `poseAutoOpen3D`

### V2.0 最新进展（2026年3月11日）
- [x] **9D Pose 模块启动开发**：
  - 新增 9D Pose 标注页面与底部 Mesh 列表视图
  - 支持按项目上传/管理 OBJ Mesh，并返回同目录资源文件列表（MTL/贴图等）
  - Three.js 3D 预览：OrbitControls、光照/网格、自动居中缩放
  - Mesh 缩略图：自动取景，并支持视角偏移/拉远以获得更完整的模型展示
  - 贴图加载链路增强：兼容大小写差异与同目录资源加载（开发环境下 `/uploads` 资源指向后端）

### V1.9 最新功能（2026年3月9日）
- [x] **管理员系统**：
  - 增加管理员登录入口与会话管理（基于 `express-session`）
  - 支持管理员创建项目、生成和重置项目验证码
  - 普通用户通过验证码访问项目，管理员拥有全部项目的管理与标注权限
  - 前端根据管理员/普通用户角色动态展示不同入口（如项目创建、图片上传、调用批量AI标注等）

### V1.8 最新功能（2026年3月4日）
- [x] **标注数据导入导出功能**：支持将整个项目的标注数据（Mask、BoundingBox、Polygon）导出为 JSON 格式，并可导入 JSON 文件恢复标注（按图片名称自动匹配）
- [x] **颜色调色板扩展**：将标签颜色调色板从 8 种扩展到 30 种，支持更多标签的视觉区分
- [x] **BoundingBox 图层独立显示**：在手动标注界面新增"仅 BoundingBox"图层模式，可单独查看边界框标注
- [x] **重命名下拉框优化**：
  - 下拉框背景色动态显示当前标签颜色，选项列表也显示对应颜色
  - 按最近使用顺序排序标签，提升操作效率
  - 导入数据后立即同步所有项目级标签-颜色映射
- [x] **自动保存功能优化**：默认开启自动保存，UI 更醒目（绿色高亮显示）

### V1.7 最新功能（2026年3月3日）
- [x] Python AI 服务接入可切换的多种实例分割后端：`modelBackend=maskrcnn / yolo_seg / sam2_amg`
- [x] SAM2 AMG 集成：通过 `SAM2_CHECKPOINT` + `SAM2_MODEL_CFG` 加载官方 SAM2 模型，并在前端下拉选择
- [x] YOLO-Seg 集成：支持 YOLO 端到端实例分割，前端可配置置信度、IoU、输入尺寸、最大检测数
- [x] 模型参数弹窗重构：根据当前后端只展示相关参数（Mask R-CNN / YOLO-Seg / SAM2 AMG 各自一组滑杆）
- [x] 外观聚类：在 Mask R-CNN 输出上按颜色 + 形状 + 位置 + 姿态做层次聚类，并支持“外观聚类距离阈值”滑杆调节
- [x] 前端 `Mask Label 对照表`：项目级维护「颜色 → label」映射，支持统一修改同色 Mask 的标签
- [x] 批量 AI 标注结果展示优化：改为只展示“成功 / 失败”数量，移除总数，界面更简洁
- [x] 手动标注体验优化：默认进入“标注图层”；多边形闭合后自动弹出重命名框；新建 Mask 默认更高不透明度

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
- [x] （旧版）支持通过提示词（prompt）过滤类别（例如：person, car 等），并打通前端提示词输入框 → Node → Python 全链路；当前 `/api/annotate/auto` 的主要入参为 `imageId + modelParams`，`prompt` 可忽略
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
- [ ] 进一步优化 SAM2 推理性能（大图显存控制、多图批处理能力）
- [ ] 9D Pose 标注工作流完善：标注交互（姿态/关键点/坐标系）、与 2D/深度/点云对齐、数据落库与导出格式
- [ ] 9D Pose：点云/深度数据的导入规范化（文件命名绑定、坐标系约定）与可视化增强
- [ ] 标注数据导出格式扩展（COCO、YOLO、Pascal VOC 等格式）
- [ ] 更丰富的标注工具
- [ ] 批量操作功能
- [ ] 用户权限管理系统
- [ ] 标注数据版本管理

