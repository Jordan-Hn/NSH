# AutoPrint setup: pick this PC's printers, start AutoPrint at login, start it now.
# Run with Setup.cmd (double-click). No admin rights or installs needed.

$ErrorActionPreference = 'Stop'
$here    = $PSScriptRoot
$ini     = Join-Path $here 'settings.ini'          # this PC's printers (never shipped)
$defIni  = Join-Path $here 'settings.default.ini'  # shipped defaults
$script  = Join-Path $here 'AutoPrint.ps1'
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'AutoPrint.lnk'

function Get-Setting($name) {
    foreach ($f in $ini, $defIni) {
        if (-not (Test-Path $f)) { continue }
        $m = Select-String -Path $f -Pattern ('^\s*' + $name + '\s*=\s*(.*?)\s*$') | Select-Object -First 1
        if ($m -and $m.Matches[0].Groups[1].Value) { return $m.Matches[0].Groups[1].Value }
    }
    return ''
}
function Set-Setting($name, $value) {
    $lines = if (Test-Path $ini) { @(Get-Content $ini) } else {
        @('; This PC''s AutoPrint printers, saved by Setup.cmd. Updates never replace this file.',
          '; Run Setup.cmd again to change them. Other settings: settings.default.ini.')
    }
    $found = $false
    $lines = $lines | ForEach-Object {
        if ($_ -match ('^\s*' + $name + '\s*=')) { $found = $true; "$name = $value" } else { $_ }
    }
    if (-not $found) { $lines += "$name = $value" }
    Set-Content -Path $ini -Value $lines -Encoding UTF8
}

function Pick-Printer($label, $current, $printers) {
    Write-Host ""
    Write-Host "Which printer for $label`?" -ForegroundColor Cyan
    for ($i = 0; $i -lt $printers.Count; $i++) {
        $mark = if ($printers[$i] -eq $current) { '  (current)' } else { '' }
        Write-Host ("  {0,2}. {1}{2}" -f ($i + 1), $printers[$i], $mark)
    }
    while ($true) {
        $ans = Read-Host "Type a number, or press Enter to keep '$current'"
        if ([string]::IsNullOrWhiteSpace($ans)) { return $current }
        $n = 0
        if ([int]::TryParse($ans, [ref]$n) -and $n -ge 1 -and $n -le $printers.Count) { return $printers[$n - 1] }
        Write-Host "  Please type a number from the list." -ForegroundColor Yellow
    }
}

Write-Host "AutoPrint setup" -ForegroundColor Green
Write-Host "Labels print on the label printer (pallet labels twice). Invoices, packing slips and picking tickets print on the page printer."

$printers = @(Get-CimInstance Win32_Printer | Sort-Object Name | Select-Object -ExpandProperty Name)
if (-not $printers.Count) { Write-Host "No printers found on this PC." -ForegroundColor Red; exit 1 }

$label = Pick-Printer 'LABELS (e.g. the Zebra)' (Get-Setting 'LabelPrinter') $printers
$page  = Pick-Printer 'FULL PAGES (invoices, packing slips, picking tickets)' (Get-Setting 'PagePrinter') $printers
Set-Setting 'LabelPrinter' $label
Set-Setting 'PagePrinter' $page

if (-not (Test-Path (Join-Path $here 'bin\SumatraPDF\SumatraPDF.exe'))) {
    Write-Host "Warning: bin\SumatraPDF\SumatraPDF.exe is missing from this folder, so nothing can print." -ForegroundColor Yellow
}

# Stop any AutoPrint already running (old or new copy), so this one takes over.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -match 'AutoPrint\.ps1' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500

# Start at login, with no window.
$ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$conhost = Join-Path $env:WINDIR 'System32\conhost.exe'
$launchArgs = "--headless `"$ps`" -NoProfile -ExecutionPolicy Bypass -File `"$script`""
$sh = (New-Object -ComObject WScript.Shell).CreateShortcut($startup)
$sh.TargetPath = $conhost
$sh.Arguments = $launchArgs
$sh.WorkingDirectory = $here
$sh.Description = 'AutoPrint for NetSuite Helper'
$sh.Save()

# Let the browser start (and restart) AutoPrint too, so it doesn't rely on the
# login shortcut alone. Per-user, no admin rights.
. (Join-Path $here 'Register-Host.ps1')
Register-AutoPrintHost $here

# FUJIFILM copiers: stop the "Print is completed" pop-up after every job
# (error pop-ups stay on). Per-user setting, only if the monitor is installed.
$fuji = 'HKCU:\Software\FUJIFILM\DocumentMonitor\DocMon\EnvSet'
if (Test-Path $fuji) {
    Set-ItemProperty $fuji -Name DisplayAtFinish -Value 0
    $tray = Get-Process Cwtray -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($tray -and $tray.Path) { $trayPath = $tray.Path; $tray | Stop-Process -Force; Start-Process $trayPath }
}

# And start it now.
Start-Process -FilePath $conhost -ArgumentList $launchArgs -WorkingDirectory $here -WindowStyle Hidden

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  Labels -> $label"
Write-Host "  Pages  -> $page"
Write-Host "AutoPrint is running. It starts by itself when you log in and when the browser opens."
Write-Host "Last step: in the browser's Extensions page, click the reload icon on NetSuite Helper." -ForegroundColor Cyan
Write-Host "(A red AP? on the button means it isn't connected yet.)"
Write-Host "Log: $(Join-Path $here 'AutoPrint.log')"
