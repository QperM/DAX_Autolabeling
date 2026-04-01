# 在仓库根目录执行（PowerShell）

## 共享 CUDA 基础镜像（base 或 Dockerfile.cuda-base.gpu 有改动时再跑）
docker build -f Docker/Dockerfile.cuda-base.gpu -t dax-cuda-base:12.1 .

## 全量：compose 构建所有服务镜像
docker compose -f Docker/docker-compose.gpu.yml build

## 全量：启动整套服务
docker compose -f Docker/docker-compose.gpu.yml up -d

## 全量：查看状态
docker compose -f Docker/docker-compose.gpu.yml ps

---

## 只用 compose 构建某一个服务的镜像（不重跑其它服务）
docker compose -f Docker/docker-compose.gpu.yml build sam2
docker compose -f Docker/docker-compose.gpu.yml build pose
docker compose -f Docker/docker-compose.gpu.yml build depthrepair
docker compose -f Docker/docker-compose.gpu.yml build api
docker compose -f Docker/docker-compose.gpu.yml build web

---

## 构建并启动某一个服务（带 --build：按 Dockerfile 重新打该服务镜像）
docker compose -f Docker/docker-compose.gpu.yml up -d --build sam2
docker compose -f Docker/docker-compose.gpu.yml up -d --build pose
docker compose -f Docker/docker-compose.gpu.yml up -d --build depthrepair
docker compose -f Docker/docker-compose.gpu.yml up -d --build api
docker compose -f Docker/docker-compose.gpu.yml up -d --build web

---

## 镜像已存在：只启动某一个服务（不加 --build）
docker compose -f Docker/docker-compose.gpu.yml up -d sam2
docker compose -f Docker/docker-compose.gpu.yml up -d pose
docker compose -f Docker/docker-compose.gpu.yml up -d depthrepair
docker compose -f Docker/docker-compose.gpu.yml up -d api
docker compose -f Docker/docker-compose.gpu.yml up -d web

---

## 不用 compose：直接 docker build（与 compose 默认 image 名一致）
docker build -f Docker/Dockerfile.sam2.gpu -t dax-sam2:local .
docker build -f Docker/Dockerfile.pose.gpu -t dax-pose:local .
docker build -f Docker/Dockerfile.depthrepair.gpu -t dax-depthrepair:local .
docker build -f Docker/Dockerfile.api -t dax-api:local .
docker build -f Docker/Dockerfile.web -t dax-web:local .
