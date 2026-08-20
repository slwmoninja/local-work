# Runs LocalWork locally for testing, via local_server.py -- a static file
# server plus a /api/refresh endpoint that the app's Settings > "Refresh job
# data" button calls to run refresh-jobs.ps1 in the background, so getting
# more roles never requires opening a separate terminal.
# Usage: powershell -File scripts\serve.ps1 [-Port 8791]
param([int]$Port = 8791)
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
python scripts\local_server.py $Port
