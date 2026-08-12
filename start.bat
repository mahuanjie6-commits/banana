@echo off
title Banana Local Server
cd /d "%~dp0"

set PORT=3780

where node >nul 2>&1
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
)
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js not found. Install from https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo [INFO] .env missing, copy from .env.example
  copy /Y ".env.example" ".env" >nul
  echo Please set JWMP_API_KEY in Notepad, save, then run again.
  notepad ".env"
  pause
  exit /b 1
)

powershell -NoProfile -Command "try { $r=Invoke-WebRequest -Uri http://127.0.0.1:%PORT%/api/health -UseBasicParsing -TimeoutSec 2; if($r.StatusCode -eq 200){exit 0}else{exit 1} } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 (
  echo [INFO] Server already running. Opening browser...
  start "" "http://127.0.0.1:%PORT%/"
  pause
  exit /b 0
)

echo.
echo Starting Banana on port %PORT% ...
echo Keep this window open. Close window = stop server.
echo.

start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:%PORT%/"

node server.js
echo.
echo Server stopped. Code=%ERRORLEVEL%
pause