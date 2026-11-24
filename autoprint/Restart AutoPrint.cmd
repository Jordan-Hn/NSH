@echo off
rem Restart AutoPrint after an update. Keeps this PC's printers. No questions asked.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Restart.ps1"
echo.
pause
