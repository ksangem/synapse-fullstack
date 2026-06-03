#Requires -RunAsAdministrator
# Install GitHub Actions self-hosted runner for Synapse (Windows VM)
# Docs: https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners
param(
    [Parameter(Mandatory = $true)]
    [string]$RepoUrl = 'https://github.com/ksangem/synapse-fullstack',
    [string]$RunnerName = 'synapse-vm',
    [string]$RunnerLabels = 'synapse,self-hosted,Windows',
    [string]$InstallDir = 'C:\actions-runner'
)

$ErrorActionPreference = 'Stop'

Write-Host @"

Synapse — GitHub self-hosted runner setup
=========================================
1. Open: $RepoUrl/settings/actions/runners/new
2. Choose Windows x64 and copy the registration token (expires in 1 hour).
3. Paste the token when prompted below.

"@

$token = Read-Host 'Registration token'
if (-not $token) { throw 'Token is required' }

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Set-Location $InstallDir

if (-not (Test-Path 'config.cmd')) {
    $zip = Join-Path $env:TEMP 'actions-runner-win-x64.zip'
    Write-Host 'Downloading actions-runner...'
    Invoke-WebRequest -Uri 'https://github.com/actions/runner/releases/download/v2.321.0/actions-runner-win-x64-2.321.0.zip' -OutFile $zip
    Expand-Archive $zip -DestinationPath $InstallDir -Force
}

Write-Host 'Configuring runner...'
.\config.cmd --unattended --url $RepoUrl --token $token --name $RunnerName --labels $RunnerLabels --work _work

Write-Host 'Installing as Windows service...'
.\svc.cmd install
.\svc.cmd start

Write-Host @"

Runner installed. In GitHub, confirm it shows Online with labels: $RunnerLabels

Deploy workflows use: runs-on: [self-hosted, Windows, synapse]

"@
