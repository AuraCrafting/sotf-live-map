@echo off
title SOTF Live Map - uninstall
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\install.ps1" -Uninstall %*
echo.
pause
