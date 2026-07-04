"""The dashboard command-center feed: live + today across tournaments."""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.matches.models import Match, MatchStatus
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def test_my_today_aggregates_across_tournaments():
    admin = User.objects.create_user(
        email=f"td-{uuid.uuid4().hex[:8]}@test.local",
        password="FixtureDemo2026!", is_active=True,
    )
    admin.email_verified_at = timezone.now()
    admin.save(update_fields=["email_verified_at"])

    now = timezone.now()
    rows = []
    for name in ("Cup A", "Cup B"):
        t = create_tournament(user=admin, name=name)
        a, b = register_school(
            tournament=t, school_name="S",
            teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
        )
        rows.append(Match.objects.create(
            organization=t.organization, tournament=t, home_team=a, away_team=b,
            match_no=1, scheduled_at=now + timedelta(hours=2),
        ))
    Match.objects.filter(pk=rows[0].pk).update(status=MatchStatus.LIVE)

    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.get("/api/me/today/")
    assert r.status_code == 200
    names = {m["tournament_name"] for m in r.data["matches"]}
    assert names == {"Cup A", "Cup B"}
    assert any(m["live"] for m in r.data["matches"])
    # The scheduled match has no scorer: it surfaces in the needs strip.
    assert any(n["kind"] == "no_scorer" for n in r.data["needs"])


def test_leaders_endpoint_scorers_defence_badges():
    """The ops leaderboards: scorers from events, defence/attack from played
    matches, latest badges; empty arrays (not errors) before results."""
    from apps.badges.services.engine import recompute_badges
    from apps.matches.models import MatchEventType
    from apps.matches.services.events import record_match_event

    admin = User.objects.create_user(
        email=f"ld-{uuid.uuid4().hex[:8]}@test.local",
        password="FixtureDemo2026!", is_active=True,
    )
    admin.email_verified_at = timezone.now()
    admin.save(update_fields=["email_verified_at"])
    t = create_tournament(user=admin, name="Leaders Cup")
    a, b = register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": [{"full_name": "Asen"}]},
               {"name": "B", "players": []}],
    )
    m = Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b,
        match_no=1, status=MatchStatus.LIVE,
        scheduled_at=timezone.now(),
    )
    c = APIClient()
    c.force_authenticate(user=admin)

    r = c.get(f"/api/tournaments/{t.id}/leaders/")
    assert r.status_code == 200
    assert r.data["played"] == 0
    fb = next(s for s in r.data["sports"] if s["sport"] == "football")
    scorer_board = next(b for b in fb["boards"] if b["key"] == "top_scorers")
    assert scorer_board["rows"] == []

    pa = a.players.first()
    record_match_event(match=m, event_type=MatchEventType.GOAL, team=a, player=pa, by=admin)
    record_match_event(match=m, event_type=MatchEventType.GOAL, team=a, player=pa, by=admin)
    Match.objects.filter(pk=m.pk).update(status=MatchStatus.COMPLETED)
    recompute_badges(t)

    r = c.get(f"/api/tournaments/{t.id}/leaders/")
    assert r.data["played"] == 1
    fb = next(s for s in r.data["sports"] if s["sport"] == "football")
    boards = {b["key"]: b for b in fb["boards"]}
    assert boards["top_scorers"]["rows"][0]["name"] == "Asen"
    assert boards["top_scorers"]["rows"][0]["value"] == 2
    assert boards["best_defence"]["rows"][0]["team_name"] == "A"  # conceded 0
    assert isinstance(r.data["latest_badges"], list)
