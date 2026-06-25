"""R11 elastic live re-timing (owner ask 2026-06-25).

`transition_match` stamps the actual `started_at`/`ended_at`; on completion the
opt-in `reflow_from_actual` moves the later matches on the same court to follow
the real end time — a long match pushes them back, an early finish pulls them
up — auto-applying only when no hard constraint is violated.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.fixtures.services.repair import reflow_from_actual
from apps.matches.models import Match, MatchStatus
from apps.matches.services.state import transition_match
from apps.teams.models import Team
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _admin():
    u = User.objects.create_user(
        email=f"reflow-{uuid.uuid4().hex[:8]}@test.local",
        password="FixtureDemo2026!", is_active=True,
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _setup(*, auto_reflow: bool):
    """A tournament with 3 matches on one court at 09:00/10:00/11:00 (60' each),
    each between a distinct pair of teams (no shared-team rest coupling)."""
    admin = _admin()
    t = create_tournament(user=admin, name="Reflow Cup")
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i}", "players": []} for i in range(6)],
    )
    cfg = {
        "date_start": "2026-08-01", "date_end": "2026-08-01",
        "venues": ["G"], "slot_minutes": 60, "rest_minutes": 60,
        "max_per_team_per_day": 9,
    }
    if auto_reflow:
        cfg["auto_reflow"] = True
    t.scheduling_config = cfg
    t.save(update_fields=["scheduling_config"])

    tz = ZoneInfo(t.time_zone)
    teams = list(Team.objects.filter(tournament=t).order_by("name"))
    matches = []
    for i, (a, b) in enumerate([(0, 1), (2, 3), (4, 5)]):
        matches.append(Match.objects.create(
            organization=t.organization, tournament=t, round_no=1, match_no=i + 1,
            home_team=teams[a], away_team=teams[b], status=MatchStatus.SCHEDULED,
            scheduled_at=datetime(2026, 8, 1, 9 + i, 0, tzinfo=tz), venue="G",
        ))
    return admin, t, tz, matches


def _hour(m: Match, tz) -> tuple[int, int]:
    m.refresh_from_db()
    local = m.scheduled_at.astimezone(tz)
    return local.hour, local.minute


# ----------------------------------------------------- actual-time stamping
def test_transition_stamps_started_and_ended():
    _admin_u, t, _tz, matches = _setup(auto_reflow=False)
    m = matches[0]
    transition_match(match=m, to_status=MatchStatus.LIVE)
    m.refresh_from_db()
    assert m.started_at is not None and m.ended_at is None
    m.home_score, m.away_score = 2, 1
    m.save(update_fields=["home_score", "away_score"])
    transition_match(match=m, to_status=MatchStatus.COMPLETED)
    m.refresh_from_db()
    assert m.ended_at is not None


# ------------------------------------------------------------ reflow effect
def test_late_finish_pushes_later_court_matches_back():
    _a, t, tz, matches = _setup(auto_reflow=True)
    m1, m2, m3 = matches
    # m1 was 09:00–10:00; it actually ended at 10:30 (30' over).
    m1.ended_at = datetime(2026, 8, 1, 10, 30, tzinfo=tz)
    m1.save(update_fields=["ended_at"])
    moved = reflow_from_actual(m1.id)
    assert {x["match_id"] for x in moved} == {str(m2.id), str(m3.id)}
    assert _hour(m2, tz) == (10, 30)   # pushed from 10:00 → 10:30
    assert _hour(m3, tz) == (11, 30)   # pushed from 11:00 → 11:30


def test_early_finish_recovers_a_late_queue_toward_plan():
    """A late-running queue recovers when an earlier match finishes early — but
    no match starts before its slot's planned end (no surprise early kickoffs)."""
    _a, t, tz, matches = _setup(auto_reflow=True)
    m1, m2, m3 = matches
    # The queue is running 45' late (e.g. earlier overruns), then m1 finishes 20' early.
    m2.scheduled_at = datetime(2026, 8, 1, 10, 45, tzinfo=tz)
    m3.scheduled_at = datetime(2026, 8, 1, 11, 45, tzinfo=tz)
    Match.objects.bulk_update([m2, m3], ["scheduled_at"])
    m1.ended_at = datetime(2026, 8, 1, 9, 40, tzinfo=tz)  # planned end 10:00 → 20' early
    m1.save(update_fields=["ended_at"])
    reflow_from_actual(m1.id)
    assert _hour(m2, tz) == (10, 25)   # 10:45 − 20' recovery, ≥ planned-end 10:00
    assert _hour(m3, tz) == (11, 25)   # 11:45 − 20' recovery


def test_early_finish_on_time_queue_does_not_start_matches_early():
    _a, t, tz, matches = _setup(auto_reflow=True)
    m1, m2, _m3 = matches
    m1.ended_at = datetime(2026, 8, 1, 9, 40, tzinfo=tz)  # 20' early, queue on time
    m1.save(update_fields=["ended_at"])
    assert reflow_from_actual(m1.id) == []
    assert _hour(m2, tz) == (10, 0)    # never pulled before its planned slot


def test_reflow_is_opt_in_per_tournament():
    _a, t, tz, matches = _setup(auto_reflow=False)
    m1, m2, _m3 = matches
    m1.ended_at = datetime(2026, 8, 1, 10, 30, tzinfo=tz)
    m1.save(update_fields=["ended_at"])
    assert reflow_from_actual(m1.id) == []
    assert _hour(m2, tz) == (10, 0)    # unchanged


def test_tiny_drift_under_threshold_is_ignored():
    _a, t, tz, matches = _setup(auto_reflow=True)
    m1, m2, _m3 = matches
    m1.ended_at = datetime(2026, 8, 1, 10, 3, tzinfo=tz)  # 3' over < 5' gate
    m1.save(update_fields=["ended_at"])
    assert reflow_from_actual(m1.id) == []
    assert _hour(m2, tz) == (10, 0)


def test_completed_match_is_not_moved_by_its_own_reflow():
    _a, t, tz, matches = _setup(auto_reflow=True)
    m1, _m2, _m3 = matches
    m1.ended_at = datetime(2026, 8, 1, 10, 30, tzinfo=tz)
    m1.save(update_fields=["ended_at"])
    moved = reflow_from_actual(m1.id)
    assert str(m1.id) not in {x["match_id"] for x in moved}
    assert _hour(m1, tz) == (9, 0)
