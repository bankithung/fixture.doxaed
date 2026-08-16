"""Tournament scope — inter-school vs intra-school (spec 2026-08-16 §D1/§D2).

The first duty of this suite is a NEGATIVE one: prove the existing
between-schools flow is byte-for-byte what it was. Everything else asserts that
the within-school funnel keeps the same five steps, the same lifecycle, and the
same guarantees — with stage two wearing a different hat.
"""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.utils import timezone

from apps.teams.models import Institution, InstitutionStatus, Season, TeamGroupKind
from apps.tournaments.models import TournamentScope
from apps.tournaments.models import TournamentStage as G
from apps.tournaments.models import TournamentStatus as S
from apps.tournaments.services import state as st
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _admin(email="scope@test.local"):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _advance(t, to):
    return st.transition_tournament(tournament=t, to_stage=to, ack_warnings=True)


def _houses(t, *names):
    """A within-school event cannot open team registration with fewer than two
    competitors — see apps/teams/tests/test_houses.py for that gate itself."""
    from apps.teams.services.houses import create_house

    for n in names or ("Blue", "Green"):
        create_house(tournament=t, name=n)


# ------------------------------------------------------------------ inter-school
def test_the_existing_flow_is_untouched():
    """No scope argument = exactly what shipped before: the same funnel, the
    same default, and none of the intra-school provisioning."""
    t = create_tournament(user=_admin(), name="Nagaland Schools Cup")

    assert t.scope == TournamentScope.INTER_SCHOOL
    assert t.group_kind == ""
    assert st.flow_order(t) == [
        G.SETUP, G.ORG_REGISTRATION, G.TEAM_REGISTRATION, G.FIXTURES, G.READY,
    ]
    assert st.flow_order(t) == st.FLOW_ORDER
    # Nothing is provisioned behind the organizer's back.
    assert t.season_ref_id is None
    assert Institution.objects.filter(tournament=t).count() == 0


def test_inter_school_funnel_and_lifecycle_unchanged():
    t = create_tournament(user=_admin("inter@test.local"), name="Inter Cup")
    assert t.stage == G.SETUP and t.status == S.DRAFT

    _advance(t, G.ORG_REGISTRATION)
    t.refresh_from_db()
    assert t.stage == G.ORG_REGISTRATION
    assert t.status == S.PUBLISHED

    _advance(t, G.TEAM_REGISTRATION)
    t.refresh_from_db()
    assert t.status == S.REGISTRATION_OPEN


def test_house_setup_is_not_reachable_in_an_inter_school_event():
    t = create_tournament(user=_admin("nohouse@test.local"), name="Inter Only")
    with pytest.raises(ValidationError):
        _advance(t, G.HOUSE_SETUP)


# ------------------------------------------------------------------ intra-school
def test_intra_school_replaces_institution_registration_with_house_setup():
    t = create_tournament(
        user=_admin("intra@test.local"), name="Annual Sports Day",
        scope=TournamentScope.INTRA_SCHOOL,
    )

    assert t.scope == TournamentScope.INTRA_SCHOOL
    assert st.flow_order(t) == [
        G.SETUP, G.HOUSE_SETUP, G.TEAM_REGISTRATION, G.FIXTURES, G.READY,
    ]
    # The funnel is still FIVE steps — house setup replaces a stage, it does
    # not remove one.
    assert len(st.flow_order(t)) == len(st.FLOW_ORDER)
    assert G.ORG_REGISTRATION not in st.flow_order(t)


def test_intra_school_provisions_its_season_and_its_one_host_school():
    """A within-school event cannot start without the season its houses hang
    off, nor without the one institution every team's PROTECT FK resolves to."""
    org_user = _admin("provision@test.local")
    t = create_tournament(
        user=org_user, name="House Meet", scope=TournamentScope.INTRA_SCHOOL,
    )

    assert t.season_ref_id is not None
    assert Season.objects.filter(organization=t.organization).count() == 1

    hosts = Institution.objects.filter(tournament=t)
    assert hosts.count() == 1
    host = hosts.first()
    assert host.status == InstitutionStatus.REGISTERED
    assert host.attributes.get("host") is True


def test_intra_school_reaches_published_exactly_like_the_school_flow():
    """The lifecycle must not diverge: house setup carries the same weight as
    the institution registration it stands in for. Skipping the stage instead
    of replacing it would have silently dropped `published`."""
    t = create_tournament(
        user=_admin("lifecycle@test.local"), name="Sports Day",
        scope=TournamentScope.INTRA_SCHOOL,
    )
    assert t.status == S.DRAFT

    _advance(t, G.HOUSE_SETUP)
    t.refresh_from_db()
    assert t.status == S.PUBLISHED

    _houses(t)
    _advance(t, G.TEAM_REGISTRATION)
    t.refresh_from_db()
    assert t.status == S.REGISTRATION_OPEN
    assert t.rules_frozen_at is not None


def test_intra_school_cannot_skip_a_step_either():
    t = create_tournament(
        user=_admin("skip@test.local"), name="No Skip",
        scope=TournamentScope.INTRA_SCHOOL,
    )
    for target in (G.TEAM_REGISTRATION, G.FIXTURES, G.READY):
        with pytest.raises(ValidationError, match="Illegal stage transition"):
            _advance(t, target)
    # And the stage it replaced is not a back door.
    with pytest.raises(ValidationError):
        _advance(t, G.ORG_REGISTRATION)


