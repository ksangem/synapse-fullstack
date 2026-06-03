#Requires -RunAsAdministrator
# Registers GitHub Actions self-hosted runner using gh CLI (no interactive token paste)
param(
    [string]$Repo = 'ksangem/synapse-fullstack',
    [string]$RunnerName = 'synapse-vm',
    [string]$InstallDir = 'C:\actions-runner'
)

$ErrorActionPreference = 'Stop'
$env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw 'GitHub CLI (gh) not found. Run deploy\install-cicd-prereqs.ps1 first.'
}

# gh must be authenticated: set GITHUB_TOKEN or run `gh auth login` once as admin
$auth = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
    if ($env:GITHUB_TOKEN) {
        $env:GITHUB_TOKEN | gh auth login --with-token
    } else {
        throw @"
gh is not authenticated. On this VM run once (Admin):
  gh auth login -h github.com -p https -w
Or set machine env GITHUB_TOKEN with a PAT (repo + admin:org or repo scope for private repos).
"@
    }
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Set-Location $InstallDir

if (-not (Test-Path 'config.cmd')) {
    $ver = '2.321.0'
    $zip = Join-Path $env:TEMP "actions-runner-win-x64-$ver.zip"
    Invoke-WebRequest -Uri "https://github.com/actions/runner/releases/download/v$ver/actions-runner-win-x64-$ver.zip" -OutFile $zip
    Expand-Archive $zip -DestinationPath $InstallDir -Force
}

# Remove previous registration if re-running
if (Test-Path '.runner') {
    Write-Host 'Runner already configured. Stopping service...'
    .\svc.cmd stop 2>$null
    .\svc.cmd uninstall 2>$null
    $removeToken = gh api -X POST "repos/$Repo/actions/runners/remove-token" --jq .token
    .\config.cmd remove --unattended --token $removeToken 2>$null
}

$regToken = gh api -X POST "repos/$Repo/actions/runners/registration-token" --jq .token
if (-not $regToken) { throw 'Failed to get registration token from GitHub API' }

.\config.cmd --unattended `
    --url "https://github.com/$Repo" `
    --token $regToken `
    --name $RunnerName `
    --labels 'synapse,self-hosted,Windows' `
    --work '_work' `
    --replace

.\svc.cmd install
.\svc.cmd start

Write-Host "==> Runner '$RunnerName' installed and started."
gh api "repos/$Repo/actions/runners" --jq '.runners[] | {name, status, labels: [.labels[].name]}'
