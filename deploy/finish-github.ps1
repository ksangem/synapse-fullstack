# Run once as the GitHub user who OWNS ksangem/synapse-fullstack (Admin PowerShell optional)
$ErrorActionPreference = 'Stop'
$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
$RepoRoot = 'C:\inetpub\wwwroot\synapse-fullstack'

Write-Host 'Step 1: Log in to GitHub (browser opens - use ksangem account)' -ForegroundColor Cyan
gh auth login -h github.com -p https -w

Write-Host 'Step 2: Push CI/CD files' -ForegroundColor Cyan
Set-Location $RepoRoot
git push origin master

Write-Host 'Step 3: Install self-hosted runner' -ForegroundColor Cyan
Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$RepoRoot\deploy\install-runner-unattended.ps1`"" -Wait

Write-Host 'Step 4: Open Actions dashboard' -ForegroundColor Green
Start-Process 'https://github.com/ksangem/synapse-fullstack/actions'
