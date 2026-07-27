<#
  db-browser.ps1 - interactive browser for the Synapse Docker databases.

  Drill-down flow:
     1. pick a database SERVER (Postgres / MySQL / SQL Server containers)
     2. pick a DATABASE inside it
     3. pick a TABLE  (or run custom SQL)
     4. choose which COLUMNS to show (e.g. 2-7, or 1,3,5, or Enter=all)
     5. see the table contents (you choose how many rows)

  At any menu:  type a number to select,  [b] = back,  [q] = quit.
  At the table menu:  [s] = run custom SQL against the selected database.

  How to run (from a PowerShell terminal opened in this folder):
     powershell -ExecutionPolicy Bypass -File .\db-browser.ps1
  or, if your policy already allows scripts:
     .\db-browser.ps1

  Requires Docker Desktop running with the Synapse stack up (docker compose up -d).
  NOTE: kept ASCII-only on purpose so Windows PowerShell 5.1 parses it cleanly.
#>

# NOT 'Stop': native CLIs (mysql, sqlcmd) write warnings to stderr, and under 'Stop'
# PowerShell escalates that into a fatal error. We handle failures via Clean-Lines and
# the try/catch in the main loop instead.
$ErrorActionPreference = 'Continue'

# --- Database servers (from docker-compose.yml) ------------------------------
$servers = @(
  @{ Name = 'synapse-postgres  (app DB :5555)';     Engine = 'pg';    Container = 'synapse-postgres';            User = 'synapse';    Pass = 'synapse';      DefaultDb = 'synapse_db'    }
  @{ Name = 'synapse-connectors-postgres  (:5556)'; Engine = 'pg';    Container = 'synapse-connectors-postgres'; User = 'connectors'; Pass = 'connectors';   DefaultDb = 'connectors_db' }
  @{ Name = 'synapse-mysql  (:3307)';               Engine = 'mysql'; Container = 'synapse-mysql';                User = 'root';       Pass = 'synapse';      DefaultDb = 'synapse_db'    }
  @{ Name = 'synapse-mssql  (SQL Server :1433)';    Engine = 'mssql'; Container = 'synapse-mssql';                User = 'sa';         Pass = 'Synapse_2024!';DefaultDb = 'master'        }
)

$SQLCMD = '/opt/mssql-tools18/bin/sqlcmd'   # path inside the mssql 2022 image
$script:RowLimit = 100                       # remembered row limit (changeable at the prompt)
$script:Vertical = $false                     # view mode: $false = table (fit to width), $true = list (one field/line)

# Actual terminal width, so output wraps to the window instead of sprawling.
function Get-TermWidth {
  try { $w = $Host.UI.RawUI.WindowSize.Width; if ($w -gt 20) { return $w } } catch {}
  return 120
}

# --- Generic menu helper. Returns an index, 'b', 'q', or an $Extra hotkey. ---
function Select-Index {
  param([string]$Title, [string[]]$Items, [array]$Extra = @())
  Write-Host ""
  Write-Host $Title -ForegroundColor Cyan
  for ($i = 0; $i -lt $Items.Count; $i++) {
    Write-Host ("  [{0,2}] {1}" -f ($i + 1), $Items[$i])
  }
  foreach ($e in $Extra) { Write-Host ("  [ {0}] {1}" -f $e.Key, $e.Label) -ForegroundColor DarkGray }
  Write-Host "  [ b] back     [ q] quit" -ForegroundColor DarkGray
  $extraKeys = @($Extra | ForEach-Object { "$($_.Key)".ToLower() })
  while ($true) {
    $sel = (Read-Host "Select").Trim().ToLower()
    if ($sel -eq 'q') { return 'q' }
    if ($sel -eq 'b') { return 'b' }
    if ($extraKeys -contains $sel) { return $sel }
    $n = 0
    if ([int]::TryParse($sel, [ref]$n) -and $n -ge 1 -and $n -le $Items.Count) { return ($n - 1) }
    Write-Host "  Invalid choice, try again." -ForegroundColor Red
  }
}

