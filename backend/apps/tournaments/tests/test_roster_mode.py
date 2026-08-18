"""Choosing how players are entered (spec 2026-08-17).

A funnel choice, not a rule: it decides whether the setup flow has a
participants step at all. So it is offered at creation AND stays switchable
afterwards — including on a tournament that already has teams, which is exactly
who wants to adopt it (owner 2026-08-18, a clone of last year's event). The
switch MIGRATES: every registered player becomes a declared participant and the
generated team form is rebuilt to pick instead of type.
"""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.teams.models import Institution, InstitutionStatus, Team, TeamStatus
from apps.tournaments.models import RosterMode, TournamentStage
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.state import flow_order

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _client(user):
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def test_created_without_asking_keeps_the_original_funnel():
    """No hard-coded change of behaviour: an existing caller gets exactly the
    five stages it always had."""
    admin = _verified("a@test.local")
    r = _client(admin).post(
        "/api/tournaments/", {"name": "Plain Cup"}, format="json",
    )
    assert r.status_code == 201, r.data
    assert r.data["roster_mode"] == RosterMode.INLINE
    from apps.tournaments.models import Tournament

    t = Tournament.objects.get(id=r.data["id"])
    assert "roster" not in flow_order(t)


def test_asking_for_participants_first_adds_no_stage():
    admin = _verified("a@test.local")
    r = _client(admin).post(
        "/api/tournaments/",
        {"name": "Roster Cup", "roster_mode": "roster_first"},
        format="json",
    )
    assert r.status_code == 201, r.data
    from apps.tournaments.models import Tournament

    t = Tournament.objects.get(id=r.data["id"])
    # The stage is retired (owner 2026-08-18): the sheet is a tab inside the
    # team form, so the mode changes the FORM, never the funnel's length.
    assert "roster" not in flow_order(t)


def test_an_unknown_mode_is_refused():
    admin = _verified("a@test.local")
    r = _client(admin).post(
        "/api/tournaments/", {"name": "Cup", "roster_mode": "telepathy"},
        format="json",
    )
    assert r.status_code == 400


def test_it_can_be_switched_on_afterwards():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    r = _client(admin).patch(
        f"/api/tournaments/{t.id}/", {"roster_mode": "roster_first"},
        format="json",
    )
    assert r.status_code == 200, r.data
    t.refresh_from_db()
    assert t.roster_mode == RosterMode.ROSTER_FIRST
    assert "roster" not in flow_order(t)  # the mode never adds a stage

    # …and back off again while nothing depends on it.
    back = _client(admin).patch(
        f"/api/tournaments/{t.id}/", {"roster_mode": "inline"}, format="json",
    )
    assert back.status_code == 200
    t.refresh_from_db()
    assert "roster" not in flow_order(t)


def test_switching_on_MIGRATES_a_tournament_that_already_has_teams():
    """Owner 2026-08-18: a clone of last year's event is exactly who wants to
    adopt this. Refusing the switch left them with no way in at all, so it
    carries the existing squads across instead."""
    from apps.forms.constants import FormPurpose
    from apps.forms.models import Form
    from apps.forms.services.generation import generate_team_form_template
    from apps.teams.models import Person, Player, RosterMember

    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Clone")
    t.sports = [{
        "key": "sepak_takraw", "name": "Sepak Takraw",
        "categories": [{"key": "u14", "name": "U14",
                        "children": [{"key": "boys", "name": "Boys"}]}],
    }]
    t.save(update_fields=["sports"])
    inst = Institution.objects.create(
        organization=t.organization, tournament=t, slug="grace",
        name="Grace School", status=InstitutionStatus.REGISTERED,
    )
    team = Team.objects.create(
        organization=t.organization, tournament=t, institution=inst,
        slug="grace-a", name="Grace A", leaf_key="sepak_takraw.u14.boys",
        sport="sepak_takraw", status=TeamStatus.REGISTERED,
    )
    for nm in ("Imli Jamir", "Toshi Ao"):
        Player.objects.create(
            organization=t.organization, tournament=t, team=team,
            person=Person.objects.create(full_name=nm),
        )
    # A generated team form, as the funnel would have left it.
    form = generate_team_form_template(tournament=t)
    assert "player_member" not in (form.settings or {})["bindings"]["category_groups"][0]

    r = _client(admin).patch(
        f"/api/tournaments/{t.id}/", {"roster_mode": "roster_first"},
        format="json",
    )
    assert r.status_code == 200, r.data
    t.refresh_from_db()
    assert t.roster_mode == RosterMode.ROSTER_FIRST

    # Every already-registered player is now a declared participant, so the
    # team form's dropdowns are not empty.
    declared = RosterMember.objects.filter(tournament=t, deleted_at__isnull=True)
    assert {m.person.full_name for m in declared} == {"Imli Jamir", "Toshi Ao"}
    assert all(m.institution_id == inst.id for m in declared)
    assert r.data["roster_switch"]["seeded"] == 2

    # …and the team form now PICKS instead of asking for typed names.
    form.refresh_from_db()
    cg = (form.settings or {})["bindings"]["category_groups"][0]
    assert "player_member" in cg
    keys = str(form.schema)
    assert cg["player_member"] in keys
    assert cg["player_name"] not in keys
    assert r.data["roster_switch"]["team_form_id"] == str(form.id)
    assert Form.objects.filter(
        tournament=t, purpose=FormPurpose.TEAM_REGISTRATION,
        deleted_at__isnull=True,
    ).count() == 1  # rebuilt in place, never duplicated


