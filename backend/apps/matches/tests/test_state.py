"""TDD — Match state machine (invariant #6): guarded, audited transitions."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.utils import timezone

from apps.matches.models import Match, MatchStatus
from apps.matches.services.state import can_transition, transition_match
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str = "org@test.local") -> "User":
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _match():
    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    a, b = register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
    )
    return admin, Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b
    )


def test_legal_transitions():
    admin, m = _match()
    transition_match(match=m, to_status=MatchStatus.LIVE, by=admin)
    m.refresh_from_db()
    assert m.status == MatchStatus.LIVE
    assert m.current_period == "first_half"

    transition_match(match=m, to_status=MatchStatus.COMPLETED, by=admin)
    m.refresh_from_db()
    assert m.status == MatchStatus.COMPLETED


def test_illegal_transition_raises():
    admin, m = _match()
    with pytest.raises(ValidationError):
        transition_match(match=m, to_status=MatchStatus.COMPLETED, by=admin)  # scheduled->completed


def test_no_transition_out_of_terminal():
    admin, m = _match()
    transition_match(
        match=m, to_status=MatchStatus.WALKOVER, by=admin,
        winner_team_id=m.home_team_id,
    )  # scheduled->walkover OK
    with pytest.raises(ValidationError):
        transition_match(match=m, to_status=MatchStatus.LIVE, by=admin)  # walkover is terminal


def test_walkover_with_winner_stamps_score_and_resolves_winner():
    """Stress-test #3: a walkover must carry a decisive result so the bracket
    advances — naming the winner stamps the conventional scoreline."""
    admin, m = _match()
    transition_match(
        match=m, to_status=MatchStatus.WALKOVER, by=admin,
        winner_team_id=m.away_team_id,
    )
    m.refresh_from_db()
    assert (m.home_score, m.away_score) == (0, 3)
    assert m.winner_id == m.away_team_id
    assert m.loser_id == m.home_team_id


def test_walkover_without_winner_or_decisive_score_is_rejected():
    admin, m = _match()
    with pytest.raises(ValidationError):
        transition_match(match=m, to_status=MatchStatus.WALKOVER, by=admin)
    m.refresh_from_db()
    assert m.status == MatchStatus.SCHEDULED  # nothing half-applied


def test_walkover_winner_must_be_in_the_match():
    admin, m = _match()
    other_admin = _verified("other@test.local")
    t2 = create_tournament(user=other_admin, name="Other")
    (stranger,) = register_school(
        tournament=t2, school_name="X", teams=[{"name": "Z", "players": []}],
    )
    with pytest.raises(ValidationError):
        transition_match(
            match=m, to_status=MatchStatus.WALKOVER, by=admin,
            winner_team_id=stranger.id,
        )


def test_knockout_draw_cannot_complete_without_shootout():
    """Stress-test #4: a LEVEL knockout match completing used to stall the
    bracket silently; now it refuses loudly (rules.match.penalties default)."""
    admin, m = _match()
    m.stage = "knockout"
    m.home_score, m.away_score = 1, 1
    m.save(update_fields=["stage", "home_score", "away_score"])
    transition_match(match=m, to_status=MatchStatus.LIVE, by=admin)
    with pytest.raises(ValidationError):
        transition_match(match=m, to_status=MatchStatus.COMPLETED, by=admin)
    m.refresh_from_db()
    assert m.status == MatchStatus.LIVE


def test_knockout_draw_completes_once_shootout_recorded():
    admin, m = _match()
    m.stage = "knockout"
    m.home_score, m.away_score = 1, 1
    m.save(update_fields=["stage", "home_score", "away_score"])
    transition_match(match=m, to_status=MatchStatus.LIVE, by=admin)
    m.home_pens, m.away_pens = 4, 3
    m.save(update_fields=["home_pens", "away_pens"])
    transition_match(match=m, to_status=MatchStatus.COMPLETED, by=admin)
    m.refresh_from_db()
    assert m.status == MatchStatus.COMPLETED
    assert m.winner_id == m.home_team_id  # pens decide the level score


def test_group_draw_still_completes_normally():
    admin, m = _match()
    m.stage = "group"
    m.home_score, m.away_score = 2, 2
    m.save(update_fields=["stage", "home_score", "away_score"])
    transition_match(match=m, to_status=MatchStatus.LIVE, by=admin)
    transition_match(match=m, to_status=MatchStatus.COMPLETED, by=admin)
    m.refresh_from_db()
    assert m.status == MatchStatus.COMPLETED
    assert m.winner_id is None  # a league draw is a normal result


def test_can_transition_table():
    assert can_transition(MatchStatus.SCHEDULED, MatchStatus.LIVE)
    assert not can_transition(MatchStatus.SCHEDULED, MatchStatus.COMPLETED)
    assert not can_transition(MatchStatus.COMPLETED, MatchStatus.LIVE)


def test_resume_from_half_time_enters_second_half():
    """C13: the sticky 'half_time' period used to survive the whole second
    half (scoreboard read 'Live · half time')."""
    admin, m = _match()
    transition_match(match=m, to_status=MatchStatus.LIVE, by=admin)
    m.refresh_from_db()
    assert m.current_period == "first_half"
    transition_match(match=m, to_status=MatchStatus.HALF_TIME, by=admin)
    m.refresh_from_db()
    assert m.current_period == "half_time"
    transition_match(match=m, to_status=MatchStatus.LIVE, by=admin)
    m.refresh_from_db()
    assert m.current_period == "second_half"


def test_in_play_interruptions_reachable_and_need_reasons():
    """PRD 5.5: a live match can be walked over, postponed, or cancelled —
    these used to be reachable only from SCHEDULED. Interrupting play always
    carries a reason (audit defensibility)."""
    import pytest as _pytest
    from django.core.exceptions import ValidationError as VE

    admin, m = _match()
    transition_match(match=m, to_status=MatchStatus.LIVE, by=admin)

    with _pytest.raises(VE):
        transition_match(match=m, to_status=MatchStatus.POSTPONED, by=admin)
    transition_match(
        match=m, to_status=MatchStatus.POSTPONED, by=admin, reason="waterlogged"
    )
    m.refresh_from_db()
    assert m.status == MatchStatus.POSTPONED

    # Resume the postponed match and walk it over mid-play (team walked off).
    transition_match(match=m, to_status=MatchStatus.LIVE, by=admin)
    transition_match(
        match=m, to_status=MatchStatus.WALKOVER, by=admin,
        winner_team_id=m.home_team_id, reason="opponents walked off",
    )
    m.refresh_from_db()
    assert m.status == MatchStatus.WALKOVER
    assert m.winner_id == m.home_team_id


def test_quick_result_level_knockout_is_refused():
    """The quick-result path used to complete a level knockout silently,
    stalling the bracket (the guard lived only on transition_match)."""
    import pytest as _pytest
    from django.core.exceptions import ValidationError as VE

    from apps.matches.services.scoring import record_score

    admin, m = _match()
    m.stage = "knockout"
    m.save(update_fields=["stage"])
    with _pytest.raises(VE):
        record_score(match=m, home_score=1, away_score=1, by=admin)
    m.refresh_from_db()
    assert m.status == MatchStatus.SCHEDULED  # nothing committed


def test_extra_time_period_control():
    """P5: a LIVE, LEVEL knockout football match steps into extra time and
    penalties explicitly — gated by rules.match, refused for set sports,
    group games and decided scores."""
    from apps.matches.services.state import set_match_period

    admin, m = _match()
    # Group/no-stage: refused.
    transition_match(match=m, to_status=MatchStatus.LIVE, by=admin)
    with pytest.raises(ValidationError, match="knockout_only"):
        set_match_period(match=m, period="extra_time_first", by=admin)

    # Knockout + ET enabled + level: allowed.
    m.stage = "knockout"
    m.save(update_fields=["stage"])
    t = m.tournament
    t.rules = {"match": {"extra_time": True, "penalties": True}}
    t.save(update_fields=["rules"])
    set_match_period(match=m, period="extra_time_first", by=admin)
    m.refresh_from_db()
    assert m.current_period == "extra_time_first"
    set_match_period(match=m, period="penalties", by=admin)
    m.refresh_from_db()
    assert m.current_period == "penalties"

    # ET disabled: refused.
    t.rules = {"match": {"extra_time": False, "penalties": True}}
    t.save(update_fields=["rules"])
    m.tournament.refresh_from_db()
    with pytest.raises(ValidationError, match="extra_time_disabled"):
        set_match_period(match=m, period="extra_time_second", by=admin)

    # Decided score: no extra time.
    t.rules = {"match": {"extra_time": True, "penalties": True}}
    t.save(update_fields=["rules"])
    Match.objects.filter(pk=m.pk).update(home_score=2, away_score=1)
    m.refresh_from_db()
    with pytest.raises(ValidationError, match="requires_level"):
        set_match_period(match=m, period="extra_time_first", by=admin)
