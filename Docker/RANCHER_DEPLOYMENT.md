# 使用 Rancher 在内网集群部署 DAX 自动标注服务（Web + API + SAM2）

> ⚠️ **安全警告**：本指南仅适用于 **内网服务部署**，请不要用这套方案直接对外暴露生产服务。

本文件基于本仓库已有的 Docker/K8s 模板，补充说明 **镜像推送到内网 registry**、**从 docker‑compose 迁移到 K8s YAML**，以及 **在 Rancher 上部署与排障** 的完整流程。

推荐整体流程（对应你在文档开头总结的 4 步）：

1. **本地/测试机打包 Docker 镜像并自测**
2. **将镜像推送到内网仓库 `registry.daxrobotics.cn`**
3. **使用该远程镜像再拉起（`docker pull`/`docker compose`）做一次验证**
4. **在 Rancher 中导入 K8s YAML 并部署到集群**

---

## 1. 容器打包 & 推送到私有 registry

> 这里与 `Docker/README.md`、`Docker/PUSH_IMAGES.md` 配合使用。

### 1.1 本地确认镜像可用

1. 使用仓库内的 Dockerfile 构建 3 个镜像（示例 tag，你可以按需调整）：

   ```bash
   # 在仓库根目录执行
   docker build -f Docker/Dockerfile.api      -t dax-api:local .
   docker build -f Docker/Dockerfile.web      -t dax-web:local .
   docker build -f Docker/Dockerfile.sam2.gpu -t dax-sam2:local .
   ```

2. 使用 `Docker/docker-compose.gpu.yml` 或 `Docker/docker-compose.cpu.yml` 做一次本地联调：

   ```bash
   # GPU 版（需要 NVIDIA Driver + NVIDIA Container Toolkit）
   docker compose -f Docker/docker-compose.gpu.yml up -d

   # 或 CPU 版
   docker compose -f Docker/docker-compose.cpu.yml up -d
   ```

3. 打开浏览器或使用 `Docker/smoke-test.ps1` 做健康检查，确保 **web / api / sam2** 三个服务都能正常工作。

### 1.2 推送镜像到 `registry.daxrobotics.cn`

> 详细命令可以看 `Docker/PUSH_IMAGES.md`，这里只列核心步骤。

1. 在浏览器中访问 `registry.daxrobotics.cn`，使用内网账户登录。
2. 创建一个新的 **Project（项目）**，例如：`auto-labeling-tool`。
3. 在该项目中创建一个 **机器人账号（Robot Account）**，用于命令行登录。
4. 在本地终端中执行：

   ```powershell
   docker login registry.daxrobotics.cn
   # Username/Password 使用上一步创建的机器人账号
   ```

5. 给本地镜像打 tag（示例版本号 `v1.0.1`，**不建议使用 `latest`**）：

   ```powershell
   docker tag dax-web:local  registry.daxrobotics.cn/auto-labeling-tool/dax-web:v1.0.1
   docker tag dax-api:local  registry.daxrobotics.cn/auto-labeling-tool/dax-api:v1.0.1
   docker tag dax-sam2:local registry.daxrobotics.cn/auto-labeling-tool/dax-sam2:v1.0.1
   ```

6. 推送镜像（**建议从小到大**，最后再推 SAM2）：

   ```powershell
   docker push registry.daxrobotics.cn/auto-labeling-tool/dax-web:v1.0.1
   docker push registry.daxrobotics.cn/auto-labeling-tool/dax-api:v1.0.1
   docker push registry.daxrobotics.cn/auto-labeling-tool/dax-sam2:v1.0.1
   ```

7. 推送成功后，对应镜像地址形如：

   - `registry.daxrobotics.cn/auto-labeling-tool/dax-web:v1.0.1`
   - `registry.daxrobotics.cn/auto-labeling-tool/dax-api:v1.0.1`
   - `registry.daxrobotics.cn/auto-labeling-tool/dax-sam2:v1.0.1`

---

## 2. 使用远程镜像再做一次 docker-compose 验证

在把服务交给 K8s/Rancher 管理之前，**强烈建议** 用刚推送上去的远程镜像再跑一次 Compose，验证镜像拉取和运行逻辑都没有问题。

