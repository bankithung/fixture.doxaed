"""Badge engine — every owner badge maps to derivable criteria; the
reconciler is idempotent and correction-proof."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.badges.models import BadgeAward
from apps.badges.services.engine import recompute_badges
from apps.matches.models import Match, MatchEventType, MatchStatus
from apps.matches.services.events import record_match_event
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified():
    u = User.objects.create_user(
        email=f"bd-{uuid.uuid4().hex[:8]}@test.local",
        password="FixtureDemo2026!", is_active=True,
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _setup(n_teams=2, players=False):
    admin = _verified()
    t = create_tournament(user=admin, name="Badge Cup")
    teams = register_school(
        tournament=t, school_name="S",
        teams=[
            {"name": f"T{i}", "players": [{"full_name": f"P{i}"}] if players else []}
            for i in range(n_teams)
        ],
    )
    return admin, t, teams


def _match(t, home, away, i=1, leaf="tt.u15", **kw):
    tz = ZoneInfo(t.time_zone)
    return Match.objects.create(
        organization=t.organization, tournament=t, home_team=home, away_team=away,
        match_no=i, leaf_key=leaf,
        scheduled_at=datetime(2026, 8, 1, 9, 0, tzinfo=tz) + timedelta(hours=i),
        **kw,
    )


def _complete_sets(m, set_scores, sport="table_tennis"):
    home_sets = sum(1 for s in set_scores if s[0] > s[1])
    away_sets = sum(1 for s in set_scores if s[1] > s[0])
    Match.objects.filter(pk=m.pk).update(
        set_scores=set_scores, sport=sport,
        home_score=home_sets, away_score=away_sets,
        status=MatchStatus.COMPLETED,
    )
    m.refresh_from_db()


def _keys(t, badge_key=None, team=None):
    qs = BadgeAward.objects.filter(tournament=t, revoked_at__isnull=True)
    if badge_key:
        qs = qs.filter(badge_key=badge_key)
    if team is not None:
        qs = qs.filter(team=team)
    return list(qs)


def test_straight_set_and_lockdown_and_evidence():
    _admin, t, (a, b) = _setup()
    m = _match(t, a, b)
    _complete_sets(m, [[11, 3], [11, 5], [11, 4]])  # conceded 12 <= 13 (TT)
    recompute_badges(t)

    sweep = _keys(t, "straight_set_win", a)
    assert len(sweep) == 1
    lockdown = _keys(t, "lockdown_match", a)
    assert len(lockdown) == 1
    assert lockdown[0].evidence["conceded"] == 12
    assert _keys(t, badge_key="straight_set_win", team=b) == []


def test_comeback_kings_set_sport():
    _admin, t, (a, b) = _setup()
    m = _match(t, a, b)
    _complete_sets(m, [[12, 15], [15, 10], [15, 8]], sport="sepaktakraw")
    recompute_badges(t)
    rows = _keys(t, "comeback_win", a)
    assert len(rows) == 1
    assert rows[0].evidence["lost_first_set"] == "12-15"


def test_clean_sweep_streak_two_in_a_row():
    _admin, t, (a, b) = _setup()
    m1 = _match(t, a, b, 1)
    m2 = _match(t, b, a, 2)
    _complete_sets(m1, [[11, 5], [11, 6]])
    recompute_badges(t)
    assert _keys(t, "clean_sweep_streak", a) == []  # one straight-set win

    _complete_sets(m2, [[4, 11], [6, 11]])  # away side (a) sweeps again
    recompute_badges(t)
    rows = _keys(t, "clean_sweep_streak", a)
    assert len(rows) == 1 and rows[0].evidence["streak"] >= 2


def test_group_badges_wait_for_group_completion():
    _admin, t, (a, b, c) = _setup(n_teams=3)
    ms = [
        _match(t, a, b, 1, group_label="A", stage="group"),
        _match(t, a, c, 2, group_label="A", stage="group"),
        _match(t, b, c, 3, group_label="A", stage="group"),
    ]
    _complete_sets(ms[0], [[15, 4], [15, 5]], sport="sepaktakraw")
    recompute_badges(t)
    assert _keys(t, "group_dominator") == []  # group still open

    _complete_sets(ms[1], [[15, 7], [15, 9]], sport="sepaktakraw")
    _complete_sets(ms[2], [[15, 11], [11, 15], [15, 12]], sport="sepaktakraw")
    recompute_badges(t)

    dom = _keys(t, "group_dominator")
    assert [d.team_id for d in dom] == [a.id]  # unbeaten, no sets lost, top PD
    perfect = _keys(t, "perfect_run", a)
    assert len(perfect) == 1
    # Competition-complete superlatives land too (all matches final).
    defence = _keys(t, "best_defence")
    assert [d.team_id for d in defence] == [a.id]
    pd = _keys(t, "point_difference")
    assert [d.team_id for d in pd] == [a.id]


def test_golden_boot_and_football_comeback():
    admin, t, (a, b) = _setup(players=True)
    m = _match(t, a, b, 1, leaf="football.u15")
    Match.objects.filter(pk=m.pk).update(status=MatchStatus.LIVE)
    m.refresh_from_db()
    pa, pb = a.players.first(), b.players.first()
    # B scores first; A comes back with two.
    record_match_event(match=m, event_type=MatchEventType.GOAL, team=b, player=pb, by=admin)
    record_match_event(match=m, event_type=MatchEventType.GOAL, team=a, player=pa, by=admin)
    record_match_event(match=m, event_type=MatchEventType.GOAL, team=a, player=pa, by=admin)
    Match.objects.filter(pk=m.pk).update(status=MatchStatus.COMPLETED)
    recompute_badges(t)

    comeback = _keys(t, "comeback_win", a)
    assert len(comeback) == 1 and comeback[0].evidence["trailed"] is True
    boot = [
        x for x in _keys(t, "golden_boot") if x.player_id == pa.id
    ]
    assert len(boot) == 1 and boot[0].evidence["goals"] == 2
    assert not [x for x in _keys(t, "golden_boot") if x.player_id == pb.id]


def test_reconciler_is_idempotent_and_revokes_on_correction():
    _admin, t, (a, b) = _setup()
    m = _match(t, a, b)
    _complete_sets(m, [[11, 3], [11, 5]])
    recompute_badges(t)
    recompute_badges(t)  # replay: no duplicates
    assert len(_keys(t, "straight_set_win", a)) == 1

    # Correction: the second set actually went to B — no longer a sweep.
    Match.objects.filter(pk=m.pk).update(
        set_scores=[[11, 3], [9, 11], [11, 5]], home_score=2, away_score=1
    )
    recompute_badges(t)
    assert _keys(t, "straight_set_win", a) == []  # revoked
    assert BadgeAward.objects.filter(
        tournament=t, badge_key="straight_set_win", revoked_at__isnull=False
    ).exists()


def test_share_card_renders_png(tmp_path, settings):
    settings.MEDIA_ROOT = str(tmp_path)
    _admin, t, (a, b) = _setup()
    m = _match(t, a, b)
    _complete_sets(m, [[15, 4], [15, 5]], sport="sepaktakraw")
    recompute_badges(t)
    award = _keys(t, "lockdown_match", a)[0]

    from apps.badges.services.cards import render_share_card

    path = render_share_card(award)
    assert path.exists() and path.stat().st_size > 5000
    with open(path, "rb") as fh:
        assert fh.read(8).startswith(b"\x89PNG")
    # Idempotent: same evidence -> same file reused.
    assert render_share_card(award) == path