function Read-RowLimit {
  $inp = (Read-Host "Rows to show [$script:RowLimit]").Trim()
  if ($inp) {
    $n = 0
    if ([int]::TryParse($inp, [ref]$n) -and $n -gt 0) { $script:RowLimit = $n }
    else { Write-Host "  Not a positive number - keeping $script:RowLimit." -ForegroundColor DarkGray }
  }
  return $script:RowLimit
}

function Clean-Lines {
  param([object]$Raw)
  return @($Raw | ForEach-Object { "$_".Trim() } | Where-Object { $_ -and $_ -notmatch '^-+$' })
}

# Parse a column selection like "2-7", "1,3,5", "2-7,10" into 1-based indices (in the
# order requested). Empty / 'all' / '*' returns $null meaning "all columns".
function Parse-Selection($text, $count) {
  $t = "$text".Trim()
  if (-not $t -or $t -eq 'all' -or $t -eq '*') { return $null }
  $list = New-Object System.Collections.Generic.List[int]
  foreach ($part in ($t -split '[,\s]+')) {
    if (-not $part) { continue }
    if ($part -match '^(\d+)\s*-\s*(\d+)$') {
      $a = [int]$Matches[1]; $b = [int]$Matches[2]
      if ($a -gt $b) { $tmp = $a; $a = $b; $b = $tmp }
      for ($i = $a; $i -le $b; $i++) { if ($i -ge 1 -and $i -le $count) { [void]$list.Add($i) } }
    } elseif ($part -match '^\d+$') {
      $i = [int]$part; if ($i -ge 1 -and $i -le $count) { [void]$list.Add($i) }
    }
  }
  if ($list.Count -eq 0) { return $null }
  return @($list | Select-Object -Unique)
}

# Quote a column name for the engine, and build a SELECT projection ('*' when none).
function Quote-Col($engine, $c) {
  switch ($engine) {
    'mysql' { return '`' + $c + '`' }
    'mssql' { return '[' + $c + ']' }
    default { return '"' + $c + '"' }   # pg
  }
}
function Build-Projection($engine, $cols) {
  if (-not $cols -or $cols.Count -eq 0) { return '*' }
  return (($cols | ForEach-Object { Quote-Col $engine $_ }) -join ', ')
}

# Print a numbered column list in a compact grid that fits the terminal.
function Show-NumberedGrid($items) {
  $w = ($items | Measure-Object -Property Length -Maximum).Maximum
  $cell = $w + 7
  $perRow = [Math]::Max(1, [Math]::Floor((Get-TermWidth) / ($cell + 2)))
  for ($i = 0; $i -lt $items.Count; $i++) {
    Write-Host -NoNewline ("  " + ("{0,3}. {1}" -f ($i + 1), "$($items[$i])".PadRight($w)))
    if ((($i + 1) % $perRow) -eq 0) { Write-Host "" }
  }
  if (($items.Count % $perRow) -ne 0) { Write-Host "" }
}

# --- Postgres ----------------------------------------------------------------
function Get-PgDatabases($s) {
  $sql = "SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY 1;"
  Clean-Lines (& docker exec -e "PGPASSWORD=$($s.Pass)" $s.Container psql -U $s.User -d $s.DefaultDb -At -c $sql 2>$null)
}
function Get-PgTables($s, $db) {
  $sql = "SELECT schemaname||'.'||tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1;"
  Clean-Lines (& docker exec -e "PGPASSWORD=$($s.Pass)" $s.Container psql -U $s.User -d $db -At -c $sql 2>$null)
}
function Get-PgColumns($s, $db, $tbl) {
  $p = $tbl.Split('.', 2)
  $sql = "SELECT column_name FROM information_schema.columns WHERE table_schema='$($p[0])' AND table_name='$($p[1])' ORDER BY ordinal_position;"
  Clean-Lines (& docker exec -e "PGPASSWORD=$($s.Pass)" $s.Container psql -U $s.User -d $db -At -c $sql 2>$null)
}
# psql display args: 'list' => expanded (one field/line); otherwise wrap to the terminal.
function Pg-FmtArgs {
  if ($script:Vertical) { return @('-P', 'pager=off', '-P', 'expanded=on') }
  return @('-P', 'pager=off', '-P', 'format=wrapped', '-P', "columns=$(Get-TermWidth)")
}
function Show-PgTable($s, $db, $tbl, $limit, $cols) {
  $p = $tbl.Split('.', 2)
  $proj = Build-Projection 'pg' $cols
  $sql = "SELECT $proj FROM ""$($p[0])"".""$($p[1])"" LIMIT $limit;"
  $fmt = Pg-FmtArgs
  & docker exec -e "PGPASSWORD=$($s.Pass)" $s.Container psql -U $s.User -d $db @fmt -c $sql
}
function Run-PgSql($s, $db, $sql) {
  $fmt = Pg-FmtArgs
  & docker exec -e "PGPASSWORD=$($s.Pass)" $s.Container psql -U $s.User -d $db @fmt -c $sql
}

