## SAM2 assets (baked into image)

把 SAM2 权重/配置放到下面路径（会在构建 `Docker/Dockerfile.sam2.gpu` 时打进镜像的 `/sam2-assets`）：

- `Docker/sam2-assets/checkpoints/sam2_hiera_large.pt`
- `Docker/sam2-assets/configs/sam2/sam2_hiera_l.yaml`

说明：
- 该目录在 `Docker/.gitignore` 里被忽略，避免把大文件提交到 Git。
- 该目录**不会**被 `.dockerignore` 忽略，因此 `docker build` 时会进入镜像。