### 2.1 示例 docker-compose（GPU 场景）

简化版示例（只展示与远程镜像、环境变量、卷相关的关键部分）：

```yaml
name: dax-autolabeling

services:
  sam2:
    image: registry.daxrobotics.cn/auto-labeling-tool/dax-sam2:v1.0.1
    ports:
      - "7860:7860"
    gpus: all
    environment:
      SAM2_CHECKPOINT: ${SAM2_CHECKPOINT:-/sam2-assets/checkpoints/sam2_hiera_large.pt}
      SAM2_MODEL_CFG: ${SAM2_MODEL_CFG:-configs/sam2/sam2_hiera_l.yaml}
      NVIDIA_VISIBLE_DEVICES: all
      NVIDIA_DRIVER_CAPABILITIES: compute,utility

  api:
    image: registry.daxrobotics.cn/auto-labeling-tool/dax-api:v1.0.1
    ports:
      - "3001:3001"
    environment:
      NODE_ENV: production
      PORT: "3001"
      SESSION_SECRET: ${SESSION_SECRET:-CHANGE_ME}
      GROUNDED_SAM2_API_URL: ${GROUNDED_SAM2_API_URL:-http://sam2:7860/api/auto-label}
    depends_on:
      - sam2
    volumes:
      - ./data/uploads:/app/server/uploads:rw
      - ./data/database:/app/database:rw

  web:
    image: registry.daxrobotics.cn/auto-labeling-tool/dax-web:v1.0.1
    ports:
      - "8080:80"
    depends_on:
      - api
```

> 建议在多台机器上、不同环境中多次验证 `docker-compose.yml`，并始终使用 **显式版本号标签**（如 `v1.0.1`），避免使用 `latest`。

---

## 3. 从 docker-compose 转成 K8s YAML（示例）

可以先把 `docker-compose.yml` 交给 AI（如 Gemini / ChatGPT 等），生成初版 K8s YAML，再结合本仓库 `Docker/k8s/*.yaml` 进行人工 review 和修正。

下面是与你提供示例等价的一套 **精简版 K8s YAML**，仅用于说明结构与关键点（生产建议直接用仓库内的模板）：

### 3.1 PVC（对应 api 的数据卷）

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: api-uploads-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: api-database-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 5Gi
```

### 3.2 SAM2 Deployment + Service（需要 GPU）

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sam2
spec:
  replicas: 1
  selector:
    matchLabels:
      app: sam2
  template:
    metadata:
      labels:
        app: sam2
    spec:
      runtimeClassName: nvidia  # 1) GPU: runtimeClassName
      containers:
        - name: sam2
          image: registry.daxrobotics.cn/auto-labeling-tool/dax-sam2:v1.0.1
          ports:
            - containerPort: 7860
          env:
            - name: SAM2_CHECKPOINT
              value: "/sam2-assets/checkpoints/sam2_hiera_large.pt"
            - name: SAM2_MODEL_CFG
              value: "configs/sam2/sam2_hiera_l.yaml"
            - name: NVIDIA_DRIVER_CAPABILITIES  # 2) GPU: driver caps
              value: "all"
          resources:
            limits:
              nvidia.com/gpu: 1              # 3) GPU: 向 K8s 申请 1 张卡
---
apiVersion: v1
kind: Service
metadata:
  name: sam2
spec:
  selector:
    app: sam2
  ports:
    - protocol: TCP
      port: 7860
      targetPort: 7860
```

> **GPU 必查三项**：`runtimeClassName: nvidia`、`NVIDIA_DRIVER_CAPABILITIES`、`resources.limits."nvidia.com/gpu"`。

### 3.3 API Deployment + Service

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 1
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: registry.daxrobotics.cn/auto-labeling-tool/dax-api:v1.0.1
          ports:
            - containerPort: 3001
          env:
            - name: NODE_ENV
              value: "production"
            - name: PORT
              value: "3001"
            - name: SESSION_SECRET
              value: "CHANGE_ME"
            - name: GROUNDED_SAM2_API_URL
              value: "http://sam2:7860/api/auto-label"
          volumeMounts:
            - name: uploads-volume
              mountPath: /app/server/uploads
            - name: database-volume
              mountPath: /app/database
      volumes:
        - name: uploads-volume
          persistentVolumeClaim:
            claimName: api-uploads-pvc
        - name: database-volume
          persistentVolumeClaim:
            claimName: api-database-pvc
