"""Switching a LIVE tournament onto (or off) the participants layer.

Owner 2026-08-18: an organizer cloned last year's event, went looking for the
participants step, and there was none — the clone carried ``inline`` and the
switch was refused outright because teams already existed. Refusing was the
wrong answer. A tournament mid-setup is exactly who wants to adopt this, so the
switch has to carry the existing data across instead of blocking:

* every player already registered becomes a DECLARED participant, so the team
  form's dropdowns are populated from the school's own squad rather than empty;
* the generated team form is rebuilt so it PICKS instead of asking for typed
  names — leaving it stale is the trap the owner just walked into.

Nothing is deleted either way. Switching back to ``inline`` leaves the declared
people in place (harmless, and they carry the identities the teams point at).
"""
from __future__ import annotations

from django.core.exceptions import ValidationError
from django.db import transaction

from apps.audit.models import ActorRole
from apps.audit.services import emit_audit
from apps.tournaments.models import RosterMode, TournamentStage


def _seed_from_teams(tournament, by=None) -> int:
    """Declare every already-registered player. Idempotent: a Person already on
    the roster for that institution is skipped, so re-running adds only what is
    missing."""
    from apps.teams.models import (
        Player,
        RosterMember,
        RosterMemberKind,
        RosterMemberStatus,
    )

    have = set(
        RosterMember.objects.filter(
            tournament=tournament, deleted_at__isnull=True
        ).values_list("institution_id", "person_id")
    )
    rows = (
        Player.objects.filter(
            tournament=tournament,
            deleted_at__isnull=True,
            team__deleted_at__isnull=True,
        )
        .exclude(team__institution__isnull=True)
        .select_related("team", "person")
    )
    new: list[RosterMember] = []
    for p in rows:
        key = (p.team.institution_id, p.person_id)
        if key in have:
            continue
        have.add(key)
        new.append(
            RosterMember(
                organization_id=tournament.organization_id,
                tournament=tournament,
                institution_id=p.team.institution_id,
                group_id=p.team.group_id,
                person=p.person,
                kind=RosterMemberKind.STUDENT,
                status=RosterMemberStatus.ACTIVE,
                created_by=by,
            )
        )
    if new:
        RosterMember.objects.bulk_create(new, batch_size=200)
    return len(new)


def _rebuild_team_form(tournament, by=None, request=None) -> str | None:
    """Rebuild the generated team form for the new mode. Returns its id, or
    None when there is nothing to rebuild.

    Only ever touches a GENERATED form (the same gate ``:regenerate/`` uses):
    a hand-built form is the organizer's own work and is left alone — the
    response says so instead.
    """
    from apps.forms.constants import FormPurpose
    from apps.forms.models import Form
    from apps.forms.services.forms import update_form
    from apps.forms.services.generation import build_team_form_schema
    from apps.tournaments.services.sports import sports_inputs_hash

    form = (
        Form.objects.filter(
            tournament=tournament,
            purpose=FormPurpose.TEAM_REGISTRATION,
            deleted_at__isnull=True,
        )
        .order_by("created_at")
        .first()
    )
    if form is None:
        return None
    settings = form.settings or {}
    if not (settings.get("generated_from_sports") or settings.get("generated_from")
            or settings.get("bindings", {}).get("category_groups")):
        return None  # hand-built: never overwrite it
    org_form = (
        Form.objects.filter(
            tournament=tournament,
            purpose=FormPurpose.ORGANIZATION_REGISTRATION,
            deleted_at__isnull=True,
        )
        .order_by("created_at")
        .first()
    )
    schema, bindings = build_team_form_schema(org_form, tournament=tournament)
    update_form(
        form,
        {
            "schema": schema,
            "settings": {
                **settings,
                "bindings": bindings,
                "inputs_hash": sports_inputs_hash(tournament.sports),
            },
        },
        user=by,
        request=request,
    )
    return str(form.id)


@transaction.atomic
def switch_roster_mode(*, tournament, mode: str, by=None, request=None) -> dict:
    """Move a tournament between ``inline`` and ``roster_first``.

    Returns what actually happened, so the UI can say it rather than leaving
    the organizer to guess: ``{mode, changed, seeded, team_form_id,
    team_form_kept}``.
    """
    if mode not in RosterMode.values:
        raise ValidationError("invalid_roster_mode")
    before = tournament.roster_mode
    if mode == before:
        return {"mode": mode, "changed": False, "seeded": 0,
                "team_form_id": None, "team_form_kept": False}
    # Standing ON the stage that is about to stop existing would park the
    # tournament outside its own funnel. Step back first — the one case we
    # still refuse, because only the organizer can say where they want to be.
    if mode == RosterMode.INLINE and tournament.stage == TournamentStage.ROSTER:
        raise ValidationError("leave_the_participants_stage_first")

    tournament.roster_mode = mode
    tournament.save(update_fields=["roster_mode", "updated_at"])

    seeded = _seed_from_teams(tournament, by=by) if mode == RosterMode.ROSTER_FIRST else 0
    form_id = _rebuild_team_form(tournament, by=by, request=request)
    # A team form that exists but was NOT rebuilt is hand-built: flag it, since
    # its questions no longer match the mode.
    from apps.forms.constants import FormPurpose
    from apps.forms.models import Form

    kept = form_id is None and Form.objects.filter(
        tournament=tournament, purpose=FormPurpose.TEAM_REGISTRATION,
        deleted_at__isnull=True,
    ).exists()

    emit_audit(
        actor_user=by,
        actor_role=ActorRole.ADMIN,
        event_type="tournament_roster_mode_changed",
        target_type="tournament",
        target_id=tournament.id,
        organization_id=tournament.organization_id,
        payload_before={"roster_mode": before},
        payload_after={
            "roster_mode": mode, "participants_seeded": seeded,
            "team_form_rebuilt": form_id,
        },
        request=request,
    )
    return {"mode": mode, "changed": True, "seeded": seeded,
            "team_form_id": form_id, "team_form_kept": kept}