# --- MySQL -------------------------------------------------------------------
# Pass the password via MYSQL_PWD env (not -p on the command line) to avoid the
# "Using a password on the command line interface can be insecure" warning on stderr.
function Get-MyDatabases($s) {
  Clean-Lines (& docker exec -e "MYSQL_PWD=$($s.Pass)" $s.Container mysql -u $s.User -N -e "SHOW DATABASES;" 2>$null)
}
function Get-MyTables($s, $db) {
  Clean-Lines (& docker exec -e "MYSQL_PWD=$($s.Pass)" $s.Container mysql -u $s.User -N -e "SHOW TABLES FROM $db;" 2>$null)
}
function Get-MyColumns($s, $db, $tbl) {
  $sql = "SELECT column_name FROM information_schema.columns WHERE table_schema='$db' AND table_name='$tbl' ORDER BY ordinal_position;"
  Clean-Lines (& docker exec -e "MYSQL_PWD=$($s.Pass)" $s.Container mysql -u $s.User -N -e $sql 2>$null)
}
function Show-MyTable($s, $db, $tbl, $limit, $cols) {
  $fmt = if ($script:Vertical) { '-E' } else { '--table' }   # -E = vertical (one field/line)
  $proj = Build-Projection 'mysql' $cols
  & docker exec -e "MYSQL_PWD=$($s.Pass)" $s.Container mysql -u $s.User -D $db $fmt -e "SELECT $proj FROM $tbl LIMIT $limit;" 2>$null
}
function Run-MySql($s, $db, $sql) {
  $fmt = if ($script:Vertical) { '-E' } else { '--table' }
  & docker exec -e "MYSQL_PWD=$($s.Pass)" $s.Container mysql -u $s.User -D $db $fmt -e "$sql" 2>$null
}

