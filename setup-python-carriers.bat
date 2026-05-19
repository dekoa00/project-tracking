@echo off
setlocal EnableExtensions
cd /d "%~dp0"

py -3.11 --version >nul 2>&1
if errorlevel 1 (
  echo ERROR: Python 3.11 is required for CMA/RCL UC carriers.
  echo Install Python 3.11, then run this file again.
  pause
  exit /b 1
)

if not exist ".venv-cma\Scripts\python.exe" (
  echo Creating Python virtual environment: .venv-cma
  py -3.11 -m venv .venv-cma
  if errorlevel 1 exit /b 1
)

echo Installing Python dependencies for CMA/RCL...
call ".venv-cma\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 exit /b 1
call ".venv-cma\Scripts\python.exe" -m pip install -r requirements\python-carriers.txt
if errorlevel 1 exit /b 1

echo Python carrier environment ready.
endlocal
