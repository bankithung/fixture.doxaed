#!/usr/bin/env bash
# Fixture Platform — one-command local dev launcher.
# Verified on Windows/Git Bash. Brings up backend (Django ASGI :8000) and
# frontend (Vite). Dev needs only Postgres (see backend/.env DATABASE_URL).
#
# Usage:  bash scripts/dev.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/backend/.venv/Scripts/python.exe"
[ -x "$PY" ] || PY="$ROOT/backend/.venv/bin/python"   # POSIX venv fallback
if [ ! -x "$PY" ]; then
  echo "ERROR: venv python not found at backend/.venv. Create it and install deps." >&2
  exit 1
fi

echo "==> Checking Postgres + applying migrations"
"$PY" "$ROOT/backend/manage.py" migrate

echo "==> Seeding RBAC module catalog + sports (idempotent)"
"$PY" "$ROOT/backend/manage.py" load_modules
"$PY" "$ROOT/backend/manage.py" load_sports

echo "==> Starting backend on http://127.0.0.1:8000"
"$PY" "$ROOT/backend/manage.py" runserver 127.0.0.1:8000 &
BACK=$!

echo "==> Starting frontend (Vite; watch the banner for the actual port)"
( cd "$ROOT/frontend" && npm run dev ) &
FRONT=$!

cleanup() {
  echo
  echo "==> Stopping (backend $BACK, frontend $FRONT)"
  kill "$BACK" "$FRONT" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo
echo "Backend pid=$BACK  Frontend pid=$FRONT"
echo "SPA: http://localhost:5173/ (or next free port)   API docs: http://localhost:8000/api/docs/"
echo "Tip: seed a login with  $PY backend/manage.py shell < backend/scripts/seed_demo_account.py"
echo "Press Ctrl+C to stop both."
wait
