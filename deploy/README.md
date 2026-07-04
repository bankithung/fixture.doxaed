# Fixture Platform — Production Deployment Runbook

Native deployment (no Docker) on Ubuntu 26.04: Postgres 18 + Redis + nginx (TLS) +
gunicorn/uvicorn (systemd). The React SPA is built to static and served by nginx;
`/api`, `/sadmin`, and `/ws` proxy to the ASGI app over a Unix socket.

## Topology

```
            ┌─────────── nginx :443 (TLS) ───────────┐
browser ───▶│  /            -> frontend/dist (SPA)    │
            │  /assets/     -> hashed SPA bundles     │
            │  /static/     -> backend/staticfiles    │
            │  /media/      -> backend/media          │
            │  /api  /sadmin /ws -> unix:/run/fixture/gunicorn.sock
            └────────────────────┬───────────────────┘
                                 ▼
              gunicorn (uvicorn workers)  ── systemd: fixture.service
                                 │
                    Postgres 18 (fixturedb)   Redis (cache + channels)
```

## Components

| Piece            | Location                                            |
|------------------|-----------------------------------------------------|
| Backend venv     | `backend/.venv` (Python 3.13)                       |
| Settings         | `fixture.settings.prod` (env-driven)                |
| Env / secrets    | `backend/.env` (chmod 600, gitignored)              |
| Gunicorn config  | `deploy/gunicorn.conf.py`                           |
| systemd unit     | `/etc/systemd/system/fixture.service`               |
| nginx site       | `/etc/nginx/sites-available/fixture.conf`           |
| TLS cert         | `/etc/ssl/fixture/fixture.{crt,key}` (self-signed)  |
| SPA build        | `frontend/dist`                                     |
| Credentials      | `deploy/CREDENTIALS-PROD.md` (chmod 600)            |

## Postgres roles (security model)

- `fixture_owner` — owns `fixturedb`, runs migrations. NOSUPERUSER. `CREATEDB`
  is granted only when running the test suite, revoked otherwise.
- `fixture_app`   — runtime role used by the live server. NON-superuser,
  NON-owner. `UPDATE`/`DELETE` are **revoked on `audit_event`** so the app role
  can never mutate the append-only audit log (defense-in-depth on top of the
  DB trigger). Default privileges grant it CRUD on future tables.

## Operations

```bash
# Service
sudo systemctl status  fixture
sudo systemctl restart fixture
sudo systemctl reload  fixture        # graceful worker reload (HUP)
journalctl -u fixture -f              # logs

# nginx
sudo nginx -t && sudo systemctl reload nginx
```

## Deploying a new version

```bash
cd /home/ubuntu/Fixture
git pull

# Backend
backend/.venv/bin/python -m pip install -r <(python - <<'PY'
import tomllib;print("\n".join(tomllib.load(open("backend/pyproject.toml","rb"))["project"]["dependencies"]))
PY
)
# Migrations run as the OWNER role (app role is intentionally non-owner):
cd backend
DJANGO_SETTINGS_MODULE=fixture.settings.prod \
DATABASE_URL="postgres://fixture_owner:<PW>@127.0.0.1:5432/fixturedb" \
  .venv/bin/python manage.py migrate --noinput
DJANGO_SETTINGS_MODULE=fixture.settings.prod .venv/bin/python manage.py collectstatic --noinput
cd ..

# Frontend
npm --prefix frontend ci --legacy-peer-deps
npm --prefix frontend run build

# Reload
sudo systemctl reload fixture
sudo systemctl reload nginx
```

> Pre-flight (PRD §5): migrations are blocked while any tournament is `live`.

## Tests

```bash
# Backend (needs a role that can CREATE the test DB):
sudo -u postgres psql -c "ALTER ROLE fixture_owner CREATEDB;"
cd backend
DATABASE_URL="postgres://fixture_owner:<PW>@127.0.0.1:5432/fixturedb" \
  .venv/bin/python -m pytest -c pyproject.toml apps -q
sudo -u postgres psql -c "ALTER ROLE fixture_owner NOCREATEDB;"   # revoke after

# Frontend:
npm --prefix frontend run test
```

## Production hardening TODO (before a real public launch)

1. **Real domain + cert.** Point DNS at the host, then replace the self-signed
   cert with Let's Encrypt (`certbot --nginx`). Update `ALLOWED_HOSTS`,
   `CSRF_TRUSTED_ORIGINS`, `CORS_ALLOWED_ORIGINS` in `backend/.env`.
