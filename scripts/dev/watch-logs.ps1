# Live-tail backend + frontend logs together, with colored [BE]/[FE] prefixes.
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/watch-logs.ps1
#         (or: npm run logs)
# Ctrl+C to stop watching. This only READS the logs — it does not stop the servers.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$be = Join-Path $root 'logs\backend.log'
$fe = Join-Path $root 'logs\frontend.log'

foreach ($f in @($be, $fe)) {
  if (-not (Test-Path $f)) { New-Item -ItemType File -Path $f -Force | Out-Null }
}

Write-Host "Watching:" -ForegroundColor Cyan
Write-Host "  [BE] $be" -ForegroundColor DarkCyan
Write-Host "  [FE] $fe" -ForegroundColor DarkMagenta
Write-Host "Ctrl+C to stop.`n" -ForegroundColor Cyan

# Tail each file on its own runspace job, tag each line, surface to the host.
$jobBE = Start-Job -ScriptBlock { param($p) Get-Content -Path $p -Wait -Tail 20 | ForEach-Object { "BE`t$_" } } -ArgumentList $be
$jobFE = Start-Job -ScriptBlock { param($p) Get-Content -Path $p -Wait -Tail 20 | ForEach-Object { "FE`t$_" } } -ArgumentList $fe

try {
  while ($true) {
    Receive-Job -Job $jobBE, $jobFE | ForEach-Object {
      $parts = $_ -split "`t", 2
      $src = $parts[0]; $line = $parts[1]
      if ($src -eq 'BE') {
        $color = if ($line -match ' ERR | 500 | threw| ABRT ') { 'Red' }
                 elseif ($line -match ' WARN | 4\d\d | SLOW') { 'Yellow' }
                 else { 'Cyan' }
        Write-Host "[BE] $line" -ForegroundColor $color
      } else {
        $color = if ($line -match 'error|ECONNREFUSED|Error|fail') { 'Red' } else { 'Magenta' }
        Write-Host "[FE] $line" -ForegroundColor $color
      }
    }
    Start-Sleep -Milliseconds 300
  }
} finally {
  Stop-Job $jobBE, $jobFE -ErrorAction SilentlyContinue
  Remove-Job $jobBE, $jobFE -Force -ErrorAction SilentlyContinue
}
