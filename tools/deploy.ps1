# Deploys the working tree to a machine with Docker over SSH and starts it as the stack
# "pricecompare" (Dockerfile, compose.yaml). Uncommitted changes go too, so a change can be tried
# there before it is committed. Files ignored by git (.env, .cache, node_modules) never go.
#
#   powershell -File tools/deploy.ps1            copy, build, restart
#   powershell -File tools/deploy.ps1 -Test      also run the type check and tests in a container first
#   powershell -File tools/deploy.ps1 -CopyEnv   also copy .env (the search keys) to the target
#   powershell -File tools/deploy.ps1 -Logs      show the last log lines after the start
#
# The target (user@host) comes from -Target, else PRICECOMPARE_DEPLOY in the environment, else the
# line PRICECOMPARE_DEPLOY=user@host in .env.deploy (git-ignored: the address stays out of the
# repository). SSH must work without a password prompt (a key). On the target the code lives in
# ~/projects/pricecompare/app, the data in the Docker volume pricecompare_data.
# Open the page through a tunnel:  ssh -N -L 8787:127.0.0.1:8787 user@host   ->  http://localhost:8787

param(
  [string]$Target = $env:PRICECOMPARE_DEPLOY,
  [switch]$Test,
  [switch]$CopyEnv,
  [switch]$Logs
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

$remoteDir = '~/projects/pricecompare/app'
$ssh = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10')

# Text sent to a native program without a byte order mark (bash would read it as part of the first line).
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
function Invoke-Remote([string]$script) {
  $script | & ssh @ssh $Target "tr -d '\r' | sed '1s/^\xEF\xBB\xBF//' | bash -s"
  if ($LASTEXITCODE -ne 0) { throw "remote step failed (exit $LASTEXITCODE)" }
}

# 1. The files git knows (committed, changed or new), packed.
$list = New-TemporaryFile
$pack = Join-Path ([System.IO.Path]::GetTempPath()) 'pricecompare-src.tgz'
Push-Location $root
try {
  git ls-files --cached --others --exclude-standard | Where-Object { Test-Path $_ } | Set-Content -Encoding ascii $list
  tar -czf $pack -T $list
  if ($LASTEXITCODE -ne 0) { throw 'packing failed' }
} finally { Pop-Location; Remove-Item $list }
Write-Host "Packed $([math]::Round((Get-Item $pack).Length / 1KB)) KB; copying to $Target"

# 2. Copy and unpack; .env on the target is kept.
& scp @ssh -q $pack "${Target}:pricecompare-src.tgz"
if ($LASTEXITCODE -ne 0) { throw 'copy failed' }
Remove-Item $pack
Invoke-Remote @"
set -e
mkdir -p $remoteDir
cd $remoteDir
find . -mindepth 1 -maxdepth 1 ! -name .env -exec rm -rf {} +
tar -xzf ~/pricecompare-src.tgz
rm ~/pricecompare-src.tgz
"@

if ($CopyEnv) {
  $envFile = Join-Path $root '.env'
  if (-not (Test-Path $envFile)) { throw 'No .env here to copy' }
  # The file is copied as it is; its content is never shown.
  & scp @ssh -q $envFile "${Target}:projects/pricecompare/app/.env"
  if ($LASTEXITCODE -ne 0) { throw 'copying .env failed' }
  Invoke-Remote "chmod 600 $remoteDir/.env"
  Write-Host 'Copied .env (search keys) to the target'
}

# 3. Optional tests in a container, then build and (re)start the stack.
$testStep = if ($Test) { 'docker build --target test -t pricecompare-test . && docker image rm pricecompare-test >/dev/null' } else { 'true' }
$logStep = if ($Logs) { 'sleep 3; docker compose logs --tail 20 app' } else { 'true' }
Invoke-Remote @"
set -e
cd $remoteDir
$testStep
docker compose up -d --build
docker compose ps --format '{{.Name}}  {{.Status}}  {{.Ports}}'
$logStep
"@
Write-Host "Done. Page through a tunnel:  ssh -N -L 8787:127.0.0.1:8787 $Target   then http://localhost:8787"
