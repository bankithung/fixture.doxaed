"""Tournament setup-workflow state machine (spec 2026-06-08 §4) — guarded,
audited stage transitions, mirroring ``apps/matches/services/state.py``.

The *stage* (setup→org_registration→…→ready) is orthogonal to the PRD *status*
lifecycle (draft→…→completed). Entering certain stages drives the status forward
(and only forward — reopening an earlier stage never rolls the lifecycle back), so
``freeze_rules`` fires once at ``registration_open`` and stays frozen across reopens.

Single writer for ``Tournament.stage``/``stage_meta``; forms are opened/closed only
through the existing ``apps/forms/services/forms.py`` (we orchestrate, never
re-implement). Idempotent on ``event_id`` (invariant 3); one new audit string
``tournament_stage_changed``.
"""
from __future__ import annotations

import logging
import math

from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from apps.audit.models import ActorRole, AuditEvent
from apps.audit.services import emit_audit
from apps.forms.constants import STAGE_TO_PURPOSE, FormPurpose, FormStatus
from apps.forms.models import Form
from apps.forms.services.forms import close_form, is_open, publish_form
from apps.matches.models import Match
from apps.teams.models import Team, TeamStatus
from apps.tournaments.models import (
    RosterMode,
    Tournament,
    TournamentMembership,
    TournamentMembershipStatus,
    TournamentScope,
    TournamentStage,
    TournamentStatus,
)
from apps.tournaments.services.rules import freeze_rules

logger = logging.getLogger(__name__)


class StageTransitionError(ValidationError):
    """Raised for a blocked or unacknowledged-warning stage transition. Carries a
    machine code (``detail``) + the structured ``consequences`` so the view maps it
    to 409 with the payload. (Plain ``ValidationError`` is used for an *illegal*
    transition → 400, mirroring ``transition_match``.)"""

    def __init__(self, detail: str, consequences: dict | None = None):
        super().__init__(detail)
        self.detail = detail
        self.consequences = consequences or {}


G = TournamentStage
S = TournamentStatus

# Forward order; forward = one step, backward (reopen) = any earlier stage.
#
# MEMBERS is deliberately NOT here (owner 2026-08-14). Inviting people and
# assigning roles is not a step you finish once and leave behind — an organizer
# adds a scorer the morning of the event — so gating the flow on it made the
# funnel lie about progress. It lives alongside Settings as an always-open
# surface instead. The enum value stays (stage_meta rows and audit history
# reference it) but nothing can transition INTO it any more.
_ORDER = [
    G.SETUP,
    G.ORG_REGISTRATION,
    G.TEAM_REGISTRATION,
    G.FIXTURES,
    G.READY,
]
# Stage two has one identity per scope (spec 2026-08-16 §D2). The funnel keeps
# FIVE steps either way: an intra-school event does not skip institution
# registration, it REPLACES it with house setup. Skipping would have dropped
# `published` — _STAGE_STATUS below is its only producer — so every consumer of
# `status == published` would never fire for a sports day.
_INTRA_ORDER = [
    G.SETUP,
    G.HOUSE_SETUP,
    G.TEAM_REGISTRATION,
    G.FIXTURES,
    G.READY,
]
_ORDER_BY_SCOPE: dict[str, list[str]] = {
    TournamentScope.INTER_SCHOOL: _ORDER,
    TournamentScope.INTRA_SCHOOL: _INTRA_ORDER,
}
#: Participants-first (spec 2026-08-17): the school declares every student and
#: teacher, THEN builds teams by picking from that list. A sixth step, added
#: only for tournaments whose ``roster_mode`` asks for it — every existing row
#: keeps the funnel it started in.
_ROSTER_AT = 2  # straight after stage two, before team registration
#: The stage that occupies slot two, per scope — the ONE place the swap is
#: declared. Everything else derives from the order lists.
STAGE_TWO: dict[str, str] = {
    TournamentScope.INTER_SCHOOL: G.ORG_REGISTRATION,
    TournamentScope.INTRA_SCHOOL: G.HOUSE_SETUP,
}
_RANK = {s: i for i, s in enumerate(_ORDER)}
# A retired stage sits BETWEEN two live ones, so it gets a fractional rank: a
# tournament parked on one (none exist in production, but a long-lived DB or a
# replayed fixture could) still compares, renders, and moves forward instead of
# raising KeyError. MEMBERS used to sit after team registration.
_RETIRED_RANK: dict[str, float] = {
    G.MEMBERS: _RANK[G.TEAM_REGISTRATION] + 0.5,
    # Sat between stage two and team registration while it existed.
    G.ROSTER: _RANK[G.TEAM_REGISTRATION] - 0.5,
}


