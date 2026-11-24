# Lets the browser start AutoPrint (native messaging). Per-user registry only,
# no admin rights needed. Used by Setup.ps1 and Restart.ps1, so moving the
# folder and running either one fixes it.

function Register-AutoPrintHost($here) {
    $json = Join-Path $here 'com.kokoblack.autoprint.json'
    $browsers = @(
        'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
        'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts',
        'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
        'HKCU:\Software\Chromium\NativeMessagingHosts'
    )
    foreach ($b in $browsers) {
        $key = "$b\com.kokoblack.autoprint"
        New-Item -Path $key -Force | Out-Null
        Set-Item -Path $key -Value $json
    }
}
