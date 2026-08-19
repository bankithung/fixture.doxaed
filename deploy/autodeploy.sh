#!/usr/bin/env bash
# ============================================================================
# Auto-deploy for fixture.doxaed.com
#
# Polls origin/main every minute (fixture-deploy.timer). Deploys whenever the
# last SUCCESSFULLY deployed commit (deployed.rev state file) is behind:
#   - new commits on origin/main       -> merged in and deployed
#   - commits made on this box, pushed -> deployed (the push is the go-signal;
#     unpushed local commits never deploy on their own)
#   - a failed deploy                  -> retried every tick until green
# Pipeline per deploy:
#   1. fast-forwards (or merges) origin into the local checkout
#   2. installs backend deps if requirements.txt changed
#   3. runs migrations if any are pending (as the fixture_owner DB role;
#      ABORTS the whole deploy if the live-tournament migrate guard blocks —
#      old code keeps serving, retried next tick)
#   4. rebuilds the frontend if frontend/ changed (tsc + vite gate the deploy)
#   5. restarts the fixture backend if backend/ changed
#   6. verifies: backend answers on /api/ and the served bundle hash changed
#   7. records the deployed commit in deployed.rev (only on success)
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

# ---- detect undeployed commits ----------------------------------------------
if ! git fetch --quiet origin "$BRANCH"; then
  log "git fetch failed (network?); will retry next tick"
  exit 1
fi

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

STATE="$LOGDIR/deployed.rev"   # last successfully deployed commit
DEPLOYED=$(cat "$STATE" 2>/dev/null || true)
if [ -z "$DEPLOYED" ] || ! git cat-file -e "$DEPLOYED^{commit}" 2>/dev/null; then
  # Bootstrap: whatever is serving right now was built from HEAD.
  DEPLOYED=$(git rev-parse HEAD)
  echo "$DEPLOYED" > "$STATE"
  log "seeded $STATE with ${DEPLOYED:0:9}"
  [ "$FORCE" -ne 1 ] && exit 0
fi

if git merge-base --is-ancestor "origin/$BRANCH" HEAD; then
  # origin brings nothing new; deploy only a pushed local advance
  if [ "$(git rev-parse HEAD)" = "$DEPLOYED" ]; then
    if [ "$FORCE" -ne 1 ]; then
      exit 0          # everything deployed; stay quiet on the timer
    fi
    log "nothing new, but --force given — running full pipeline"
  elif ! git merge-base --is-ancestor HEAD "origin/$BRANCH"; then
    # local commits exist but are not on origin yet: the push is the
    # go-signal, so wait (a --force overrides for manual runs)
    if [ "$FORCE" -ne 1 ]; then
      exit 0
    fi
    log "HEAD is ahead of origin (unpushed), but --force given — deploying it"
  fi
fi

OLDREV=$DEPLOYED
NEWREV=$(git rev-parse "origin/$BRANCH")
log "================ deploying ${NEWREV:0:9} (last deployed ${OLDREV:0:9}) ================"

STEP=""
run(){                         # run <step-name> <command...>
  STEP="$1"; shift
  log ">>> $STEP"
  # The status MUST be captured on the same line that runs the command. Reading
  # $? after `if "$@"; then return 0; fi` reads the exit status of the *if
  # statement* — which is 0 when the condition failed and there is no else — not
  # the command's. That is how this helper used to log "FAILED (0)" and then
  # `return 0`, which made every `run … || fail` guard below dead code: a blocked
  # migrate carried on to the backend restart with an unmigrated schema.
  local rc=0
  "$@" >>"$LOG" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ]; then
    log "!!! FAILED ($rc) at step: $STEP"
  fi
  return "$rc"
}
# ---- failure alerting --------------------------------------------------------
# A blocked deploy used to retry every minute in total silence: on 2026-08-16 it
# failed 278 times over hours while the site quietly served stale code. Email the
# owner ONCE per outage (after ALERT_AFTER consecutive failures), then once more
# when it recovers.
FAILC="$LOGDIR/fail.count"
ALERTED="$LOGDIR/alert.sent"
ALERT_AFTER=${DEPLOY_ALERT_AFTER:-3}

alert(){                       # alert <subject>
  local body="$LOGDIR/alert.body"
  { echo "$1"; echo; echo "host: $(hostname)   repo: $REPO"; echo "commit: $(git rev-parse --short HEAD 2>/dev/null)"; echo; echo "--- last 60 log lines ---"; tail -n 60 "$LOG"; } > "$body"
  "$PY" "$REPO/deploy/deploy_guard.py" alert --subject "$1" --body-file "$body" >>"$LOG" 2>&1 \
    && log ">>> alert emailed: $1" || log ">>> alert email FAILED (see log)"
}

