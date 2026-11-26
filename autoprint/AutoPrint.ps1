# AutoPrint - prints PDFs sent by NetSuite Helper's Auto Print button (and Bulk Print).
#   Label-sized pages -> LabelPrinter (twice for pallet labels)
#   A4 / letter pages -> PagePrinter
# NetSuite Helper saves into Downloads\AutoPrint; each file is printed, then deleted.
# Settings: settings.default.ini (shipped, safe to overwrite with updates), then
# settings.ini (this PC's own printers, made by Setup, never shipped, so an update
# can't reset it). Log: AutoPrint.log next to this script.
# Nothing to install: SumatraPDF and pdftotext live in the bin folder next to this script.

# ---- Settings (built-in defaults; settings.default.ini, then settings.ini, override) ----
$Settings = @{
    LabelPrinter  = 'ZDesigner GK420d'
    PagePrinter   = 'Door 1'
    LabelMaxPts   = '700'          # longest page side under this (points) = label. A4 is 842, a 4x6" label 432.
    PalletPattern = '(?i)\bPallet\b'
    PalletCopies  = '2'
    PollSeconds   = '1'
    WatchFolder   = ''             # blank = Downloads\AutoPrint
    UpdateRepo    = ''             # owner/name on GitHub; blank = no automatic updates
    UpdateSource  = ''             # a local folder instead of GitHub (testing)
    UpdateMinutes = '15'
}
foreach ($iniName in 'settings.default.ini', 'settings.ini') {
    $IniPath = Join-Path $PSScriptRoot $iniName
    if (-not (Test-Path $IniPath)) { continue }
    foreach ($line in Get-Content $IniPath) {
        if ($line -match '^\s*([A-Za-z]+)\s*=\s*(.*?)\s*$' -and $line -notmatch '^\s*[;#]') {
            if ($Matches[2] -ne '' -or $Matches[1] -in 'WatchFolder', 'UpdateRepo', 'UpdateSource') { $Settings[$Matches[1]] = $Matches[2] }
        }
    }
}
$LabelPrinter  = $Settings.LabelPrinter
$PagePrinter   = $Settings.PagePrinter
$LabelMaxPts   = [double]$Settings.LabelMaxPts
$PalletPattern = $Settings.PalletPattern
$PalletCopies  = [int]$Settings.PalletCopies
$PollSeconds   = [double]$Settings.PollSeconds
$UpdateMinutes = [math]::Max(5, [double]$Settings.UpdateMinutes)
$WatchFolder   = if ($Settings.WatchFolder) { $Settings.WatchFolder } else { Join-Path $env:USERPROFILE 'Downloads\AutoPrint' }

