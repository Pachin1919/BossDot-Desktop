@echo off
setlocal
set "BOSSDOT_APP=%~dp0desktop-app\release\win-unpacked\BossDot.exe"
if not exist "%BOSSDOT_APP%" (
  echo BossDot.exe was not found.
  pause
  exit /b 1
)
set "BOSSCLAW_DEBUG=0"
set "BOSSCLAW_CONTROL=1"
start "" "%BOSSDOT_APP%" --control-bridge
