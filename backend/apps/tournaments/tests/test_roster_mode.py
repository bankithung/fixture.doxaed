"""Choosing how players are entered (spec 2026-08-17).

A funnel choice, not a rule: it decides whether the setup flow has a
participants step at all. So it is offered at creation AND remains editable for
as long as the funnel is still ahead of you — which stops once teams exist,
because by then the team form's dropdowns are bound to the declared list and
the people already declared would be stranded.
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


def test_asking_for_participants_first_adds_the_stage():
    admin = _verified("a@test.local")
    r = _client(admin).post(
        "/api/tournaments/",
        {"name": "Roster Cup", "roster_mode": "roster_first"},
        format="json",
    )
    assert r.status_code == 201, r.data
    from apps.tournaments.models import Tournament

    t = Tournament.objects.get(id=r.data["id"])
    order = flow_order(t)
    assert order.index("roster") == 2
    assert order.index("roster") < order.index("team_registration")


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
    assert "roster" in flow_order(t)

    # …and back off again while nothing depends on it.
    back = _client(admin).patch(
        f"/api/tournaments/{t.id}/", {"roster_mode": "inline"}, format="json",
    )
    assert back.status_code == 200
    t.refresh_from_db()
    assert "roster" not in flow_order(t)


def test_it_locks_once_a_team_is_registered():
    admin = _verified("a@test.local")
    t = create_tournament(
        user=admin, name="Cup", roster_mode=RosterMode.ROSTER_FIRST,
    )
    inst = Institution.objects.create(
        organization=t.organization, tournament=t, slug="grace",
        name="Grace School", status=InstitutionStatus.REGISTERED,
    )
    Team.objects.create(
        organization=t.organization, tournament=t, institution=inst,
        slug="grace-a", name="Grace A", status=TeamStatus.REGISTERED,
    )
    r = _client(admin).patch(
        f"/api/tournaments/{t.id}/", {"roster_mode": "inline"}, format="json",
    )
    assert r.status_code == 409
    assert r.data["detail"] == "roster_mode_locked"
    t.refresh_from_db()
    assert t.roster_mode == RosterMode.ROSTER_FIRST


def test_re_sending_the_same_mode_is_not_a_lock():
    """Idempotent: a settings screen that PATCHes everything it shows must not
    trip the guard just for restating what is already true."""
    admin = _verified("a@test.local")
    t = create_tournament(
        user=admin, name="Cup", roster_mode=RosterMode.ROSTER_FIRST,
    )
    inst = Institution.objects.create(
        organization=t.organization, tournament=t, slug="grace",
        name="Grace School", status=InstitutionStatus.REGISTERED,
    )
    Team.objects.create(
        organization=t.organization, tournament=t, institution=inst,
        slug="grace-a", name="Grace A", status=TeamStatus.REGISTERED,
    )
    r = _client(admin).patch(
        f"/api/tournaments/{t.id}/", {"roster_mode": "roster_first"},
        format="json",
    )
    assert r.status_code == 200


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
    assert r.status_code == 409
    assert r.data["detail"] == "roster_mode_locked"


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
