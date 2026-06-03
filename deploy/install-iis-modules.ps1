#Requires -RunAsAdministrator
# Fixes HTTP 500.19 (0x8007000d) — IIS cannot read <rewrite> without these modules.
$ErrorActionPreference = 'Stop'

Write-Host "Installing IIS URL Rewrite + Application Request Routing..."

if (Get-Command choco -ErrorAction SilentlyContinue) {
    choco install urlrewrite iis-arr -y
} else {
    Write-Host "Chocolatey not found. Download and install manually:"
    Write-Host "  URL Rewrite 2.1: https://www.iis.net/downloads/microsoft/url-rewrite"
    Write-Host "  ARR 3.0:         https://www.iis.net/downloads/microsoft/application-request-routing"
    exit 1
}

$appcmd = "$env:windir\System32\inetsrv\appcmd.exe"
& $appcmd set config -section:system.webServer/proxy /enabled:"True" /commit:apphost

$repo = 'C:\inetpub\wwwroot\synapse-fullstack'
Copy-Item (Join-Path $repo 'deploy\web.config') (Join-Path $repo 'packages\frontend\dist\web.config') -Force

Write-Host "Done. Restart IIS: iisreset"
Write-Host "Then open https://synapse.nalashaa.com/"
