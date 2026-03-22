# `app.py`：Diff-DOPE 6D 姿态服务逻辑说明

本文档描述 `server/pose-service/app.py` 的**端到端行为**，便于排查参数、单位与质量门槛问题。

---

## 1. 服务定位

- **框架**：FastAPI。
- **核心库**：仓库内嵌的 `diff-dope` 包（`import diffdope as dd`）。
- **并发**：全局 `_LOCK` 线程锁，**同一时刻只处理一个** `/diffdope/estimate6d` 请求，避免多 GPU/多进程争用同一套优化状态（与 demo 脚本行为一致、实现简单）。

---

## 2. HTTP 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查，返回 `{"ok": true}`。 |
| `POST` | `/diffdope/estimate6d` | 主入口：根据 RGB、深度、内参、Mesh、2D mask 多边形估计 6D 姿态。 |

上游（Node `pose.js`）负责解析数据库中的**文件路径**，将 `rgbPath`、`depthPath`、`intrinsicsPath`、`meshPath` 以及 `maskFlatPoints`（多边形顶点展平坐标）传给本服务。

---

## 3. 请求体 `Estimate6DRequest`（要点）

### 3.1 必选路径与几何

- `rgbPath` / `depthPath` / `intrinsicsPath` / `meshPath`：本地可读路径，**必须存在**。
- `maskFlatPoints`：`[x0,y0,x1,y1,...]`，在 **RGB 图像像素坐标系**下定义多边形；至少 3 个点（6 个数）。

### 3.2 姿态初始化（当前实现）

- 请求里虽有 `init: Optional[InitPose]` 字段，**当前 `estimate6d` 未使用**。
- **平移初始化使用深度图**：在 mask 内取深度 **中位数** `z_cm`（单位 **cm**）；若无有效深度则 **`z_cm = 80.0`**。再取 mask 前景像素的 **中值像素** `(u,v)`，针孔反投影得 `x_cm, y_cm`。
- 四元数恒为 **单位四元数** `[0,0,0,1]`（xyzw）。

### 3.3 损失与阶段参数（与两阶段优化的关系）

| 字段 | 含义（摘要） |
|------|----------------|
| `batchSize` | 并行候选数，裁剪到 `[1, 64]`。 |
| `stage1Iters` / `stage2Iters` | 第一、二轮迭代次数，默认 80 / 120，裁剪到 `[1, 500]`。 |
| `stage1WeightMask` / `stage2WeightMask` | 各阶段 **mask** 损失权重。 |
| `stage2WeightDepth` | 第二轮 **深度** 损失权重（仅当 `useDepthLoss=True` 时生效）。 |
| `useDepthLoss` | 第二轮是否加入 **观测深度 vs 渲染深度** 的 `l1_depth_with_mask`。**关闭时第二轮仍可只用 mask（及可选 RGB）**；见下文。 |
| `useRgbLoss` | 第二轮是否加入 **RGB** 的 `l1_rgb_with_mask`。 |
| `weightRgb` | 第二轮 RGB 权重（与 `useRgbLoss` 配合）。 |
| `stage1BaseLr` / `stage1LrDecay` | **第一轮**覆盖优化器 `base_lr` / `lr_decay`（默认 20 / 0.1）。 |
| `stage2BaseLr` / `stage2LrDecay` | **第二轮**覆盖优化器 `base_lr` / `lr_decay`。 |
| `stage1EarlyStopLoss` / `stage2EarlyStopLoss` | 若 `> 0`，作为该阶段 `early_stop_loss`；否则不早停。 |
| `maxAllowedFinalLoss` | **质量门槛**：若第二轮结束时的标量 loss 超过该值，返回失败并**不**采用位姿结果（见 §7）。 |

其余如 `iters`、`baseLr`、`lrDecay`、`weightMask`、`weightDepth` 等会写入初次 `OmegaConf`，但**两阶段实际使用的超参以阶段内显式赋值为准**（见 §5）。

---

## 4. 辅助函数行为

### 4.1 `_load_intrinsics`

- 读取 JSON，供相机矩阵与 `depth_scale` 使用。

### 4.2 `_load_depth_cm(depth_path, intr)`

目标：得到与内部一致的 **`depth_cm`（厘米）** 二维数组。

- **`.npy`**：按浮点数组加载；若判定为「米制合理范围」（启发式：`p99 ≤ 20` 且 `p50 > 0`），则 **`×100` → cm**。
- **其它（如 PNG）**：按 `depth_scale`（默认 `0.001`）换算为米再 **`×100` → cm**（与 `intr` 中 `depth_scale` / `depthScale` 兼容）。
- 多通道深度图会尽量压成单通道（取变化最大的通道或灰度）。

### 4.3 `_mask_from_flat_points`

- 将多边形栅格化为 `h×w` 的 `uint8` mask（0/255）。

---

## 5. `/diffdope/estimate6d` 主流程

### 5.1 输入检查与分辨率