def test_the_migration_is_idempotent():
    from apps.teams.models import Person, Player, RosterMember

    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Twice")
    inst = Institution.objects.create(
        organization=t.organization, tournament=t, slug="grace",
        name="Grace School", status=InstitutionStatus.REGISTERED,
    )
    team = Team.objects.create(
        organization=t.organization, tournament=t, institution=inst,
        slug="grace-a", name="Grace A", status=TeamStatus.REGISTERED,
    )
    Player.objects.create(
        organization=t.organization, tournament=t, team=team,
        person=Person.objects.create(full_name="Imli Jamir"),
    )
    c = _client(admin)
    c.patch(f"/api/tournaments/{t.id}/", {"roster_mode": "roster_first"}, format="json")
    c.patch(f"/api/tournaments/{t.id}/", {"roster_mode": "inline"}, format="json")
    r = c.patch(f"/api/tournaments/{t.id}/", {"roster_mode": "roster_first"},
                format="json")
    assert r.status_code == 200, r.data
    assert RosterMember.objects.filter(tournament=t, deleted_at__isnull=True).count() == 1
    assert r.data["roster_switch"]["seeded"] == 0  # nothing new to declare


def test_reselecting_the_mode_repairs_a_form_an_older_build_left_typed():
    """Owner 2026-08-18, live tournament: the flag was flipped by a build that
    did not rebuild the form, so the funnel showed Participants while the public
    team form still asked for typed names — and re-selecting the mode reported
    "nothing to do", because the flag was already right. The switch has to
    CONVERGE, not merely transition."""
    from apps.forms.services.generation import generate_team_form_template
    from apps.tournaments.services.roster_mode import team_form_matches_mode

    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Stranded")
    t.sports = [{
        "key": "sepak_takraw", "name": "Sepak Takraw",
        "categories": [{"key": "u14", "name": "U14",
                        "children": [{"key": "boys", "name": "Boys"}]}],
    }]
    t.save(update_fields=["sports"])
    # Exactly the stranded shape: a form generated while inline, then the flag
    # set behind its back (what the older build did).
    form = generate_team_form_template(tournament=t)
    t.roster_mode = RosterMode.ROSTER_FIRST
    t.save(update_fields=["roster_mode"])
    assert team_form_matches_mode(t) is False

    r = _client(admin).patch(
        f"/api/tournaments/{t.id}/", {"roster_mode": "roster_first"},
        format="json",
    )
    assert r.status_code == 200, r.data
    # The flag did not move — the repair is the point.
    assert r.data["roster_switch"]["changed"] is False
    assert r.data["roster_switch"]["repaired"] is True
    assert r.data["roster_switch"]["team_form_id"] == str(form.id)

    form.refresh_from_db()
    cg = (form.settings or {})["bindings"]["category_groups"][0]
    assert "player_member" in cg
    assert cg["player_name"] not in str(form.schema)
    t.refresh_from_db()
    assert team_form_matches_mode(t) is True


def test_a_matching_form_is_left_alone_when_the_mode_is_reselected():
    """The other half of converging: regenerating a form that is ALREADY right
    would drop the rosters inside existing responses, so it must not happen."""
    from apps.forms.services.generation import generate_team_form_template
    from apps.tournaments.services.roster_mode import team_form_matches_mode

    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Fine", roster_mode="roster_first")
    t.sports = [{
        "key": "sepak_takraw", "name": "Sepak Takraw",
        "categories": [{"key": "u14", "name": "U14",
                        "children": [{"key": "boys", "name": "Boys"}]}],
    }]
    t.save(update_fields=["sports"])
    form = generate_team_form_template(tournament=t)
    assert team_form_matches_mode(t) is True
    before = form.updated_at

    r = _client(admin).patch(
        f"/api/tournaments/{t.id}/", {"roster_mode": "roster_first"},
        format="json",
    )
    assert r.status_code == 200, r.data
    assert r.data["roster_switch"]["repaired"] is False
    assert r.data["roster_switch"]["team_form_id"] is None
    form.refresh_from_db()
    assert form.updated_at == before  # untouched


def test_a_hand_built_team_form_is_never_overwritten():
    """The organizer's own work is theirs. Flagged, not rewritten."""
    from apps.forms.constants import FormPurpose
    from apps.forms.services.forms import create_form

    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Handmade")
    hand = create_form(
        tournament=t, title="Our own team form",
        purpose=FormPurpose.TEAM_REGISTRATION, stage="team_registration",
        schema={"version": 1, "sections": [{"key": "s", "title": "S", "fields": [
            {"key": "who", "type": "short_text", "label": "Who"},
        ]}]},
    )
    r = _client(admin).patch(
        f"/api/tournaments/{t.id}/", {"roster_mode": "roster_first"}, format="json",
    )
    assert r.status_code == 200, r.data
    assert r.data["roster_switch"]["team_form_kept"] is True
    assert r.data["roster_switch"]["team_form_id"] is None
    hand.refresh_from_db()
    assert hand.schema["sections"][0]["fields"][0]["key"] == "who"


def test_it_locks_while_standing_on_the_stage_it_would_remove():
    admin = _verified("a@test.local")
    t = create_tournament(
        user=admin, name="Cup", roster_mode=RosterMode.ROSTER_FIRST,
    )
    t.stage = TournamentStage.ROSTER
    t.save(update_fields=["stage"])
    r = _client(admin).patch(
        f"/api/tournaments/{t.id}/", {"roster_mode": "inline"}, format="json",
    )
    assert r.status_code == 400
    assert r.data["detail"] == "leave_the_participants_stage_first"


def test_a_stranger_cannot_change_it():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    r = _client(_verified("b@test.local")).patch(
        f"/api/tournaments/{t.id}/", {"roster_mode": "roster_first"},
        format="json",
    )
    assert r.status_code == 404  # no existence leak (invariant 2)
    t.refresh_from_db()
    assert t.roster_mode == RosterMode.INLINE
