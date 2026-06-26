"""All-competitions combined flow: ONE master dry-run across every sport +
category, scheduled together (so shared courts + clashes coordinate globally),
and a publish-all that commits every competition's draw + schedule atomically.
"""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.fixtures.models import Venue
from apps.fixtures.services.preview import preview_all_fixtures
from apps.matches.models import Match
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()
pytestmark = pytest.mark.django_db

SCHEDULE = {
    "date_start": "2026-08-01", "date_end": "2026-08-07",
    "daily_start": "09:00", "daily_end": "18:00", "slot_minutes": 60,
    "rest_minutes": 0, "max_per_team_per_day": 6,
}


def _verified(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _client(user):
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _tournament(admin):
    t = create_tournament(user=admin, name="Multi Cup")
    t.sports = normalize_sports([
        {"name": "Football", "nodes": [{"name": "U15"}]},
        {"name": "Table Tennis", "nodes": [{"name": "U15"}]},
    ])
    t.save(update_fields=["sports"])
    return t


def _register(t, n, leaf, sport, school):
    return register_school(
        tournament=t, school_name=school,
        teams=[{"name": f"{school} T{i}", "leaf_key": leaf, "sport": sport,
                "players": []} for i in range(n)],
    )


def _venues(t):
    for name, sport in [("Field", "football"), ("Hall", "table_tennis")]:
        Venue.objects.create(
            organization=t.organization, name=name, count=2, sports=[sport],
        )


def _seed(t):
    _register(t, 4, "football.u15", "football", "S1")
    _register(t, 4, "table_tennis.u15", "table_tennis", "S2")
    _venues(t)


def test_preview_all_spans_every_competition_scheduled_together():
    admin = _verified("a@test.local")
    t = _tournament(admin)
    _seed(t)
    out = preview_all_fixtures(tournament=t, schedule=SCHEDULE, include_schedule=True)

    assert out["competitions"] == 2
    leaves = {m["leaf_key"] for m in out["matches"]}
    assert leaves == {"football.u15", "table_tennis.u15"}
    # every match placed, each sport bound to its own venue, NOTHING persisted
    assert all(m["scheduled_at"] for m in out["matches"])
    by_sport: dict[str, set[str]] = {}
    for m in out["matches"]:
        by_sport.setdefault(m["leaf_key"].split(".")[0], set()).add(
            (m["venue"] or "").split(" · ")[0])
    assert by_sport["football"] == {"Field"}
    assert by_sport["table_tennis"] == {"Hall"}
    assert Match.objects.count() == 0


def test_preview_all_refs_are_globally_unique_across_leaves():
    # Each competition's plans index from 0; without re-basing, p{ref+1} ids
    # collide across leaves and matches overwrite each other in scheduling.
    admin = _verified("a@test.local")
    t = _tournament(admin)
    _seed(t)
    out = preview_all_fixtures(tournament=t, schedule=SCHEDULE)
    refs = [m["ref"] for m in out["matches"]]
    assert len(refs) == len(set(refs))


def test_preview_all_skips_competitions_with_too_few_teams():
    admin = _verified("a@test.local")
    t = _tournament(admin)
    _venues(t)
    _register(t, 4, "football.u15", "football", "S1")
    _register(t, 1, "table_tennis.u15", "table_tennis", "S2")  # 1 team → no draw
    out = preview_all_fixtures(tournament=t, schedule=SCHEDULE)
    assert {m["leaf_key"] for m in out["matches"]} == {"football.u15"}


def test_publish_all_commits_every_competition_and_is_idempotent():
    admin = _verified("a@test.local")
    t = _tournament(admin)
    _seed(t)
    c = _client(admin)
    url = f"/api/tournaments/{t.id}/fixtures/publish-all/"

    r = c.post(url, {"schedule": SCHEDULE}, format="json")
    assert r.status_code == 201, r.content
    body = r.json()
    assert body["competitions"] == 2
    assert body["scheduled"] > 0
    for leaf in ("football.u15", "table_tennis.u15"):
        assert Match.objects.filter(tournament=t, leaf_key=leaf).exists()
    assert all(m.scheduled_at is not None for m in Match.objects.filter(tournament=t))

    # idempotent — the draws are kept, no duplicate matches on a second run
    n = Match.objects.filter(tournament=t).count()
    r2 = c.post(url, {"schedule": SCHEDULE}, format="json")
    assert r2.status_code == 201
    assert Match.objects.filter(tournament=t).count() == n


def test_combined_endpoints_require_a_manager():
    admin = _verified("owner@test.local")
    t = _tournament(admin)
    _seed(t)
    stranger = _verified("stranger@test.local")
    sc = _client(stranger)
    assert sc.post(f"/api/tournaments/{t.id}/fixtures/preview-all/",
                   {"schedule": SCHEDULE}, format="json").status_code == 404
    assert sc.post(f"/api/tournaments/{t.id}/fixtures/publish-all/",
                   {"schedule": SCHEDULE}, format="json").status_code == 404
