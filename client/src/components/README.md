# `components/` 目录说明

为便于维护，页面与业务相关组件按维度分子目录（由 `App.tsx` 直接引用的路由页放在对应目录下）。

| 目录 | 用途 |
|------|------|
| **`2d/`** | 2D 图像标注：`AnnotationPage`、`ManualAnnotation`、`AnnotationCanvas`、图片上传、Labelme ZIP 导出等 |
| **`9d/`** | 9D / Pose 工作区：`PoseAnnotationPage`、`PoseManualAnnotation`、点云与 Mesh 预览、Depth/Mesh 上传、Pose ZIP 导出等 |
| **`common/`** | 跨模块通用入口页：`LandingPage`（及配套样式） |

**路径约定**：子目录内文件引用 `src` 下模块时使用 `../../`（如 `../../services/api`）；引用同目录组件用 `./`。

**样式**：`AnnotationPage.css`、`ManualAnnotation.css` 仍放在 `2d/`，Pose 页通过 `import '../2d/AnnotationPage.css'` 复用布局样式。
