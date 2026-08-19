@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0luma\scripts\stop.ps1" -IncludeComfy
pause
