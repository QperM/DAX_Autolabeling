@echo off
echo ========================================
echo 智能图像标注系统 - 启动脚本
echo 版本: V1.0
echo ========================================

echo 正在启动后端服务...
cd server
start "后端服务" cmd /k "npm run dev"

timeout /t 3 /nobreak >nul

echo 正在启动前端应用...
cd ../client
start "前端应用" cmd /k "npm run dev"

echo.
echo ========================================
echo 启动完成！
echo 后端服务: http://localhost:3001
echo 前端应用: http://localhost:5173
echo ========================================
echo 请在浏览器中访问前端应用地址开始使用
pause