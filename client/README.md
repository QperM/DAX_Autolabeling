# 前端（client）

本目录是前端 React + TypeScript + Vite 应用。

更完整的项目说明请查看仓库根目录的 `README.md`。

## 开发运行

```bash
cd client
npm install
npm run dev
```

默认访问：`http://localhost:5173`

## 构建

```bash
cd client
npm run build
```

## 需要同时启动的服务

- Node.js 后端：`server/`（默认 `http://localhost:3001`）
- Python AI 服务：`server/sam2-service/`（默认 `http://localhost:7860`）
