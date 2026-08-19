"""Copy one tournament's FIXTURE SETUP onto another (owner 2026-08-19).

A host who has spent a season tuning a tournament's rules — which competition
goes first, how long a match is, when the breaks fall, which court is reserved
for whom, how the finish is ordered — should not have to retype any of it for
next year's event. This copies exactly that: the inputs the fixture generator
reads, and nothing else.

**It never touches data.** Schools, teams, players, forms, responses, matches
and results all belong to the tournament that owns them; only settings move.

**It refuses to copy something the target cannot use.** The rules and the draw
config are written in terms of COMPETITION LEAF KEYS
(``table_tennis.u_14.boys.singles``). If the target's sports tree does not have
a leaf the source names, the copied record would be a dead reference that
silently does nothing — so the copy reports every such key. Run it with
``dry_run=True`` first to see that report without writing.

Venues and courts are ORGANIZATION-scoped and already shared between a
workspace's tournaments, so a court reservation carries over on its own; there
is nothing to copy and nothing to duplicate.
"""
from __future__ import annotations

from typing import Any

from django.db import transaction
from django.utils import timezone

#: What can be copied, and what each part is called on screen. Ordered as the
#: report reads.
COPYABLE_PARTS: dict[str, str] = {
    "constraints": "Scheduling rules",
    "draw_config": "Draw settings, calendar and durations",
    "scheduling_config": "Saved schedule settings",
    "rules": "Scoring rules and tiebreakers",
}

#: The fixture generator's own inputs — the default, because that is what the
#: owner asked for: "everything that comes under the fixture that is used to
#: generate the fixture". Scoring rules govern MATCHES, not the draw, so they
#: are opt-in rather than assumed.
DEFAULT_PARTS: tuple[str, ...] = ("constraints", "draw_config", "scheduling_config")


def _leaf_keys(tournament) -> set[str]:
    from apps.tournaments.services.sports import iter_leaves

    return {
        str(lf.get("leaf_key"))
        for lf in iter_leaves(tournament.sports or [])
        if lf.get("leaf_key")
    }


def _referenced_leaves(constraints: list, draw_config: dict) -> set[str]:
    """Every competition key the copied settings talk about.

    Scopes (``leaf:<key>``), the priority and finish orders, and the per-leaf
    draw config are all keyed by leaf. A prefix or a bare sport is NOT a leaf
    and is left out — it matches whatever the target happens to have, which is
    the point of writing it that way.
    """
    out: set[str] = set()
    for c in constraints or []:
        if not isinstance(c, dict):
            continue
        scope = str(c.get("scope") or "")
        if scope.startswith("leaf:"):
            out.add(scope.split(":", 1)[1].strip())
        params = c.get("params") or {}
        for key in ("order", "final_order"):
            for entry in params.get(key) or []:
                if isinstance(entry, str) and "." in entry:
                    out.add(entry.strip())
    for key in draw_config or {}:
        # "*" is the whole-tournament layer; "sport:x" is a sport layer.
        if key and key != "*" and not key.startswith("sport:"):
            out.add(str(key))
    return {k for k in out if k}


def copy_fixture_setup(
    *,
    source,
    target,
    by,
    parts: list[str] | tuple[str, ...] | None = None,
    dry_run: bool = False,
    event_id: str | None = None,
    request=None,
) -> dict[str, Any]:
    """Copy ``source``'s fixture setup onto ``target``.

    Returns a JSON-safe report: what was copied (or would be), which
    competition keys the settings name that the target does not have, and
    whether anything was actually written.

    Raises PermissionError("different_organization") when the two tournaments
    are not in the same workspace — settings can carry a workspace's court
    reservations and venue names, and moving them across tenants would leak
    one org's setup into another. Raises ValueError("nothing_to_copy") when
    ``parts`` names nothing known.
    """
    from apps.audit.models import ActorRole
    from apps.audit.services import emit_audit
    from apps.fixtures.services.constraints import validate_constraints

    if source.pk == target.pk:
        raise ValueError("same_tournament")
    if source.organization_id != target.organization_id:
        raise PermissionError("different_organization")

    wanted = [p for p in (parts or DEFAULT_PARTS) if p in COPYABLE_PARTS]
    if not wanted:
        raise ValueError("nothing_to_copy")

    if event_id is not None and not dry_run:
        from apps.audit.models import AuditEvent

        prior = AuditEvent.objects.filter(
            idempotency_key=event_id, event_type="tournament_setup_copied"
        ).first()
        if prior is not None:
            return {"copied": False, "replayed": True, "parts": wanted}

    constraints = list(source.constraints or []) if "constraints" in wanted else []
    draw_config = dict(source.draw_config or {}) if "draw_config" in wanted else {}

    # A rule the target cannot act on is worse than no rule: it reads as set
    # and does nothing. Name every one rather than copying quietly.
    have = _leaf_keys(target)
    referenced = _referenced_leaves(constraints, draw_config)
    missing = sorted(k for k in referenced if k not in have)

    report: dict[str, Any] = {
        "source_id": str(source.id),
        "source_name": source.name,
        "parts": wanted,
        "counts": {
            "constraints": len(source.constraints or []) if "constraints" in wanted else 0,
            "draw_config": len(source.draw_config or {}) if "draw_config" in wanted else 0,
            "scheduling_config": (
                len(source.scheduling_config or {})
                if "scheduling_config" in wanted else 0
            ),
            "rules": len(source.rules or {}) if "rules" in wanted else 0,
        },
        "unknown_competitions": missing,
        "target_had": {
            "constraints": len(target.constraints or []),
            "draw_config": len(target.draw_config or {}),
        },
        "copied": False,
        "dry_run": bool(dry_run),
    }
    if dry_run:
        return report

    fields: list[str] = []
    with transaction.atomic():
        if "constraints" in wanted:
            # Through the catalog validator, so a record the source stored
            # under an older shape cannot land here unvalidated.
            target.constraints = validate_constraints(constraints)
            fields.append("constraints")
        if "draw_config" in wanted:
            target.draw_config = draw_config
            fields.append("draw_config")
        if "scheduling_config" in wanted:
            target.scheduling_config = dict(source.scheduling_config or {})
            fields.append("scheduling_config")
        if "rules" in wanted:
            target.rules = dict(source.rules or {})
            fields.append("rules")
        target.last_manual_edit_at = timezone.now()
        fields.append("last_manual_edit_at")
        target.save(update_fields=fields)
        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="tournament_setup_copied",
            target_type="tournament",
            target_id=target.id,
            organization_id=target.organization_id,
            idempotency_key=event_id,
            payload_after={
                "source_tournament_id": str(source.id),
                "parts": wanted,
                "unknown_competitions": missing,
            },
            request=request,
        )
    report["copied"] = True
    return report
