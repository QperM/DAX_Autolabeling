@echo off

@REM Activate conda environment
@call conda activate diffdope >nul 2>&1

@REM Start Python service
@python app.py

@REM Keep window open
@pause