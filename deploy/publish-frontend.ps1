# Publish frontend build to IIS site folder(s). Run after npm run build in packages/frontend.
$ErrorActionPreference = 'Stop'
$repo = 'C:\inetpub\wwwroot\synapse-fullstack'
$src = Join-Path $repo 'packages\frontend\dist'
$webConfig = Join-Path $repo 'deploy\web.config'

if (-not (Test-Path (Join-Path $src 'index.html'))) {
    Push-Location (Join-Path $repo 'packages\frontend')
    npm run build
    Pop-Location
}

Copy-Item $webConfig (Join-Path $src 'web.config') -Force

# Synapse-Integration-Hub physical path (update if your site points elsewhere)
$targets = @(
    $src,
    'C:\inetpub\wwwroot\synapse-fullstack-master\packages\frontend\dist'
)

foreach ($dest in $targets) {
    if ($dest -eq $src) { Write-Host "Primary: $src"; continue }
    if (-not (Test-Path (Split-Path $dest -Parent)) { Write-Host "Skip: $dest"; continue }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Get-ChildItem $dest -Exclude 'web.config' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
    Copy-Item -Recurse -Force "$src\*" $dest
    Copy-Item $webConfig (Join-Path $dest 'web.config') -Force
    Write-Host "Published -> $dest"
}

Write-Host "Done. Hard-refresh https://synapse.nalashaa.com (Ctrl+F5)"
