"""Per-team iCal feeds (trust layer, increment H).

A tournament manager (or the team institution's registered contact) mints a
SIGNED calendar token — same `django.core.signing` pattern as the team-access
share links (`services/access.py`) — and the public `calendar.ics` endpoint
exchanges it for the team's VEVENTs. The raw token is the capability: no
token (or a tampered / another team's token) → 403. Times are stored aware
(invariant 14) and emitted in UTC (`...Z`), which calendar apps render in the
viewer's local time.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from django.core import signing
from django.utils import timezone as dj_tz

CALENDAR_TOKEN_SALT = "team-calendar"  # noqa: S105 — a signing salt, not a secret
# Calendar apps poll feeds for a whole season — generous, but not eternal.
CALENDAR_TOKEN_MAX_AGE = 366 * 24 * 60 * 60


def make_calendar_token(team: Any) -> str:
    return signing.dumps({"t": str(team.id)}, salt=CALENDAR_TOKEN_SALT)


def read_calendar_token(token: str) -> dict[str, Any] | None:
    """Verified payload, or None (tampered / expired)."""
    try:
        data = signing.loads(
            token, salt=CALENDAR_TOKEN_SALT, max_age=CALENDAR_TOKEN_MAX_AGE
        )
    except signing.BadSignature:
        return None
    return data if isinstance(data, dict) else None


def _esc(value: Any) -> str:
    """RFC 5545 TEXT escaping (backslash, semicolon, comma, newline)."""
    return (
        str(value)
        .replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\r\n", "\\n")
        .replace("\n", "\\n")
    )


def _utc(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def team_calendar_ics(team: Any) -> str:
    """The team's schedule as a VCALENDAR string (UID = match id, DTSTART in
    UTC, SUMMARY 'A vs B — Competition', LOCATION venue)."""
    from django.db.models import Q

    from apps.fixtures.services.repair import _duration_minutes
    from apps.matches.models import Match, MatchStatus
    from apps.tournaments.services.sports import leaf_label

    tournament = team.tournament
    matches = (
        Match.objects.filter(
            tournament=tournament,
            deleted_at__isnull=True,
            scheduled_at__isnull=False,
        )
        .filter(Q(home_team=team) | Q(away_team=team))
        .exclude(status=MatchStatus.CANCELLED)
        .select_related("home_team", "away_team")
        .order_by("scheduled_at", "match_no")
    )
    default_minutes = int(
        (tournament.scheduling_config or {}).get("slot_minutes") or 90
    )
    stamp = _utc(dj_tz.now())

    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Fixture//Team Calendar//EN",
        "CALSCALE:GREGORIAN",
        f"X-WR-CALNAME:{_esc(team.name)}",
    ]
    for m in matches:
        competition = (
            leaf_label(tournament.sports, m.leaf_key)
            if m.leaf_key
            else (m.group_label or tournament.name)
        )
        home = m.home_team.name if m.home_team is not None else "TBD"
        away = m.away_team.name if m.away_team is not None else "TBD"
        start = m.scheduled_at
        assert start is not None  # filtered scheduled_at__isnull=False
        end = start + timedelta(
            minutes=_duration_minutes(tournament, m.sport, default_minutes)
        )
        lines += [
            "BEGIN:VEVENT",
            f"UID:{m.id}@fixture",
            f"DTSTAMP:{stamp}",
            f"DTSTART:{_utc(start)}",
            f"DTEND:{_utc(end)}",
            f"SUMMARY:{_esc(f'{home} vs {away} — {competition}')}",
        ]
        if m.venue:
            lines.append(f"LOCATION:{_esc(m.venue)}")
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines) + "\r\n"