#: The setup funnel, in order — the ONE list, for the default (inter-school)
#: scope. Import this rather than re-declaring it (the assistant's prompt
#: builder does); the stage payload's ``order`` comes from ``flow_order``, so
#: screen and prompt can never drift.
FLOW_ORDER: list[str] = list(_ORDER)


def flow_order(t: Tournament | None = None) -> list[str]:
    """The setup funnel for a tournament, in order. No argument (or an
    inter-school, name-typed tournament) yields the original five stages
    unchanged."""
    return list(_order_for(t))


def _order_for(t: Tournament | None) -> list[str]:
    # The roster stage is RETIRED from the funnel (owner 2026-08-18): the
    # participants sheet lives inside the team registration form as its own
    # tab, so a standalone stage for it was the same work asked for twice.
    # ``roster_first`` still changes how the TEAM form is generated; it just
    # no longer adds a step. The stage keeps a retired rank below, so any row
    # historically parked on it still ranks forward instead of dead-ending.
    scope = getattr(t, "scope", None) or TournamentScope.INTER_SCHOOL
    return list(_ORDER_BY_SCOPE.get(scope, _ORDER))


def _rank(stage: str, order: list[str] | None = None) -> float:
    """Flow position of ``stage`` within ``order``. Retired stages rank between
    their old neighbours so ``to > from`` still means "forward"; a stage that
    belongs to the OTHER scope's funnel (only reachable if a row's scope was
    changed under it) ranks at its slot in this one, so it is never a dead end."""
    seq = order or _ORDER
    if stage in seq:
        return seq.index(stage)
    if stage in _RETIRED_RANK:
        return _RETIRED_RANK[stage]
    # The other scope's stage two occupies slot one either way.
    if stage in (G.ORG_REGISTRATION, G.HOUSE_SETUP):
        return 1
    return 0

# PRD §5.2 lifecycle order (for forward-only coupling).
_STATUS_ORDER = [
    S.DRAFT,
    S.PUBLISHED,
    S.REGISTRATION_OPEN,
    S.SCHEDULED,
    S.LIVE,
    S.COMPLETED,
    S.ARCHIVED,
]
_STATUS_RANK = {s: i for i, s in enumerate(_STATUS_ORDER)}

# Stage entered -> lifecycle status to apply (forward-only; see _lifecycle_for_stage).
# HOUSE_SETUP carries the SAME lifecycle weight as the institution registration
# it stands in for, so both scopes pass through `published` identically.
_STAGE_STATUS = {
    G.ORG_REGISTRATION: S.PUBLISHED,
    G.HOUSE_SETUP: S.PUBLISHED,
    G.TEAM_REGISTRATION: S.REGISTRATION_OPEN,  # triggers freeze_rules
    G.READY: S.SCHEDULED,  # engages TZ-lock
}


def _allowed(frm: str, order: list[str] | None = None) -> set[str]:
    """Forward one step, or back to any earlier stage. A retired stage's
    fractional rank makes ``ceil`` the next live stage and ``floor`` the
    earlier ones, so it is never a dead end."""
    seq = order or _ORDER
    i = _rank(frm, seq)
    nxt = math.floor(i) + 1  # the next live stage
    fwd = {seq[nxt]} if nxt < len(seq) else set()
    back = set(seq[: math.ceil(i)])  # every live stage strictly before frm
    return fwd | back


# Retired stages get an entry too, so a tournament parked on one is not stuck.
# This is the INTER-school table (the default scope); use
# ``allowed_transitions(t)`` for a tournament, which honours its scope.
ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    s: _allowed(s) for s in [*_ORDER, *_RETIRED_RANK]
}


def allowed_transitions(t: Tournament) -> dict[str, set[str]]:
    """The transition table for one tournament's funnel."""
    seq = _order_for(t)
    return {s: _allowed(s, seq) for s in [*seq, *_RETIRED_RANK]}


