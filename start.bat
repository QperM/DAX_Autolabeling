@echo off
echo ========================================
echo 智能图像标注系统 - 启动脚本
echo 版本: V1.3
echo ========================================

echo 正在启动 Node.js 后端服务...
cd server
start "Node.js后端服务" cmd /k "npm run dev"

timeout /t 3 /nobreak >nul

echo 正在启动 Grounded SAM2 API 服务...
cd sam2-service
start "SAM2服务" cmd /k "start_sam2.bat"

timeout /t 3 /nobreak >nul

echo 正在启动前端应用...
cd ..\..\client
start "前端应用" cmd /k "npm run dev"

echo.
echo ========================================
echo 启动完成！
echo Node.js 后端服务: http://localhost:3001
echo Grounded SAM2 API: http://localhost:7860
echo 前端应用: http://localhost:5173
echo ========================================
echo 请在浏览器中访问前端应用地址开始使用
echo.
echo 注意：如果 SAM2 服务启动失败，请先运行初始化脚本：
echo   cd server\sam2-service
echo   setup.bat
echo.
echo 或手动确保：
echo 1. 已安装 conda
echo 2. 已创建环境: conda create -n sam2 python=3.10 -y
echo 3. 已安装依赖: cd server\sam2-service ^&^& pip install -r requirements.txt
pause