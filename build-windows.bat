@echo off
setlocal
title Build Pulse
cd /d "%~dp0"

echo.
echo  Building the Pulse installer. The first build takes 5-15 minutes.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js is not installed. Get the LTS version from https://nodejs.org
  echo  then run this file again.
  pause
  exit /b 1
)
where cargo >nul 2>nul
if errorlevel 1 (
  echo  Rust is not installed. Get it from https://rustup.rs
  echo  Accept the "Visual Studio C++ Build Tools" step when it asks.
  echo  Then CLOSE this window, open it again, and run this file again.
  pause
  exit /b 1
)

call npm install
if errorlevel 1 goto fail
call npm run tauri build
if errorlevel 1 goto fail

echo.
echo  Done! Your installer is in the folder that is about to open.
echo  Double-click Pulse_0.1.0_x64-setup.exe to install.
start "" "src-tauri\target\release\bundle\nsis"
pause
exit /b 0

:fail
echo.
echo  The build stopped with an error. Copy the red text above and send it back.
pause
exit /b 1
