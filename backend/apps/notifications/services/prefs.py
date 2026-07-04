"""Notification preferences — the catalog of user-facing kinds, per-user
resolution with defaults, and the dispatch-time gate. The catalog is the
single source of truth the settings UI renders from."""
from __future__ import annotations

from django.core.exceptions import ValidationError

from apps.notifications.models import NotificationPreference

# Every user-facing notification kind the platform emits, with its display
# copy and channel defaults. In-app defaults ON everywhere (the bell is the
# durable record); email defaults ON only where missing it costs an operator
# a match (assignment, schedule, disputes).
KIND_CATALOG: list[dict] = [
    {
        "kind": "match_assignment",
        "label": "Match assignments",
        "description": "You are named scorer or official for a match.",
        "default_in_app": True,
        "default_email": True,
    },
    {
        "kind": "schedule_changed",
        "label": "Schedule changes",
        "description": "Kick-off times or venues move for your matches.",
        "default_in_app": True,
        "default_email": True,
    },
    {
        "kind": "dispute_raised",
        "label": "Disputes raised",
        "description": "A team raises a dispute in a tournament you manage.",
        "default_in_app": True,
        "default_email": True,
    },
    {
        "kind": "dispute_resolved",
        "label": "Dispute outcomes",
        "description": "A dispute you raised is resolved.",
        "default_in_app": True,
        "default_email": False,
    },
    {
        "kind": "match_incident_filed",
        "label": "Match incidents",
        "description": "A referee files an incident report in your tournament.",
        "default_in_app": True,
        "default_email": False,
    },
]

_BY_KIND = {row["kind"]: row for row in KIND_CATALOG}
CHANNELS = ("in_app", "email")


def _defaults_for(kind: str) -> dict[str, bool]:
    row = _BY_KIND.get(kind)
    if row is None:
        # Unknown/new kind: deliver in-app, hold email — never drop silently.
        return {"in_app": True, "email": False}
    return {"in_app": row["default_in_app"], "email": row["default_email"]}


def resolved_prefs(user) -> dict:
    """The full matrix the settings page renders: every catalog kind with its
    effective switches, plus the digest flag."""
    stored = getattr(user, "notification_preference", None)
    overrides = (stored.prefs if stored else None) or {}
    kinds = []
    for row in KIND_CATALOG:
        eff = {**_defaults_for(row["kind"]), **overrides.get(row["kind"], {})}
        kinds.append({
            "kind": row["kind"],
            "label": row["label"],
            "description": row["description"],
            "in_app": bool(eff.get("in_app", True)),
            "email": bool(eff.get("email", False)),
        })
    return {"kinds": kinds, "digest": bool(stored.digest) if stored else False}


def update_prefs(*, user, kinds: dict | None = None, digest: bool | None = None):
    """Persist overrides. `kinds` maps kind -> {in_app?, email?}; only known
    channels are stored, unknown kinds rejected so typos surface loudly."""
    clean: dict[str, dict[str, bool]] = {}
    for kind, channels in (kinds or {}).items():
        if kind not in _BY_KIND:
            raise ValidationError(f"unknown_notification_kind:{kind}")
        if not isinstance(channels, dict):
            raise ValidationError("bad_channels")
        clean[kind] = {
            ch: bool(channels[ch]) for ch in CHANNELS if ch in channels
        }
    pref, _ = NotificationPreference.objects.get_or_create(user=user)
    if clean:
        merged = dict(pref.prefs or {})
        for kind, channels in clean.items():
            merged[kind] = {**merged.get(kind, {}), **channels}
        pref.prefs = merged
    if digest is not None:
        pref.digest = bool(digest)
    pref.save(update_fields=["prefs", "digest", "updated_at"])
    return pref


def allows(user, kind: str, channel: str) -> bool:
    """Dispatch-time gate: does this user take `kind` on `channel`?"""
    stored = getattr(user, "notification_preference", None)
    overrides = ((stored.prefs if stored else None) or {}).get(kind, {})
    eff = {**_defaults_for(kind), **overrides}
    return bool(eff.get(channel, False))
