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
        # Read (and ignore) the message body; any message means "check and report".
        $len = [BitConverter]::ToInt32($head, 0)
        if ($len -gt 0 -and $len -lt 1048576) {
            $body = New-Object byte[] $len; $got = 0
            while ($got -lt $len) { $n = $stdin.Read($body, $got, $len - $got); if ($n -le 0) { break }; $got += $n }
        }
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
