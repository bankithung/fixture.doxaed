"""P1.a — the SportDefinition registry + the state-machine traits it drives.

Football stays byte-identical (sport="" maps to the football definition);
set sports gain the two fixes the architecture called out: HALF_TIME is
API-unreachable, and a walkover awards a LEGAL sets tally (2-0 in a
best-of-3, not football's 3-0) with set_scores left empty so stats/badges
keep skipping walkovers.
"""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.utils import timezone

from apps.matches.models import Match, MatchStatus
from apps.matches.services.set_scoring import SPORT_PROFILES
from apps.matches.services.sport_defs import (
    TARGET,
    TIMED,
    get_definition,
)
from apps.matches.services.state import transition_match
from apps.teams.models import Team
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def test_registry_resolution_and_profile_derivation():
    assert get_definition("").code == "football"          # historic default
    assert get_definition(None).code == "football"
    assert get_definition("kabaddi").code == "football"   # unknown -> default (P2 gates this)
    assert get_definition("sepak-takraw").code == "sepak_takraw"  # normalized
    assert get_definition("football").period_model == TIMED
    assert get_definition("table_tennis").period_model == TARGET
    # ITTF deuce is uncapped — the cap MUST stay None (Law 2.11.1).
    assert get_definition("table_tennis").scoring["cap"] is None
    # SPORT_PROFILES keeps its historic shape, derived from the registry.
    assert set(SPORT_PROFILES) == {
        "football", "volleyball", "table_tennis", "sepak_takraw", "badminton"
    }
    assert SPORT_PROFILES["football"]["scoring"] == {"type": "goals"}
    assert SPORT_PROFILES["sepak_takraw"]["scoring"]["deciding"] == {
        "points": 15, "win_by": 2, "cap": 17
    }


def _match(sport=""):
    u = User.objects.create_user(
        email=f"defs-{sport or 'fb'}@test.local",
        password="FixtureDemo2026!", is_active=True,
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    t = create_tournament(user=u, name=f"Defs {sport or 'fb'} Cup")
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
    )
    a, b = list(Team.objects.filter(tournament=t).order_by("name"))
    return u, Match.objects.create(
        organization=t.organization, tournament=t, sport=sport,
        home_team=a, away_team=b,
    )


def test_half_time_is_unreachable_for_set_sports():
    admin, m = _match("table_tennis")
    transition_match(match=m, to_status=MatchStatus.LIVE, by=admin)
    with pytest.raises(ValidationError, match="no_half_time_for_set_sport"):
        transition_match(match=m, to_status=MatchStatus.HALF_TIME, by=admin)
    # Football keeps its half time.
    admin2, fb = _match("")
    transition_match(match=fb, to_status=MatchStatus.LIVE, by=admin2)
    transition_match(match=fb, to_status=MatchStatus.HALF_TIME, by=admin2)
    fb.refresh_from_db()
    assert fb.current_period == "half_time"


def test_opening_period_is_a_sport_trait():
    admin, tt = _match("table_tennis")
    transition_match(match=tt, to_status=MatchStatus.LIVE, by=admin)
    tt.refresh_from_db()
    assert tt.current_period == "game_1"

    admin2, st = _match("sepak_takraw")
    transition_match(match=st, to_status=MatchStatus.LIVE, by=admin2)
    st.refresh_from_db()
    assert st.current_period == "set_1"

    admin3, fb = _match("")
    transition_match(match=fb, to_status=MatchStatus.LIVE, by=admin3)
    fb.refresh_from_db()
    assert fb.current_period == "first_half"


def test_walkover_awards_legal_sets_tally():
    admin, st = _match("sepak_takraw")
    transition_match(
        match=st, to_status=MatchStatus.WALKOVER, by=admin,
        winner_team_id=st.away_team_id,
    )
    st.refresh_from_db()
    # Best-of-3: winner gets 2 sets, never football's 3; nothing was played.
    assert (st.home_score, st.away_score) == (0, 2)
    assert st.set_scores == []
    assert st.winner_id == st.away_team_id

    admin2, fb = _match("")
    transition_match(
        match=fb, to_status=MatchStatus.WALKOVER, by=admin2,
        winner_team_id=fb.home_team_id,
    )
    fb.refresh_from_db()
    assert (fb.home_score, fb.away_score) == (3, 0)  # football convention kept