def test_intra_school_reopens_backward_like_any_other_funnel():
    t = create_tournament(
        user=_admin("reopen@test.local"), name="Reopen Meet",
        scope=TournamentScope.INTRA_SCHOOL,
    )
    _advance(t, G.HOUSE_SETUP)
    _houses(t)
    _advance(t, G.TEAM_REGISTRATION)
    _advance(t, G.HOUSE_SETUP)
    t.refresh_from_db()
    assert t.stage == G.HOUSE_SETUP
    # Reopening never rolls the lifecycle back.
    assert t.status == S.REGISTRATION_OPEN


# ------------------------------------------------------------------ the grouping noun
def test_the_host_names_the_grouping_and_the_groups():
    """House is only the default. The same machinery runs an inter-class event
    — nothing user-visible hardcodes the word."""
    t = create_tournament(
        user=_admin("kind@test.local"), name="Inter-class Knockout",
        scope=TournamentScope.INTRA_SCHOOL, group_kind=TeamGroupKind.CLASS,
    )
    assert t.group_kind == TeamGroupKind.CLASS

    default = create_tournament(
        user=_admin("kind2@test.local"), name="Sports Day",
        scope=TournamentScope.INTRA_SCHOOL,
    )
    assert default.group_kind == TeamGroupKind.HOUSE


def test_a_nonsense_scope_or_grouping_is_refused():
    user = _admin("bad@test.local")
    with pytest.raises(ValidationError):
        create_tournament(user=user, name="Bad", scope="between_planets")
    with pytest.raises(ValidationError):
        create_tournament(
            user=user, name="Bad2", scope=TournamentScope.INTRA_SCHOOL,
            group_kind="dormitory",
        )


# ------------------------------------------------------------------ payload parity
def test_the_stage_payload_reports_the_funnel_the_tournament_actually_has():
    """`order` is what the browser renders the stepper from, so it must follow
    the scope — the parity contract that stops screen and server drifting."""
    user = _admin("payload@test.local")
    inter = create_tournament(user=user, name="Inter Payload")
    intra = create_tournament(
        user=user, name="Intra Payload", scope=TournamentScope.INTRA_SCHOOL,
    )

    p_inter = st.build_stage_payload(inter, user)
    p_intra = st.build_stage_payload(intra, user)

    assert p_inter["order"] == st.FLOW_ORDER
    assert p_intra["order"] == [
        G.SETUP, G.HOUSE_SETUP, G.TEAM_REGISTRATION, G.FIXTURES, G.READY,
    ]
    assert [s["key"] for s in p_intra["stages"]] == p_intra["order"]
    assert [s["key"] for s in p_inter["stages"]] == p_inter["order"]
    assert p_inter["allowed_to"] == [G.ORG_REGISTRATION]
    assert p_intra["allowed_to"] == [G.HOUSE_SETUP]


# ------------------------------------------------------------------ roster mode
def test_the_funnel_is_unchanged_for_every_existing_tournament():
    """Participants-first is opt-in (spec 2026-08-17). A tournament that does
    not ask for it keeps the exact funnel it started in — which is what stops
    a schema change reshaping events already in flight."""
    from apps.tournaments.models import RosterMode

    t = create_tournament(user=_admin("inline@test.local"), name="Typed Names")
    assert t.roster_mode == RosterMode.INLINE
    assert st.flow_order(t) == st.FLOW_ORDER
    assert G.ROSTER not in st.flow_order(t)


def test_participants_first_inserts_one_step_before_team_registration():
    from apps.tournaments.models import RosterMode

    t = create_tournament(
        user=_admin("roster@test.local"), name="Roster First",
        roster_mode=RosterMode.ROSTER_FIRST,
    )
    assert st.flow_order(t) == [
        G.SETUP, G.ORG_REGISTRATION, G.ROSTER, G.TEAM_REGISTRATION,
        G.FIXTURES, G.READY,
    ]


def test_participants_first_composes_with_the_within_school_funnel():
    from apps.tournaments.models import RosterMode

    t = create_tournament(
        user=_admin("both@test.local"), name="Sports Day",
        scope=TournamentScope.INTRA_SCHOOL, roster_mode=RosterMode.ROSTER_FIRST,
    )
    assert st.flow_order(t) == [
        G.SETUP, G.HOUSE_SETUP, G.ROSTER, G.TEAM_REGISTRATION,
        G.FIXTURES, G.READY,
    ]


def test_the_roster_step_is_walked_one_at_a_time_and_changes_no_lifecycle():
    """It sits between two stages that DO drive the lifecycle, and must not
    move it itself — the rule freeze stays exactly where it is today."""
    from apps.tournaments.models import RosterMode

    t = create_tournament(
        user=_admin("walk@test.local"), name="Walk",
        roster_mode=RosterMode.ROSTER_FIRST,
    )
    _advance(t, G.ORG_REGISTRATION)
    t.refresh_from_db()
    assert t.status == S.PUBLISHED

    # Team registration is no longer one step away.
    with pytest.raises(ValidationError, match="Illegal stage transition"):
        _advance(t, G.TEAM_REGISTRATION)

    _advance(t, G.ROSTER)
    t.refresh_from_db()
    assert t.stage == G.ROSTER
    assert t.status == S.PUBLISHED  # unchanged by the roster step
    assert t.rules_frozen_at is None

    _advance(t, G.TEAM_REGISTRATION)
    t.refresh_from_db()
    assert t.status == S.REGISTRATION_OPEN
    assert t.rules_frozen_at is not None
