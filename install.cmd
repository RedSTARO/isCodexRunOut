@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js 22.12 or newer is required.
  set "EXIT_CODE=1"
  goto :finish
)

node.exe -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 22.12 or newer is required. Current version:
  node.exe --version
  set "EXIT_CODE=1"
  goto :finish
)

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo npm is required but was not found in PATH.
  set "EXIT_CODE=1"
  goto :finish
)

if not exist "node_modules\@electron\asar\package.json" goto :install_dependencies
if not exist "node_modules\esbuild\package.json" goto :install_dependencies
goto :run_installer

:install_dependencies
echo Installing locked Node.js dependencies...
call npm.cmd ci
if errorlevel 1 (
  set "EXIT_CODE=!ERRORLEVEL!"
  echo Dependency installation failed with exit code !EXIT_CODE!.
  goto :finish
)

:run_installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\direct-operation.ps1" -Operation patch
set "EXIT_CODE=%ERRORLEVEL%"

:finish
echo.
if not "%EXIT_CODE%"=="0" echo Installation failed with exit code %EXIT_CODE%.
if "%EXIT_CODE%"=="0" echo Installation completed.
pause
exit /b %EXIT_CODE%
