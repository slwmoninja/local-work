@echo off
setlocal
cd /d "%~dp0"

echo Refreshing LocalWork job data -- this re-scrapes local employer
echo career pages and job boards and re-scores every posting. Takes a
echo few minutes.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\refresh-jobs.ps1"

echo.
echo ==============================================
echo Refresh finished. Changes since the last commit:
echo ==============================================
git status --short
echo.
echo Review the diff above before committing/pushing -- this window
echo does not push anything on its own.
echo.
pause
