@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo [%date% %time%] Start scheduled Project Tracking
call run_silent.bat
set EXITCODE=%ERRORLEVEL%
echo [%date% %time%] End scheduled Project Tracking. Exit code: %EXITCODE%
exit /b %EXITCODE%
