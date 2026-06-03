# Deploy Synapse backend (Node API on port 4000)
# Preserves packages/backend/.env on the VM
param(
    [string]$RepoRoot = $env:SYNAPSE_REPO_ROOT,
    [string]$BackendPath = $env:SYNAPSE_BACKEND_PATH,
    [string]$ServiceName = $env:SYNAPSE_SERVICE_NAME,
    [switch]$UseArtifact = ($env:SYNAPSE_USE_ARTIFACT -eq 'true'),
    [string]$ArtifactPath = $env:SYNAPSE_ARTIFACT_PATH,
    [switch]$RunDbSeed = ($env:SYNAPSE_RUN_DB_SEED -eq 'true')
)

$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) { $RepoRoot = Split-Path $PSScriptRoot -Parent }
if (-not $BackendPath) { $BackendPath = Join-Path $RepoRoot 'packages\backend' }
if (-not $ServiceName) { $ServiceName = 'SynapseBackend' }

Write-Host "==> Synapse backend deploy"
Write-Host "    Target: $BackendPath"

$envFile = Join-Path $BackendPath '.env'
$envBackup = $null
if (Test-Path $envFile) {
    $envBackup = Get-Content $envFile -Raw
    Write-Host "    Preserving existing .env"
}

function Copy-Tree($src, $dest) {
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force
}

if ($UseArtifact -and $ArtifactPath -and (Test-Path $ArtifactPath)) {
    Write-Host "    Source: CI artifact ($ArtifactPath)"
    if (Test-Path (Join-Path $ArtifactPath 'dist')) {
        Copy-Tree (Join-Path $ArtifactPath 'dist') (Join-Path $BackendPath 'dist')
    }
    if (Test-Path (Join-Path $ArtifactPath 'node_modules')) {
        $nm = Join-Path $BackendPath 'node_modules'
        if (Test-Path $nm) { Remove-Item $nm -Recurse -Force }
        Copy-Tree (Join-Path $ArtifactPath 'node_modules') $nm
    }
    foreach ($f in @('package.json', 'package-lock.json')) {
        $p = Join-Path $ArtifactPath $f
        if (Test-Path $p) { Copy-Item $p (Join-Path $BackendPath $f) -Force }
    }
} else {
    Write-Host "    Source: build on VM"
    Push-Location (Join-Path $RepoRoot 'packages\backend')
    if (Test-Path package-lock.json) { npm ci } else { npm install }
    npm run build
    npm ci --omit=dev
    Pop-Location
}

if ($envBackup) {
    Set-Content -Path $envFile -Value $envBackup -NoNewline -Encoding utf8
}

if ($RunDbSeed) {
    $psql = 'C:\Program Files\PostgreSQL\18\bin\psql.exe'
    if (-not (Test-Path $psql)) { $psql = 'psql' }
    $seed = Join-Path $RepoRoot 'deploy\seed-default-org.sql'
    if (Test-Path $seed) {
        Write-Host "    Running seed-default-org.sql"
        & $psql -U synapse -h localhost -d synapse_db -f $seed 2>&1
    }
}

# Restart Windows service or fall back to killing node on 4000
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.Status -eq 'Running') { Restart-Service $ServiceName -Force }
    else { Start-Service $ServiceName }
    Write-Host "    Service restarted: $ServiceName"
} else {
    Write-Host "    No service '$ServiceName' — restarting node on port 4000"
    Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    Start-Sleep 2
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
    Start-Process -FilePath $node -ArgumentList 'dist\index.js' -WorkingDirectory $BackendPath -WindowStyle Hidden
    Start-Sleep 3
}

$health = Invoke-WebRequest -Uri 'http://127.0.0.1:4000/health' -UseBasicParsing -TimeoutSec 20
if ($health.Content -notmatch 'ok') { throw "Health check failed after deploy" }
Write-Host "    Health: $($health.Content)"
Write-Host "==> Backend deploy complete"
