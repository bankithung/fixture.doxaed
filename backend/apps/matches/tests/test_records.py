"""Phase 5 — school-facing records: who played, wins/losses, any time."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.matches.models import Match, MatchStatus
from apps.matches.services.records import (
    institution_record,
    school_history,
    team_record,
)
from apps.teams.models import Institution
from apps.teams.services.registration import register_school
from apps.tournaments.models import Tournament, TournamentStatus
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified():
    u = User.objects.create_user(
        email=f"rc-{uuid.uuid4().hex[:8]}@test.local",
        password="FixtureDemo2026!", is_active=True,
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _cup(admin, name, season="2026", status=TournamentStatus.SCHEDULED):
    t = create_tournament(user=admin, name=name)
    Tournament.objects.filter(pk=t.pk).update(status=status, season=season)
    t.refresh_from_db()
    a, b = register_school(
        tournament=t, school_name="Don Bosco",
        teams=[{"name": "Don Bosco A", "players": [{"full_name": "Asen"}]},
               {"name": "Rivals", "players": []}],
    )
    tz = ZoneInfo(t.time_zone)
    ms = [
        Match.objects.create(
            organization=t.organization, tournament=t, home_team=a, away_team=b,
            match_no=i + 1,
            scheduled_at=datetime(2026, 8, 1, 9, 0, tzinfo=tz) + timedelta(hours=i),
        )
        for i in range(3)
    ]
    return t, a, b, ms


def _score(m, h, a_):
    Match.objects.filter(pk=m.pk).update(
        home_score=h, away_score=a_, status=MatchStatus.COMPLETED
    )


def test_team_record_full_story():
    admin = _verified()
    _t, a, _b, ms = _cup(admin, "Records Cup")
    _score(ms[0], 2, 0)   # W
    _score(ms[1], 1, 1)   # D
    _score(ms[2], 0, 3)   # L

    rec = team_record(a)
    assert (rec["played"], rec["wins"], rec["draws"], rec["losses"]) == (3, 1, 1, 1)
    assert (rec["scored"], rec["conceded"], rec["difference"]) == (3, 4, -1)
    assert rec["form"] == ["W", "D", "L"]
    assert len(rec["matches"]) == 3
    assert rec["matches"][0]["opponent"] == "Rivals"


def test_institution_rollup_and_cross_year_history():
    admin = _verified()
    t1, _a1, _b1, ms1 = _cup(admin, "Cup 2026", season="2026")
    _score(ms1[0], 2, 0)
    # The same school (name variant spacing) in another season's tournament.
    t2 = create_tournament(user=admin, name="Cup 2027")
    Tournament.objects.filter(pk=t2.pk).update(
        status=TournamentStatus.COMPLETED, season="2027"
    )
    t2.refresh_from_db()
    register_school(
        tournament=t2, school_name="Don  Bosco",
        teams=[{"name": "DB United", "players": []}],
    )

    inst1 = Institution.objects.get(tournament=t1, name="Don Bosco")
    roll = institution_record(inst1)
    assert roll["totals"]["wins"] == 1
    assert {r["team_name"] for r in roll["teams"]} == {"Don Bosco A", "Rivals"}

    history = school_history("don bosco")
    seasons = {h["season"] for h in history}
    assert seasons == {"2026", "2027"}  # normalized name unifies the years


def test_public_endpoints_expose_record_without_auth():
    admin = _verified()
    t, a, _b, ms = _cup(admin, "Public Cup")
    _score(ms[0], 5, 1)
    inst = Institution.objects.get(tournament=t, name="Don Bosco")

    c = APIClient()  # anonymous
    r = c.get(f"/api/public/tournaments/{t.slug}/{t.id}/teams/{a.id}/")
    assert r.status_code == 200
    assert r.data["wins"] == 1
    assert r.data["roster"][0]["name"] == "Asen"

    r2 = c.get(
        f"/api/public/tournaments/{t.slug}/{t.id}/institutions/{inst.id}/record/"
    )
    assert r2.status_code == 200
    assert r2.data["totals"]["played"] >= 1
    assert r2.data["history"]  # season-grouped

    # Draft tournaments stay invisible.
    Tournament.objects.filter(pk=t.pk).update(status=TournamentStatus.DRAFT)
    r3 = c.get(f"/api/public/tournaments/{t.slug}/{t.id}/teams/{a.id}/")
    assert r3.status_code == 404