---
apiVersion: v1
kind: Service
metadata:
  name: dax-api
spec:
  selector:
    app: api
  ports:
    - protocol: TCP
      port: 3001
      targetPort: 3001
```

### 3.4 Web Deployment + Service（NodePort 示例）

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: registry.daxrobotics.cn/auto-labeling-tool/dax-web:v1.0.1
          ports:
            - containerPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  type: NodePort  # Demo 用，生产建议配 Ingress
  selector:
    app: web
  ports:
    - name: http
      protocol: TCP
      port: 8080
      targetPort: 80
      # 可选：自定义 nodePort（30000–32767 范围内）
      # nodePort: 30080
```

> K8s 会自动为 NodePort 分配一个 30000–32767 之间的端口。除非非常确定，否则不建议手动指定 `nodePort` 以避免端口冲突。

---

## 4. 在 Rancher 上部署

Rancher 地址：`https://rancher.mgmt.daxrobotics.cn/`  
如无权限，请联系 IT 同事开通。

### 4.1 选择集群

1. 登录 Rancher。
2. 在首页选择你要使用的 Kubernetes 集群，例如：**gpu-server-0**（带 GPU 的集群）。

### 4.2 创建 Project/Namespace

> 建议 **不要部署在 `default` 命名空间**，以免环境污染。

1. 左侧菜单进入 **Cluster -> Projects/Namespaces**。
2. 点击右上角 **Create Project**，新建一个 Project，例如 `dax-autolabeling`。
3. 在创建 Project 时，可以在 **Add Members** 里添加 `rancher-users` 用户组，这样其他同事可以直接看到你的项目，方便协作。

### 4.3 导入 YAML（核心步骤）

1. 在对应 Project/Namespace 里，点击右上角 **Import YAML**。
2. 将前面准备好的 K8s YAML（例如整合为 `dax-stack.yaml`）内容复制粘贴进去。
3. 在底部 **Namespace** 处选择你刚创建的 namespace（例如 `dax-autolabeling`）。
4. 点击 **Import** 完成应用。

### 4.4 检查 Workload 运行状态

1. 左侧菜单进入 **Workloads -> Deployments**。
2. 你应该能看到 `sam2`、`api` 和 `web` 三个 Deployment。
3. 如果镜像地址正确、集群资源充足、GPU 配置无误，它们会很快变为 **Active（绿色）**。

---

## 5. 通过 NodePort 访问已部署的 Web

在上面的示例中，`web` Service 使用 `type: NodePort` 暴露服务。

1. 在 Rancher 中进入对应 **Cluster + Namespace**。
2. 左侧菜单打开 **Service Discovery -> Services**。
3. 找到名为 `web` 的 Service。
4. 在 `Ports` 一列，你会看到类似 `8080:31567/TCP` 的显示：
   - `8080`：集群内部端口 (`spec.ports[].port`)。
   - `31567`：映射到物理机的端口 (`spec.ports[].nodePort`)。
5. 假设 GPU 服务器的内网地址是 `10.69.3.110`，则可以在浏览器中访问：

   ```text
   http://10.69.3.110:31567
   ```

> 如果必须自定义 NodePort，可以在 YAML 中显式写上 `nodePort: 30080`（范围必须在 `30000–32767`），但**不推荐**随意固定端口，以免产生冲突。

---

## 6. 更新服务版本的推荐流程

1. **本地更新代码 & 重建镜像**，使用新的版本号 tag，例如 `v1.0.2`。
2. **推送新镜像** 到 `registry.daxrobotics.cn`，注意不要覆盖旧版本。
3. 打开 Rancher：**Cluster -> Workloads -> Deployments**，在对应 namespace 下找到要更新的 Deployment（如 `web`/`api`/`sam2`），点击 **Edit Config**。
4. 在 **Image** 字段里，把 tag 修改为新的版本号（例如从 `v1.0.1` 改为 `v1.0.2`），点击右下角 **Save**。
5. 等待 Pod 滚动更新完成，状态重新变为绿色 **Active** 即可。

