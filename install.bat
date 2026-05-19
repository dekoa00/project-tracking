@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo Installing Node dependencies...
call npm install
if errorlevel 1 exit /b 1

echo Installing Playwright Microsoft Edge support...
call npx playwright install msedge
if errorlevel 1 exit /b 1

echo Installing Python carrier dependencies...
call setup-python-carriers.bat
if errorlevel 1 exit /b 1

echo Setup completed.
pause
endlocal
