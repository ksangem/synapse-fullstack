#Requires -RunAsAdministrator
# One-shot: prerequisites + IIS modules + optional runner + push workflows
# Run: powershell -ExecutionPolicy Bypass -File C:\inetpub\wwwroot\synapse-fullstack\deploy\INSTALL-ALL.ps1
$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path $PSScriptRoot -Parent

Write-Host '=== Synapse CI/CD full install ===' -ForegroundColor Cyan

& "$RepoRoot\deploy\install-cicd-prereqs.ps1"

$env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')

# Copy web.config to dist
Copy-Item "$RepoRoot\deploy\web.config" "$RepoRoot\packages\frontend\dist\web.config" -Force

# Try runner (needs gh auth or GITHUB_TOKEN)
try {
    & "$RepoRoot\deploy\install-runner-unattended.ps1"
} catch {
    Write-Warning "Runner install skipped: $($_.Exception.Message)"
    Write-Host 'After gh auth login, run: deploy\install-runner-unattended.ps1'
}

# Try push workflows to GitHub
Set-Location $RepoRoot
if (Get-Command git -ErrorAction SilentlyContinue) {
    $status = git status --porcelain 2>&1
    if ($status) {
        git add .github deploy docs README.md packages/backend/src/index.ts packages/frontend/src/services/api.js 2>$null
        git add -A .github deploy docs 2>$null
        git commit -m "Add CI/CD pipelines, deploy scripts, and dashboard" 2>$null
    }
    if (Get-Command gh -ErrorAction SilentlyContinue) {
        gh auth status 2>$null
        if ($LASTEXITCODE -eq 0) {
            git push origin main 2>$null
            if ($LASTEXITCODE -ne 0) { git push origin master 2>$null }
            Write-Host 'Pushed to GitHub.'
        } else {
            Write-Host 'Push skipped — run: gh auth login'
        }
    }
}

Write-Host '=== Done. Open: https://github.com/ksangem/synapse-fullstack/actions ===' -ForegroundColor Green
