"""P5 — team ties: rubbers derive the tie; dead rubbers die; stop_at_wins
completes."""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.matches.models import Match, MatchStatus
from apps.matches.services.set_scoring import record_set_result
from apps.matches.services.ties import create_tie
from apps.teams.models import Team
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db

TT = {"type": "sets", "points": 11, "win_by": 2, "cap": None, "best_of": 5}


def _setup():
    u = User.objects.create_user(
        email="ties@test.local", password="FixtureDemo2026!", is_active=True
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    t = create_tournament(user=u, name="Team Tie Cup")
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
    )
    a, b = list(Team.objects.filter(tournament=t).order_by("name"))
    return u, t, a, b


def test_olympic_tie_completes_at_three_and_kills_dead_rubbers(
    django_capture_on_commit_callbacks,
):
    admin, t, a, b = _setup()
    tie = create_tie(
        tournament=t, home_team=a, away_team=b, sport="table_tennis",
        format_key="olympic_tt", by=admin,
    )
    rubbers = list(
        Match.objects.filter(tie=tie).order_by("rubber_no")
    )
    assert len(rubbers) == 5
    assert rubbers[2].rubber_kind == "doubles"

    win = [[11, 5], [11, 6], [11, 7]]  # 3-0 in a best-of-5 rubber
    for r in rubbers[:3]:
        with django_capture_on_commit_callbacks(execute=True):
            record_set_result(
                match=r, set_scores=win, rules=TT, by=admin,
                event_id=uuid.uuid4(),
            )

    tie.refresh_from_db()
    assert (tie.home_rubbers_won, tie.away_rubbers_won) == (3, 0)
    assert tie.status == "completed"
    assert tie.winner_id == a.id
    # Rubbers 4 + 5 are DEAD: cancelled, never scored.
    for r in rubbers[3:]:
        r.refresh_from_db()
        assert r.status == MatchStatus.CANCELLED


def test_tie_tracks_a_split_series():
    admin, t, a, b = _setup()
    tie = create_tie(
        tournament=t, home_team=a, away_team=b, sport="sepak_takraw",
        format_key="sepak_team_regu", by=admin,
    )
    r1, r2, r3 = list(Match.objects.filter(tie=tie).order_by("rubber_no"))
    SEPAK = {"type": "sets", "points": 15, "win_by": 2, "cap": 17,
             "best_of": 3}
    from apps.matches.services.ties import recompute_tie

    record_set_result(match=r1, set_scores=[[15, 8], [15, 9]], rules=SEPAK,
                      by=admin, event_id=uuid.uuid4())
    record_set_result(match=r2, set_scores=[[9, 15], [10, 15]], rules=SEPAK,
                      by=admin, event_id=uuid.uuid4())
    recompute_tie(tie.id)
    tie.refresh_from_db()
    assert (tie.home_rubbers_won, tie.away_rubbers_won) == (1, 1)
    assert tie.status == "live"
    assert tie.winner_id is None

    record_set_result(match=r3, set_scores=[[15, 11], [15, 12]], rules=SEPAK,
                      by=admin, event_id=uuid.uuid4())
    recompute_tie(tie.id)
    tie.refresh_from_db()
    assert tie.winner_id == a.id and tie.status == "completed"
