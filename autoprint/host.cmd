@echo off
rem Started by the browser. Logs each start (to a file, never to the screen: the
rem screen is how it talks to the browser), then runs host.ps1.
>>"%~dp0host.log" echo %date% %time% started by browser: %*
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0host.ps1" %*
>>"%~dp0host.log" echo %date% %time% ended, code %errorlevel%