fail(){
  log "================ DEPLOY FAILED (step: $STEP) ================"
  local n=$(( $(cat "$FAILC" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$FAILC"
  if [ "$n" -ge "$ALERT_AFTER" ] && [ ! -f "$ALERTED" ]; then
    alert "[fixture] deploy stuck: $n consecutive failures at '$STEP'"
    touch "$ALERTED"
  fi
  exit 1
}

# ---- 1. bring the checkout up to date ---------------------------------------
if ! git merge-base --is-ancestor "origin/$BRANCH" HEAD; then
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

    # The PRD 5 guard refuses to migrate while any tournament is LIVE. That is
    # right for an event being scored right now and WRONG for demo rows left
    # live forever: a stale LIVE tournament used to dead-lock every deploy, so
    # the box served old code indefinitely while the checkout sat on new code.
    # Ask deploy_guard whether anything is genuinely in play; only override
    # when nothing has been scored inside the window (exit 2 = unknown = wait).
    LIVE_OVERRIDE=0
    GUARD_MSG=$("$PY" "$REPO/deploy/deploy_guard.py" stale-live 2>&1); GUARD_RC=$?
    log ">>> live guard: $GUARD_MSG"
    [ "$GUARD_RC" -eq 0 ] && LIVE_OVERRIDE=1

    if ! run "django migrate (owner)" env DATABASE_URL="$FIXTURE_OWNER_DATABASE_URL" \
        FIXTURE_ALLOW_LIVE_MIGRATE="$LIVE_OVERRIDE" \
        "$PY" "$BACKEND/manage.py" migrate --noinput; then
      # A real in-play event, or a genuinely broken migration. Abort BEFORE
      # restarting: old code + old schema stay consistent; the timer retries
      # every minute and the deploy lands once the event finishes.
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
  BUILT_BUNDLE=$(grep -o 'index-[^"]*\.js' "$FRONTEND/dist/index.html" | head -1)
  log ">>> served bundle: ${OLD_BUNDLE:-none} -> ${NEW_BUNDLE:-none} (built ${BUILT_BUNDLE:-none})"
  # The invariant is "nginx serves exactly what we just built", NOT "the hash
  # changed". The old check compared the served hash against the last
  # SUCCESSFUL deploy, so once a build landed and a later step failed, every
  # retry rebuilt identical output, saw an unchanged hash and failed forever --
  # a self-deadlock that ate 244 deploys on 2026-08-16 alone. Comparing disk to
  # served still catches the real faults (build wrote nothing, nginx root stale
  # or misconfigured) and is correct on a retry.
  if [ -z "$BUILT_BUNDLE" ]; then
    log "!!! build produced no index bundle in $FRONTEND/dist"
    STEP="verify bundle hash"; fail
  fi
  if [ -n "$NEW_BUNDLE" ] && [ "$NEW_BUNDLE" != "$BUILT_BUNDLE" ]; then
    log "!!! nginx serves $NEW_BUNDLE but the build produced $BUILT_BUNDLE"
    STEP="verify bundle hash"; fail
  fi
fi

# ---- 6. backend restart --------------------------------------------------------
if changed "^backend/\|^deploy/gunicorn\|^deploy/fixture.service"; then
  # reload, NOT restart. ExecReload=HUP makes gunicorn re-exec its workers with
  # no dropped requests (measured 2026-08-19: 8/8 logins healthy through a
  # reload vs ~15s of 502s through a restart, which locked the owner out
  # mid-session). A restart is only actually required when the unit file or its
  # environment changes -- python code and gunicorn.conf.py are both re-read by
  # the re-forked workers.
  if changed "^deploy/fixture.service"; then
    run "install unit" sudo -n cp deploy/fixture.service /etc/systemd/system/fixture.service || fail
    run "daemon-reload" sudo -n systemctl daemon-reload || fail
    run "restart backend (unit file changed)" sudo -n systemctl restart fixture || fail
  else
    run "reload backend" sudo -n systemctl reload fixture || fail
  fi
  # /api/me/ does not exist (it is /api/accounts/me/) so this check used to read
  # 404 and pass -- it would have gone green with the whole API unrouted. The
  # real endpoint answers 403 unauthenticated; 404 now means broken routing.
  # Gunicorn drains SSE streams on stop (TimeoutStopSec=30), so poll instead of
  # sleeping a fixed 3s and calling a still-draining worker a failure.
  HEALTH_PATH=/api/accounts/me/
  CODE=000
  for _ in $(seq 1 20); do
    sleep 3
    CODE=$(curl -sk -o /dev/null -w "%{http_code}" "https://127.0.0.1$HEALTH_PATH" -H "Host: fixture.doxaed.com")
    case "$CODE" in 5*|000) ;; *) break ;; esac
  done
  log ">>> backend health: HTTP $CODE on $HEALTH_PATH"
  case "$CODE" in
    5*|000) log "!!! backend not answering after restart"; STEP="verify backend"; fail ;;
    404)    log "!!! $HEALTH_PATH returned 404 -- API routing is broken"; STEP="verify backend"; fail ;;
  esac
fi

git rev-parse HEAD > "$STATE"
log "================ DEPLOY OK @ $(git rev-parse --short HEAD) ================"
if [ -f "$ALERTED" ]; then
  alert "[fixture] deploy recovered @ $(git rev-parse --short HEAD)"
  rm -f "$ALERTED"
fi
echo 0 > "$FAILC"
exit 0
