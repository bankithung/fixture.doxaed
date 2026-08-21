"""Freeze and restore a tournament's whole fixture.

A fixture is not written once. It is drawn, scheduled, repaired, re-drawn and
hand-edited, and every pass used to overwrite the last with nothing kept — an
organiser who preferred yesterday's draw had no way back to it, and no way to
show a school what moved. A snapshot keeps every match as it stood.

Two things make a restore safe rather than a blunt overwrite:

* **Ids are part of the payload.** Restoring puts the SAME match rows back, so
  the typed `winner_of` / `loser_of` pointers between them still resolve — a
  snapshot that recreated rows with fresh ids would restore a bracket whose
  every pointer dangled (invariant 9).
* **A played match blocks it.** Once anything has kicked off, the fixture is no
  longer a plan and rewinding it would erase a result. `restore` refuses, and
  says which match stopped it.
"""

from __future__ import annotations

from typing import Any

from django.db import transaction
from django.utils import timezone as dj_tz

from apps.audit.models import ActorRole
from apps.audit.services import emit_audit
from apps.fixtures.models import FixtureSnapshot
from apps.matches.models import Match, MatchStatus

# Everything needed to put a match back exactly as it was. `id` leads because
# it is what keeps the bracket's pointers pointing at something.
FIELDS = (
    "id", "stage", "stage_no", "group_label", "round_no", "match_no",
    "home_team_id", "away_team_id", "home_source", "away_source",
    "status", "home_score", "away_score", "home_pens", "away_pens",
    "sport", "set_scores", "leaf_key", "scheduled_at", "venue", "court_id",
    "locked_at", "inputs_hash",
)
# Statuses that mean "still only a plan". Anything else is a result.
PLAN_STATUSES = frozenset({MatchStatus.SCHEDULED, MatchStatus.POSTPONED})


def _dump(m: Match) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for f in FIELDS:
        v = getattr(m, f)
        if hasattr(v, "isoformat"):
            v = v.isoformat()
        elif f == "id" or f.endswith("_id"):
            v = str(v) if v is not None else None
        out[f] = v
    return out


def _summarise(matches: list[Match]) -> dict[str, Any]:
    comps = sorted({m.leaf_key for m in matches if m.leaf_key})
    days = sorted(
        {m.scheduled_at.date().isoformat() for m in matches if m.scheduled_at}
    )
    return {
        "competitions": comps,
        "competition_count": len(comps),
        "days": days,
        "scheduled": sum(1 for m in matches if m.scheduled_at),
        "played": sum(1 for m in matches if m.status not in PLAN_STATUSES),
    }


def capture(
    tournament, *, kind: str = FixtureSnapshot.Kind.MANUAL, label: str = "",
    by=None, request=None,
) -> FixtureSnapshot | None:
    """Freeze the tournament's current fixture. Returns None when there is
    nothing to freeze — an empty fixture is not a version worth keeping."""
    matches = list(
        Match.objects.filter(tournament=tournament, deleted_at__isnull=True)
        .order_by("leaf_key", "stage", "stage_no", "round_no", "match_no", "id")
    )
    if not matches:
        return None
    snap = FixtureSnapshot.objects.create(
        organization_id=tournament.organization_id,
        tournament=tournament,
        kind=kind,
        label=label[:120],
        match_count=len(matches),
        summary=_summarise(matches),
        payload=[_dump(m) for m in matches],
        created_by=by if getattr(by, "is_authenticated", False) else None,
    )
    emit_audit(
        actor_user=snap.created_by,
        actor_role=ActorRole.SYSTEM if by is None else ActorRole.ADMIN,
        event_type="fixture.snapshot.captured",
        target_type="fixture_snapshot",
        target_id=snap.id,
        organization_id=tournament.organization_id,
        tournament_id=tournament.id,
        payload_after={"kind": kind, "label": snap.label, "matches": len(matches)},
        request=request,
    )
    return snap


def capture_quiet(tournament, *, kind: str, label: str = "") -> None:
    """Capture from inside a generation or scheduling run.

    Never lets a snapshot failure take the fixture down with it: the fixture is
    the product, the version history is the convenience.
    """
    try:
        capture(tournament, kind=kind, label=label)
    except Exception:  # pragma: no cover - defensive
        pass


class RestoreBlocked(Exception):
    """A restore that would erase a played match."""


@transaction.atomic
def restore(snapshot: FixtureSnapshot, *, by=None, request=None) -> dict[str, int]:
    """Put the snapshot's fixture back.

    Matches in the payload are written back onto their own rows (undeleting one
    that had been removed); anything the tournament has now that the snapshot
    does not is soft-deleted. Refuses outright if any match has been played,
    because a fixture with results in it is no longer a plan to rewind.
    """
    tournament = snapshot.tournament
    live = list(
        Match.objects.filter(tournament=tournament, deleted_at__isnull=True)
    )
    played = [m for m in live if m.status not in PLAN_STATUSES]
    if played:
        raise RestoreBlocked(
            "%d match(es) already have a result, starting with %s. Restoring "
            "would erase them." % (len(played), played[0].id)
        )
    # A snapshot taken when something had already been played is equally unsafe
    # to lay down: it would resurrect a result that has since been corrected.
    if snapshot.summary.get("played"):
        raise RestoreBlocked(
            "This snapshot was taken after %d match(es) had been played, so it "
            "cannot be laid back down over a clean fixture."
            % snapshot.summary["played"]
        )

    # The fixture about to be overwritten is itself worth keeping, so a
    # restore can be undone. Taken BEFORE anything is written.
    capture_quiet(
        tournament,
        kind=FixtureSnapshot.Kind.RESTORED,
        label="Before restoring %s" % snapshot.created_at.strftime("%d %b %H:%M"),
    )

    keep = {row["id"] for row in snapshot.payload}
    by_id = {str(m.id): m for m in Match.objects.filter(tournament=tournament)}
    restored = created = removed = 0
    for row in snapshot.payload:
        m = by_id.get(row["id"])
        if m is None:
            m = Match(
                id=row["id"], tournament=tournament,
                organization_id=tournament.organization_id,
            )
            created += 1
        else:
            restored += 1
        for f in FIELDS:
            if f == "id":
                continue
            setattr(m, f, row.get(f))
        m.deleted_at = None
        m.save()
    now = dj_tz.now()
    for m in live:
        if str(m.id) not in keep:
            m.deleted_at = now
            m.save(update_fields=["deleted_at"])
            removed += 1

    emit_audit(
        actor_user=by if getattr(by, "is_authenticated", False) else None,
        actor_role=ActorRole.ADMIN if by is not None else ActorRole.SYSTEM,
        event_type="fixture.snapshot.restored",
        target_type="fixture_snapshot",
        target_id=snapshot.id,
        organization_id=tournament.organization_id,
        tournament_id=tournament.id,
        payload_after={
            "restored": restored, "created": created, "removed": removed,
            "captured_at": snapshot.created_at.isoformat(),
        },
        request=request,
    )
    return {"restored": restored, "created": created, "removed": removed}
