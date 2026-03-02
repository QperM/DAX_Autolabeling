@echo off
echo ========================================
echo Grounded SAM2 API Service 启动脚本
echo ========================================

REM 检查 conda 环境是否存在
where conda >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 conda，请先安装 Anaconda 或 Miniconda
    pause
    exit /b 1
)

REM 检查 sam2 环境是否存在（避免依赖 conda activate，在脚本/非交互场景更稳定）
call conda info --envs | findstr "sam2" >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 conda 环境 sam2
    echo.
    echo 请先运行初始化脚本进行首次安装:
    echo   cd server\sam2-service
    echo   setup.bat
    echo.
    pause
    exit /b 1
)

REM 切换到服务目录
cd /d %~dp0

REM 检查 app.py 是否存在
if not exist app.py (
    echo [错误] 未找到 app.py 文件
    pause
    exit /b 1
)

REM 启动服务
echo 正在启动 Grounded SAM2 API 服务...
echo 服务地址: http://localhost:7860
echo.
conda run -n sam2 python app.py

pause