1. 四路径存在性检查。
2. 读 RGB 得 `h, w`；读内参 `fx, fy, cx, cy`（`cx/cy` 兼容 `ppx/ppy`）。
3. 由 `maskFlatPoints` 生成 **mask**；若 mask 无前景像素则报错。
4. 加载 **depth → depth_cm**；在 mask 内取 **正深度中位数** `z_cm`；若无有效深度则 **`z_cm = 80.0` cm**。
5. mask 前景像素的 **中值坐标** `(u, v)` 作为投影中心。
6. 反投影：  
   `x_cm = (u - cx) * z_cm / fx`，`y_cm = (v - cy) * z_cm / fy`，`z_cm` 同上。  
   得到 `init_xyz = [x_cm, y_cm, z_cm]`，`init_quat = [0,0,0,1]`。  
   同一 `depth_cm` 随后用于构造 `scene.tensor_depth`（第二轮 depth loss 等）。

### 5.2 Diff-DOPE 配置与对象构建

1. 加载 `diff-dope/configs/diffdope.yaml`，写入相机、**object3d**（模型路径、`scale=100` 表示 mesh 以米读入、内部按 cm 对齐）、初始位姿等。
2. **`cfg.scene.path_depth` / `path_segmentation` 在 YAML 层置空**——真实 GT **不通过磁盘路径加载**，而是下面手动注入 tensor。
3. 构造 `dd.Scene(path_img=rgb)`，再 **手动设置**：
   - `tensor_segmentation`：由 mask 经 **垂直翻转**（与 OpenGL/渲染约定一致）后扩成 3 通道、再 batch 复制。
   - `tensor_depth`：深度图同样 **flip** 后作为 `dd.Image(..., depth=True)`，**始终注入**（供渲染与可能的深度 loss 使用）。

### 5.3 两阶段优化（核心）

**阶段一（粗定位）**

- 按请求开关组装 **mask / RGB** 损失（无 depth）；权重为 `stage1WeightMask` / `stage1WeightRgb`。
- `nb_iterations = stage1Iters`；可选 `early_stop_loss = stage1EarlyStopLoss`。
- **学习率**：`base_lr = stage1BaseLr`，`lr_decay = stage1LrDecay`（在 `run_optimization()` 前写入 `cfg.hyperparameters`）。
- `run_optimization()`。

**阶段二（精修）**

- `l1_mask` **开启**；`weight_mask = stage2WeightMask`。
- **`useDepthLoss`（`stage2_use_depth`）**：
  - `True`：`l1_depth_with_mask` 开启，`weight_depth = stage2WeightDepth`。
  - `False`：**不**把 `l1_depth_with_mask` 加入 `loss_functions`，`weight_depth` 置 0（配置层关闭深度项）。
- **`useRgbLoss`（`stage2_use_rgb`）**：
  - `True`：加入 `l1_rgb_with_mask`，`weight_rgb = weightRgb`。
  - `False`：不加入 RGB 项。
- 第二轮迭代数、早停、**学习率** `base_lr` / `lr_decay` 使用请求中的 `stage2*` 字段。
- `loss_functions = [l1_mask] + [l1_depth_with_mask?] + [l1_rgb_with_mask?]`。
- 再次 `run_optimization()`。

> **注意**：即使第二轮 **关闭 depth 损失**，仍会加载深度文件并注入 **`tensor_depth`**；仅**优化目标**中可能不包含深度一致性项。初始平移 **使用** mask 内深度中位数（见 §3.2 / §5.1）。

### 5.4 结果与诊断

1. 读取第二轮结束时的 **`final_loss_scalar`** 作为 `stage2ScalarLoss`（质量门槛主用）。
2. `get_argmin()` 得到最优 batch 索引；汇总各 loss 键在最后一迭代的 **argmin 分量**与 **batch 均值**（`meta.qualityGate` 内多套口径）。
3. `get_pose(batch_index=argmin)` → `pose44`。
4. `render_img(..., render_selection="rgb")` 生成拟合叠加图；可 Base64 返回；若带 `projectId`，写入  
   `uploads/project_{id}/pose-fit-overlays/fit_image_{imageId}_mesh_{meshId}.png`（固定文件名，**覆盖**旧图）。

---

## 6. 质量门槛与失败处理（`maxAllowedFinalLoss`）

- 若配置了 `maxAllowedFinalLoss > 0` 且 `stage2ScalarLoss` 大于该值：
  - 返回 `success: false`，`code: LOSS_EXCEEDS_THRESHOLD`。
  - 若同时提供了 `projectId`、`imageId`、`meshId`，会尝试 **删除** 对应 overlay PNG，避免前端看到**上一次成功**的残留图。

---

## 7. `debug` 模式

- `req.debug=True` 时：控制台打印初始化信息；在 `pose-service/debug_outputs/api_*` 下保存 mask 与 overlay；`meta.debugArtifacts` 返回路径。

---

## 8. 与上游约定小结

- **Node 侧**必须能解析出深度与内参路径；深度用于 **初始 z（mask 内中位数）**、**tensor_depth** 与可选 **depth loss**。
- 前端各阶段的 **Mask/RGB/Depth 开关**控制对应 **loss**；**初始化 z** 仍来自深度图中位数（§3.2）。

---

## 9. 相关文档

- `diff-dope/UNIT_CONVERSION_EXPLAINED.md`：深度单位与 `depth_scale` 行为。
- `diff-dope/configs/diffdope.yaml`：默认损失与渲染配置基底。
