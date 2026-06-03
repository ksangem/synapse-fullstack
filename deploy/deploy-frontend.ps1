# Deploy Synapse frontend to IIS physical path
# Called by GitHub Actions (self-hosted) or manually on the VM
param(
    [string]$RepoRoot = $env:SYNAPSE_REPO_ROOT,
    [string]$FrontendPath = $env:SYNAPSE_FRONTEND_PATH,
    [string]$IisSite = $env:SYNAPSE_IIS_SITE,
    [switch]$UseArtifact = ($env:SYNAPSE_USE_ARTIFACT -eq 'true'),
    [string]$ArtifactPath = $env:SYNAPSE_ARTIFACT_PATH
)

$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) { $RepoRoot = Split-Path $PSScriptRoot -Parent }
if (-not $FrontendPath) { $FrontendPath = Join-Path $RepoRoot 'packages\frontend\dist' }
if (-not $IisSite) { $IisSite = 'Synapse-Integration-Hub' }

$webConfigSrc = Join-Path $RepoRoot 'deploy\web.config'

Write-Host "==> Synapse frontend deploy"
Write-Host "    Target: $FrontendPath"

New-Item -ItemType Directory -Force -Path $FrontendPath | Out-Null

if ($UseArtifact -and $ArtifactPath -and (Test-Path $ArtifactPath)) {
    Write-Host "    Source: CI artifact ($ArtifactPath)"
    Get-ChildItem $FrontendPath -Exclude 'web.config' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
    Copy-Item -Path (Join-Path $ArtifactPath '*') -Destination $FrontendPath -Recurse -Force
} else {
    Write-Host "    Source: build on VM"
    Push-Location (Join-Path $RepoRoot 'packages\frontend')
    if (Test-Path package-lock.json) { npm ci } else { npm install }
    npm run build
    Pop-Location
    $built = (Resolve-Path (Join-Path $RepoRoot 'packages\frontend\dist')).Path
    $targetResolved = Resolve-Path $FrontendPath -ErrorAction SilentlyContinue
    if ($targetResolved) { $target = $targetResolved.Path } else { $target = (New-Item -ItemType Directory -Force -Path $FrontendPath).FullName }
    if ($built.TrimEnd('\') -ne $target.TrimEnd('\')) {
        Get-ChildItem $target -Exclude 'web.config' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
        Copy-Item -Path (Join-Path $built '*') -Destination $target -Recurse -Force
    }
}

Copy-Item $webConfigSrc (Join-Path $FrontendPath 'web.config') -Force

if (-not (Test-Path (Join-Path $FrontendPath 'index.html'))) {
    throw "Deploy failed: index.html missing in $FrontendPath"
}

# Recycle IIS site if WebAdministration is available
try {
    Import-Module WebAdministration -ErrorAction Stop
    if (Get-Website -Name $IisSite -ErrorAction SilentlyContinue) {
        Restart-WebAppPool -Name (Get-Item "IIS:\Sites\$IisSite").applicationPool
        Write-Host "    Recycled app pool for site: $IisSite"
    }
} catch {
    Write-Host '    (IIS recycle skipped - run iisreset as Administrator if needed)'
}

Write-Host "==> Frontend deploy complete"
