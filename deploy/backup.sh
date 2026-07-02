#!/usr/bin/env bash
# Nightly backup: Postgres dump + media tarball, 14-day rotation.
# Credentials come from ~/.pgpass (never from this repo).
# Installed via fixture-backup.timer (see deploy/README.md "Backups").
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/home/ubuntu/backups/fixture}"
MEDIA_DIR="${MEDIA_DIR:-/home/ubuntu/Fixture/backend/media}"
DB_NAME="${DB_NAME:-fixturedb}"
DB_USER="${DB_USER:-fixture_owner}"
DB_HOST="${DB_HOST:-127.0.0.1}"
KEEP_DAYS="${KEEP_DAYS:-14}"

stamp="$(date -u +%Y-%m-%d_%H%M)"
mkdir -p "$BACKUP_DIR"

db_out="$BACKUP_DIR/fixturedb_${stamp}.dump"
pg_dump -Fc -h "$DB_HOST" -U "$DB_USER" "$DB_NAME" -f "$db_out"
# A dump that pg_restore cannot list is not a backup.
pg_restore --list "$db_out" > /dev/null
echo "db dump ok: $db_out ($(du -h "$db_out" | cut -f1))"

if [ -d "$MEDIA_DIR" ]; then
  media_out="$BACKUP_DIR/media_${stamp}.tar.gz"
  tar -czf "$media_out" -C "$(dirname "$MEDIA_DIR")" "$(basename "$MEDIA_DIR")"
  echo "media ok: $media_out ($(du -h "$media_out" | cut -f1))"
fi

find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'fixturedb_*.dump' -o -name 'media_*.tar.gz' \) -mtime "+$KEEP_DAYS" -delete
echo "rotation done (kept last $KEEP_DAYS days)"

# Offsite seam: drop an executable at this path (rclone/s3 sync) and it runs
# after every successful local backup. Needs owner-provided credentials.
OFFSITE_HOOK="/home/ubuntu/backups/offsite-sync.sh"
if [ -x "$OFFSITE_HOOK" ]; then
  "$OFFSITE_HOOK" "$BACKUP_DIR"
  echo "offsite sync ok"
else
  echo "offsite sync not configured (create $OFFSITE_HOOK)"
fi
