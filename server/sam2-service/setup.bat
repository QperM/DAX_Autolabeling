@echo off
echo =========================================
echo Grounded SAM2 API Service - 首次安装脚本
echo =========================================
echo.

REM 用法:
REM   setup.bat            (交互式选择 PyTorch 安装方式)
REM   setup.bat pip        (非交互：使用 pip 安装 cu121 版 PyTorch)
REM   setup.bat conda      (非交互：使用 conda 安装 PyTorch + CUDA)
REM   setup.bat skip       (非交互：跳过 PyTorch 安装)
set MODE=%1

REM 检查 conda 是否安装
where conda >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 conda
    echo.
    echo 请先安装 Anaconda 或 Miniconda:
    echo https://www.anaconda.com/products/distribution
    echo 或
    echo https://docs.conda.io/en/latest/miniconda.html
    echo.
    pause
    exit /b 1
)

echo [1/4] 检查 conda 环境...
call conda info --envs | findstr "sam2" >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] conda 环境 sam2 已存在
    echo.
    set SKIP_ENV=1
)
if %errorlevel% neq 0 (
    echo [WARN] conda 环境 sam2 不存在，将创建新环境
    echo.
    set SKIP_ENV=0
)

REM 创建 conda 环境（如果不存在）
if "%SKIP_ENV%"=="0" (
    echo [2/4] 正在创建 conda 环境 sam2 (Python 3.10)...
    echo 这可能需要几分钟时间，请耐心等待...
    call conda create -n sam2 python=3.10 -y
    if %errorlevel% neq 0 (
        echo [错误] 创建 conda 环境失败
        pause
        exit /b 1
    )
    echo [OK] conda 环境创建成功
    echo.
) else (
    echo [2/4] 跳过环境创建（环境已存在）
    echo.
)

REM 激活环境并安装依赖
echo [3/4] 激活环境并安装 Python 依赖...
call conda activate sam2
if %errorlevel% neq 0 (
    echo [错误] 无法激活 conda 环境 sam2
    pause
    exit /b 1
)

REM 切换到脚本所在目录
cd /d %~dp0

echo 正在安装基础依赖（FastAPI, Uvicorn 等）...
call pip install -r requirements.txt
if %errorlevel% neq 0 (
    echo [警告] 部分依赖安装失败，但可以继续
    echo.
)

echo.
echo [4/4] 安装 PyTorch (CUDA 12.1)...
echo 这可能需要较长时间，请耐心等待...
echo.
set choice=
if /I "%MODE%"=="conda" set choice=1
if /I "%MODE%"=="pip" set choice=2
if /I "%MODE%"=="skip" set choice=3

if "%choice%"=="" (
    echo 选择安装方式:
    echo [1] 使用 conda 安装（推荐，自动处理 CUDA）
    echo [2] 使用 pip 安装（推荐在 Windows 上更稳定，避免 conda clobber 冲突）
    echo [3] 跳过 PyTorch 安装（稍后手动安装）
    echo.
    set /p choice="请选择 (1/2/3): "
)

if "%choice%"=="1" (
    echo 正在使用 conda 安装 PyTorch...
    call conda install pytorch torchvision torchaudio pytorch-cuda=12.1 -c pytorch -c nvidia -y
    if %errorlevel% neq 0 (
        echo [警告] PyTorch 安装可能失败，请稍后手动安装
    ) else (
        echo [OK] PyTorch 安装成功
    )
) else if "%choice%"=="2" (
    echo 正在使用 pip 安装 PyTorch...
    echo 将写入日志: %~dp0pip_torch_install.log
    call python -m pip install -v --upgrade --no-cache-dir --progress-bar off --log "%~dp0pip_torch_install.log" torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121 --retries 5 --timeout 120
    if %errorlevel% neq 0 (
        echo [警告] PyTorch 安装可能失败，请稍后手动安装
    ) else (
        echo [OK] PyTorch 安装成功
    )
) else (
    echo 跳过 PyTorch 安装
    echo 稍后可以手动运行:
    echo   conda activate sam2
    echo   conda install pytorch torchvision torchaudio pytorch-cuda=12.1 -c pytorch -c nvidia
)

echo.
echo ========================================
echo 安装完成！
echo ========================================
echo.
echo 验证安装:
call python -c "import fastapi; print('[OK] FastAPI:', fastapi.__version__)"
call python -c "import uvicorn; print('[OK] Uvicorn:', uvicorn.__version__)" 2>nul
call python -c "import torch; print('[OK] PyTorch:', torch.__version__, ', CUDA:', torch.cuda.is_available())" 2>nul || echo [WARN] PyTorch 未安装或 CUDA 不可用
echo.
echo 下一步:
echo 1. 运行 start.bat 启动所有服务
echo 2. 或单独运行 start_sam2.bat 启动 SAM2 服务
echo 3. （可选）启用 YOLO-Seg:
echo    conda activate sam2
echo    cd server\sam2-service
echo    pip install -r requirements-yolo.txt
echo.
pause
