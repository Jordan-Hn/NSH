# Restart AutoPrint with the files in this folder, keeping this PC's printers.
# Use after copying an update over this folder. No questions asked.

$here    = $PSScriptRoot
$script  = Join-Path $here 'AutoPrint.ps1'
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'AutoPrint.lnk'

Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -match 'AutoPrint\.ps1' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800

$ps      = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$conhost = Join-Path $env:WINDIR 'System32\conhost.exe'
$launch  = "--headless `"$ps`" -NoProfile -ExecutionPolicy Bypass -File `"$script`""

# Keep the login shortcut pointing at this folder (in case the folder moved).
$sh = (New-Object -ComObject WScript.Shell).CreateShortcut($startup)
$sh.TargetPath = $conhost; $sh.Arguments = $launch; $sh.WorkingDirectory = $here
$sh.Description = 'AutoPrint for NetSuite Helper'; $sh.Save()

Start-Process -FilePath $conhost -ArgumentList $launch -WorkingDirectory $here -WindowStyle Hidden

# Keep the browser's link to this folder up to date (per-user, no admin).
. (Join-Path $here 'Register-Host.ps1')
Register-AutoPrintHost $here
Start-Sleep -Seconds 3

if (Test-Path (Join-Path $here 'settings.ini')) {
    Write-Host "AutoPrint restarted with this PC's printers." -ForegroundColor Green
} else {
    Write-Host "AutoPrint restarted, but no printers are saved yet. Run Setup.cmd once." -ForegroundColor Yellow
}
Get-Content (Join-Path $here 'AutoPrint.log') -Tail 1 -ErrorAction SilentlyContinue
