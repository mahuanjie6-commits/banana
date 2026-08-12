@echo off
title Banana Git Update
cd /d "%~dp0"

echo.
echo ========================================
echo   Banana: git add / commit / push
echo ========================================
echo.

where git >nul 2>&1
if errorlevel 1 (
  echo [ERROR] git not found. Install Git first.
  pause
  exit /b 1
)

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Not a git repository.
  pause
  exit /b 1
)

echo [1/4] status
git status -sb
echo.

echo [2/4] git add .
git add .
if errorlevel 1 (
  echo [ERROR] git add failed.
  pause
  exit /b 1
)

git diff --cached --quiet
if not errorlevel 1 (
  git status -sb | findstr /C:"ahead" >nul 2>&1
  if errorlevel 1 (
    echo [INFO] Nothing to commit, nothing to push.
    echo.
    pause
    exit /b 0
  )
  echo [INFO] No new changes, pushing existing commits...
  goto do_push
)

set "MSG="
set /p "MSG=Commit message (Enter = default): "
if "%MSG%"=="" set "MSG=update"

echo.
echo [3/4] git commit
git commit -m "%MSG%"
if errorlevel 1 (
  echo [ERROR] git commit failed.
  pause
  exit /b 1
)

:do_push
echo.
echo [4/4] git push origin main
git push origin main
if errorlevel 1 (
  echo.
  echo [ERROR] push failed. Check network / GitHub login.
  echo   Or run manually: git push origin main
  echo.
  pause
  exit /b 1
)

echo.
echo ========================================
echo   Done. Render will auto-deploy if linked.
echo ========================================
echo.
pause
exit /b 0