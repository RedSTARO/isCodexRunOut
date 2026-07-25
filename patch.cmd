@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\direct-operation.ps1" -Operation patch
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo Patch failed with exit code %EXIT_CODE%.
if "%EXIT_CODE%"=="0" echo Patch completed.
pause
exit /b %EXIT_CODE%