# Programs: bin folder first, then the usual installed places.
function Find-Tool($candidates) {
    foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
    return $null
}
$Sumatra = Find-Tool @(
    (Join-Path $PSScriptRoot 'bin\SumatraPDF\SumatraPDF.exe'),
    (Join-Path $env:LOCALAPPDATA 'SumatraPDF\SumatraPDF.exe')
)
$PdfToText = Find-Tool @(
    (Join-Path $PSScriptRoot 'bin\poppler\pdftotext.exe'),
    (Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages') -Filter pdftotext.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName)
)
# -----------------------------------------------------------------------------

$LogFile = Join-Path $PSScriptRoot 'AutoPrint.log'

function Write-Log($msg) {
    $line = '{0:yyyy-MM-dd HH:mm:ss.fff}  {1}' -f (Get-Date), $msg
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

# Returns the longest side of the first page in points, or $null if unknown.
function Get-PageLongSide($path) {
    $text = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($path))
    $m = [regex]::Match($text, '/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]')
    if (-not $m.Success) { return $null }
    $w = [math]::Abs([double]$m.Groups[3].Value - [double]$m.Groups[1].Value)
    $h = [math]::Abs([double]$m.Groups[4].Value - [double]$m.Groups[2].Value)
    return [math]::Max($w, $h)
}

# True once the browser has finished writing the file (no waiting here; the
# main loop retries for up to ~15 seconds, as before).
function Test-FileReady($path) {
    try {
        $s = [System.IO.File]::Open($path, 'Open', 'Read', 'None'); $s.Close()
        return $true
    } catch { return $false }
}

# Decide printer, scaling and copies for a file (same rules as before).
function Get-PrintJob($file) {
    $long = Get-PageLongSide $file.FullName
    if ($null -ne $long) {
        $isLabel = $long -lt $LabelMaxPts
        $why = "page long side $([math]::Round($long)) pt"
    } else {
        # Page size not readable (compressed PDF): fall back to the file name.
        $isLabel = $file.Name -like '*Label*'
        $why = 'page size unreadable, used file name'
    }

    $copies = 1
    if ($isLabel) {
        # Labels are black and white anyway; monochrome keeps the print job small.
        $printer = $LabelPrinter; $scale = 'fit,monochrome'
        if ($PdfToText) {
            $text = (& $PdfToText -q $file.FullName - 2>$null) -join "`n"
            if ($text -match $PalletPattern) { $copies = $PalletCopies; $why += ', pallet label' }
        } else { Write-Log "  pdftotext not found; pallet labels print once" }
    } else { $printer = $PagePrinter; $scale = 'shrink,paper=A4,simplex' }

    # All copies in one SumatraPDF run instead of one run per copy.
    if ($copies -gt 1) { $scale += ",$($copies)x" }
    $pages = Get-PageCount $file.FullName
    if ($pages -gt 1) { $why += ", $pages pages" }
    return [pscustomobject]@{ File = $file; Printer = $printer; Settings = $scale; Copies = $copies; Pages = $pages; Why = $why }
}

# Page count (pdfinfo, else counted in the file), 1 if unknown. Sets how long a print may take.
$PdfInfo = Join-Path $PSScriptRoot 'bin\poppler\pdfinfo.exe'
function Get-PageCount($path) {
    try {
        if (Test-Path $PdfInfo) {
            $line = (& $PdfInfo $path 2>$null) | Where-Object { $_ -match '^Pages:\s+(\d+)' } | Select-Object -First 1
            if ($line -and $line -match '(\d+)\s*$') { return [int]$Matches[1] }
        }
        $text = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($path))
        $n = [regex]::Matches($text, '/Type\s*/Page[^s]').Count
        if ($n -gt 0) { return $n }
    } catch {}
    return 1
}

# Each printer prints its own files in arrival order, but the label printer and
# the page printer work at the same time (a label no longer waits for an invoice).
$Queues  = @{}   # printer -> list of jobs waiting
$Busy    = @{}   # printer -> @{ Job; Proc; Start }
$Pending = @{}   # file path -> first time seen (waiting for the browser to finish)

