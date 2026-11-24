@echo off
rem Double-click to set up AutoPrint: pick printers, start at login, start now.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup.ps1"
echo.
pause