def can_transition(frm: str, to: str, t: Tournament | None = None) -> bool:
    table = allowed_transitions(t) if t is not None else ALLOWED_TRANSITIONS
    return to in table.get(frm, set())


def _lifecycle_for_stage(to_stage: str, current_status: str) -> str | None:
    """New status to apply on entering ``to_stage``, or None. Never moves the
    lifecycle backward (so reopening a stage keeps rules frozen / matches scheduled)."""
    target = _STAGE_STATUS.get(to_stage)
    if target is None:
        return None
    if _STATUS_RANK.get(target, 0) <= _STATUS_RANK.get(current_status, 0):
        return None
    return target


# --------------------------------------------------------------------------- counts
def _team_count(t: Tournament) -> int:
    return Team.objects.filter(
        tournament_id=t.id, status=TeamStatus.REGISTERED, deleted_at__isnull=True
    ).count()


def _match_count(t: Tournament) -> int:
    return Match.objects.filter(tournament_id=t.id).count()


def _member_count(t: Tournament) -> int:
    return TournamentMembership.objects.filter(
        tournament_id=t.id, status=TournamentMembershipStatus.ACTIVE
    ).count()


def _institution_count(t: Tournament) -> int:
    """Registered/invited institutions for this tournament (the real entity)."""
    from apps.teams.models import Institution

    return Institution.objects.filter(
        tournament_id=t.id, deleted_at__isnull=True
    ).exclude(status__in=["withdrawn", "rejected"]).count()


def _house_count(t: Tournament) -> int:
    """Houses entered in a within-school event. Always 0 for inter-school —
    there are none, and the funnel never asks."""
    if t.scope != TournamentScope.INTRA_SCHOOL:
        return 0
    from apps.teams.models import TournamentHouse

    return TournamentHouse.objects.filter(
        tournament=t, group__deleted_at__isnull=True
    ).count()


def _participant_count(t: Tournament) -> int:
    """People declared for a participants-first tournament. Always 0 for the
    tournaments that never asked for the stage — nothing writes a roster there."""
    if getattr(t, "roster_mode", None) != RosterMode.ROSTER_FIRST:
        return 0
    from apps.teams.models import RosterMember, RosterMemberStatus

    return RosterMember.objects.filter(
        tournament=t, deleted_at__isnull=True, status=RosterMemberStatus.ACTIVE
    ).count()


def _counts_for(t: Tournament) -> dict[str, int]:
    return {
        "institutions": _institution_count(t),
        "houses": _house_count(t),
        "participants": _participant_count(t),
        "teams": _team_count(t),
        "members": _member_count(t),
        "matches": _match_count(t),
    }


# --------------------------------------------------------------------------- forms
def _stage_forms(t: Tournament, stage: str):
    """Every form that belongs to a setup ``stage``: those explicitly bound via
    ``Form.stage``, PLUS legacy forms with a blank stage whose ``purpose`` maps
    to this stage (created before stage-binding existed, so they'd otherwise slip
    past auto-close). Ordered oldest-first."""
    cond = Q(stage=stage)
    purpose = STAGE_TO_PURPOSE.get(stage)
    if purpose:
        cond |= Q(stage="", purpose=purpose)
    return (
        Form.objects.filter(tournament_id=t.id, deleted_at__isnull=True)
        .filter(cond)
        .order_by("created_at")
    )


def _stage_form(t: Tournament, stage: str) -> Form | None:
    """First form bound to a stage (single-form previews/warnings)."""
    return _stage_forms(t, stage).first()


def _close_stage_form(t: Tournament, stage: str, *, by=None, request=None) -> list[str]:
    """Close EVERY open form bound to the stage being left — not just the first —
    so a stage with multiple registration forms (or a legacy blank-stage one) all
    stop accepting submissions on advance."""
    closed: list[str] = []
    for form in _stage_forms(t, stage):
        if form.status == FormStatus.OPEN:
            close_form(form, user=by, request=request)
            closed.append(str(form.id))
    return closed


def _reopen_stage_form(t: Tournament, stage: str, *, by=None, request=None) -> list[str]:
    """Reopen every closed, non-empty form bound to the stage being reopened."""
    reopened: list[str] = []
    for form in _stage_forms(t, stage):
        if form.status == FormStatus.CLOSED and form.schema.get("sections"):
            publish_form(form, user=by, request=request)
            reopened.append(str(form.id))
    return reopened


