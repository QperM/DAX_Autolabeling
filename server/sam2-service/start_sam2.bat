@echo off

REM 1. 激活 conda 环境
REM 注意：确保 conda 已添加到系统 PATH，或者使用绝对路径调用 activate.bat
call conda activate sam2

REM 2. 设置环境变量 (格式: set 变量名=值，中间不能有空格)
set "SCRIPT_DIR=%~dp0"
REM 使用相对路径，避免项目目录改名/移动后环境变量失效
set "SAM2_CHECKPOINT=%SCRIPT_DIR%grounded-sam2\checkpoints\sam2_hiera_large.pt"
set "SAM2_MODEL_CFG=%SCRIPT_DIR%grounded-sam2\sam2\configs\sam2\sam2_hiera_l.yaml"

REM 3. 运行 Python 脚本
python app.py

REM 防止窗口立即关闭，方便查看报错信息
pause