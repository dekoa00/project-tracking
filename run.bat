@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if not exist config.json (
  echo Missing config.json. Copy config.example.json to config.json and edit the paths first.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing npm packages...
  call npm install
  if errorlevel 1 exit /b 1
)

echo ==========================================
echo Project Tracking - OneDrive manual 1.raw run
echo ==========================================
echo Input : tracking_raw.xlsx / 1. raw
echo Output: tracking_result.xlsx + tracking_raw.xlsx / 3. result
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run_staged_sync.ps1" -ConfigPath "%~dp0config.json"
if errorlevel 1 (
  echo.
  echo ERROR: Tracking flow failed.
  echo Close tracking_raw.xlsx / tracking_result.xlsx everywhere, wait OneDrive sync, then rerun.
  pause
  exit /b 1
)

echo.
echo DONE.
pause
