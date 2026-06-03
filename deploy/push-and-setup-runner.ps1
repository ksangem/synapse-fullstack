# Run in YOUR PowerShell session (logged in as you on the VM)
# Option A: Browser login (recommended)
#   gh auth login -h github.com -p https -w
# Option B: Paste a token once (repo write access):
#   $env:GITHUB_TOKEN = 'ghp_xxxx'
#   $env:GITHUB_TOKEN | gh auth login --with-token

$ErrorActionPreference = 'Stop'
$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
$RepoRoot = 'C:\inetpub\wwwroot\synapse-fullstack'

if (-not (gh auth status 2>$null)) {
    if ($env:GITHUB_TOKEN) {
        $env:GITHUB_TOKEN | gh auth login --with-token
    } else {
        Write-Host 'Opening GitHub login in browser - sign in with YOUR account (ksangem or collaborator with write access).'
        gh auth login -h github.com -p https -w
    }
}

Set-Location $RepoRoot
git push origin master
if ($LASTEXITCODE -ne 0) { git push origin main }

Write-Host 'Installing runner (Admin)...'
Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$RepoRoot\deploy\install-runner-unattended.ps1`"" -Wait

Start-Process 'https://github.com/ksangem/synapse-fullstack/actions'
Write-Host 'Done.'
