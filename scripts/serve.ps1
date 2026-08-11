# Thin wrapper to run LocalWork locally for testing.
# Usage: powershell -File scripts\serve.ps1 [-Port 8791]
param([int]$Port = 8791)
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Write-Host "Serving LocalWork at http://localhost:$Port/index.html  (Ctrl+C to stop)"
python -m http.server $Port
