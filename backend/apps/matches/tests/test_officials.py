"""Officials assignment — assign/remove referees & assistants to matches.

Mirrors the scorer-flow tests. Covers the happy path, idempotency, in-place
role reassignment, member-verification, the permission gate, and removal.
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.fixtures.services.generate import generate_round_robin
from apps.matches.models import Match, MatchOfficial
from apps.teams.services.registration import register_school
from apps.tournaments.models import (
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
)
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str):
    u = User.objects.create_user(
        email=email, password="FixtureDemo2026!", is_active=True
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _tournament_with_match(admin):
    t = create_tournament(user=admin, name="Cup")
    register_school(
        tournament=t,
        school_name="S",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
    )
    generate_round_robin(tournament=t, group_size=2)
    return t, Match.objects.filter(tournament=t).first()


def _member(t, email, role):
    u = _verified(email)
    TournamentMembership.objects.create(
        user=u, tournament=t, role=role, status=TournamentMembershipStatus.ACTIVE
    )
    return u


def _url(m):
    return f"/api/matches/{m.id}/officials/"


def test_manager_assigns_official():
    admin = _verified("admin@test.local")
    t, m = _tournament_with_match(admin)
    ref = _member(t, "ref@test.local", TournamentMembershipRole.REFEREE)
    client = APIClient()
    client.force_authenticate(user=admin)

    r = client.post(
        _url(m), {"user_id": str(ref.id), "role": "referee"}, format="json"
    )
    assert r.status_code == 200, r.content
    assert MatchOfficial.objects.filter(match=m, user=ref, role="referee").exists()
    assert any(o["user_id"] == str(ref.id) for o in r.json()["officials"])


def test_assign_is_idempotent_on_event_id():
    admin = _verified("admin@test.local")
    t, m = _tournament_with_match(admin)
    ref = _member(t, "ref@test.local", TournamentMembershipRole.REFEREE)
    client = APIClient()
    client.force_authenticate(user=admin)

    body = {"user_id": str(ref.id), "role": "referee", "event_id": str(uuid.uuid4())}
    client.post(_url(m), body, format="json")
    client.post(_url(m), body, format="json")
    assert MatchOfficial.objects.filter(match=m).count() == 1


def test_reassign_role_updates_in_place():
    admin = _verified("admin@test.local")
    t, m = _tournament_with_match(admin)
    ref = _member(t, "ref@test.local", TournamentMembershipRole.REFEREE)
    client = APIClient()
    client.force_authenticate(user=admin)

    client.post(_url(m), {"user_id": str(ref.id), "role": "referee"}, format="json")
    client.post(_url(m), {"user_id": str(ref.id), "role": "fourth"}, format="json")
    rows = MatchOfficial.objects.filter(match=m, user=ref)
    assert rows.count() == 1
    assert rows.first().role == "fourth"


def test_non_member_cannot_be_assigned():
    admin = _verified("admin@test.local")
    t, m = _tournament_with_match(admin)
    outsider = _verified("out@test.local")  # not a tournament member
    client = APIClient()
    client.force_authenticate(user=admin)

    r = client.post(
        _url(m), {"user_id": str(outsider.id), "role": "referee"}, format="json"
    )
    assert r.status_code == 400


def test_outsider_cannot_assign():
    admin = _verified("admin@test.local")
    t, m = _tournament_with_match(admin)
    ref = _member(t, "ref@test.local", TournamentMembershipRole.REFEREE)
    outsider = _verified("out@test.local")
    client = APIClient()
    client.force_authenticate(user=outsider)

    r = client.post(
        _url(m), {"user_id": str(ref.id), "role": "referee"}, format="json"
    )
    assert r.status_code in (403, 404)


def test_scorer_without_module_cannot_assign():
    admin = _verified("admin@test.local")
    t, m = _tournament_with_match(admin)
    scorer = _member(t, "scorer@test.local", TournamentMembershipRole.MATCH_SCORER)
    ref = _member(t, "ref@test.local", TournamentMembershipRole.REFEREE)
    client = APIClient()
    client.force_authenticate(user=scorer)

    r = client.post(
        _url(m), {"user_id": str(ref.id), "role": "referee"}, format="json"
    )
    assert r.status_code == 403


def test_remove_official():
    admin = _verified("admin@test.local")
    t, m = _tournament_with_match(admin)
    ref = _member(t, "ref@test.local", TournamentMembershipRole.REFEREE)
    client = APIClient()
    client.force_authenticate(user=admin)

    r = client.post(
        _url(m), {"user_id": str(ref.id), "role": "referee"}, format="json"
    )
    oid = r.json()["officials"][0]["id"]
    r2 = client.delete(_url(m), {"official_id": oid}, format="json")
    assert r2.status_code == 200
    assert not MatchOfficial.objects.filter(match=m).exists()


def test_invalid_role_rejected():
    admin = _verified("admin@test.local")
    t, m = _tournament_with_match(admin)
    ref = _member(t, "ref@test.local", TournamentMembershipRole.REFEREE)
    client = APIClient()
    client.force_authenticate(user=admin)

    r = client.post(
        _url(m), {"user_id": str(ref.id), "role": "captain"}, format="json"
    )
    assert r.status_code == 400


@pytest.mark.django_db(transaction=True)
def test_assignment_notifies_the_assignee():
    """Phase 2: crew used to be assigned silently. Both seats notify with a
    console deep link (in-app row; email is best-effort). transaction=True so
    the post-commit notification hook actually fires."""
    from apps.matches.services.scoring import assign_scorer
    from apps.notifications.models import Notification
    from apps.tournaments.models import TournamentMembershipRole

    admin = _verified("notify-admin@test.local")
    t, m = _tournament_with_match(admin)
    member = _member(t, "notify-scorer@test.local", TournamentMembershipRole.MATCH_SCORER)

    assign_scorer(match=m, user=member, by=admin)
    n = Notification.objects.filter(user=member, kind="match_assignment").first()
    assert n is not None
    assert str(m.id) in n.url

    # Clearing the seat is now possible (no notification for a clear).
    assign_scorer(match=m, user=None, by=admin)
    m.refresh_from_db()
    assert m.scorer_id is None
