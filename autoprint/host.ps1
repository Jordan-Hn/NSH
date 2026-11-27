# AutoPrint host: started by the browser (native messaging) when it opens.
# It makes sure the AutoPrint helper is running, restarts it if it stops, and
# tells NetSuite Helper whether it's running (so the button can warn you).
# Ends when the browser closes. No admin rights needed.
#
# Talks to the browser over stdin/stdout: each message is a 4-byte length then JSON.
# Nothing else may be written to stdout.

$ErrorActionPreference = 'SilentlyContinue'
$here   = $PSScriptRoot
$stdin  = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()

function Send-Message($obj) {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress))
    $stdout.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

# The helper holds this lock while it runs (only one copy can).
function Test-HelperRunning {
    $m = $null
    $ok = [Threading.Mutex]::TryOpenExisting('Local\AutoPrintWatcher', [ref]$m)
    if ($m) { $m.Dispose() }
    return $ok
}

function Start-Helper {
    $ps      = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $conhost = Join-Path $env:WINDIR 'System32\conhost.exe'
    $launch  = "--headless `"$ps`" -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $here 'AutoPrint.ps1')`""
    Start-Process -FilePath $conhost -ArgumentList $launch -WorkingDirectory $here -WindowStyle Hidden
    for ($i = 0; $i -lt 20 -and -not (Test-HelperRunning); $i++) { Start-Sleep -Milliseconds 250 }
}

# The version of the extension files in this folder (so the browser can tell
# when they've been updated and reload itself).
function Get-FolderVersion {
    try { return [string]((Get-Content (Join-Path (Split-Path $here -Parent) 'manifest.json') -Raw | ConvertFrom-Json).version) } catch { return '' }
}

# ---- Settings page: printers and copies (27/11/2026) ----
$ini    = Join-Path $here 'settings.ini'
$defIni = Join-Path $here 'settings.default.ini'
function Get-Setting($name, $fallback) {
    foreach ($f in $ini, $defIni) {
        if (-not (Test-Path $f)) { continue }
        $m = Select-String -Path $f -Pattern ('^\s*' + $name + '\s*=\s*(.*?)\s*$') | Select-Object -First 1
        if ($m -and $m.Matches[0].Groups[1].Value) { return $m.Matches[0].Groups[1].Value }
    }
    return $fallback
}
function Set-Setting($name, $value) {
    $lines = if (Test-Path $ini) { @(Get-Content $ini) } else { @('; This PC''s AutoPrint settings. Updates never replace this file.') }
    $found = $false
    $lines = $lines | ForEach-Object { if ($_ -match ('^\s*' + $name + '\s*=')) { $found = $true; "$name = $value" } else { $_ } }
    if (-not $found) { $lines += "$name = $value" }
    Set-Content -Path $ini -Value $lines -Encoding UTF8
}
function Get-PrinterNames {
    try { return @(Get-CimInstance Win32_Printer | Select-Object -ExpandProperty Name | Sort-Object) } catch { return @() }
}
function Restart-Helper {
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match 'AutoPrint\.ps1' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 800
    Start-Helper
}
function Handle-Request($req) {
    if ($req.cmd -eq 'printers') {
        Send-Message @{ reply = 'printers'; id = $req.id; ok = $true; printers = @(Get-PrinterNames)
            label = (Get-Setting 'LabelPrinter' ''); page = (Get-Setting 'PagePrinter' '')
            labelCopies = [int](Get-Setting 'LabelCopies' '1'); palletCopies = [int](Get-Setting 'PalletCopies' '2')
            invoiceCopies = [int](Get-Setting 'InvoiceCopies' '1'); pageCopies = [int](Get-Setting 'PageCopies' '1') }
        return $true
    }
    if ($req.cmd -eq 'save-printers') {
        try {
            $names = Get-PrinterNames
            foreach ($p in $req.label, $req.page) { if ($p -and $names -notcontains $p) { throw "There's no printer called $p on this PC." } }
            if ($req.label) { Set-Setting 'LabelPrinter' $req.label }
            if ($req.page) { Set-Setting 'PagePrinter' $req.page }
            foreach ($k in 'LabelCopies', 'PalletCopies', 'InvoiceCopies', 'PageCopies') {
                $v = [int]$req.($k.Substring(0, 1).ToLower() + $k.Substring(1))
                if ($v -ge 1 -and $v -le 9) { Set-Setting $k $v }
            }
            Restart-Helper
            Send-Message @{ reply = 'save-printers'; id = $req.id; ok = $true }
        } catch {
            Send-Message @{ reply = 'save-printers'; id = $req.id; ok = $false; error = $_.Exception.Message }
        }
        return $true
    }
    return $false
}

function Report($started) {
    Send-Message @{ running = [bool](Test-HelperRunning); started = [bool]$started; folder = $here; version = (Get-FolderVersion) }
}

$started = $false
if (-not (Test-HelperRunning)) { Start-Helper; $started = $true }
Report $started

$head = New-Object byte[] 4
$read = $stdin.ReadAsync($head, 0, 4)
while ($true) {
    if ($read.Wait(5000)) {
        if ($read.Result -le 0) { break }   # the browser closed the connection
        # Read the message. Settings-page requests get their own answer; anything else
        # means "check and report".
        $len = [BitConverter]::ToInt32($head, 0)
        $req = $null
        if ($len -gt 0 -and $len -lt 1048576) {
            $body = New-Object byte[] $len; $got = 0
            while ($got -lt $len) { $n = $stdin.Read($body, $got, $len - $got); if ($n -le 0) { break }; $got += $n }
            try { $req = [Text.Encoding]::UTF8.GetString($body, 0, $got) | ConvertFrom-Json } catch { $req = $null }
        }
        if ($req -and $req.cmd -and (Handle-Request $req)) { $read = $stdin.ReadAsync($head, 0, 4); continue }
        $restarted = $false
        if (-not (Test-HelperRunning)) { Start-Helper; $restarted = $true }
        Report $restarted
        $read = $stdin.ReadAsync($head, 0, 4)
    } else {
        if (-not (Test-HelperRunning)) {
            # Helper stopped on its own: start it again and say so.
            Start-Helper
            Report $true
        }
        # Every ~minute, report anyway, so a new version in the folder is noticed.
        $tick = [int]$tick + 1
        if ($tick % 12 -eq 0) { Report $false }
    }
}