---

## 7. CrashLoopBackOff 排障指南（以 web 为例）

`CrashLoopBackOff` 表示：**容器能拉起，但很快崩溃退出，K8s 不断重试并逐渐拉长重试间隔**。  
如果 `sam2` 和 `api` 能正常运行，而 `web` 处于 `CrashLoopBackOff`，通常说明：

- 集群本身（镜像拉取、网络）大概率是好的；
- 问题多半出在 **web 容器内部的配置或启动逻辑**。

### 7.1 第一步：看容器日志（最关键）

1. 在 Rancher 左侧菜单进入 **Workloads -> Deployments**。
2. 点击进入 `web` 这个 Deployment。
3. 在下方 Pods 列表中，找到状态为 `CrashLoopBackOff` 或 `Error` 的 Pod。
4. 点击该 Pod 右侧的 `⋮` 菜单，选择 **View Logs**。

重点关注：

- 如果是 Node.js/Next.js 或其他前端框架：
  - 是否有 `Error: Missing environment variable`、`Cannot find module` 之类的报错。
- 如果是 Nginx：
  - 是否有 `nginx: [emerg] host not found in upstream "api"` 等上游解析失败；
  - 或 Nginx 配置语法错误导致直接崩溃。

### 7.2 第二步：查看 Pod 事件（Events）

如果日志为空（容器来不及输出就被杀掉），需要看 K8s 记录的事件。

1. 在 Pods 列表中，点击有问题的 Pod 名字，进入 Pod 详情。
2. 切换到 **Events** 标签页。

关注点：

- `OOMKilled`：容器因为内存不足被杀，需要调高内存 limit。
- `Liveness probe failed`：健康检查配置错误或过于严格，导致 Pod 被频繁重启。
- 查看 **State** 里的 Exit Code：
  - `Exit Code 1`：通常是应用报错退出；
  - `Exit Code 137`：通常是被系统强制终止（常见于 OOM）。

### 7.3 常见原因对照（结合 docker-compose）

结合之前的 `docker-compose.yml`，web 在 K8s 中 CrashLoop 的常见原因：

1. **上游代理解析问题（Nginx）**
   - 例如在配置中写了 `proxy_pass http://api:3001;`，但 K8s Service 名称、端口或 namespace 不匹配；
   - 或者 Nginx 启动时 DNS 尚未解析成功，导致“host not found”直接退出。
2. **环境变量不完整**
   - docker-compose 本地可能通过 `.env`/`environment` 提供了一些变量，在 K8s YAML 中没有同步配置。
3. **启动命令退出过早**
   - 如果 entrypoint/command 中把主要服务后台执行（如 `nginx` 没有 `daemon off;`，或脚本执行完就结束），K8s 会认为容器已退出，从而反复重启。

### 7.4 终极调试手段：让容器“先活下来”（sleep 驻留法）

如果通过日志和事件仍找不到原因，可以采用 **覆盖启动命令，让容器先不退出** 的方法，然后进入容器内部手动执行原来的启动命令观察报错。

操作步骤：

1. 在 Rancher 中编辑 `web` Deployment（右上角 **Edit Config**）。
2. 在 **Command/Entrypoint** 部分覆盖原有命令，改为：

   - Command: `/bin/sh`
   - Args: `-c`, `sleep infinity`

3. 保存并等待 Deployment 重新部署，Pod 状态应变为 **Running（绿色）**。
4. 在该 Pod 右侧 `⋮` 菜单中选择 **Execute Shell**，进入容器终端。
5. 在容器内手动执行原本的启动命令（例如 `nginx -g 'daemon off;'` 或 `npm start` 等），观察终端输出的错误信息，并据此修复配置。

---

## 8. 小结

- **镜像构建 & 本地 compose 自测** 是第一道关；
- **推送到 `registry.daxrobotics.cn` 后，用远程镜像再跑一次 compose**，确保仓库与镜像本身没有问题；
- **K8s YAML 建议在本仓库模板基础上调整**，重点关注 GPU、PVC、Service 名称等；
- **Rancher 只是 K8s 的“图形化控制台”**：大部分问题都能通过 **Pod 日志 + Events + 进入容器调试** 来定位。

