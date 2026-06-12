"""Schedule versioning — the unified slot-change feed (trust layer, F).

Every persisted slot change (manual reslot, delay cascade, swap, rain-day
shift, scheduler re-run, lock/unlock) ALREADY emits an AuditEvent; this
module flattens those rows — no new model — into a reverse-chrono list of
per-match entries the control room and team pages can render:

    {match_id, match_label, leaf_key, changed_at, actor, kind,
     old: {scheduled_at, venue} | None, new: {...} | None,
     reason, batch_id}

``batch_id`` is the source audit row's id — the same value increment G uses
to dedupe change notifications per (user, batch):
``queue_slot_change_notifications`` is called by every repair verb and by
``apply_schedule`` inside their transaction; on commit it notifies the
affected teams' institution contacts + the tournament admins, once per
(user, batch), skipping initial scheduling (previous slot was empty).
"""
from __future__ import annotations

import json
import uuid as _uuid
from datetime import datetime
from typing import Any

from django.db import transaction

# audit event_type → feed kind. fixtures_scheduled rows older than the trust
# layer carry no per-match ``changes`` payload (and no tournament_id) — they
# simply yield no entries.
KIND_BY_EVENT_TYPE = {
    "match_rescheduled": "rescheduled",
    "match_delay_cascade": "delayed",
    "match_slots_swapped": "swapped",
    "shift_day": "day_shifted",
    "fixtures_scheduled": "engine_rerun",
    "match_locked": "locked",
    "match_unlocked": "unlocked",
}

_MAX_ROWS = 1000


def _slot(d: dict[str, Any] | None) -> dict[str, Any]:
    d = d or {}
    return {"scheduled_at": d.get("scheduled_at"), "venue": d.get("venue")}


def _row_changes(ev: Any) -> list[dict[str, Any]]:
    """One audit row → [{match_id, old, new}] (old/new = slot dicts or None)."""
    before = ev.payload_before or {}
    after = ev.payload_after or {}
    et = ev.event_type
    if et == "match_rescheduled":
        return [{
            "match_id": str(ev.target_id),
            "old": _slot(before),
            "new": _slot(after),
        }]
    if et in ("match_delay_cascade", "shift_day"):
        # moved: [{match_id, old, new, venue?}] — venue unchanged by both
        # verbs (None on legacy delay rows that predate the venue field).
        return [
            {
                "match_id": str(e.get("match_id")),
                "old": {"scheduled_at": e.get("old"), "venue": e.get("venue")},
                "new": {"scheduled_at": e.get("new"), "venue": e.get("venue")},
            }
            for e in after.get("moved") or []
        ]
    if et == "match_slots_swapped":
        old_by = {
            str(s.get("match_id")): s for s in before.get("slots") or []
        }
        return [
            {
                "match_id": str(s.get("match_id")),
                "old": _slot(old_by.get(str(s.get("match_id")))),
                "new": _slot(s),
            }
            for s in after.get("slots") or []
        ]
    if et == "fixtures_scheduled":
        return [
            {
                "match_id": str(c.get("match_id")),
                "old": _slot(c.get("old")),
                "new": _slot(c.get("new")),
            }
            for c in after.get("changes") or []
        ]
    if et in ("match_locked", "match_unlocked"):
        # The slot itself did not move — old/new are null by design.
        return [{"match_id": str(ev.target_id), "old": None, "new": None}]
    return []


def match_label(m: Any) -> str:
    """'Team A vs Team B', or a terse positional code while sides are TBD."""
    if m is None:
        return ""
    home = m.home_team.name if m.home_team_id else ""
    away = m.away_team.name if m.away_team_id else ""
    if home and away:
        return f"{home} vs {away}"
    return f"M{m.match_no} R{m.round_no}"


# ----------------------------------------------------------- notifications (G)
NOTIFICATION_KIND = "schedule_changed"
NOTIFICATION_TITLE = "notification.schedule_changed"  # i18n code (invariant 13)


def _instant(value: Any) -> Any:
    """ISO string → datetime for comparison; the same wall-clock instant may
    serialize with different offsets (UTC vs tournament TZ)."""
    try:
        return datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return value


def _really_moved(change: dict[str, Any]) -> bool:
    """True when a previously SLOTTED match got a different time or venue —
    initial scheduling (no previous scheduled_at) is silent by design."""
    old = change.get("old") or {}
    new = change.get("new") or {}
    if not old.get("scheduled_at"):
        return False
    if _instant(old.get("scheduled_at")) != _instant(new.get("scheduled_at")):
        return True
    return (old.get("venue") or "") != (new.get("venue") or "")


def queue_slot_change_notifications(
    *, tournament: Any, batch_id: Any, changes: list[dict[str, Any]], by: Any = None,
) -> None:
    """Register the post-commit change-notification fan-out for one batch.

    ``changes`` = [{match_id, old: {scheduled_at, venue}, new: {...}}] —
    exactly the shape the audit payloads carry. ``batch_id`` is the audit
    row id; the dedupe key is (user, batch). Call INSIDE the verb's
    transaction; nothing fires unless it commits (invariant 4 spirit)."""
    relevant = [c for c in changes if _really_moved(c)]
    if not relevant:
        return
    tournament_id, actor_id = tournament.id, getattr(by, "id", None)
    transaction.on_commit(
        lambda: _send_slot_change_notifications(
            tournament_id, batch_id, relevant, actor_id
        )
    )


