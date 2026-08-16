#!/usr/bin/env bash
# ============================================================================
# Manual redeploy for fixture.doxaed.com -- ONE command for the whole pipeline
# (pull, deps, migrate, rebuild frontend, restart services, verify).
#
#   deploy/redeploy.sh              # deploy whatever is on origin/main now
#   deploy/redeploy.sh --force      # run every step even if nothing changed
#   deploy/redeploy.sh --status     # what is deployed / is anything stuck?
#   deploy/redeploy.sh --logs       # tail the deploy log
#
# This is a thin front end over autodeploy.sh so the manual path and the timer
# path are the SAME pipeline -- one place to fix, no drift between "what the
# timer does" and "what I do by hand". The timer keeps running; this just makes
# it happen now and prints the outcome instead of leaving it in a log file.
# ============================================================================
set -uo pipefail

REPO=/home/ubuntu/Fixture
LOGDIR=/home/ubuntu/fixture-deploy
LOG="$LOGDIR/deploy.log"
STATE="$LOGDIR/deployed.rev"
SERVICES=(fixture)          # systemd units that must be up after a deploy

cd "$REPO" || { echo "FATAL: $REPO missing"; exit 1; }

case "${1:-}" in
  --logs)
    exec tail -n "${2:-80}" -f "$LOG" ;;
  --status)
    echo "deployed : $(cut -c1-9 < "$STATE" 2>/dev/null || echo unknown)"
    echo "HEAD     : $(git rev-parse --short=9 HEAD)"
    echo "origin   : $(git fetch -q origin main 2>/dev/null; git rev-parse --short=9 origin/main)"
    echo "failures : $(cat "$LOGDIR/fail.count" 2>/dev/null || echo 0) consecutive"
    [ -f "$LOGDIR/alert.sent" ] && echo "ALERT    : an unresolved deploy failure has been emailed"
    echo "pending migrations:"
    "$REPO/backend/.venv/bin/python" "$REPO/backend/manage.py" showmigrations --plan 2>/dev/null \
      | grep '^\[ \]' || echo "  (none)"
    echo "live guard:"
    echo "  $("$REPO/backend/.venv/bin/python" "$REPO/deploy/deploy_guard.py" stale-live 2>&1)"
    for s in "${SERVICES[@]}"; do printf '%-9s: %s\n' "$s" "$(systemctl is-active "$s")"; done
    exit 0 ;;
esac

echo "==> running the deploy pipeline (this is the same one the timer runs)"
"$REPO/deploy/autodeploy.sh" "${1:---force}"
RC=$?

# The pipeline only restarts what changed. A manual run is also the thing you
# reach for when something is simply wedged, so make sure every unit is up
# regardless of what the diff said.
for s in "${SERVICES[@]}"; do
  if ! systemctl is-active --quiet "$s"; then
    echo "==> $s is $(systemctl is-active "$s"); starting it"
    sudo -n systemctl start "$s" || echo "!!! could not start $s"
  fi
done

echo
echo "==> result"
tail -n 15 "$LOG"
echo
for s in "${SERVICES[@]}"; do printf '%-9s: %s\n' "$s" "$(systemctl is-active "$s")"; done
printf 'api      : HTTP %s on /api/accounts/me/ (403 = healthy, unauthenticated)\n' \
  "$(curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1/api/accounts/me/ -H 'Host: fixture.doxaed.com')"
printf 'spa      : HTTP %s serving %s\n' \
  "$(curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1/ -H 'Host: fixture.doxaed.com')" \
  "$(curl -sk https://127.0.0.1/ -H 'Host: fixture.doxaed.com' | grep -o 'index-[^"]*\.js' | head -1)"

[ "$RC" -eq 0 ] && echo && echo "==> DEPLOY OK" || { echo; echo "==> DEPLOY FAILED (rc=$RC) -- see $LOG"; }
exit "$RC"
