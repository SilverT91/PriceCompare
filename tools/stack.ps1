# Operates the PriceCompare stack on the deploy target (see tools/deploy.ps1 for deploying).
#
#   powershell -File tools/stack.ps1 status            container state and port
#   powershell -File tools/stack.ps1 logs [-Lines 50]  the app's last log lines
#   powershell -File tools/stack.ps1 restart | stop | start
#   powershell -File tools/stack.ps1 backup            a consistent copy of the database, kept on the target
#                                                      in ~/pricecompare-backups/ (the app keeps running)
#   powershell -File tools/stack.ps1 tunnel            ssh -N -L 8787:127.0.0.1:8787 (blocks; Ctrl+C ends it)
#   powershell -File tools/stack.ps1 run -Script x.sh  run a bash script file on the target, in the stack's folder
#
# Target: -Target, else PRICECOMPARE_DEPLOY, else PRICECOMPARE_DEPLOY=user@host in .env.deploy (git-ignored).
# Remote commands are sent as a script on stdin; a command in it that reads stdin (docker compose exec)
# must get </dev/null, or it swallows the rest of the script.

param(
  [Parameter(Position = 0, Mandatory = $true)]
  [ValidateSet('status', 'logs', 'restart', 'stop', 'start', 'backup', 'tunnel', 'run')]
  [string]$Action,
  [string]$Target = $env:PRICECOMPARE_DEPLOY,
  [int]$Lines = 30,
  [string]$Script
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (-not $Target) {
  $conf = Join-Path $root '.env.deploy'
  if (Test-Path $conf) {
    $line = Get-Content $conf | Where-Object { $_ -match '^\s*PRICECOMPARE_DEPLOY\s*=' } | Select-Object -First 1
    if ($line) { $Target = ($line -split '=', 2)[1].Trim() }
  }
}
if (-not $Target) { throw 'No target: pass -Target user@host, set PRICECOMPARE_DEPLOY, or write PRICECOMPARE_DEPLOY=user@host into .env.deploy' }
$ssh = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10')
$OutputEncoding = New-Object System.Text.UTF8Encoding $false

function Invoke-Remote([string]$body) {
  $text = "set -e`nexec 2>&1`ncd ~/projects/pricecompare/app`n$body`n"
  $text | & ssh @ssh $Target "tr -d '\r' | sed '1s/^\xEF\xBB\xBF//' | bash -s"
  if ($LASTEXITCODE -ne 0) { throw "remote step failed (exit $LASTEXITCODE)" }
}

switch ($Action) {
  'status' { Invoke-Remote "docker compose ps --format '{{.Name}}  {{.Status}}  {{.Ports}}'" }
  'logs' { Invoke-Remote "docker compose logs --tail $Lines app" }
  'restart' { Invoke-Remote 'docker compose restart app' }
  'stop' { Invoke-Remote 'docker compose stop app' }
  'start' { Invoke-Remote 'docker compose start app' }
  'backup' {
    Invoke-Remote @'
mkdir -p ~/pricecompare-backups
name=pricecompare-$(date +%Y%m%d-%H%M).sqlite
docker compose exec -T app rm -f /tmp/backup.sqlite </dev/null
docker compose exec -T app node -e "require('node:sqlite').DatabaseSync && new (require('node:sqlite').DatabaseSync)('/data/price-compare.sqlite').exec(\"VACUUM INTO '/tmp/backup.sqlite'\")" </dev/null
docker compose cp app:/tmp/backup.sqlite ~/pricecompare-backups/$name >/dev/null
docker compose exec -T app rm /tmp/backup.sqlite </dev/null
ls -la ~/pricecompare-backups/$name
'@
  }
  'tunnel' {
    Write-Host "Tunnel open: http://localhost:8787  (Ctrl+C to close)"
    & ssh @ssh -o ExitOnForwardFailure=yes -N -L 8787:127.0.0.1:8787 $Target
  }
  'run' {
    if (-not $Script -or -not (Test-Path $Script)) { throw 'run needs -Script <path to a bash script file>' }
    Invoke-Remote (Get-Content -Raw $Script)
  }
}
