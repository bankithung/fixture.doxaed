"""Bulk crew assignment — assign one scorer/official to a whole court /
category / sport in a single call.

Reuses the officials-test harness. Covers scope resolution (court/category/
sport), only-unassigned skipping, the per-role permission gates (scorer needs a
manager; officials need the assign_officials module), cross-org isolation, and
idempotent replay on event_id.
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
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _member(t, email, role):
    u = _verified(email)
    TournamentMembership.objects.create(
        user=u, tournament=t, role=role, status=TournamentMembershipStatus.ACTIVE
    )
    return u


def _tournament_with_matches(admin):
    """A tournament with 6 round-robin matches (4 teams)."""
    t = create_tournament(user=admin, name="Cup")
    register_school(
        tournament=t,
        school_name="S",
        teams=[{"name": n, "players": []} for n in ("A", "B", "C", "D")],
    )
    generate_round_robin(tournament=t, group_size=4)
    return t, list(Match.objects.filter(tournament=t).order_by("match_no"))


def _url(t):
    return f"/api/tournaments/{t.id}/crew/bulk-assign/"


def test_assign_scorer_to_a_whole_court():
    admin = _verified("admin@test.local")
    t, matches = _tournament_with_matches(admin)
    scorer = _member(t, "scorer@test.local", TournamentMembershipRole.MATCH_SCORER)
    # Two matches on T1, the rest elsewhere.
    for m in matches[:2]:
        m.venue = "T1"
        m.save(update_fields=["venue"])
    for m in matches[2:]:
        m.venue = "T2"
        m.save(update_fields=["venue"])

    client = APIClient()
    client.force_authenticate(user=admin)
    r = client.post(
        _url(t),
        {"scope": "court", "key": "T1", "role": "scorer", "user_id": str(scorer.id)},
        format="json",
    )
    assert r.status_code == 200, r.content
    body = r.json()
    assert body["assigned"] == 2
    assert body["total"] == 2
    assert Match.objects.filter(tournament=t, venue="T1", scorer=scorer).count() == 2
    # T2 untouched.
    assert Match.objects.filter(tournament=t, venue="T2", scorer__isnull=False).count() == 0


def test_only_unassigned_skips_staffed_matches():
    admin = _verified("admin@test.local")
    t, matches = _tournament_with_matches(admin)
    scorer = _member(t, "scorer@test.local", TournamentMembershipRole.MATCH_SCORER)
    for m in matches:
        m.venue = "T1"
        m.save(update_fields=["venue"])
    matches[0].scorer = scorer
    matches[0].save(update_fields=["scorer"])

    client = APIClient()
    client.force_authenticate(user=admin)
    r = client.post(
        _url(t),
        {"scope": "court", "key": "T1", "role": "scorer", "user_id": str(scorer.id),
         "only_unassigned": True},
        format="json",
    )
    body = r.json()
    assert body["assigned"] == len(matches) - 1
    assert body["skipped"] == 1


def test_assign_by_category_and_sport():
    admin = _verified("admin@test.local")
    t, matches = _tournament_with_matches(admin)
    scorer = _member(t, "scorer@test.local", TournamentMembershipRole.MATCH_SCORER)
    matches[0].leaf_key = "tt.u14.boys"
    matches[0].sport = "table_tennis"
    matches[0].save(update_fields=["leaf_key", "sport"])
    matches[1].sport = "table_tennis"
    matches[1].save(update_fields=["sport"])

    client = APIClient()
    client.force_authenticate(user=admin)
    # Category scope hits exactly one match.
    r1 = client.post(
        _url(t),
        {"scope": "category", "key": "tt.u14.boys", "role": "scorer",
         "user_id": str(scorer.id)},
        format="json",
    )
    assert r1.json()["assigned"] == 1
    # Sport scope hits both TT matches (idempotent for the already-set one is
    # off because only_unassigned defaults True → the first is skipped).
    r2 = client.post(
        _url(t),
        {"scope": "sport", "key": "table_tennis", "role": "scorer",
         "user_id": str(scorer.id)},
        format="json",
    )
    assert r2.json()["assigned"] == 1
    assert r2.json()["skipped"] == 1


def test_assign_officials_to_a_court():
    admin = _verified("admin@test.local")
    t, matches = _tournament_with_matches(admin)
    ref = _member(t, "ref@test.local", TournamentMembershipRole.REFEREE)
    for m in matches[:3]:
        m.venue = "T1"
        m.save(update_fields=["venue"])

    client = APIClient()
    client.force_authenticate(user=admin)
    r = client.post(
        _url(t),
        {"scope": "court", "key": "T1", "role": "referee", "user_id": str(ref.id)},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert r.json()["assigned"] == 3
    assert MatchOfficial.objects.filter(match__in=matches[:3], user=ref).count() == 3


def test_day_filter():
    from datetime import timedelta

    admin = _verified("admin@test.local")
    t, matches = _tournament_with_matches(admin)
    scorer = _member(t, "scorer@test.local", TournamentMembershipRole.MATCH_SCORER)
    day1 = timezone.now().replace(hour=3, minute=0, second=0, microsecond=0)
    day2 = day1 + timedelta(days=1)
    for m in matches:
        m.venue = "T1"
    matches[0].scheduled_at = day1
    matches[1].scheduled_at = day1
    for m in matches[2:]:
        m.scheduled_at = day2
    for m in matches:
        m.save(update_fields=["venue", "scheduled_at"])

    from zoneinfo import ZoneInfo

    from django.utils import timezone as dj_tz

    local_day1 = dj_tz.localtime(day1, ZoneInfo(t.time_zone)).date().isoformat()

    client = APIClient()
    client.force_authenticate(user=admin)
    r = client.post(
        _url(t),
        {"scope": "court", "key": "T1", "role": "scorer", "user_id": str(scorer.id),
         "day": local_day1},
        format="json",
    )
    assert r.json()["assigned"] == 2


def test_scorer_role_requires_manager():
    admin = _verified("admin@test.local")
    t, matches = _tournament_with_matches(admin)
    scorer = _member(t, "scorer@test.local", TournamentMembershipRole.MATCH_SCORER)
    for m in matches:
        m.venue = "T1"
        m.save(update_fields=["venue"])

    client = APIClient()
    client.force_authenticate(user=scorer)  # a plain scorer, not a manager
    r = client.post(
        _url(t),
        {"scope": "court", "key": "T1", "role": "scorer", "user_id": str(scorer.id)},
        format="json",
    )
    assert r.status_code == 403


def test_official_role_requires_module():
    admin = _verified("admin@test.local")
    t, matches = _tournament_with_matches(admin)
    scorer = _member(t, "scorer@test.local", TournamentMembershipRole.MATCH_SCORER)
    ref = _member(t, "ref@test.local", TournamentMembershipRole.REFEREE)
    for m in matches:
        m.venue = "T1"
        m.save(update_fields=["venue"])

    client = APIClient()
    client.force_authenticate(user=scorer)  # no assign_officials module
    r = client.post(
        _url(t),
        {"scope": "court", "key": "T1", "role": "referee", "user_id": str(ref.id)},
        format="json",
    )
    assert r.status_code == 403


def test_cross_org_isolation():
    admin = _verified("admin@test.local")
    t, _matches = _tournament_with_matches(admin)
    scorer = _member(t, "scorer@test.local", TournamentMembershipRole.MATCH_SCORER)
    outsider = _verified("out@test.local")

    client = APIClient()
    client.force_authenticate(user=outsider)
    r = client.post(
        _url(t),
        {"scope": "court", "key": "T1", "role": "scorer", "user_id": str(scorer.id)},
        format="json",
    )
    assert r.status_code == 404


def test_idempotent_replay():
    admin = _verified("admin@test.local")
    t, matches = _tournament_with_matches(admin)
    scorer = _member(t, "scorer@test.local", TournamentMembershipRole.MATCH_SCORER)
    for m in matches:
        m.venue = "T1"
        m.save(update_fields=["venue"])

    client = APIClient()
    client.force_authenticate(user=admin)
    body = {
        "scope": "court", "key": "T1", "role": "scorer",
        "user_id": str(scorer.id), "event_id": str(uuid.uuid4()),
    }
    r1 = client.post(_url(t), body, format="json")
    r2 = client.post(_url(t), body, format="json")
    assert r1.json()["assigned"] == len(matches)
    # Replay returns the cached result, not a fresh run over now-staffed matches.
    assert r2.json()["assigned"] == len(matches)
    assert r2.json()["skipped"] == 0


def test_invalid_scope_and_role_rejected():
    admin = _verified("admin@test.local")
    t, _matches = _tournament_with_matches(admin)
    scorer = _member(t, "scorer@test.local", TournamentMembershipRole.MATCH_SCORER)
    client = APIClient()
    client.force_authenticate(user=admin)
    r1 = client.post(
        _url(t),
        {"scope": "bogus", "key": "T1", "role": "scorer", "user_id": str(scorer.id)},
        format="json",
    )
    assert r1.status_code == 400
    r2 = client.post(
        _url(t),
        {"scope": "court", "key": "T1", "role": "captain", "user_id": str(scorer.id)},
        format="json",
    )
    assert r2.status_code == 400
