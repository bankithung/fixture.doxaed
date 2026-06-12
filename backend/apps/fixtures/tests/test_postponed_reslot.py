"""Increment E (part 1) — apply_schedule/preview reslot POSTPONED matches.

A postponed match needs a new slot more than anything else on the calendar:
``build_schedule_inputs`` now includes ``postponed`` (alongside ``scheduled``)
in the reassignment targets — still excluding locked matches, which stay on
the calendar as fixed bookings. Status is NOT touched: the organizer flips
postponed → scheduled through the audited state machine."""
from __future__ import annotations

import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.fixtures.services.scheduler import (
    apply_schedule,
    build_schedule_inputs,
    config_from_dict,
)
from apps.matches.models import Match, MatchStatus
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str):
    u = User.objects.create_user(
        email=email, password="FixtureDemo2026!", is_active=True
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _setup():
    admin = _verified(f"resl-{uuid.uuid4().hex[:8]}@test.local")
    t = create_tournament(user=admin, name="Reslot Cup")
    register_school(
        tournament=t,
        school_name="School",
        teams=[{"name": f"Team {i + 1}", "players": []} for i in range(4)],
    )
    from apps.fixtures.services.generate import generate_round_robin

    generate_round_robin(tournament=t, group_size=4)
    t.scheduling_config = {
        "date_start": "2026-08-01", "date_end": "2026-08-31",
        "venues": ["G", "G2"], "slot_minutes": 90,
        "rest_minutes": 60, "max_per_team_per_day": 1,
    }
    t.save(update_fields=["scheduling_config"])
    tz = ZoneInfo(t.time_zone)
    matches = list(Match.objects.filter(tournament=t).order_by("match_no"))
    for i, m in enumerate(matches):
        m.scheduled_at = datetime(2026, 8, 1 + i, 9, 0, tzinfo=tz)
        m.venue = "G"
        m.save(update_fields=["scheduled_at", "venue"])
    return admin, t, tz, matches


def test_build_inputs_includes_postponed_and_keeps_excluding_locked():
    _admin, t, tz, matches = _setup()
    postponed = matches[0]
    postponed.status = MatchStatus.POSTPONED
    postponed.save(update_fields=["status"])
    locked_postponed = matches[1]
    locked_postponed.status = MatchStatus.POSTPONED
    locked_postponed.locked_at = timezone.now()
    locked_postponed.save(update_fields=["status", "locked_at"])

    cfg = config_from_dict(t.scheduling_config)
    reqs, preoccupied, _linked = build_schedule_inputs(t, cfg)
    req_ids = {r.id for r in reqs}
    assert str(postponed.id) in req_ids        # postponed: reassignable
    assert str(locked_postponed.id) not in req_ids  # locked: never
    # the locked one still blocks the calendar as a fixed booking
    local = locked_postponed.scheduled_at.astimezone(tz).replace(tzinfo=None)
    assert any(p[0] == "G" and p[1] == local for p in preoccupied)
    # ...and the movable postponed one is NOT doubly booked as preoccupied
    plocal = postponed.scheduled_at.astimezone(tz).replace(tzinfo=None)
    assert not any(p[0] == "G" and p[1] == plocal for p in preoccupied)


def test_apply_schedule_reslots_postponed_without_touching_status():
    admin, t, _tz, matches = _setup()
    postponed = matches[0]
    postponed.status = MatchStatus.POSTPONED
    postponed.scheduled_at = None  # the typical washout: slot lost entirely
    postponed.save(update_fields=["status", "scheduled_at"])

    res = apply_schedule(
        tournament=t,
        config=dict(t.scheduling_config),
        by=admin,
    )
    assert str(postponed.id) in res.assignments
    postponed.refresh_from_db()
    assert postponed.scheduled_at is not None  # it got a slot
    assert postponed.status == MatchStatus.POSTPONED  # state machine owns status


def test_preview_treats_other_leaves_postponed_as_bookings():
    """The plans path is a re-draw of ONE leaf; a postponed match in another
    competition still blocks the calendar exactly like before."""
    _admin, t, tz, matches = _setup()
    other = matches[0]
    other.leaf_key = "football.u17.boys"
    other.status = MatchStatus.POSTPONED
    other.save(update_fields=["leaf_key", "status"])

    from apps.fixtures.services.generate import MatchPlan

    cfg = config_from_dict(t.scheduling_config)
    plans = [MatchPlan(stage="group", round_no=1,
                       leaf_key="football.u15.boys", ref=0)]
    _reqs, preoccupied, _linked = build_schedule_inputs(
        t, cfg, leaf_key="football.u15.boys", plans=plans,
    )
    local = other.scheduled_at.astimezone(tz).replace(tzinfo=None)
    assert any(p[0] == "G" and p[1] == local for p in preoccupied)