def _ensure_participants_form(tournament_id, user_id) -> None:
    """On entering ``roster``, auto-create the DRAFT participants form when none
    exists — the same courtesy the team stage already does, so the admin arrives
    at a ready sheet rather than a blank builder. Post-commit + idempotent."""
    from apps.forms.services.generation import generate_participants_form

    exists = (
        Form.objects.filter(tournament_id=tournament_id, deleted_at__isnull=True)
        .filter(Q(stage=G.ROSTER) | Q(purpose=FormPurpose.PARTICIPANT_REGISTRATION))
        .exists()
    )
    if exists:
        return
    tournament = Tournament.objects.filter(id=tournament_id).first()
    if tournament is None:
        return
    user = None
    if user_id is not None:
        from django.contrib.auth import get_user_model

        user = get_user_model().objects.filter(id=user_id).first()
    generate_participants_form(tournament=tournament, created_by=user)


def _ensure_team_form(tournament_id, user_id) -> None:
    """On entering ``team_registration``, auto-create a DRAFT team-registration
    form (derived from the org form, with a live institution selector) when none
    exists yet — so the admin finds a ready draft to review and publish. Runs
    post-commit; idempotent (a no-op when a team form already exists, so going
    back and re-advancing never duplicates)."""
    from apps.forms.services.generation import generate_team_form_template

    exists = (
        Form.objects.filter(tournament_id=tournament_id, deleted_at__isnull=True)
        .filter(Q(stage=G.TEAM_REGISTRATION) | Q(purpose=FormPurpose.TEAM_REGISTRATION))
        .exists()
    )
    if exists:
        return
    tournament = Tournament.objects.filter(id=tournament_id).first()
    if tournament is None:
        return
    user = None
    if user_id is not None:
        from django.contrib.auth import get_user_model

        user = get_user_model().objects.filter(id=user_id).first()
    generate_team_form_template(tournament=tournament, created_by=user)


# --------------------------------------------------------------------------- previews
def preview_advance(t: Tournament, to_stage: str) -> dict:
    """Read-only dry-run of a FORWARD transition (warn-before-advance, spec §5.2)."""
    frm = t.stage
    blockers: list[str] = []
    warnings: list[dict] = []
    counts = _counts_for(t)

    # Hard gates (each stage gates the next). Team registration now gates
    # FIXTURES directly — members/roles left the flow (owner 2026-08-14), and
    # there is nothing to draw a fixture from without teams.
    if to_stage == G.FIXTURES and counts["teams"] == 0:
        blockers.append("no_teams_registered")
    # A within-school event needs something to compete: one house cannot play
    # itself, and the generated registration form has nothing to bind to.
    if (
        to_stage == G.TEAM_REGISTRATION
        and t.scope == TournamentScope.INTRA_SCHOOL
        and counts["houses"] < 2
    ):
        blockers.append("not_enough_houses")
    if to_stage == G.READY and counts["matches"] == 0:
        blockers.append("no_fixtures_generated")

    # Soft consequences (require ack). Warn for EVERY open form that will close
    # when leaving the current stage — there can be more than one.
    for cur_form in _stage_forms(t, frm):
        if is_open(cur_form):
            warnings.append(
                {"code": "form_will_close", "form_id": str(cur_form.id),
                 "form_title": cur_form.title}
            )
    new_status = _lifecycle_for_stage(to_stage, t.status)
    if new_status is not None:
        warnings.append(
            {"code": "lifecycle_will_change", "from": t.status, "to": new_status}
        )
    if to_stage == G.TEAM_REGISTRATION and new_status == S.REGISTRATION_OPEN:
        warnings.append({"code": "rules_will_freeze"})
    # Entering team registration auto-creates a team-form draft (WS-C) when none
    # exists — surface it so the advance isn't a surprise.
    if to_stage == G.TEAM_REGISTRATION and not _stage_forms(t, G.TEAM_REGISTRATION).exists():
        warnings.append({"code": "team_form_will_be_created"})
    if to_stage == G.ROSTER and not _stage_forms(t, G.ROSTER).exists():
        warnings.append({"code": "participants_form_will_be_created"})
    # Participants-first: teams are built by picking declared people, so opening
    # team registration with an empty roster leaves every dropdown blank. A
    # WARNING, not a blocker — an organizer who enters the roster themselves
    # afterwards is doing nothing wrong.
    if (
        to_stage == G.TEAM_REGISTRATION
        and t.roster_mode == RosterMode.ROSTER_FIRST
        and counts["participants"] == 0
    ):
        warnings.append({"code": "no_participants_declared"})
    # Nudge the admin to pick sports before opening stage two (institution
    # registration, or house setup) — the sports drive the generated forms +
    # fixtures either way.
    if to_stage in (G.ORG_REGISTRATION, G.HOUSE_SETUP) and not (t.sports or []):
        warnings.append({"code": "no_sports_selected"})
    # The READY gate is whole-tournament (>=1 match); per-competition coverage
    # is a warning — list category leaves that have teams but no draw yet
    # (spec 2026-06-10: the old gate let one leaf go live with others empty).
    if to_stage == G.READY:
        from collections import Counter

        leaf_teams = Counter(
            Team.objects.filter(
                tournament=t, status=TeamStatus.REGISTERED,
                deleted_at__isnull=True,
            ).exclude(leaf_key="").values_list("leaf_key", flat=True)
        )
        drawn = set(
            Match.objects.filter(tournament=t, deleted_at__isnull=True)
            .values_list("leaf_key", flat=True)
        )
        missing = sorted(
            lk for lk, n in leaf_teams.items() if n >= 2 and lk not in drawn
        )
        if missing:
            warnings.append(
                {"code": "leaves_without_fixtures", "leaves": missing}
            )

    return {
        "from_stage": frm,
        "to_stage": to_stage,
        "allowed": not blockers,
        "blockers": blockers,
        "warnings": warnings,
        "lifecycle_effect": (
            {"status_from": t.status, "status_to": new_status} if new_status else None
        ),
        "summary_counts": counts,
    }


