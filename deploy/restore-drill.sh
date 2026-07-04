#!/usr/bin/env bash
# Restore drill (H7): prove the newest backup actually restores. Restores the
# latest dump into a SCRATCH database, sanity-checks row counts, then drops
# the scratch DB. Touches nothing else — safe to run any time.
#
#   sudo -u postgres deploy/restore-drill.sh
#
# A backup that has never been restored is a hope, not a backup.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/home/ubuntu/backups/fixture}"
SCRATCH_DB="fixture_restore_drill"

latest_dump="$(ls -1t "$BACKUP_DIR"/fixturedb_*.dump 2>/dev/null | head -1)"
[ -n "$latest_dump" ] || { echo "drill: no dump in $BACKUP_DIR" >&2; exit 1; }
echo "drill: restoring $(basename "$latest_dump")"

dropdb --if-exists "$SCRATCH_DB"
createdb "$SCRATCH_DB"
pg_restore --no-owner --no-privileges -d "$SCRATCH_DB" "$latest_dump"

check() {
  local label="$1" sql="$2" min="$3"
  local n
  n="$(psql -tAq -d "$SCRATCH_DB" -c "$sql")"
  if [ "$n" -ge "$min" ]; then
    echo "drill: OK  $label = $n"
  else
    echo "drill: FAIL $label = $n (expected >= $min)" >&2
    exit 1
  fi
}

check "users"       "SELECT count(*) FROM accounts_user;" 1
check "tournaments" "SELECT count(*) FROM tournaments_tournament;" 1
check "teams"       "SELECT count(*) FROM teams_team;" 1
check "matches"     "SELECT count(*) FROM matches_match;" 1
check "audit rows"  "SELECT count(*) FROM audit_event;" 1

dropdb "$SCRATCH_DB"
echo "drill: PASSED — $(basename "$latest_dump") restores cleanly"
