#!/usr/bin/env bash
# ============================================================================
# Auto-deploy for fixture.doxaed.com
#
# Polls origin/main every minute (fixture-deploy.timer). When new commits land:
#   1. fast-forwards (or merges) them into the local checkout
#   2. installs backend deps if requirements.txt changed
#   3. runs migrations if any are pending (as the fixture_owner DB role;
#      ABORTS the whole deploy if the live-tournament migrate guard blocks —
#      old code keeps serving, retried next tick)
#   4. rebuilds the frontend if frontend/ changed (tsc + vite gate the deploy)
#   5. restarts the fixture backend if backend/ changed
#   6. verifies: backend answers on /api/ and the served bundle hash changed
#
# This checkout doubles as the dev working tree: the merge step lets git
# protect dirty files (a conflicting pull aborts cleanly and is retried once
# the local work is committed). Nothing here ever resets or stashes.
#
# Manual use:
#   deploy/autodeploy.sh          # deploy only if origin/main advanced
#   deploy/autodeploy.sh --force  # full pipeline even with no new commits
# ============================================================================
set -uo pipefail

REPO=/home/ubuntu/Fixture
BACKEND="$REPO/backend"
FRONTEND="$REPO/frontend"
PY="$BACKEND/.venv/bin/python"
BRANCH=main
LOGDIR=/home/ubuntu/fixture-deploy
LOG="$LOGDIR/deploy.log"
LOCKFILE="$LOGDIR/deploy.lock"
ENVFILE="$LOGDIR/deploy.env"   # holds FIXTURE_OWNER_DATABASE_URL (chmod 600)

export PATH="/home/ubuntu/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export HOME=/home/ubuntu

mkdir -p "$LOGDIR"
# keep the log from growing without bound
[ -f "$LOG" ] && [ "$(stat -c%s "$LOG")" -gt 5242880 ] && tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
log(){ echo "[$(date -Is)] $*" | tee -a "$LOG"; }

# ---- single-instance lock ---------------------------------------------------
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  log "another deploy is already running; skipping this tick"
  exit 0
fi

cd "$REPO" || { log "FATAL: repo $REPO missing"; exit 1; }

# ---- detect new upstream commits --------------------------------------------
if ! git fetch --quiet origin "$BRANCH"; then
  log "git fetch failed (network?); will retry next tick"
  exit 1
fi

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

if git merge-base --is-ancestor "origin/$BRANCH" HEAD; then
  if [ "$FORCE" -ne 1 ]; then
    exit 0            # up to date; stay quiet on the timer
  fi
  log "no new commits, but --force given — running full pipeline"
fi

OLDREV=$(git rev-parse HEAD)
NEWREV=$(git rev-parse "origin/$BRANCH")
log "================ deploying origin/$BRANCH ${NEWREV:0:9} (from ${OLDREV:0:9}) ================"

STEP=""
run(){                         # run <step-name> <command...>
  STEP="$1"; shift
  log ">>> $STEP"
  if "$@" >>"$LOG" 2>&1; then return 0; fi
  local rc=$?
  log "!!! FAILED ($rc) at step: $STEP"
  return "$rc"
}
fail(){ log "================ DEPLOY FAILED (step: $STEP) ================"; exit 1; }

# ---- 1. bring the checkout up to date ---------------------------------------
if [ "$OLDREV" != "$NEWREV" ]; then
  if ! run "git merge (ff)" git merge --ff-only "origin/$BRANCH"; then
    # local commits diverge from origin; try a real merge, abort cleanly on conflict
    if ! run "git merge" git merge --no-edit "origin/$BRANCH"; then
      git merge --abort >>"$LOG" 2>&1 || true
      log "merge conflicts with local work; leaving the tree untouched, retrying next tick"
      fail
    fi
  fi
fi

# ---- 2. what changed? --------------------------------------------------------
CHANGED=$(git diff --name-only "$OLDREV" "$(git rev-parse HEAD)")
changed(){ [ "$FORCE" -eq 1 ] || grep -q "$1" <<<"$CHANGED"; }

# ---- 3. backend deps ---------------------------------------------------------
if changed "^backend/requirements.txt"; then
  run "pip install deps" "$PY" -m pip install -q -r "$BACKEND/requirements.txt" || fail
fi

# ---- 4. migrations (owner role; live-guard aborts the deploy) ----------------
if changed "^backend/.*/migrations/"; then
  if ! "$PY" "$BACKEND/manage.py" migrate --check >>"$LOG" 2>&1; then
    log ">>> pending migrations detected"
    if [ ! -f "$ENVFILE" ]; then
      log "!!! $ENVFILE missing (needs FIXTURE_OWNER_DATABASE_URL); cannot migrate"
      STEP="migrate (env missing)"; fail
    fi
    # shellcheck disable=SC1090
    . "$ENVFILE"
    if ! run "django migrate (owner)" env DATABASE_URL="$FIXTURE_OWNER_DATABASE_URL" \
        "$PY" "$BACKEND/manage.py" migrate --noinput; then
      # Most likely the live-tournament guard (migrations are blocked while a
      # tournament is LIVE, by design). Abort BEFORE restarting: old code +
      # old schema stay consistent; the timer retries every minute and the
      # deploy lands once no tournament is live.
      log "migrate blocked or failed; NOT restarting with unmigrated code"
      fail
    fi
  else
    log ">>> migration files changed but nothing pending (already applied)"
  fi
fi

# ---- 5. frontend build --------------------------------------------------------
if changed "^frontend/"; then
  if changed "^frontend/package-lock.json"; then
    run "npm ci" npm --prefix "$FRONTEND" ci --no-audit --no-fund || fail
  fi
  OLD_BUNDLE=$(curl -sk https://127.0.0.1/ -H "Host: fixture.doxaed.com" | grep -o 'index-[^"]*\.js' | head -1)
  run "npm run build" npm --prefix "$FRONTEND" run build || fail
  NEW_BUNDLE=$(curl -sk https://127.0.0.1/ -H "Host: fixture.doxaed.com" | grep -o 'index-[^"]*\.js' | head -1)
  log ">>> served bundle: ${OLD_BUNDLE:-none} -> ${NEW_BUNDLE:-none}"
  if [ -n "$OLD_BUNDLE" ] && [ "$OLD_BUNDLE" = "$NEW_BUNDLE" ] && ! git diff --quiet "$OLDREV" HEAD -- frontend/src frontend/index.html 2>/dev/null; then
    log "!!! bundle hash did not change after a frontend src change"
    STEP="verify bundle hash"; fail
  fi
fi

# ---- 6. backend restart --------------------------------------------------------
if changed "^backend/\|^deploy/gunicorn"; then
  run "restart backend" sudo -n systemctl restart fixture || fail
  sleep 3
  CODE=$(curl -sk -o /dev/null -w "%{http_code}" https://127.0.0.1/api/me/ -H "Host: fixture.doxaed.com")
  log ">>> backend health: HTTP $CODE on /api/me/"
  case "$CODE" in
    5*|000) log "!!! backend not answering after restart"; STEP="verify backend"; fail ;;
  esac
fi

log "================ DEPLOY OK @ ${NEWREV:0:9} ================"
exit 0