def preview_reopen(t: Tournament, to_stage: str) -> dict:
    """Read-only dry-run of a REOPEN (backward) transition (spec §5.3)."""
    frm = t.stage
    warnings: list[dict] = []
    matches = _match_count(t)

    target_form = _stage_form(t, to_stage)
    if target_form is not None and target_form.status == FormStatus.CLOSED:
        warnings.append({"code": "form_will_reopen", "form_id": str(target_form.id)})

    if to_stage in (G.ORG_REGISTRATION, G.HOUSE_SETUP, G.TEAM_REGISTRATION) and matches > 0:
        warnings.append(
            {"code": "downstream_artifacts_exist", "kind": "matches", "count": matches,
             "detail": "Generated fixtures exist. Editing teams may invalidate them."}
        )
    if t.rules_frozen_at is not None:
        warnings.append(
            {"code": "rules_frozen",
             "detail": "Rules are frozen; editing them requires an amend reason."}
        )

    return {
        "from_stage": frm,
        "to_stage": to_stage,
        "allowed": True,  # reopen is always allowed (spec: every stage reversible)
        "blockers": [],
        "warnings": warnings,
        "irreversible": False,
    }


def preview_transition(t: Tournament, to_stage: str) -> dict:
    if to_stage not in TournamentStage.values:
        raise ValidationError(f"Unknown stage: {to_stage}")
    seq = _order_for(t)
    if to_stage not in _allowed(t.stage, seq):
        return {
            "from_stage": t.stage, "to_stage": to_stage, "allowed": False,
            "blockers": ["illegal_transition"], "warnings": [],
        }
    is_forward = _rank(to_stage, seq) > _rank(t.stage, seq)
    return preview_advance(t, to_stage) if is_forward else preview_reopen(t, to_stage)


