# Fixture Platform - one-command local dev launcher (PowerShell).
# Opens backend and frontend in two separate windows. Dev needs only Postgres
# (see backend\.env DATABASE_URL).
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\dev.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$py = Join-Path $root 'backend\.venv\Scripts\python.exe'
$manage = Join-Path $root 'backend\manage.py'

if (-not (Test-Path $py)) {
  Write-Error "venv python not found at backend\.venv. Create it and install deps."
}

Write-Host '==> Applying migrations + seeding (idempotent)'
& $py $manage migrate
& $py $manage load_modules
& $py $manage load_sports

Write-Host '==> Launching backend on http://127.0.0.1:8000 (new window)'
Start-Process $py -ArgumentList @($manage, 'runserver', '127.0.0.1:8000') -WorkingDirectory $root

Write-Host '==> Launching frontend / Vite (new window)'
Start-Process 'npm' -ArgumentList @('run', 'dev') -WorkingDirectory (Join-Path $root 'frontend')

Write-Host ''
Write-Host 'SPA:      http://localhost:5173/  (Vite picks the next free port if busy)'
Write-Host 'API docs: http://localhost:8000/api/docs/'
Write-Host 'Seed a login:  python backend\manage.py shell < backend\scripts\seed_demo_account.py'
