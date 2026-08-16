"""Houses as tournament participants (spec 2026-08-16 §D4/§D5).

The competitor in a within-school event. A house is a ``teams.TeamGroup`` —
season-scoped, because houses belong to the school year and a year's events sum
into one house table — and this module is what binds them to a tournament, gives
them a lifecycle they never had (rename, retire), and answers the one question
the rest of the system needs: *which houses may this user register for?*

Everything here is a no-op for an inter-school tournament, which has no houses.
"""
from __future__ import annotations

from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from apps.audit.models import ActorRole
from apps.audit.services import emit_audit
from apps.teams.models import (
    Season,
    TeamGroup,
    TeamGroupKind,
    TeamGroupMembership,
    TeamGroupMembershipRole,
    TournamentHouse,
)
from apps.tournaments.models import (
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
    TournamentScope,
)


def _require_intra(tournament) -> None:
    if tournament.scope != TournamentScope.INTRA_SCHOOL:
        raise ValidationError("houses_require_intra_school_scope")


def season_for(tournament) -> Season:
    """The season a tournament's houses live in. Intra-school tournaments are
    created with one (``services/create.py``); this is the guard for a row that
    predates that or had its season cleared."""
    if tournament.season_ref_id is None:
        raise ValidationError("tournament_has_no_season")
    return tournament.season_ref


def houses_for(tournament):
    """The houses entered in this tournament, in creation order. Retired houses
    drop out; their history in the points ledger does not."""
    return (
        TeamGroup.objects.filter(
            tournament_entries__tournament=tournament, deleted_at__isnull=True
        )
        .order_by("created_at")
        .distinct()
    )


@transaction.atomic
def create_house(
    *, tournament, name: str, colour: str = "", kind: str | None = None,
    by=None, request=None,
) -> TeamGroup:
    """Add a house to a tournament, creating the season-level group when it is
    new and re-entering an existing one when the school already has it.

    The name is whatever the host types — this only requires that it is not
    blank and not already taken in the season."""
    _require_intra(tournament)
    season = season_for(tournament)
    label = (name or "").strip()
    if not label:
        raise ValidationError("house_name_required")
    kind = kind or tournament.group_kind or TeamGroupKind.HOUSE
    if kind not in TeamGroupKind.values:
        raise ValidationError("invalid_group_kind")

    group = TeamGroup.objects.filter(
        season=season, name__iexact=label, deleted_at__isnull=True
    ).first()
    if group is None:
        group = TeamGroup.objects.create(
            organization=tournament.organization,
            season=season,
            kind=kind,
            name=label[:120],
            colour=(colour or "")[:16],
        )
    _, created = TournamentHouse.objects.get_or_create(
        tournament=tournament,
        group=group,
        defaults={"organization": tournament.organization},
    )
    if created:
        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="tournament_house_added",
            target_type="team_group",
            target_id=group.id,
            organization_id=tournament.organization_id,
            payload_after={"name": group.name, "tournament": str(tournament.id)},
            request=request,
        )
    return group


@transaction.atomic
def update_house(
    *, tournament, group: TeamGroup, name: str | None = None,
    colour: str | None = None, by=None, request=None,
) -> TeamGroup:
    """Rename or recolour. `TeamGroup` had no edit path at all before this."""
    _require_intra(tournament)
    before = {"name": group.name, "colour": group.colour}
    fields: list[str] = []
    if name is not None:
        label = name.strip()
        if not label:
            raise ValidationError("house_name_required")
        clash = (
            TeamGroup.objects.filter(
                season_id=group.season_id, name__iexact=label, deleted_at__isnull=True
            )
            .exclude(pk=group.pk)
            .exists()
        )
        if clash:
            raise ValidationError("house_name_taken")
        group.name = label[:120]
        fields.append("name")
    if colour is not None:
        group.colour = colour[:16]
        fields.append("colour")
    if fields:
        group.save(update_fields=fields)
        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="tournament_house_updated",
            target_type="team_group",
            target_id=group.id,
            organization_id=tournament.organization_id,
            payload_before=before,
            payload_after={"name": group.name, "colour": group.colour},
            request=request,
        )
    return group