# --------------------------------------------------------------------------- meta
def _stamp_stage_meta(t, frm, to_stage, by, is_forward, consequences) -> None:
    meta = dict(t.stage_meta or {})
    now = timezone.now().isoformat()
    # exit the stage we leave
    leaving = meta.get(frm, {})
    leaving["exited_at"] = now
    if is_forward and consequences.get("warnings"):
        for w in consequences["warnings"]:
            if w.get("code") == "form_will_close":
                leaving["form_closed_on_advance"] = True
                leaving["form_id"] = w.get("form_id")
    meta[frm] = leaving
    # enter the destination
    entry = meta.get(to_stage, {})
    entry["entered_at"] = now
    entry["exited_at"] = None
    entry["entered_by"] = str(by.id) if by is not None else None
    if not is_forward:
        entry["reopened_count"] = int(entry.get("reopened_count", 0)) + 1
    entry["completeness"] = {
        "ok": consequences.get("allowed", True),
        "counts": consequences.get("summary_counts", {}),
    }
    meta[to_stage] = entry
    t.stage_meta = meta


def _flag_regeneration(tid) -> None:
    """on_commit: a reopen that may have invalidated generated fixtures. Stamps
    the staleness signal the FE reads (inputs_hash / last_manual_edit_at, invariant 10)."""
    try:
        Tournament.objects.filter(pk=tid).update(last_manual_edit_at=timezone.now())
    except Exception:  # pragma: no cover - best-effort signal
        logger.exception("Failed to flag regeneration for tournament %s", tid)


def _has_artifacts(consequences: dict) -> bool:
    return any(
        w.get("code") == "downstream_artifacts_exist"
        for w in consequences.get("warnings", [])
    )


# --------------------------------------------------------------------------- transition
def transition_tournament(
    *, tournament, to_stage, by=None, reason="", ack_warnings=False,
    event_id=None, request=None,
) -> Tournament:
    """Move a tournament's setup stage. Guarded + audited (mirrors transition_match).

    Raises ``ValidationError`` for an illegal transition, unmet blockers
    (``{"detail":"stage_blocked", ...}``), or unacknowledged warnings
    (``{"detail":"unacknowledged_warnings", ...}``). Idempotent on ``event_id``.
    """
    if to_stage not in TournamentStage.values:
        raise ValidationError(f"Unknown stage: {to_stage}")

    if event_id is not None:
        prior = AuditEvent.objects.filter(
            idempotency_key=event_id, event_type="tournament_stage_changed"
        ).first()
        if prior is not None:
            return tournament  # replay (invariant 3)

    with transaction.atomic():
        locked = Tournament.objects.select_for_update().get(pk=tournament.pk)
        frm = locked.stage
        seq = _order_for(locked)
        if to_stage not in _allowed(frm, seq):
            raise ValidationError(f"Illegal stage transition: {frm} -> {to_stage}")

        is_forward = _rank(to_stage, seq) > _rank(frm, seq)
        consequences = (
            preview_advance(locked, to_stage)
            if is_forward
            else preview_reopen(locked, to_stage)
        )
        if consequences["blockers"]:
            raise StageTransitionError("stage_blocked", consequences)
        if consequences["warnings"] and not ack_warnings:
            raise StageTransitionError("unacknowledged_warnings", consequences)

        before = {"stage": frm, "status": locked.status}

        # form auto-close / re-open
        if is_forward:
            _close_stage_form(locked, frm, by=by, request=request)
        else:
            _reopen_stage_form(locked, to_stage, by=by, request=request)

        # lifecycle coupling (forward-only) + rule freeze
        new_status = _lifecycle_for_stage(to_stage, locked.status)
        if new_status is not None:
            locked.status = new_status
            if new_status == S.REGISTRATION_OPEN:
                freeze_rules(locked)  # idempotent; wires the previously-dead gate

        _stamp_stage_meta(locked, frm, to_stage, by, is_forward, consequences)
        locked.stage = to_stage
        locked.save(update_fields=["stage", "status", "stage_meta", "updated_at"])

        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="tournament_stage_changed",
            target_type="tournament",
            target_id=locked.id,
            organization_id=locked.organization_id,
            idempotency_key=event_id,
            reason=reason,
            payload_before=before,
            payload_after={
                "stage": to_stage,
                "status": locked.status,
                "direction": "forward" if is_forward else "reopen",
            },
            request=request,
        )

        if (not is_forward) and _has_artifacts(consequences):
            tid = locked.id
            transaction.on_commit(lambda: _flag_regeneration(tid))

        # Entering team registration: auto-create the team-form DRAFT (derived
        # from the org form) for the admin to review & publish. Post-commit +
        # idempotent, so it never blocks the transition or duplicates.
        if is_forward and to_stage == G.TEAM_REGISTRATION:
            tid_team = locked.id
            actor_id = getattr(by, "id", None)
            transaction.on_commit(lambda: _ensure_team_form(tid_team, actor_id))

        # Same for the participants stage (spec 2026-08-17).
        if is_forward and to_stage == G.ROSTER:
            tid_roster = locked.id
            actor_roster = getattr(by, "id", None)
            transaction.on_commit(
                lambda: _ensure_participants_form(tid_roster, actor_roster)
            )

    return locked


