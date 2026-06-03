#Requires -RunAsAdministrator
# Installs CI/CD prerequisites on the Synapse VM (no prompts)
$ErrorActionPreference = 'Stop'

Write-Host '==> Installing Git, GitHub CLI, IIS URL Rewrite, ARR...'

if (Get-Command choco -ErrorAction SilentlyContinue) {
    choco install git.install gh urlrewrite iis-arr -y --no-progress
} else {
    throw 'Chocolatey required. Install from https://chocolatey.org/install'
}

$appcmd = "$env:windir\System32\inetsrv\appcmd.exe"
& $appcmd set config -section:system.webServer/proxy /enabled:"True" /commit:apphost

$env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')

Write-Host '==> Prerequisites installed.'
Write-Host '    Git:  ' ((Get-Command git -ErrorAction SilentlyContinue).Source)
Write-Host '    gh:   ' ((Get-Command gh -ErrorAction SilentlyContinue).Source)