function Start-Next($printer) {
    $q = $Queues[$printer]
    if (-not $q -or $q.Count -eq 0) { return }
    $job = $q[0]; $q.RemoveAt(0)
    Write-Log "PRINT $($job.File.Name) -> $($job.Printer) x$($job.Copies) ($($job.Why))"
    $p = Start-Process -FilePath $Sumatra -ArgumentList @('-print-to', "`"$($job.Printer)`"", '-print-settings', $job.Settings, '-silent', '-exit-when-done', "`"$($job.File.FullName)`"") -PassThru -WindowStyle Hidden
    $Busy[$printer] = @{ Job = $job; Proc = $p; Start = Get-Date }
}

# Seconds a print may take before it's given up on: 2 minutes, or 90 s plus 60 s per page
# printed for longer files (Door 1 can take 30-75 s a page, see TODO.md).
function Get-PrintLimit($job) {
    $n = [math]::Max(1, [int]$job.Pages) * [math]::Max(1, [int]$job.Copies)
    return [math]::Max(120, 90 + 60 * $n)
}

function Check-Busy {
    foreach ($printer in @($Busy.Keys)) {
        $b = $Busy[$printer]
        $secs = ((Get-Date) - $b.Start).TotalSeconds
        if ($b.Proc.HasExited) {
            if ($b.Proc.ExitCode -eq 0) {
                Remove-Item -LiteralPath $b.Job.File.FullName -Force -ErrorAction SilentlyContinue
                Write-Log ("  done in {0:N1}s: {1}" -f $secs, $b.Job.File.Name)
            } else {
                Write-Log "  print may have failed (exit code $($b.Proc.ExitCode)); kept $($b.Job.File.FullName)"
            }
            $Busy.Remove($printer)
        } elseif ($secs -gt (Get-PrintLimit $b.Job)) {
            # 26/11/2026: a flat 2 minutes cut off an 8-page ticket PDF on a slow copier after one
            # ticket, and Kill() left SumatraPDF running and the half job stuck in the queue,
            # blocking everything after it. Now the limit grows with the pages, and a print that
            # is given up on is ended for sure and taken out of the printer's queue.
            try { Stop-Process -Id $b.Proc.Id -Force -ErrorAction Stop } catch {}
            try {
                $leaf = $b.Job.File.Name
                PrintManagement\Get-PrintJob -PrinterName $printer -ErrorAction Stop |
                    Where-Object { $_.DocumentName -like "*$leaf*" } |
                    ForEach-Object { PrintManagement\Remove-PrintJob -InputObject $_ -ErrorAction SilentlyContinue }
            } catch {}
            Write-Log ("  print took over {0:N0}s; stopped it, cleared it from the queue and kept {1}" -f (Get-PrintLimit $b.Job), $b.Job.File.FullName)
            $Busy.Remove($printer)
        }
    }
    foreach ($printer in @($Queues.Keys)) { if (-not $Busy.ContainsKey($printer)) { Start-Next $printer } }
}

# Only one copy may run (same lock name as the original helper, so the two never both print).
$mutex = New-Object System.Threading.Mutex($false, 'Local\AutoPrintWatcher')
if (-not $mutex.WaitOne(0)) { exit }

if (-not $Sumatra) { Write-Log "SumatraPDF not found (expected bin\SumatraPDF\SumatraPDF.exe next to this script)"; exit 1 }
New-Item -ItemType Directory -Force -Path $WatchFolder | Out-Null
Write-Log "Started. Watching $WatchFolder. Labels -> $LabelPrinter, pages -> $PagePrinter. Sumatra: $Sumatra"

# Leftovers from before a restart (older than 2 minutes) are not printed again.
# Anything newer was just sent, e.g. the click that made the browser start this
# helper, so it still prints.
$seen = @{}
Get-ChildItem $WatchFolder -Filter *.pdf -File -ErrorAction SilentlyContinue | ForEach-Object {
    if (((Get-Date) - $_.LastWriteTime).TotalMinutes -gt 2) { $seen[$_.FullName] = $true }
}

# React the moment a file lands (the browser saves as .crdownload, then renames
# to .pdf), instead of checking once a second. The timeout is a safety net.
$watcher = New-Object System.IO.FileSystemWatcher $WatchFolder
$watcher.IncludeSubdirectories = $false

# Updates: Update.ps1 checks GitHub for a newer NetSuite Helper, in its own hidden
# process so printing never waits on it. First check 2 minutes after starting.
$Updater    = Join-Path $PSScriptRoot 'Update.ps1'
$NextUpdate = (Get-Date).AddMinutes(2)
function Start-UpdateCheck {
    if (-not ($Settings.UpdateRepo -or $Settings.UpdateSource) -or -not (Test-Path $Updater)) { return }
    $ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    Start-Process -FilePath $ps -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$Updater`"") -WindowStyle Hidden
}

while ($true) {
    if ((Get-Date) -ge $NextUpdate) {
        $NextUpdate = (Get-Date).AddMinutes($UpdateMinutes)
        try { Start-UpdateCheck } catch { Write-Log "Update check didn't start: $($_.Exception.Message)" }
    }
    $quick = ($Busy.Count -gt 0) -or ($Pending.Count -gt 0)
    $wait = if ($quick) { 250 } else { [int]($PollSeconds * 1000) }
    [void]$watcher.WaitForChanged([System.IO.WatcherChangeTypes]::All, $wait)

    Get-ChildItem $WatchFolder -Filter *.pdf -File -ErrorAction SilentlyContinue | ForEach-Object {
        if (-not $seen.ContainsKey($_.FullName)) { $seen[$_.FullName] = $true; $Pending[$_.FullName] = Get-Date }
    }

    foreach ($path in @($Pending.Keys)) {
        try {
            if (Test-FileReady $path) {
                $Pending.Remove($path)
                $job = Get-PrintJob (Get-Item -LiteralPath $path)
                if (-not $Queues.ContainsKey($job.Printer)) { $Queues[$job.Printer] = New-Object System.Collections.ArrayList }
                [void]$Queues[$job.Printer].Add($job)
            } elseif (((Get-Date) - $Pending[$path]).TotalSeconds -gt 15) {
                $Pending.Remove($path)
                Write-Log "SKIP (file stayed locked): $(Split-Path $path -Leaf)"
            }
        } catch {
            $Pending.Remove($path)
            Write-Log "ERROR $(Split-Path $path -Leaf): $($_.Exception.Message)"
        }
    }

    try { Check-Busy } catch { Write-Log "ERROR: $($_.Exception.Message)" }
}
