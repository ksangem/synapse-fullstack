# Run as Administrator — fixes https://synapse.nalashaa.com 404
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$repo = 'C:\inetpub\wwwroot\synapse-fullstack'
$siteName = 'Synapse-Integration-Hub'
$hostName = 'synapse.nalashaa.com'
$physicalPath = Join-Path $repo 'packages\frontend\dist'
$appcmd = "$env:windir\System32\inetsrv\appcmd.exe"

Import-Module WebAdministration

# Build + publish static files
$dist = Join-Path $repo 'packages\frontend\dist'
if (-not (Test-Path (Join-Path $dist 'index.html'))) {
    Push-Location (Join-Path $repo 'packages\frontend')
    npm run build
    Pop-Location
}
Copy-Item (Join-Path $repo 'deploy\web.config') (Join-Path $dist 'web.config') -Force

& $appcmd set config -section:system.webServer/proxy /enabled:"True" /commit:apphost

# Create or update site
if (-not (Get-Website -Name $siteName -ErrorAction SilentlyContinue)) {
    New-Website -Name $siteName -PhysicalPath $physicalPath -Force | Out-Null
} else {
    Set-ItemProperty "IIS:\Sites\$siteName" -Name physicalPath -Value $physicalPath
}

# Remove bindings that steal port 4000 or duplicate hostless :80/:443
Get-WebBinding -Name $siteName | ForEach-Object {
    $bi = $_.bindingInformation
    if ($bi -match ':4000:' -or ($bi -eq '*:80:' -and $bi -notmatch $hostName) -or ($bi -eq '*:443:' -and $bi -notmatch $hostName)) {
        # keep only host-specific bindings below
    }
    if ($bi -match ':4000:') {
        Remove-WebBinding -Name $siteName -BindingInformation $bi -Protocol $_.protocol
        Write-Host "Removed $bi"
    }
}

# HTTP host header (required — otherwise Default Web Site answers for synapse.nalashaa.com)
$httpBinding = "*:80:$hostName"
if (-not (Get-WebBinding -Name $siteName -Protocol 'http' | Where-Object { $_.bindingInformation -eq $httpBinding })) {
    New-WebBinding -Name $siteName -Protocol http -Port 80 -HostHeader $hostName
    Write-Host "Added HTTP binding $httpBinding"
}

# HTTPS host header + certificate
$httpsBinding = "*:443:$hostName"
function Test-HostMatchesCert([string]$dnsHost, $cert) {
    foreach ($d in $cert.DnsNameList) {
        $n = $d.Unicode
        if ($n -eq $dnsHost) { return $true }
        if ($n.StartsWith('*.') -and $dnsHost.EndsWith($n.Substring(1))) { return $true }
    }
    return $false
}
$cert = Get-ChildItem Cert:\LocalMachine\My -ErrorAction SilentlyContinue |
    Where-Object { Test-HostMatchesCert $hostName $_ } |
    Sort-Object NotAfter -Descending | Select-Object -First 1
if (-not $cert) {
    $cert = Get-ChildItem Cert:\LocalMachine\WebHosting -ErrorAction SilentlyContinue |
        Where-Object { $_.DnsNameList.Unicode -contains $hostName } |
        Sort-Object NotAfter -Descending | Select-Object -First 1
}

if (-not (Get-WebBinding -Name $siteName -Protocol 'https' | Where-Object { $_.bindingInformation -eq $httpsBinding })) {
    if ($cert) {
        New-WebBinding -Name $siteName -Protocol https -Port 443 -HostHeader $hostName -SslFlags 1
        $bind = Get-WebBinding -Name $siteName -Protocol 'https' -HostHeader $hostName
        $bind.AddSslCertificate($cert.Thumbprint, 'My')
        Write-Host "Added HTTPS binding with cert $($cert.Thumbprint)"
    } else {
        Write-Warning "No cert found for $hostName — add HTTPS binding manually in IIS Manager"
    }
}

Start-Website -Name $siteName

Write-Host ""
Write-Host "Site: $siteName"
Write-Host "Path: $physicalPath"
Write-Host "URL:  https://$hostName/"
Write-Host "Ensure Node backend: deploy\start-backend.cmd (PORT=4000)"
