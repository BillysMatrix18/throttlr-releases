@echo off
REM ============================================================
REM  Throttlr build script (web UI version)
REM
REM  Steps:
REM    1. Install Python deps + PyInstaller
REM    2. Run PyInstaller to produce dist\Throttlr.exe
REM    3. (NEW) If Inno Setup 6 is installed, compile throttlr.iss
REM       to produce dist\Throttlr-Setup-X.X.X.exe
REM
REM  First-time setup:
REM    - Install Python 3.10+ from https://www.python.org/downloads/
REM    - Install Inno Setup 6 from https://jrsoftware.org/isinfo.php
REM      (the installer has all default options - just click through)
REM ============================================================

cd /d "%~dp0"

echo Locating Python...

REM Try 'python' command first
python --version >nul 2>nul
if %errorlevel%==0 (
    set PYTHON=python
    goto :found
)

REM Fall back to 'py' launcher
py --version >nul 2>nul
if %errorlevel%==0 (
    set PYTHON=py
    goto :found
)

echo.
echo ============================================================
echo  ERROR: Python not found.
echo.
echo  Install Python 3.10+ from:
echo    https://www.python.org/downloads/
echo.
echo  IMPORTANT: tick "Add Python to PATH" during install,
echo  then run this build script again.
echo ============================================================
echo.
pause
exit /b 1

:found
echo Using: %PYTHON%
%PYTHON% --version

echo.
echo [1/6] Upgrading pip...
%PYTHON% -m pip install --upgrade pip

echo.
echo [2/6] Installing dependencies (pydivert, psutil, PySide6, pyinstaller)...
%PYTHON% -m pip install pydivert psutil PySide6 PySide6-Addons pyinstaller
if %errorlevel% neq 0 (
    echo.
    echo Dependency install failed. Check the error above.
    pause
    exit /b 1
)

echo.
echo [3/6] Verifying QtWebEngine is available...
%PYTHON% -c "from PySide6.QtWebEngineWidgets import QWebEngineView" 2>nul
if %errorlevel% neq 0 (
    echo.
    echo ERROR: QtWebEngine import failed.
    echo Try: pip install --upgrade --force-reinstall PySide6 PySide6-Addons
    pause
    exit /b 1
)
echo QtWebEngine OK.

echo.
echo [4/6] Cleaning previous build...
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist
if exist Throttlr.spec del Throttlr.spec

echo.
echo [5/6] Building Throttlr.exe (this takes 2-5 minutes)...
%PYTHON% -m PyInstaller ^
    --onefile ^
    --windowed ^
    --name Throttlr ^
    --icon throttlr.ico ^
    --uac-admin ^
    --collect-all pydivert ^
    --collect-submodules psutil ^
    --collect-all PySide6 ^
    --add-data "ui;ui" ^
    --add-data "throttlr.ico;." ^
    --noconfirm ^
    throttlr.py

if not exist dist\Throttlr.exe (
    echo.
    echo ============================================================
    echo  BUILD FAILED at PyInstaller step. Scroll up to see the error.
    echo ============================================================
    echo.
    pause
    exit /b 1
)

REM ============================================================
REM  [6/6] Compile the Windows installer with Inno Setup
REM ============================================================
echo.
echo [6/6] Looking for Inno Setup 6...

set INNO_PATH=
if exist "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" set INNO_PATH=C:\Program Files (x86)\Inno Setup 6\ISCC.exe
if exist "C:\Program Files\Inno Setup 6\ISCC.exe" set INNO_PATH=C:\Program Files\Inno Setup 6\ISCC.exe

if not defined INNO_PATH (
    echo.
    echo ============================================================
    echo  Throttlr.exe BUILT - but Inno Setup 6 was NOT FOUND.
    echo.
    echo  You can still ship the .exe directly, OR install Inno Setup
    echo  to also build a proper Windows installer:
    echo    1. Download from https://jrsoftware.org/isdl.php
    echo    2. Run "innosetup-6.x.x.exe", click through with defaults
    echo    3. Re-run this build.bat
    echo.
    echo  Output so far:
    echo    %CD%\dist\Throttlr.exe
    echo ============================================================
    echo.
    pause
    exit /b 0
)

echo Found: "%INNO_PATH%"
echo Compiling installer...
echo.
"%INNO_PATH%" /Q throttlr.iss
if %errorlevel% neq 0 (
    echo.
    echo ============================================================
    echo  Inno Setup compile FAILED. Throttlr.exe still built OK.
    echo  Check throttlr.iss for syntax errors.
    echo ============================================================
    echo.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo  ALL DONE!
echo.
echo  Files produced:
echo    %CD%\dist\Throttlr.exe              (~80-120 MB raw exe)
echo    %CD%\dist\Throttlr-Setup-*.exe      (the installer for users)
echo.
echo  For GitHub releases, upload BOTH:
echo    - Throttlr-Setup-X.X.X.exe   (primary download for users)
echo    - throttlr-X.X.X.zip         (zip Throttlr.exe by hand for the
echo                                  auto-update system to find)
echo ============================================================
echo.
pause
