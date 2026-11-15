# Starts / stops the private development PostgreSQL cluster used on this machine.
#
#   powershell -ExecutionPolicy Bypass -File scripts/dev-db.ps1 start
#   powershell -ExecutionPolicy Bypass -File scripts/dev-db.ps1 stop
#   powershell -ExecutionPolicy Bypass -File scripts/dev-db.ps1 status
#
# It is a separate cluster on port 5434 (local connections only, no password), so it never
# touches any other PostgreSQL server on the machine. Development use only.
# If you prefer your own PostgreSQL server, ignore this script and set DATABASE_URL instead.
param([Parameter(Mandatory = $true)][ValidateSet('start', 'stop', 'status')][string]$Action)

$ErrorActionPreference = 'Stop'
$bin = Get-ChildItem 'C:\Program Files\PostgreSQL' -Directory -ErrorAction SilentlyContinue | Sort-Object { [int]$_.Name } -Descending | Select-Object -First 1
if (-not $bin) { throw 'PostgreSQL binaries were not found under C:\Program Files\PostgreSQL.' }
$bin = Join-Path $bin.FullName 'bin'
$root = Join-Path $env:LOCALAPPDATA 'cas-dev-pg'
$data = Join-Path $root 'data'
$port = 5434

if ($Action -eq 'status') { & "$bin\pg_isready.exe" -h 127.0.0.1 -p $port; exit $LASTEXITCODE }
if ($Action -eq 'stop') { & "$bin\pg_ctl.exe" -D $data stop -m fast; exit $LASTEXITCODE }

if (-not (Test-Path $data)) {
  New-Item -ItemType Directory -Force $root | Out-Null
  & "$bin\initdb.exe" -D $data -U cas -A trust -E UTF8 --locale=C | Out-Null
}
& "$bin\pg_isready.exe" -h 127.0.0.1 -p $port | Out-Null
if ($LASTEXITCODE -ne 0) {
  Start-Process -FilePath "$bin\pg_ctl.exe" -ArgumentList @('-D', "`"$data`"", '-o', "`"-p $port -c listen_addresses=127.0.0.1`"", '-l', "`"$root\pg.log`"", '-w', 'start') -WindowStyle Hidden -Wait
}
foreach ($db in 'cas_dev', 'cas_test') {
  $exists = & "$bin\psql.exe" -h 127.0.0.1 -p $port -U cas -d postgres -Atc "select 1 from pg_database where datname='$db'"
  if ($exists -ne '1') { & "$bin\psql.exe" -h 127.0.0.1 -p $port -U cas -d postgres -c "create database $db" | Out-Null }
}
& "$bin\pg_isready.exe" -h 127.0.0.1 -p $port
