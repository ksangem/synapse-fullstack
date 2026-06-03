# Apply Drizzle SQL migrations (schemas app/jira_data must already exist)
$psql = 'C:\Program Files\PostgreSQL\18\bin\psql.exe'
$env:PGPASSWORD = 'synapse'
$migrations = @(
    '..\packages\backend\src\db\migrations\0000_shallow_wonder_man.sql',
    '..\packages\backend\src\db\migrations\0001_abandoned_paper_doll.sql'
)
Set-Location $PSScriptRoot
foreach ($f in $migrations) {
    $path = Join-Path $PSScriptRoot $f
    if (-not (Test-Path $path)) { throw "Missing $path" }
    $sql = (Get-Content $path -Raw) -replace '--> statement-breakpoint', "`n"
    # Schemas already created by setup-database.sql
    $sql = $sql -replace '(?m)^CREATE SCHEMA "app";\s*', ''
    $sql = $sql -replace '(?m)^CREATE SCHEMA "jira_data";\s*', ''
    $tmp = [System.IO.Path]::GetTempFileName() + '.sql'
    Set-Content -Path $tmp -Value $sql -Encoding UTF8
    Write-Host "Applying $(Split-Path $f -Leaf)..."
    & $psql -U synapse -h localhost -d synapse_db -v ON_ERROR_STOP=1 -f $tmp
    if ($LASTEXITCODE -ne 0) { Remove-Item $tmp -Force; exit $LASTEXITCODE }
    Remove-Item $tmp -Force
}
Write-Host "Migrations OK."
& $psql -U synapse -h localhost -d synapse_db -c "SELECT count(*) AS app_tables FROM information_schema.tables WHERE table_schema='app';"