# --- SQL Server --------------------------------------------------------------
function Get-MsDatabases($s) {
  $sql = "SET NOCOUNT ON; SELECT name FROM sys.databases ORDER BY name;"
  Clean-Lines (& docker exec $s.Container $SQLCMD -S localhost -U $s.User -P $s.Pass -C -h -1 -W -Q $sql 2>$null)
}
function Get-MsTables($s, $db) {
  $sql = "SET NOCOUNT ON; SELECT s.name + '.' + t.name FROM sys.tables t JOIN sys.schemas s ON t.schema_id = s.schema_id ORDER BY 1;"
  Clean-Lines (& docker exec $s.Container $SQLCMD -S localhost -U $s.User -P $s.Pass -C -d $db -h -1 -W -Q $sql 2>$null)
}
function Get-MsColumns($s, $db, $tbl) {
  $p = $tbl.Split('.', 2)
  $sql = "SET NOCOUNT ON; SELECT c.name FROM sys.columns c WHERE c.object_id = OBJECT_ID('$($p[0]).$($p[1])') ORDER BY c.column_id;"
  Clean-Lines (& docker exec $s.Container $SQLCMD -S localhost -U $s.User -P $s.Pass -C -d $db -h -1 -W -Q $sql 2>$null)
}
# Table mode: cap large text columns with -y (NOTE: -y and -W are mutually exclusive),
# and use a pipe separator. Regular varchar(n) columns still show at their declared width
# in sqlcmd (no flag fixes that) -> use the [v] list view for wide tables.
function Show-MsTableTabular($s, $db, $query) {
  & docker exec $s.Container $SQLCMD -S localhost -U $s.User -P $s.Pass -C -d $db -s "|" -y 60 -Q $query
}
# List mode: sqlcmd has no vertical output, so we fetch tab-separated values + the column
# names and print one field per line ourselves. Honors a selected column subset ($cols).
function Show-MsTableVertical($s, $db, $tbl, $limit, $cols) {
  $p = $tbl.Split('.', 2); $schema = $p[0]; $name = $p[1]
  $colList = if ($cols -and $cols.Count) { @($cols) } else { Get-MsColumns $s $db $tbl }
  if (-not $colList -or $colList.Count -eq 0) { Show-MsTableTabular $s $db "SELECT TOP $limit * FROM [$schema].[$name];"; return }
  $proj = Build-Projection 'mssql' $colList
  $tab = [char]9
  $rowsQ = "SET NOCOUNT ON; SELECT TOP $limit $proj FROM [$schema].[$name];"
  $raw = & docker exec $s.Container $SQLCMD -S localhost -U $s.User -P $s.Pass -C -d $db -h -1 -W -s ([string]$tab) -Q $rowsQ 2>$null
  $rows = @($raw | Where-Object { "$_".Trim() -ne '' -and "$_" -notmatch 'rows affected' })
  $pad = ($colList | Measure-Object -Property Length -Maximum).Maximum
  $r = 0
  foreach ($line in $rows) {
    $r++
    Write-Host ("-[ RECORD {0} ]----------------------------------------" -f $r) -ForegroundColor DarkCyan
    $vals = "$line".Split($tab)
    for ($i = 0; $i -lt $colList.Count; $i++) {
      $v = if ($i -lt $vals.Count) { $vals[$i] } else { '' }
      Write-Host ("{0} | {1}" -f $colList[$i].PadRight($pad), $v)
    }
  }
  if ($r -eq 0) { Write-Host "(no rows)" }
}
function Show-MsTable($s, $db, $tbl, $limit, $cols) {
  if ($script:Vertical) { Show-MsTableVertical $s $db $tbl $limit $cols }
  else { $p = $tbl.Split('.', 2); $proj = Build-Projection 'mssql' $cols; Show-MsTableTabular $s $db "SELECT TOP $limit $proj FROM [$($p[0])].[$($p[1])];" }
}
function Run-MsSql($s, $db, $sql) {
  # Custom SQL uses tabular (vertical needs a known column list).
  Show-MsTableTabular $s $db $sql
}

# --- Engine dispatch ---------------------------------------------------------
function Get-Databases($s) { switch ($s.Engine) { 'pg' { Get-PgDatabases $s } 'mysql' { Get-MyDatabases $s } 'mssql' { Get-MsDatabases $s } } }
function Get-Tables($s, $db) { switch ($s.Engine) { 'pg' { Get-PgTables $s $db } 'mysql' { Get-MyTables $s $db } 'mssql' { Get-MsTables $s $db } } }
function Get-Columns($s, $db, $tbl) { switch ($s.Engine) { 'pg' { Get-PgColumns $s $db $tbl } 'mysql' { Get-MyColumns $s $db $tbl } 'mssql' { Get-MsColumns $s $db $tbl } } }
function Show-Table($s, $db, $tbl, $limit, $cols) { switch ($s.Engine) { 'pg' { Show-PgTable $s $db $tbl $limit $cols } 'mysql' { Show-MyTable $s $db $tbl $limit $cols } 'mssql' { Show-MsTable $s $db $tbl $limit $cols } } }
function Run-Sql($s, $db, $sql) { switch ($s.Engine) { 'pg' { Run-PgSql $s $db $sql } 'mysql' { Run-MySql $s $db $sql } 'mssql' { Run-MsSql $s $db $sql } } }

function Test-Container($name) {
  $hit = & docker ps --filter "name=^/$name$" --format "{{.Names}}" 2>$null
  return [bool]$hit
}

