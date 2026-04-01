# Docker & K8s 部署（推荐路线：Web + API + SAM2 + Pose + DepthRepair 五镜像）

本目录提供一套可直接落地到 **Kubernetes（上海服务器）** 的打包/部署步骤与模板文件。

> 目标拆分（推荐）  
> - **web**：`client` 构建后的静态站点，用 **Nginx** 托管，并反代 `/api`、`/uploads` 到后端  
> - **api**：Node/Express（`server`），负责业务 + SQLite + uploads 静态文件  
> - **sam2**：Python/FastAPI（`server/sam2-service`），仅做 SAM2 推理服务  
> - **pose**：Python/FastAPI（`server/pose-service`），做 Diff-DOPE 6D 推理/渲染  
> - **depthrepair**：Python/FastAPI（`server/depthrepair-service`），做深度补全推理  

---

## 0. 你需要先决定的 4 件事（不决定会后面返工）

- **是否有 GPU 节点**：SAM2 推理服务是否要用 GPU（强烈建议）  
- **checkpoint 放哪**：建议 **PVC 挂载**（不要 bake 进镜像）  
- **后端是否多副本**：如果 API > 1 副本，需要 **Redis session store** 或 Ingress sticky session  
- **持久化策略**：SQLite + uploads 都需要 PVC（或把 SQLite 换成 PostgreSQL）

---

## 1. 镜像打包（5 个镜像）

下面命令以仓库根目录为构建上下文（context），这样 Dockerfile 可以复制 `client/`、`server/` 等目录。

### 1.1 构建 API 镜像（Node）

Dockerfile：`Docker/Dockerfile.api`

```bash
docker build -f Docker/Dockerfile.api -t <registry>/<repo>/dax-api:<tag> .
docker push <registry>/<repo>/dax-api:<tag>
```

运行时关键点：
- **端口**：3001（可用 `PORT` 环境变量覆盖）
- **持久化卷**：
  - `/app/database`（SQLite：`annotations.db`）
  - `/app/uploads`（图片/ZIP 解压内容）
- **SAM2 地址**：通过环境变量 `GROUNDED_SAM2_API_URL` 指向 K8s service，例如  
  `http://dax-sam2:7860/api/auto-label`

### 1.2 构建 Web 镜像（Nginx 托管前端 + 反代）

Dockerfile：`Docker/Dockerfile.web`  
Nginx 配置：`Docker/nginx.web.conf`

```bash
docker build -f Docker/Dockerfile.web -t <registry>/<repo>/dax-web:<tag> .
docker push <registry>/<repo>/dax-web:<tag>
```

默认约定：
- `/api/*` 反代到 `dax-api:3001`
- `/uploads/*` 反代到 `dax-api:3001`（后端静态文件）

### 1.3 构建 SAM2 镜像（FastAPI）

Dockerfile（GPU 版，推荐生产使用）：`Docker/Dockerfile.sam2.gpu`

```bash
docker build -f Docker/Dockerfile.sam2.gpu -t <registry>/<repo>/dax-sam2:<tag> .
docker push <registry>/<repo>/dax-sam2:<tag>
```

运行时关键点：
- **端口**：7860
- **必须配置**（建议通过 K8s `env` + `volumeMounts`）：
  - `SAM2_CHECKPOINT`：checkpoint 文件路径（容器内路径）
  - `SAM2_MODEL_CFG`：cfg 文件路径（容器内路径）
- **注意**：
  - GPU 服务共享 `Docker/Dockerfile.cuda-base.gpu` 构建的 `dax-cuda-base:12.1`（CUDA 12.1 + cu121 PyTorch）。若驱动或 CUDA 版本不同，需同步调整基础 Dockerfile 中的版本与 `TORCH_INDEX_URL`，并重建 `dax-cuda-base` 后重打业务镜像。
  - 集群侧必须安装 **NVIDIA device plugin**，并确保节点可分配 `nvidia.com/gpu` 资源。

---

## 1.5 上线前测试（强烈建议：先在本地/测试机用 Docker Compose 跑通）

我们在本目录提供了一份本地联调用的 `docker-compose.yml`（GPU 版）：`Docker/docker-compose.gpu.yml`

### 1.5.1 本地构建五镜像（打 `:local` 标签）

```bash
docker build -f Docker/Dockerfile.cuda-base.gpu -t dax-cuda-base:12.1 .
docker build -f Docker/Dockerfile.api -t dax-api:local .
docker build -f Docker/Dockerfile.web -t dax-web:local .
docker build -f Docker/Dockerfile.sam2.gpu -t dax-sam2:local .
docker build -f Docker/Dockerfile.pose.gpu -t dax-pose:local .
docker build -f Docker/Dockerfile.depthrepair.gpu -t dax-depthrepair:local .
```

### 1.5.2 准备 SAM2 资产（checkpoint/cfg，随镜像打包）

把 checkpoint/cfg 放到下面固定路径（`Docker/Dockerfile.sam2.gpu` 会在 build 时 `COPY Docker/sam2-assets -> /sam2-assets`）：
- `Docker/sam2-assets/checkpoints/sam2_hiera_large.pt`
- `Docker/sam2-assets/configs/sam2/sam2_hiera_l.yaml`

