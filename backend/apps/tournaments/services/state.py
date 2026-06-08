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

from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from apps.audit.models import ActorRole, AuditEvent
from apps.audit.services import emit_audit
from apps.forms.constants import FormStatus
from apps.forms.models import Form
from apps.forms.services.forms import close_form, is_open, publish_form
from apps.matches.models import Match
from apps.teams.models import Team, TeamStatus
from apps.tournaments.models import (
    Tournament,
    TournamentMembership,
    TournamentMembershipStatus,
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
_ORDER = [
    G.SETUP,
    G.ORG_REGISTRATION,
    G.TEAM_REGISTRATION,
    G.MEMBERS,
    G.FIXTURES,
    G.READY,
]
_RANK = {s: i for i, s in enumerate(_ORDER)}

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
_STAGE_STATUS = {
    G.ORG_REGISTRATION: S.PUBLISHED,
    G.TEAM_REGISTRATION: S.REGISTRATION_OPEN,  # triggers freeze_rules
    G.READY: S.SCHEDULED,  # engages TZ-lock
}


def _allowed(frm: str) -> set[str]:
    i = _RANK[frm]
    fwd = {_ORDER[i + 1]} if i + 1 < len(_ORDER) else set()
    back = set(_ORDER[:i])
    return fwd | back


ALLOWED_TRANSITIONS: dict[str, set[str]] = {s: _allowed(s) for s in _ORDER}


def can_transition(frm: str, to: str) -> bool:
    return to in ALLOWED_TRANSITIONS.get(frm, set())


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


def _counts_for(t: Tournament) -> dict[str, int]:
    return {
        "institutions": _institution_count(t),
        "teams": _team_count(t),
        "members": _member_count(t),
        "matches": _match_count(t),
    }


# --------------------------------------------------------------------------- forms
def _stage_form(t: Tournament, stage: str) -> Form | None:
    return (
        Form.objects.filter(tournament_id=t.id, stage=stage, deleted_at__isnull=True)
        .order_by("created_at")
        .first()
    )


def _close_stage_form(t: Tournament, stage: str, *, by=None, request=None) -> str | None:
    form = _stage_form(t, stage)
    if form is not None and form.status == FormStatus.OPEN:
        close_form(form, user=by, request=request)
        return str(form.id)
    return str(form.id) if form is not None else None


def _reopen_stage_form(t: Tournament, stage: str, *, by=None, request=None) -> str | None:
    form = _stage_form(t, stage)
    if form is None:
        return None
    if form.status == FormStatus.CLOSED and form.schema.get("sections"):
        publish_form(form, user=by, request=request)
    return str(form.id)


# --------------------------------------------------------------------------- previews
def preview_advance(t: Tournament, to_stage: str) -> dict:
    """Read-only dry-run of a FORWARD transition (warn-before-advance, spec §5.2)."""
    frm = t.stage
    blockers: list[str] = []
    warnings: list[dict] = []
    counts = _counts_for(t)

    # Hard gates (each stage gates the next).
    if to_stage == G.MEMBERS and counts["teams"] == 0:
        blockers.append("no_teams_registered")
    if to_stage == G.READY and counts["matches"] == 0:
        blockers.append("no_fixtures_generated")

    # Soft consequences (require ack).
    cur_form = _stage_form(t, frm)
    if cur_form is not None and is_open(cur_form):
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

    if to_stage in (G.ORG_REGISTRATION, G.TEAM_REGISTRATION) and matches > 0:
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
    if to_stage not in ALLOWED_TRANSITIONS.get(t.stage, set()):
        return {
            "from_stage": t.stage, "to_stage": to_stage, "allowed": False,
            "blockers": ["illegal_transition"], "warnings": [],
        }
    is_forward = _RANK[to_stage] > _RANK[t.stage]
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
        if to_stage not in ALLOWED_TRANSITIONS.get(frm, set()):
            raise ValidationError(f"Illegal stage transition: {frm} -> {to_stage}")

        is_forward = _RANK[to_stage] > _RANK[frm]
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

    return locked


# --------------------------------------------------------------------------- payload
def build_stage_payload(t: Tournament, user) -> dict:
    """The stepper payload (spec §6.1). FE renders order/allowed_to from here
    (never hardcodes) — the parity contract against ALLOWED_TRANSITIONS."""
    from apps.tournaments.permissions import can_manage_tournament

    counts = _counts_for(t)
    cur_rank = _RANK[t.stage]
    stages = []
    for i, s in enumerate(_ORDER):
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
    return {
        "stage": t.stage,
        "status": t.status,
        "order": list(_ORDER),
        "allowed_to": sorted(ALLOWED_TRANSITIONS.get(t.stage, set())),
        "can_manage": can_manage_tournament(user, t),
        "rules_frozen_at": (
            t.rules_frozen_at.isoformat() if t.rules_frozen_at else None
        ),
        "stages": stages,
    }


def _stage_counts(stage: str, counts: dict) -> dict:
    if stage == G.ORG_REGISTRATION:
        return {"institutions": counts["institutions"]}
    if stage == G.TEAM_REGISTRATION:
        return {"teams": counts["teams"]}
    if stage == G.MEMBERS:
        return {"members": counts["members"]}
    if stage == G.FIXTURES:
        return {"matches": counts["matches"]}
    return {}
