#!/usr/bin/env python
"""Deploy-time helpers for autodeploy.sh.

Two jobs, both deliberately raw-SQL / stdlib only so they stay correct in the
one state that matters here: NEW code checked out on disk while the DB is still
on the OLD schema (that is exactly when a deploy is deciding whether to migrate,
and it is when the ORM would explode on a column that does not exist yet).

    deploy_guard.py stale-live [--hours N]
        Decide whether the PRD 5 "no migrations while a tournament is LIVE"
        guard is protecting a real in-play event or just stale demo rows.
        exit 0 -> safe to set FIXTURE_ALLOW_LIVE_MIGRATE=1 (nothing is actually
                  being scored)
        exit 1 -> a live tournament saw match activity inside the window; the
                  deploy must wait
        exit 2 -> could not tell (DB down, unexpected schema); caller must treat
                  this as "do not override"

    deploy_guard.py alert --subject S --body-file F [--to ADDR]
        Send one operational email through the configured prod SMTP.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent / "backend"
DEFAULT_STALE_HOURS = 6
DEFAULT_ALERT_TO = "doxaedoffice@gmail.com"


def _django(settings: str) -> None:
    sys.path.insert(0, str(BACKEND))
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", settings)
    import django

    django.setup()


# --- stale-live ------------------------------------------------------------
# A tournament is "actually live" if anything was scored or a match row moved
# inside the window. Both signals are read straight from the tables so this
# works before the pending migrations are applied.
_SQL = """
SELECT t.name,
       GREATEST(
         COALESCE((SELECT max(m.updated_at) FROM matches_match m
                    WHERE m.tournament_id = t.id), 'epoch'::timestamptz),
         COALESCE((SELECT max(e.created_at) FROM matches_match_event e
                    WHERE e.tournament_id = t.id), 'epoch'::timestamptz)
       ) AS last_activity
  FROM tournaments_tournament t
 WHERE t.status = 'live' AND t.deleted_at IS NULL
"""


def cmd_stale_live(args: argparse.Namespace) -> int:
    try:
        _django("fixture.settings.dev")
        from django.db import connection
        from django.utils import timezone

        with connection.cursor() as cur:
            cur.execute(_SQL)
            rows = cur.fetchall()
    except Exception as exc:  # DB down, schema surprise -> never override
        print(f"stale-live: cannot determine live state ({exc.__class__.__name__}: {exc})")
        return 2

    if not rows:
        print("stale-live: no tournament is LIVE; guard is not blocking")
        return 0

    cutoff = timezone.now() - timezone.timedelta(hours=args.hours)
    active = [(n, ts) for n, ts in rows if ts is not None and ts >= cutoff]
    if active:
        detail = "; ".join(f"{n!r} last activity {ts:%Y-%m-%d %H:%M} UTC" for n, ts in active)
        print(f"stale-live: {len(active)} live tournament(s) active within {args.hours}h: {detail}")
        return 1

    newest = max((ts for _, ts in rows if ts is not None), default=None)
    when = f"{newest:%Y-%m-%d %H:%M} UTC" if newest else "never"
    print(
        f"stale-live: {len(rows)} tournament(s) LIVE but idle "
        f"(newest activity {when}, cutoff {args.hours}h); safe to override"
    )
    return 0


# --- alert -----------------------------------------------------------------
def cmd_alert(args: argparse.Namespace) -> int:
    body = Path(args.body_file).read_text(encoding="utf-8", errors="replace")
    try:
        # prod settings carry the real SMTP backend; dev would only print it.
        os.environ["DJANGO_SETTINGS_MODULE"] = "fixture.settings.prod"
        _django("fixture.settings.prod")
        from django.conf import settings
        from django.core.mail import send_mail

        send_mail(
            subject=args.subject,
            message=body,
            from_email=getattr(settings, "SERVER_EMAIL", None),
            recipient_list=[args.to],
            fail_silently=False,
        )
    except Exception as exc:
        print(f"alert: send failed ({exc.__class__.__name__}: {exc})")
        return 1
    print(f"alert: sent to {args.to}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(prog="deploy_guard.py")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("stale-live")
    s.add_argument(
        "--hours",
        type=float,
        default=float(os.environ.get("DEPLOY_STALE_LIVE_HOURS", DEFAULT_STALE_HOURS)),
    )
    s.set_defaults(func=cmd_stale_live)

    a = sub.add_parser("alert")
    a.add_argument("--subject", required=True)
    a.add_argument("--body-file", required=True)
    a.add_argument("--to", default=os.environ.get("DEPLOY_ALERT_TO", DEFAULT_ALERT_TO))
    a.set_defaults(func=cmd_alert)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