> 注意：镜像会非常大（包含 checkpoint），但优点是上服务器后无需再挂载本地路径或手动拷贝权重。

### 1.5.3 启动（不需要本地跑 npm）

```bash
docker compose -f Docker/docker-compose.gpu.yml up -d --build
```

可选：确认权重/配置已被打进镜像（容器内能看到文件）：

```bash
docker exec -it dax-autolabeling-sam2-1 ls -lah /sam2-assets/checkpoints /sam2-assets/configs/sam2
```

服务端口：
- Web：`http://localhost:38080`
- API：`http://localhost:3001`
- SAM2：`http://localhost:37860`

### 1.5.4 冒烟测试（健康检查）

```powershell
pwsh -File Docker/smoke-test.ps1
```

> 通过标准：`/health`、`/api/health` 返回 200，Web 首页可打开。

### 1.5.5 GPU 前置条件（必须）

要让 `sam2` 容器用到 GPU，你需要在运行 Docker 的那台机器上满足：
- 已安装 NVIDIA 驱动（`nvidia-smi` 正常）
- 已安装 **NVIDIA Container Toolkit**（否则容器里看不到 GPU）

本项目只提供 GPU 版本：

```bash
docker compose -f Docker/docker-compose.gpu.yml up -d --build
```

验证容器是否拿到 GPU：

```bash
docker exec -it dax-autolabeling-sam2-1 nvidia-smi
```

---

## 2. K8s 部署（模板） + Rancher 指南

模板目录：`Docker/k8s/`  
基于 Rancher 的完整内网部署流程见：`Docker/RANCHER_DEPLOYMENT.md`

推荐顺序：
1. 创建 namespace（可选）
2. 创建 PVC（`uploads`、`database`）
3. 部署 `sam2`（先让 `/health` 200）
4. 部署 `pose`（先让 `/health` 200）
5. 部署 `depthrepair`（先让 `/health` 200）
6. 部署 `api`（确认 `/api/health` 200，且能访问 sam2/pose/depthrepair）
7. 部署 `web`（确认页面可用、cookie 登录正常）
8. 配 Ingress（或用你们现有网关体系）

### 2.1 应用 YAML（示例）

```bash
kubectl apply -f Docker/k8s/00-namespace.yaml
kubectl apply -f Docker/k8s/31-secret.example.yaml
kubectl apply -f Docker/k8s/10-pvc.yaml
kubectl apply -f Docker/k8s/20-sam2.yaml
kubectl apply -f Docker/k8s/21-pose.yaml
kubectl apply -f Docker/k8s/22-depthrepair.yaml
kubectl apply -f Docker/k8s/30-api.yaml
kubectl apply -f Docker/k8s/40-web.yaml
kubectl apply -f Docker/k8s/50-ingress.yaml
```

---

## 3. 生产必做项（强烈建议）

### 3.1 Session 多副本问题（非常关键）

当前后端使用 `express-session`，默认是**内存 session**。如果 API 开多副本，会出现：
- 同一个用户请求被负载到不同 Pod 后 “突然 403/掉登录”

解决路线（推荐）：
- 上 **Redis** 做 session store（connect-redis）
- 或者 Ingress sticky session（不如 Redis 稳定）

> 如果你们第一版先单副本 API，也可以先不做 Redis，但后面扩容会踩坑。

### 3.2 数据持久化与备份

- SQLite：PVC + 定期备份（或迁移到 PostgreSQL）
- uploads：PVC（容量规划、清理策略、备份策略）

### 3.3 SAM2 GPU 化（上海服务器）

如果上海服务器有 GPU，建议：
- K8s 安装 NVIDIA device plugin
- `sam2` Deployment 里申请 GPU：
  - `resources.limits["nvidia.com/gpu"]=1`（本项目模板已默认开启，见 `Docker/k8s/20-sam2.yaml`）
- 使用 CUDA 基础镜像构建 SAM2（需要你提供 cu 版本、驱动、torch 版本策略）

### 3.4 Ingress 上传体积限制（ZIP 大文件）

你们后端允许单文件最高 3GB（ZIP），Ingress 往往默认限制更小。至少需要：
- 调大 `proxy-body-size`（nginx ingress）或对应网关的 body size limit
- 调大读写超时（解压/处理时可能较久）

---

## 4. 文件索引

- `Docker/Dockerfile.api`：Node/Express API 镜像
- `Docker/Dockerfile.web`：前端构建 + Nginx 托管/反代镜像
- `Docker/nginx.web.conf`：web 反代配置
- `Docker/Dockerfile.sam2.gpu`：SAM2 FastAPI（GPU 版）
- `Docker/Dockerfile.pose.gpu`：Pose-service（Diff-DOPE，GPU 版）
- `Docker/Dockerfile.depthrepair.gpu`：DepthRepair-service（LingBot-Depth，GPU 版）
- `Docker/k8s/*.yaml`：K8s 模板（PVC/Deploy/Service/Ingress）

