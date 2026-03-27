@echo off
setlocal
cd /d "%~dp0"

REM Activate conda env:
REM 1) lingbot (preferred on this machine)
call conda.bat activate lingbot >nul 2>&1
if errorlevel 1 (
  call conda.bat activate depthfix-lingbot-depth >nul 2>&1
  if errorlevel 1 (
    echo [ERROR] Failed to activate conda env: lingbot / depthfix-lingbot-depth
    exit /b 1
  )
)

REM Set model path (default fallback exists, but explicit is safer)
set "SCRIPT_DIR=%~dp0"
set "DEPTHREPAIR_MODEL_PATH=%SCRIPT_DIR%lingbot-depth\model.pt"

REM Run service
python -c "import sys; print('[depthrepair] python:', sys.executable)"
python app.py

