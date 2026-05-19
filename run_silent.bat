@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if not exist node_modules (
  call npm install >nul 2>&1
  if errorlevel 1 exit /b 1
)

if not exist data mkdir data
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run_staged_sync.ps1" -ConfigPath "%~dp0config.json" -Silent
exit /b %ERRORLEVEL%
