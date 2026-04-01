# 推送镜像到私有仓库

## 仓库地址
`registry.daxrobotics.cn`

## 操作步骤

### 1. 登录仓库
```powershell
docker login registry.daxrobotics.cn
```

### 2. 打标签（tag 为 v1.0.1）
```powershell
docker tag dax-web:local registry.daxrobotics.cn/auto-labeling-tool/dax-web:v1.0.1
docker tag dax-api:local registry.daxrobotics.cn/auto-labeling-tool/dax-api:v1.0.1
docker tag dax-sam2:local registry.daxrobotics.cn/auto-labeling-tool/dax-sam2:v1.0.1
docker tag dax-pose:local registry.daxrobotics.cn/auto-labeling-tool/dax-pose:v1.0.1
docker tag dax-depthrepair:local registry.daxrobotics.cn/auto-labeling-tool/dax-depthrepair:v1.0.1
```

### 3. 推送镜像（先推小的，最后推大的）
```powershell
docker push registry.daxrobotics.cn/auto-labeling-tool/dax-web:v1.0.1
docker push registry.daxrobotics.cn/auto-labeling-tool/dax-api:v1.0.1
docker push registry.daxrobotics.cn/auto-labeling-tool/dax-sam2:v1.0.1
docker push registry.daxrobotics.cn/auto-labeling-tool/dax-pose:v1.0.1
docker push registry.daxrobotics.cn/auto-labeling-tool/dax-depthrepair:v1.0.1
```

## 注意事项

- **推送顺序**：建议先推送体积小的镜像（web、api），最后推送体积大的镜像（sam2，约 19.6GB）
- **版本标签**：推送前确认版本号，避免覆盖已有版本
- **网络**：推送大镜像时确保网络稳定，避免中断

## 完整命令（一键复制）

```powershell
docker login registry.daxrobotics.cn
docker tag dax-web:local registry.daxrobotics.cn/auto-labeling-tool/dax-web:v1.0.1
docker tag dax-api:local registry.daxrobotics.cn/auto-labeling-tool/dax-api:v1.0.1
docker tag dax-sam2:local registry.daxrobotics.cn/auto-labeling-tool/dax-sam2:v1.0.1
docker tag dax-pose:local registry.daxrobotics.cn/auto-labeling-tool/dax-pose:v1.0.1
docker tag dax-depthrepair:local registry.daxrobotics.cn/auto-labeling-tool/dax-depthrepair:v1.0.1
docker push registry.daxrobotics.cn/auto-labeling-tool/dax-web:v1.0.1
docker push registry.daxrobotics.cn/auto-labeling-tool/dax-api:v1.0.1
docker push registry.daxrobotics.cn/auto-labeling-tool/dax-sam2:v1.0.1
docker push registry.daxrobotics.cn/auto-labeling-tool/dax-pose:v1.0.1
docker push registry.daxrobotics.cn/auto-labeling-tool/dax-depthrepair:v1.0.1
```