# --------------------------------------------------------------------------- payload
def build_stage_payload(t: Tournament, user) -> dict:
    """The stepper payload (spec §6.1). FE renders order/allowed_to from here
    (never hardcodes) — the parity contract against ALLOWED_TRANSITIONS."""
    from apps.tournaments.permissions import (
        can_manage_tournament,
        is_tournament_organizer,
    )

    counts = _counts_for(t)
    seq = _order_for(t)
    cur_rank = _rank(t.stage, seq)
    stages = []
    for i, s in enumerate(seq):
        if i < cur_rank:
            st = "complete"
        elif i == cur_rank:
            st = "current"
        else:
            st = "upcoming"
        form = _stage_form(t, s)
        stages.append(
            {
                "key": s,
                "label": str(TournamentStage(s).label),
                "state": st,
                "entered_at": (t.stage_meta or {}).get(s, {}).get("entered_at"),
                "reopened_count": (t.stage_meta or {}).get(s, {}).get("reopened_count", 0),
                "form": (
                    {"id": str(form.id), "status": form.status, "title": form.title}
                    if form is not None
                    else None
                ),
                "counts": _stage_counts(s, counts),
            }
        )
    from apps.permissions.services.resolver import effective_tournament_modules

    return {
        "stage": t.stage,
        "status": t.status,
        "order": list(seq),
        "allowed_to": sorted(_allowed(t.stage, seq)),
        "can_manage": can_manage_tournament(user, t),
        # Organizer-only destructive rights (delete/deactivate) — the FE's
        # workspace-header Delete button gates on this, not can_manage.
        "can_delete": is_tournament_organizer(user, t),
        # The caller's effective module set (role defaults ± per-member
        # grants) — the FE gates nav/surfaces on this (spec 2026-06-10 P5).
        "modules": sorted(effective_tournament_modules(user, t)),
        "rules_frozen_at": (
            t.rules_frozen_at.isoformat() if t.rules_frozen_at else None
        ),
        "stages": stages,
    }


def _stage_counts(stage: str, counts: dict) -> dict:
    if stage == G.ORG_REGISTRATION:
        return {"institutions": counts["institutions"]}
    if stage == G.HOUSE_SETUP:
        return {"houses": counts["houses"]}
    if stage == G.ROSTER:
        return {"participants": counts["participants"]}
    if stage == G.TEAM_REGISTRATION:
        return {"teams": counts["teams"]}
    if stage == G.FIXTURES:
        return {"matches": counts["matches"]}
    return {}


# ----------------------------------------------------------------- lifecycle
# The PRD §5.2 tail (scheduled → live → completed) used to be dead: nothing
# ever set LIVE or COMPLETED, so the live-delete guard never fired, dashboards
# counted zero forever, and a finished tournament could only be hidden
# (ARCHIVED 404s the public pages). The match state machine now drives it.

def mark_tournament_live(tournament_id) -> bool:
    """First kickoff: scheduled → live (forward-only, idempotent, audited).
    Called post-commit when a match transitions to LIVE."""
    with transaction.atomic():
        t = (
            Tournament.objects.select_for_update()
            .filter(pk=tournament_id, deleted_at__isnull=True)
            .first()
        )
        if t is None or t.status != S.SCHEDULED:
            return False
        t.status = S.LIVE
        t.save(update_fields=["status", "updated_at"])
        emit_audit(
            actor_user=None,
            actor_role=ActorRole.SYSTEM,
            event_type="tournament_lifecycle_changed",
            target_type="tournament",
            target_id=t.id,
            organization_id=t.organization_id,
            reason="first_kickoff",
            payload_before={"status": S.SCHEDULED},
            payload_after={"status": S.LIVE},
        )
    return True