@transaction.atomic
def remove_house(*, tournament, group: TeamGroup, by=None, request=None) -> None:
    """Withdraw a house from a tournament.

    Withdrawing is not deleting: the season keeps the house (its points are an
    append-only ledger). A house that already has teams in THIS tournament
    cannot be withdrawn — the teams would be orphaned mid-draw.
    """
    _require_intra(tournament)
    from apps.teams.models import Team

    has_teams = Team.objects.filter(
        tournament=tournament, group=group, deleted_at__isnull=True
    ).exists()
    if has_teams:
        raise ValidationError("house_has_teams")
    TournamentHouse.objects.filter(tournament=tournament, group=group).delete()
    emit_audit(
        actor_user=by,
        actor_role=ActorRole.ADMIN,
        event_type="tournament_house_removed",
        target_type="team_group",
        target_id=group.id,
        organization_id=tournament.organization_id,
        payload_before={"name": group.name, "tournament": str(tournament.id)},
        request=request,
    )


@transaction.atomic
def retire_house(*, tournament, group: TeamGroup, by=None, request=None) -> None:
    """Soft-delete the house for the whole season. Its ledger rows survive."""
    _require_intra(tournament)
    group.deleted_at = timezone.now()
    group.save(update_fields=["deleted_at"])
    TournamentHouse.objects.filter(group=group).delete()
    emit_audit(
        actor_user=by,
        actor_role=ActorRole.ADMIN,
        event_type="tournament_house_retired",
        target_type="team_group",
        target_id=group.id,
        organization_id=tournament.organization_id,
        payload_before={"name": group.name},
        request=request,
    )


# ------------------------------------------------------------------- members
@transaction.atomic
def add_house_member(
    *, tournament, group: TeamGroup, user, by=None, request=None,
) -> TeamGroupMembership:
    """Put a person in charge of one house's registrations."""
    _require_intra(tournament)
    existing = TeamGroupMembership.objects.filter(
        group=group, user=user, revoked_at__isnull=True
    ).first()
    if existing is not None:
        return existing
    membership = TeamGroupMembership.objects.create(
        organization=tournament.organization,
        group=group,
        user=user,
        role=TeamGroupMembershipRole.MANAGER,
        assigned_by=by,
    )
    # A house membership alone leaves the captain unable to SEE the event:
    # tournament access resolves through TournamentMembership, so without this
    # every endpoint 404s at them and they can never reach the form they were
    # appointed to fill. The tournament role is the coarse "you're in";
    # `manageable_house_ids` is what narrows them to their own house.
    TournamentMembership.objects.get_or_create(
        user=user,
        tournament=tournament,
        role=TournamentMembershipRole.TEAM_MANAGER,
        status=TournamentMembershipStatus.ACTIVE,
        defaults={"assigned_by": by},
    )
    emit_audit(
        actor_user=by,
        actor_role=ActorRole.ADMIN,
        event_type="house_member_added",
        target_type="team_group",
        target_id=group.id,
        organization_id=tournament.organization_id,
        payload_after={"user": str(user.id), "house": group.name},
        request=request,
    )
    return membership


@transaction.atomic
def remove_house_member(
    *, tournament, membership: TeamGroupMembership, by=None, request=None,
) -> None:
    membership.revoked_at = timezone.now()
    membership.save(update_fields=["revoked_at"])
    emit_audit(
        actor_user=by,
        actor_role=ActorRole.ADMIN,
        event_type="house_member_removed",
        target_type="team_group",
        target_id=membership.group_id,
        organization_id=tournament.organization_id,
        payload_before={"user": str(membership.user_id)},
        request=request,
    )


def manageable_house_ids(tournament, user) -> set[str] | None:
    """Which houses this user may register for.

    ``None`` means "no restriction" — a tournament manager, or an inter-school
    tournament where houses are not the competitor. A set (possibly empty)
    means the user is a house manager and may act for exactly those houses.

    This is the first per-competitor scope in the system: before it, a
    ``team_manager`` could edit any institution's teams.
    """
    from apps.tournaments.permissions import can_manage_tournament

    if tournament.scope != TournamentScope.INTRA_SCHOOL:
        return None
    if user is None or not getattr(user, "is_authenticated", False):
        return set()
    if can_manage_tournament(user, tournament):
        return None
    entered = set(
        TournamentHouse.objects.filter(tournament=tournament).values_list(
            "group_id", flat=True
        )
    )
    mine = set(
        TeamGroupMembership.objects.filter(
            user=user, revoked_at__isnull=True, group__deleted_at__isnull=True
        ).values_list("group_id", flat=True)
    )
    return {str(gid) for gid in (entered & mine)}


def may_register_for(tournament, user, group_id) -> bool:
    """Gate for one house. ``manageable_house_ids`` returning None = allowed."""
    allowed = manageable_house_ids(tournament, user)
    return allowed is None or str(group_id) in allowed