# --- Main loop ---------------------------------------------------------------
Clear-Host
Write-Host "===========================================" -ForegroundColor Green
Write-Host "  Synapse Docker DB Browser" -ForegroundColor Green
Write-Host "===========================================" -ForegroundColor Green

# Verify Docker is reachable
try { & docker info *> $null } catch { }
if ($LASTEXITCODE -ne 0) {
  Write-Host "Docker does not appear to be running. Start Docker Desktop and try again." -ForegroundColor Red
  return
}

while ($true) {
  $serverPick = Select-Index "Databases (servers):" ($servers | ForEach-Object { $_.Name })
  if ($serverPick -eq 'q') { Write-Host "Bye."; return }
  if ($serverPick -eq 'b') { continue }
  $s = $servers[$serverPick]

  if (-not (Test-Container $s.Container)) {
    Write-Host "`nContainer '$($s.Container)' is not running.  Start it with:  docker compose up -d" -ForegroundColor Red
    continue
  }

  # --- Database level ---
  while ($true) {
    $dbs = Get-Databases $s
    if (-not $dbs -or $dbs.Count -eq 0) {
      Write-Host "`nNo databases found (or could not connect to $($s.Container))." -ForegroundColor Red
      break
    }
    $dbPick = Select-Index "Databases in $($s.Name):" $dbs
    if ($dbPick -eq 'q') { Write-Host "Bye."; return }
    if ($dbPick -eq 'b') { break }
    $db = $dbs[$dbPick]

    # --- Table level ---
    while ($true) {
      $tables = @(Get-Tables $s $db)
      if ($tables.Count -eq 0) {
        Write-Host "`n(No tables in '$db' - you can still run custom SQL.)" -ForegroundColor Yellow
      }
      $viewLabel = if ($script:Vertical) { 'list (one field/line)' } else { 'table (fit to width)' }
      $tablePick = Select-Index "Tables in $db ($($tables.Count)):" $tables @(
        @{ Key = 's'; Label = 'run custom SQL on this database' }
        @{ Key = 'v'; Label = "toggle view - now: $viewLabel" }
      )
      if ($tablePick -eq 'q') { Write-Host "Bye."; return }
      if ($tablePick -eq 'b') { break }

      if ($tablePick -eq 'v') {
        $script:Vertical = -not $script:Vertical
        continue
      }

      if ($tablePick -eq 's') {
        # --- Custom SQL ---
        $sql = Read-Host "`nSQL to run on '$db' (blank = cancel)"
        if ($sql.Trim()) {
          Write-Host "`n>> $($s.Container) / $db  - custom SQL" -ForegroundColor Green
          Write-Host ""
          try { Run-Sql $s $db $sql } catch { Write-Host "Error running SQL: $_" -ForegroundColor Red }
          Read-Host "`nPress Enter to continue"
        }
        continue
      }

      $tbl = $tables[$tablePick]

      # --- Column picker ---
      $allCols = @(Get-Columns $s $db $tbl)
      $selCols = $null   # $null = all columns
      if ($allCols.Count -gt 0) {
        Write-Host "`nColumns in $tbl ($($allCols.Count)):" -ForegroundColor Cyan
        Show-NumberedGrid $allCols
        $csel = Read-Host "Columns to show - e.g. 2-7  or  1,3,5  (Enter = all)"
        $idx = Parse-Selection $csel $allCols.Count
        if ($idx) { $selCols = @($idx | ForEach-Object { $allCols[$_ - 1] }) }
      }

      # --- Content (with row-limit prompt) ---
      $limit = Read-RowLimit
      $colNote = if ($selCols) { "cols: $($selCols -join ', ')" } else { 'all cols' }
      Write-Host ""
      Write-Host ">> $($s.Container) / $db / $tbl  (first $limit rows, $colNote)" -ForegroundColor Green
      Write-Host ""
      try { Show-Table $s $db $tbl $limit $selCols } catch { Write-Host "Error reading table: $_" -ForegroundColor Red }
      Read-Host "`nPress Enter to continue"
    }
  }
}
