@echo off
chcp 65001 >nul
echo ========================================
echo 智能图像标注系统 - 启动脚本
echo 版本: V1.8
echo ========================================

echo 正在启动 Node.js 后端服务...
cd server
set "SERVER_DIR=%CD%"
start "Node.js后端服务" powershell -NoExit -Command "cd '%SERVER_DIR%'; npm run dev"

timeout /t 3 /nobreak >nul

echo 正在启动 Grounded SAM2 API 服务...
cd sam2-service
set "SAM2_DIR=%CD%"
REM 使用 PowerShell 启动 SAM2 服务，PowerShell 对 conda 支持更好
start "SAM2服务" powershell -NoExit -Command "cd '%SAM2_DIR%'; conda activate sam2; $env:SAM2_CHECKPOINT='%SAM2_DIR%\grounded-sam2\checkpoints\sam2_hiera_large.pt'; $env:SAM2_MODEL_CFG='configs/sam2/sam2_hiera_l.yaml'; python app.py; Write-Host 'Press any key to exit...'; $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')"

timeout /t 3 /nobreak >nul

echo 正在启动前端应用...
cd ..\..\client
set "CLIENT_DIR=%CD%"
start "前端应用" powershell -NoExit -Command "cd '%CLIENT_DIR%'; npm run dev"

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