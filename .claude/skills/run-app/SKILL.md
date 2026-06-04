---
name: run-app
description: Use when asked to run, start, launch, or boot the Fixture Platform locally (backend + frontend / the dev environment / "see it running"). Captures the verified Windows launch sequence so it doesn't have to be rediscovered.
---

# Run the Fixture Platform locally (backend + frontend)

Verified launch recipe for this repo. Backend = Django (ASGI) on `:8000`;
frontend = React/Vite SPA. Dev needs **only Postgres** (Channels + cache are
in-memory in `dev.py`; Redis is NOT required until Phase 1B `live`).

## Prerequisites (check first)

1. **Postgres** running on `localhost:5432` with the DB named in
   `backend/.env` (`DATABASE_URL`, default `fixturedb`). If `manage.py
   showmigrations` errors with a connection error, Postgres is down — start it.
2. `backend/.env` exists (copy from `backend/.env.example` if not) with a real
   `SECRET_KEY` and `DATABASE_URL`.
3. venv at `backend/.venv` (Python 3.13). Frontend deps installed
   (`frontend/node_modules`; run `npm --prefix frontend install` if missing).

Python interpreter path (Windows): `backend/.venv/Scripts/python.exe`
(POSIX: `backend/.venv/bin/python`).

## One command

```bash
bash scripts/dev.sh           # Git Bash / WSL — runs migrate+seed, then both servers
```
or, in PowerShell: `powershell -File scripts\dev.ps1` (opens two windows).

## Manual sequence (what dev.sh automates)

```bash
PY=backend/.venv/Scripts/python.exe
$PY backend/manage.py migrate
$PY backend/manage.py load_modules     # 22-module RBAC catalog (idempotent)
$PY backend/manage.py load_sports      # 59 sports (idempotent)
$PY backend/manage.py runserver 127.0.0.1:8000 &     # backend
npm --prefix frontend run dev &                       # frontend (Vite)
```

## URLs

- SPA: `http://localhost:5173/` — **Vite auto-increments to 5174/5175… if the
  port is busy.** Read the Vite banner for the actual port. `dev.py` allows CORS
  for 5173–5177.
- API docs (Swagger): `http://localhost:8000/api/docs/`
- Super-admin console: `http://localhost:8000/sadmin/`

## Login accounts for the SPA

The `createsuperuser` account is for `/sadmin`, NOT the SPA. The repo ships a
canonical, idempotent demo seed that creates the `doxaed` org with one user per
role (credentials documented in `backend/scripts/CREDENTIALS.md`). Re-run any
time to repair drift / reset passwords:

```bash
# IPython-safe. NOTE: `manage.py shell < file` mis-parses blank lines inside
# function bodies when IPython is installed (it is, in dev deps) — use runpy:
backend/.venv/Scripts/python.exe -c "import os,sys; sys.path.insert(0,'backend'); os.environ.setdefault('DJANGO_SETTINGS_MODULE','fixture.settings.dev'); import django; django.setup(); import runpy; runpy.run_path('backend/scripts/seed_full_demo.py', run_name='__main__')"
```

Quick logins (see `CREDENTIALS.md` for the full table): admin `admin@doxaed.test`
/ `Admin123!@` → SPA; super-admin `graceschooledu@gmail.com` / `DoxaEd33@` →
`/sadmin/`. Or sign up at `/signup` — the email-verification link prints to the
**Django console** (dev uses the console email backend).

## Smoke test (prove it's actually up)

```bash
curl -s -o /dev/null -w "backend %{http_code}\n"  http://localhost:8000/api/docs/
curl -s -o /dev/null -w "frontend %{http_code}\n" http://localhost:5173/   # use the real Vite port
```
Then load the SPA in a browser and confirm `GET /api/accounts/me/` round-trips
(403 when logged out is expected and correct).

## Windows gotchas (hit during the verified run)

- **IPv4/IPv6 split:** Django binds IPv4 (`127.0.0.1`), Vite binds `localhost`
  (often IPv6 `::1`). A `curl` to the `127.0.0.1` literal can miss Vite — use
  `localhost` or the browser. The Vite `/api` proxy → `http://localhost:8000`
  was verified working against Django on `127.0.0.1:8000`. If the proxy ever
  fails to connect, pin the proxy target to `http://127.0.0.1:8000` in
  `frontend/vite.config.ts` (or bind Django to `localhost:8000`).
- **Stale Vite on :5173:** an old `vite` process can hold 5173, pushing the new
  one to 5174. Close the old terminal to avoid confusion.

## Stop

`Ctrl+C` the `dev.sh` terminal (it traps and kills both). If servers were
backgrounded manually, kill the `python manage.py runserver` and `node`/`vite`
processes.
