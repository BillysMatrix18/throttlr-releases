@echo off
REM Throttlr launcher — auto-elevates to Administrator
REM Place this file in the same folder as throttlr.py

cd /d "%~dp0"

REM Check if we already have admin
net session >nul 2>&1
if %errorLevel% == 0 (
    python throttlr.py
) else (
    echo Requesting Administrator privileges...
    powershell -Command "Start-Process python -ArgumentList 'throttlr.py' -WorkingDirectory '%~dp0' -Verb RunAs"
)