# Match statuses that keep a tournament open: still to play, in play, or
# awaiting an organizer decision (postponed reslot / abandoned replay).
_OPEN_MATCH_STATUSES = ("scheduled", "live", "half_time", "postponed", "abandoned")


def _stages_pending(t: Tournament) -> bool:
    """True when any leaf's multi-stage plan extends beyond its highest
    materialized stage — the next stage's matches don't EXIST yet (deferred
    materialization), so "every match is terminal" must not read as "the
    tournament is over"."""
    from apps.fixtures.services.draw_config import effective_stages

    leafs = (
        Match.objects.filter(tournament_id=t.id, deleted_at__isnull=True)
        .values_list("leaf_key", flat=True)
        .distinct()
    )
    for leaf in leafs:
        stages = effective_stages(t, leaf or "")
        if len(stages) <= 1:
            continue
        top = (
            Match.objects.filter(
                tournament_id=t.id, leaf_key=leaf, deleted_at__isnull=True
            )
            .order_by("-stage_no")
            .values_list("stage_no", flat=True)
            .first()
        )
        if top is None or top < len(stages) - 1:
            return True
    return False


def maybe_complete_tournament(tournament_id) -> bool:
    """live/scheduled → completed once every match is terminal and no
    multi-stage remainder awaits materialization. Called post-commit after a
    match reaches a terminal status (AFTER advancement, so a freshly
    materialized next stage is visible). Idempotent; concurrent last-match
    finishes serialize on the tournament row."""
    with transaction.atomic():
        t = (
            Tournament.objects.select_for_update()
            .filter(pk=tournament_id, deleted_at__isnull=True)
            .first()
        )
        if t is None or t.status not in (S.SCHEDULED, S.LIVE):
            return False
        ms = Match.objects.filter(tournament_id=t.id, deleted_at__isnull=True)
        if not ms.exists():
            return False
        if ms.filter(status__in=_OPEN_MATCH_STATUSES).exists():
            return False
        if _stages_pending(t):
            return False
        before = t.status
        t.status = S.COMPLETED
        t.save(update_fields=["status", "updated_at"])
        emit_audit(
            actor_user=None,
            actor_role=ActorRole.SYSTEM,
            event_type="tournament_lifecycle_changed",
            target_type="tournament",
            target_id=t.id,
            organization_id=t.organization_id,
            reason="all_matches_final",
            payload_before={"status": before},
            payload_after={"status": S.COMPLETED},
        )
    return True


def complete_tournament(
    *, tournament, by, reason="", force=False, event_id=None, request=None
) -> Tournament:
    """Manual "Wrap up tournament". Blocked while a match is in play; with
    matches still outstanding it requires ``force`` + a reason (they stay as
    they are — wrapping up records the event as finished, it cancels nothing).
    COMPLETED stays public read-only; ARCHIVED remains the separate hide."""
    if event_id is not None:
        prior = AuditEvent.objects.filter(
            idempotency_key=event_id, event_type="tournament_lifecycle_changed"
        ).first()
        if prior is not None:
            tournament.refresh_from_db()
            return tournament

    with transaction.atomic():
        t = Tournament.objects.select_for_update().get(pk=tournament.pk)
        if t.status == S.COMPLETED:
            return t
        if _STATUS_RANK.get(t.status, 0) > _STATUS_RANK[S.COMPLETED]:
            raise ValidationError("tournament_archived")
        ms = Match.objects.filter(tournament_id=t.id, deleted_at__isnull=True)
        if ms.filter(status__in=("live", "half_time")).exists():
            raise ValidationError("matches_in_play")
        outstanding = ms.filter(status__in=_OPEN_MATCH_STATUSES).count()
        if outstanding and not force:
            raise StageTransitionError(
                "outstanding_matches",
                {"warnings": [{"code": "outstanding_matches", "count": outstanding}]},
            )
        if outstanding and not (reason or "").strip():
            raise ValidationError("reason_required")
        before = t.status
        t.status = S.COMPLETED
        t.save(update_fields=["status", "updated_at"])
        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="tournament_lifecycle_changed",
            target_type="tournament",
            target_id=t.id,
            organization_id=t.organization_id,
            idempotency_key=event_id,
            reason=reason or "wrap_up",
            payload_before={"status": before},
            payload_after={"status": S.COMPLETED, "outstanding": outstanding},
            request=request,
        )
    return t
