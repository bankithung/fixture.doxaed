"""TDD — record scores, complete matches, compute standings (idempotent)."""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.matches.models import Match, MatchStatus
from apps.matches.services.scoring import assign_scorer, record_score
from apps.matches.services.standings import compute_standings
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str = "org@test.local") -> "User":
    user = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    user.email_verified_at = timezone.now()
    user.save(update_fields=["email_verified_at"])
    return user


def _two_teams(t):
    teams = register_school(
        tournament=t,
        school_name="Demo School",
        teams=[{"name": "Alpha", "players": []}, {"name": "Beta", "players": []}],
    )
    return teams[0], teams[1]


def test_record_score_completes_match_and_sets_winner():
    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    a, b = _two_teams(t)
    m = Match.objects.create(organization=t.organization, tournament=t, home_team=a, away_team=b)

    record_score(match=m, home_score=2, away_score=1, by=admin)

    m.refresh_from_db()
    assert m.status == MatchStatus.COMPLETED
    assert (m.home_score, m.away_score) == (2, 1)
    assert m.winner_id == a.id


def test_standings_from_completed_matches():
    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    a, b = _two_teams(t)
    m = Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b,
        group_label="Group A",
    )
    record_score(match=m, home_score=3, away_score=1, by=admin)

    rows = compute_standings(t, group_label="Group A")
    assert rows[0]["team_id"] == str(a.id)
    assert rows[0]["Pts"] == 3 and rows[0]["GD"] == 2
    assert rows[1]["team_id"] == str(b.id)
    assert rows[1]["Pts"] == 0


def test_record_score_idempotent_on_event_id():
    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    a, b = _two_teams(t)
    m = Match.objects.create(organization=t.organization, tournament=t, home_team=a, away_team=b)
    eid = uuid.uuid4()

    record_score(match=m, home_score=2, away_score=2, by=admin, event_id=eid)
    record_score(match=m, home_score=5, away_score=0, by=admin, event_id=eid)  # replay ignored

    m.refresh_from_db()
    assert (m.home_score, m.away_score) == (2, 2)


def test_rescore_completed_match_is_blocked():
    from django.core.exceptions import ValidationError

    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    a, b = _two_teams(t)
    m = Match.objects.create(organization=t.organization, tournament=t, home_team=a, away_team=b)
    record_score(match=m, home_score=1, away_score=0, by=admin)

    with pytest.raises(ValidationError):
        record_score(match=m, home_score=9, away_score=9, by=admin)  # different (no) event_id


def test_assign_scorer_requires_tournament_membership():
    from django.core.exceptions import ValidationError

    from apps.tournaments.models import (
        TournamentMembership,
        TournamentMembershipRole,
        TournamentMembershipStatus,
    )

    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    a, b = _two_teams(t)
    m = Match.objects.create(organization=t.organization, tournament=t, home_team=a, away_team=b)
    outsider = _verified("outsider@test.local")

    with pytest.raises(ValidationError):
        assign_scorer(match=m, user=outsider, by=admin)

    TournamentMembership.objects.create(
        user=outsider, tournament=t, role=TournamentMembershipRole.MATCH_SCORER,
        status=TournamentMembershipStatus.ACTIVE,
    )
    assign_scorer(match=m, user=outsider, by=admin)
    m.refresh_from_db()
    assert m.scorer_id == outsider.id


def test_head_to_head_two_way_tie_overrides_name_order():
    """Clean two-way tie where alphabetical order and h2h disagree."""
    admin = _verified("h2h2@test.local")
    t = create_tournament(user=admin, name="H2H Two")
    t.rules = {"tiebreakers": ["points", "head_to_head", "name"]}
    t.save(update_fields=["rules"])
    alpha, zulu = register_school(
        tournament=t, school_name="S",
        teams=[{"name": "Alpha", "players": []}, {"name": "Zulu", "players": []}],
    )

    def play(home, away, hs, as_, label="Group A"):
        m = Match.objects.create(
            organization=t.organization, tournament=t, stage="group",
            group_label=label, home_team=home, away_team=away,
            status=MatchStatus.LIVE,
        )
        record_score(match=m, home_score=hs, away_score=as_, by=admin)

    # Double round-robin between the two: one win each on points... that
    # leaves the mini-table level too. Single decisive meeting instead:
    play(zulu, alpha, 2, 0)  # Zulu wins the head-to-head
    # Both then beat-and-lose against each other? With only one match,
    # Zulu 3pts vs Alpha 0 — no tie. Add a reversed result with a third
    # team to equalize points but keep h2h decisive:
    (mid,) = register_school(
        tournament=t, school_name="S3", teams=[{"name": "Mid", "players": []}],
    )
    play(alpha, mid, 3, 0)   # Alpha 3 pts
    play(mid, zulu, 1, 3)    # Zulu 6 pts... adjust: give Alpha another win
    play(mid, alpha, 0, 1)   # Alpha 6 pts — Alpha & Zulu now both 6? Zulu has 6 too
    rows = compute_standings(t, group_label="Group A")
    by_name = {r["name"]: r for r in rows}
    assert by_name["Alpha"]["Pts"] == by_name["Zulu"]["Pts"] == 6
    # Alphabetical would put Alpha first; head-to-head (Zulu 2-0 Alpha) must win:
    assert [r["name"] for r in rows[:2]] == ["Zulu", "Alpha"]