2. **SMTP.** Fill `EMAIL_*` in `.env` so password-reset / email-verify mails send.
3. **Remove demo data** (`organizer@demo.test`, `*.doxaed.test`) — published creds.
4. **Rotate** the super-admin password and the GitHub PAT used to clone.
5. **2FA** for the super-admin (currently not enrolled on the seed account).
6. **Firewall** — restrict Postgres/Redis to localhost (already bound local),
   open only 80/443 publicly. Consider `SADMIN_IP_ALLOWLIST` in `.env`.

## Backups (installed 2026-07-02)

Nightly at 21:00 UTC (02:30 IST): `fixture-backup.timer` runs `deploy/backup.sh`
as `ubuntu`, writing to `/home/ubuntu/backups/fixture/`:

- `fixturedb_<stamp>.dump` — `pg_dump -Fc` as `fixture_owner` (creds in `~ubuntu/.pgpass`,
  mode 600, NOT in the repo). Each dump is verified with `pg_restore --list`.
- `media_<stamp>.tar.gz` — the `backend/media` upload tree.
- 14-day rotation. Logs: `journalctl -u fixture-backup.service`.

**Offsite copy (still needed):** create an executable
`/home/ubuntu/backups/offsite-sync.sh` (e.g. `rclone sync "$1" remote:fixture-backups`)
and it runs after every successful backup. Requires owner-provided credentials
(S3 bucket / rclone remote). Until this exists, backups die with the disk.

**Restore runbook** (practice on a scratch DB first):

```bash
# 1. Stop the app so nothing writes:
sudo systemctl stop fixture
# 2. Restore into a fresh DB, then swap (safer than in-place):
sudo -u postgres createdb fixturedb_restore -O fixture_owner
pg_restore -h 127.0.0.1 -U fixture_owner -d fixturedb_restore --no-owner \
  /home/ubuntu/backups/fixture/fixturedb_<stamp>.dump
sudo -u postgres psql -c "ALTER DATABASE fixturedb RENAME TO fixturedb_broken;"
sudo -u postgres psql -c "ALTER DATABASE fixturedb_restore RENAME TO fixturedb;"
# 3. Media:
tar -xzf /home/ubuntu/backups/fixture/media_<stamp>.tar.gz -C /home/ubuntu/Fixture/backend/
# 4. Restart + smoke-check:
sudo systemctl start fixture
curl -sk https://127.0.0.1/api/accounts/me/ -H "Host: fixture.doxaed.com"   # 403/401 JSON = app is up
```

## Disaster recovery (H7, verified 2026-07-04)

The safety-net chain, each link VERIFIED on 2026-07-04:

1. **Nightly local backup** — `fixture-backup.timer` (21:00 UTC) runs
   `deploy/backup.sh`: `pg_dump -Fc` (integrity-checked with
   `pg_restore --list`) + media tarball, 14-day rotation in
   `/home/ubuntu/backups/fixture/`.
2. **Offsite copy** — `backup.sh` then calls
   `/home/ubuntu/backups/offsite-sync.sh` (source: `deploy/offsite-sync.sh`):
   both artifacts gpg-encrypted (AES256, passphrase in
   `~/backups/.offsite-passphrase` and `deploy/CREDENTIALS-PROD.md` — keep a
   copy OFF this box) and pushed as `backup-*` release assets to the private
   GitHub repo. Offsite rotation keeps the newest 14 and only ever deletes
   `backup-*` tags.
3. **Restore drill** — `sudo -u postgres BACKUP_DIR=/home/ubuntu/backups/fixture deploy/restore-drill.sh`
   restores the newest dump into a scratch DB, asserts row counts
   (users/tournaments/teams/matches/audit), and drops it. Run it after any
   backup-related change and at least monthly. A backup that has never been
   restored is a hope, not a backup.
4. **Error monitoring** — prod `LOGGING` mails unhandled 500s / ERROR logs to
   `OPS_ALERT_EMAIL` (default graceschooledu@gmail.com) via the configured
   SMTP (deliverability verified 2026-07-04).

**Full restore (disaster):** provision box → clone repo → restore venv/env →
download newest `backup-*` release assets → `gpg -d` both →
`pg_restore -d fixturedb` as `fixture_owner` → untar media into
`backend/media/` → deploy per this README.
