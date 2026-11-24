# Keeps NetSuite Helper up to date from its GitHub repo. AutoPrint starts this about
# every 15 minutes (UpdateMinutes); it can also be run by hand.
#   1. Reads the version in the repo's manifest.json.
#   2. If it's newer than this folder's, downloads the repo as a zip and copies its
#      files over this folder. This PC's settings.ini and the logs are never touched.
#      manifest.json goes last, so NetSuite Helper only reloads once everything is in
#      place (it watches the version and reloads itself, waiting if a tool is busy).
#   3. If AutoPrint's own files changed, AutoPrint restarts.
# Never downgrades. Never runs in the folder that makes the releases (the one with
# make-release.ps1 in it). Anything that fails is left as it was and tried again next time.
# Settings (settings.default.ini / settings.ini): UpdateRepo = owner/name on GitHub,
# UpdateBranch (default main). UpdateSource = a local folder instead of GitHub (testing).
# Log: Update.log next to this script.

param([switch]$Force)   # -Force: run even in the release-making folder (testing only)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Split-Path $here -Parent
$log  = Join-Path $here 'Update.log'

function Write-UpdateLog($msg) {
    Add-Content -Path $log -Value ('{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $msg) -Encoding UTF8
}

$set = @{ UpdateRepo = ''; UpdateBranch = 'main'; UpdateSource = '' }
foreach ($iniName in 'settings.default.ini', 'settings.ini') {
    $ini = Join-Path $here $iniName
    if (-not (Test-Path $ini)) { continue }
    foreach ($line in Get-Content $ini) {
        if ($line -match '^\s*([A-Za-z]+)\s*=\s*(.*?)\s*$' -and $line -notmatch '^\s*[;#]' -and $set.ContainsKey($Matches[1]) -and $Matches[2] -ne '') {
            $set[$Matches[1]] = $Matches[2]
        }
    }
}
if (-not $set.UpdateRepo -and -not $set.UpdateSource) { exit 0 }   # updates not set up

# The text that gets signed: the version, then "sha256 path" per file, sorted. The same
# function is used by publish-release.ps1 when signing, so the two always agree.
function Get-ReleaseText([string]$version, $files) {
    $lines = @('NetSuite Helper release', "version=$version")
    $files.Keys | Sort-Object { $_.ToLowerInvariant() } | ForEach-Object { $lines += ($files[$_].ToLowerInvariant() + ' ' + $_) }
    return ($lines -join "`n")
}

# Checks release.sig in $dir against this PC's public key. Returns @{ path = SHA256 }
# for the signed files, or throws. Every file in the download must be listed with the
# right hash, every listed file must be there, and the signed version must be $version.
function Test-ReleaseSignature([string]$dir, [version]$version) {
    $keyFile = Join-Path $here 'release-key.xml'
    if (-not (Test-Path $keyFile)) { throw 'no release-key.xml on this PC, so updates can''t be checked (install the latest zip by hand once)' }
    $sigFile = Join-Path $dir 'release.sig'
    if (-not (Test-Path $sigFile)) { throw 'the download is not signed' }
    $sig = Get-Content $sigFile -Raw | ConvertFrom-Json
    if ([version]$sig.version -ne $version) { throw "the signature is for version $($sig.version), not $version" }
    $files = @{}
    foreach ($f in $sig.files) {
        $p = [string]$f.path
        if ($p -match '\.\.|:|^[\\/]|[/]' -or $p -eq '') { throw "the signed list has a bad path: $p" }
        if ($f.sha256 -notmatch '^[0-9A-Fa-f]{64}$') { throw "the signed list has a bad hash for $p" }
        $files[$p] = ([string]$f.sha256).ToUpperInvariant()
    }
    $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider
    try {
        $rsa.FromXmlString((Get-Content $keyFile -Raw))
        $bytes = [Text.Encoding]::UTF8.GetBytes((Get-ReleaseText $sig.version $files))
        $ok = $rsa.VerifyData($bytes, 'SHA256', [Convert]::FromBase64String([string]$sig.signature))
    } finally { $rsa.Dispose() }
    if (-not $ok) { throw 'the signature is not valid (not made with the release key). Nothing was changed' }
    $found = @{}
    Get-ChildItem $dir -Recurse -File -Force | ForEach-Object {
        $rel = $_.FullName.Substring($dir.Length + 1)
        if ($rel -eq 'release.sig' -or $rel -like '.git\*') { return }
        if (-not $files.ContainsKey($rel)) { throw "the download has a file that isn't signed: $rel" }
        if ((Get-FileHash $_.FullName -Algorithm SHA256).Hash -ne $files[$rel]) { throw "a file doesn't match its signature: $rel" }
        $found[$rel] = $true
    }
    foreach ($p in $files.Keys) { if (-not $found.ContainsKey($p)) { throw "a signed file is missing from the download: $p" } }
    return $files
}
if ((Test-Path (Join-Path $root 'make-release.ps1')) -and -not $Force) { exit 0 }   # the release-making copy

# One update at a time.
$mutex = New-Object System.Threading.Mutex($false, 'Local\NetSuiteHelperUpdate')
if (-not $mutex.WaitOne(0)) { exit 0 }

$work = Join-Path ([IO.Path]::GetTempPath()) ('nsh-update-' + [guid]::NewGuid().ToString('N'))
try {
    $local = [version]((Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json).version)

    # ---- What's the newest version? ----
    if ($set.UpdateSource) {
        $remoteManifest = Get-Content (Join-Path $set.UpdateSource 'manifest.json') -Raw
    } else {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $url = 'https://raw.githubusercontent.com/' + $set.UpdateRepo + '/' + $set.UpdateBranch + '/manifest.json?t=' + [DateTime]::UtcNow.Ticks
        $remoteManifest = (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 30 -Headers @{ 'User-Agent' = 'netsuite-helper-updater' }).Content
    }
    $remote = [version](($remoteManifest | ConvertFrom-Json).version)
    if ($remote -le $local) { exit 0 }
    Write-UpdateLog "Update found: $local -> $remote"

    # ---- Get the files ----
    if ($set.UpdateSource) {
        $src = $set.UpdateSource
    } else {
        New-Item -ItemType Directory -Force -Path $work | Out-Null
        $zip = Join-Path $work 'update.zip'
        $zipUrl = 'https://codeload.github.com/' + $set.UpdateRepo + '/zip/refs/heads/' + $set.UpdateBranch
        Invoke-WebRequest -Uri $zipUrl -OutFile $zip -UseBasicParsing -TimeoutSec 300 -Headers @{ 'User-Agent' = 'netsuite-helper-updater' }
        Expand-Archive -Path $zip -DestinationPath (Join-Path $work 'x')
        $src = (Get-ChildItem (Join-Path $work 'x') -Directory | Select-Object -First 1).FullName
    }
    $srcManifest = Join-Path $src 'manifest.json'
    if (-not (Test-Path $srcManifest)) { throw 'the download has no manifest.json' }
    $got = [version]((Get-Content $srcManifest -Raw | ConvertFrom-Json).version)
    if ($got -ne $remote) { throw "the download is version $got, expected $remote (try again later)" }

    # ---- Signature check: nothing is copied unless every file matches the signed list ----
    # Releases are signed with a private key that only exists on the release-making PC.
    # This PC holds the matching public key (release-key.xml). So a changed download, a
    # hacked GitHub account or an old version can't get onto this PC.
    $listed = Test-ReleaseSignature $src $remote

    # ---- Copy over this folder (only the signed files) ----
    $skip = @('autoprint\settings.ini', 'manifest.json', 'release.sig')
    $changed = New-Object System.Collections.ArrayList
    $failed  = New-Object System.Collections.ArrayList
    $listed.Keys | Sort-Object | ForEach-Object {
        $rel = $_
        if ($skip -contains $rel -or $rel -like '*.log') { return }
        $from = Join-Path $src $rel
        $dst = Join-Path $root $rel
        if ((Test-Path $dst) -and (Get-FileHash $dst -Algorithm SHA256).Hash -eq $listed[$rel]) { return }
        try {
            New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
            Copy-Item -LiteralPath $from -Destination $dst -Force
            [void]$changed.Add($rel)
        } catch {
            [void]$failed.Add($rel)
        }
    }
    if ($failed.Count) {
        Write-UpdateLog ("Couldn't replace (in use?), will try again: " + ($failed -join ', '))
        exit 1
    }
    # Last: the version, which makes NetSuite Helper reload.
    Copy-Item -LiteralPath $srcManifest -Destination (Join-Path $root 'manifest.json') -Force
    $text = "NetSuite Helper $remote, updated $(Get-Date -Format 'dd/MM/yyyy HH:mm')"
    Set-Content -Path (Join-Path $root 'VERSION.txt') -Value $text -Encoding UTF8
    Write-UpdateLog ("Updated to $remote (" + ($changed.Count + 1) + ' files)')

    # AutoPrint's own files changed: restart it (Restart.ps1 keeps this PC's printers).
    if ($changed | Where-Object { $_ -like 'autoprint\*' }) {
        Write-UpdateLog 'Restarting AutoPrint for its new files'
        $ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
        Start-Process -FilePath $ps -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $here 'Restart.ps1')`"") -WindowStyle Hidden
    }
} catch {
    Write-UpdateLog "Update failed: $($_.Exception.Message)"
    exit 1
} finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    $mutex.ReleaseMutex()
}
