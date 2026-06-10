"""W2-D real-game constraints (spec 2026-06-10 Wave 2):

* same-institution teams don't meet in the OPENING round (round robin +
  knockout) and spread across pools;
* teams sharing a rostered person (one student in two competitions) never
  play overlapping matches;
* register_school dedupes Persons per institution so that sharing is
  representable (Player uniqueness is now per-team, not per-tournament);
* badminton resolves a full BWF set profile.
"""
from __future__ import annotations

from datetime import date, time

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.fixtures.services.generate import (
    _opening_pairs_bracket,
    _opening_pairs_circle,
    _separate_institutions,
    generate_round_robin_by_category,
    generate_single_elimination,
)
from apps.fixtures.services.scheduler import (
    MatchSlotReq,
    ScheduleConfig,
    schedule_matches,
)
from apps.teams.models import Person, Player, Team, TeamStatus
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()
pytestmark = pytest.mark.django_db


def _admin(email="sep@test.local"):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!",
                                 is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _cup(admin, name="Sep Cup"):
    t = create_tournament(user=admin, name=name)
    t.sports = normalize_sports([{"name": "Football", "nodes": [{"name": "U15"}]}])
    t.save(update_fields=["sports"])
    return t


def _teams(t, spec):
    """spec = [(school, team_name), ...] → registered teams in football.u15."""
    out = []
    for school, tname in spec:
        out.extend(register_school(
            tournament=t, school_name=school,
            teams=[{"name": tname, "sport": "football",
                    "leaf_key": "football.u15", "players": []}],
        ))
    return out


def _opening_matches(matches):
    return [m for m in matches if m.round_no == 1 and m.home_team_id and m.away_team_id]


def test_round_robin_opening_round_separates_institutions():
    admin = _admin()
    t = _cup(admin)
    _teams(t, [("Don Bosco", "DB A"), ("Don Bosco", "DB B"),
               ("St. Mary", "SM A"), ("St. Mary", "SM B")])
    created = generate_round_robin_by_category(tournament=t, leaf_key="football.u15")
    teams = {tm.id: tm for tm in Team.objects.filter(tournament=t)}
    for m in _opening_matches(created):
        home, away = teams[m.home_team_id], teams[m.away_team_id]
        assert home.institution_id != away.institution_id, (
            f"round 1 pairs {home.name} vs {away.name} from the same school"
        )


def test_knockout_opening_round_separates_institutions():
    admin = _admin("ko@test.local")
    t = _cup(admin, "KO Cup")
    teams = _teams(t, [("Don Bosco", "DB A"), ("Don Bosco", "DB B"),
                       ("St. Mary", "SM A"), ("Greenfield", "GF A")])
    created = generate_single_elimination(
        tournament=t, teams=teams, leaf_key="football.u15",
    )
    by_id = {tm.id: tm for tm in teams}
    for m in _opening_matches(created):
        home, away = by_id[m.home_team_id], by_id[m.away_team_id]
        assert home.institution_id != away.institution_id


def test_separation_helper_is_noop_when_unavoidable_or_distinct():
    admin = _admin("noop@test.local")
    t = _cup(admin, "Tiny Cup")
    same = _teams(t, [("Don Bosco", "DB A"), ("Don Bosco", "DB B")])
    # only one institution → mathematically unavoidable, helper must not loop
    assert len(_separate_institutions(same, _opening_pairs_circle(2))) == 2
    distinct = _teams(t, [("X School", "X"), ("Y School", "Y"), ("Z School", "Z")])
    assert _separate_institutions(distinct, _opening_pairs_bracket(3)) == distinct


def test_register_school_dedupes_persons_within_institution():
    admin = _admin("dedupe@test.local")
    t = _cup(admin, "Dedupe Cup")
    register_school(
        tournament=t, school_name="Don Bosco",
        teams=[{"name": "DB Football", "sport": "football",
                "leaf_key": "football.u15",
                "players": [{"full_name": "Imna Jamir"}]}],
    )
    register_school(
        tournament=t, school_name="Don Bosco",
        teams=[{"name": "DB Badminton", "sport": "badminton",
                "leaf_key": "badminton",
                "players": [{"full_name": "imna jamir"}]}],  # case-insensitive
    )
    assert Person.objects.filter(full_name__iexact="imna jamir").count() == 1
    person = Person.objects.get(full_name__iexact="imna jamir")
    # one Player row per team — per-team uniqueness, not per-tournament
    assert Player.objects.filter(tournament=t, person=person).count() == 2


def test_scheduler_keeps_linked_teams_from_overlapping():
    cfg = ScheduleConfig(
        date_start=date(2026, 8, 1), date_end=date(2026, 8, 1),
        daily_start=time(9, 0), daily_end=time(18, 0), slot_minutes=60,
        venues=["A", "B"], rest_minutes=0, max_per_team_per_day=99,
    )
    matches = [
        MatchSlotReq(id="fb", round_no=1, match_no=1, home="t-fb", away="t-x",
                     duration_minutes=60),
        MatchSlotReq(id="bd", round_no=1, match_no=2, home="t-bd", away="t-y",
                     duration_minutes=60),
    ]
    # unlinked: two venues → both land at 9:00
    free = schedule_matches(matches, cfg)
    assert free.assignments["fb"][0] == free.assignments["bd"][0]
    # linked (a student plays in both teams): must not overlap
    linked = {"t-fb": {"t-bd"}, "t-bd": {"t-fb"}}
    res = schedule_matches(matches, cfg, linked=linked)
    assert not res.unscheduled
    (fb_dt, _), (bd_dt, _) = res.assignments["fb"], res.assignments["bd"]
    assert fb_dt != bd_dt
    assert abs((fb_dt - bd_dt).total_seconds()) >= 3600


def test_badminton_profile_is_bwf():
    from apps.matches.services.set_scoring import scoring_rules, sport_profile

    prof = sport_profile("badminton")
    assert prof is not None
    assert prof["venue_type"] == "indoor_court"
    rules = scoring_rules("badminton")
    assert rules["best_of"] == 3
    assert rules["points"] == 21 and rules["win_by"] == 2 and rules["cap"] == 30
    assert rules["deciding"] == {"points": 21, "win_by": 2, "cap": 30}


def test_separation_survives_status_filter():
    # only REGISTERED teams enter draws — sanity that helper input matches
    admin = _admin("statuses@test.local")
    t = _cup(admin, "Status Cup")
    _teams(t, [("Don Bosco", "DB A"), ("St. Mary", "SM A")])
    Team.objects.filter(name="SM A").update(status=TeamStatus.WITHDRAWN)
    with pytest.raises(ValueError):
        generate_round_robin_by_category(tournament=t, leaf_key="football.u15")