def _send_slot_change_notifications(
    tournament_id: Any, batch_id: Any, changes: list[dict[str, Any]], actor_id: Any,
) -> None:
    from django.contrib.auth import get_user_model
    from django.db.models import Q

    from apps.matches.models import Match
    from apps.notifications.services.dispatch import create_notification
    from apps.tournaments.models import (
        Tournament,
        TournamentMembership,
        TournamentMembershipRole,
        TournamentMembershipStatus,
    )

    tournament = Tournament.objects.filter(id=tournament_id).first()
    if tournament is None:
        return
    matches = {
        str(m.id): m
        for m in Match.objects.filter(
            tournament=tournament, id__in=[c["match_id"] for c in changes]
        ).select_related(
            "home_team__institution", "away_team__institution",
            "home_team", "away_team",
        )
    }

    items: list[dict[str, Any]] = []
    emails_by_match: dict[str, set[str]] = {}
    for c in changes:
        mid = str(c["match_id"])
        m = matches.get(mid)
        items.append({
            "match_id": mid,
            "match_label": match_label(m),
            "leaf_key": m.leaf_key if m else "",
            "old": c.get("old"),
            "new": c.get("new"),
        })
        emails: set[str] = set()
        for team in ((m.home_team, m.away_team) if m else ()):
            inst = team.institution if team and team.institution_id else None
            email = (inst.contact_email or "").strip().lower() if inst else ""
            if email:
                emails.add(email)
        emails_by_match[mid] = emails

    admin_ids = set(
        TournamentMembership.objects.filter(
            tournament=tournament,
            status=TournamentMembershipStatus.ACTIVE,
            role__in=(
                TournamentMembershipRole.ADMIN,
                TournamentMembershipRole.CO_ORGANIZER,
            ),
        ).values_list("user_id", flat=True)
    )
    if tournament.created_by_id:
        admin_ids.add(tournament.created_by_id)

    all_emails = {e for s in emails_by_match.values() for e in s}
    users = list(
        get_user_model().objects.filter(is_active=True).filter(
            Q(id__in=admin_ids) | Q(email__in=all_emails)
        )
    )

    for user in users:
        if user.id == actor_id:  # never notify the editor of their own change
            continue
        if user.id in admin_ids:
            mine = items  # admins see the whole batch
        else:
            mine = [
                i for i in items if user.email in emails_by_match[i["match_id"]]
            ]
        if not mine:
            continue
        create_notification(
            user=user,
            kind=NOTIFICATION_KIND,
            title=NOTIFICATION_TITLE,
            body=json.dumps(
                {
                    "code": NOTIFICATION_KIND,
                    "batch_id": str(batch_id),
                    "changes": mine,
                },
                default=str,
            ),
            url=f"/tournaments/{tournament.id}",
            tournament=tournament,
            event_id=_uuid.uuid5(
                _uuid.NAMESPACE_URL,
                f"fixture:schedule-change:{batch_id}:{user.id}",
            ),
        )


def schedule_changes(
    tournament: Any,
    *,
    since: datetime | None = None,
    leaf_key: str | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """Flat reverse-chrono slot-change feed sourced from AuditEvent rows."""
    from apps.audit.models import AuditEvent
    from apps.matches.models import Match

    qs = (
        AuditEvent.objects.filter(
            tournament_id=tournament.id,
            event_type__in=KIND_BY_EVENT_TYPE,
        )
        .select_related("actor_user")
        .order_by("-created_at", "-id")
    )
    if since is not None:
        qs = qs.filter(created_at__gt=since)

    raw = [(ev, _row_changes(ev)) for ev in qs[:_MAX_ROWS]]
    match_ids = {
        c["match_id"] for _, changes in raw for c in changes if c["match_id"]
    }
    # Soft-deleted matches stay resolvable — the feed is history.
    matches = {
        str(m.id): m
        for m in Match.objects.filter(
            tournament=tournament, id__in=match_ids
        ).select_related("home_team", "away_team")
    }

    entries: list[dict[str, Any]] = []
    for ev, changes in raw:
        actor = (
            {"id": str(ev.actor_user_id), "email": ev.actor_user.email}
            if ev.actor_user_id and ev.actor_user
            else None
        )
        for c in changes:
            m = matches.get(c["match_id"])
            lk = m.leaf_key if m else ""
            if leaf_key and lk != leaf_key:
                continue
            entries.append({
                "match_id": c["match_id"],
                "match_label": match_label(m),
                "leaf_key": lk,
                "changed_at": ev.created_at.isoformat(),
                "actor": actor,
                "kind": KIND_BY_EVENT_TYPE[ev.event_type],
                "old": c["old"],
                "new": c["new"],
                "reason": ev.reason or "",
                "batch_id": str(ev.id),
            })
            if len(entries) >= limit:
                return entries
    return entries
