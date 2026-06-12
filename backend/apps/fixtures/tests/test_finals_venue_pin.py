"""TDD — finals venue pin (increment T).

``round_pinned_to_window`` params grow an optional ``venues: [names]``: when
present, the pinned round's matches land ONLY on those venues (hard). The
catalog's ``params_schema`` advertises the field (the FE builder renders it),
pinned-first placement filters slots by venue, an unplaceable venue pin
surfaces as the existing ``pinned_round_unplaced`` violation, and
``validate_schedule`` flags a pinned match parked on a disallowed venue
(``pinned_round_venue``) — so the repair verbs refuse to move a final off
center court unless forced."""
from __future__ import annotations

from datetime import date, datetime, time
from zoneinfo import ZoneInfo

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.fixtures.services.constraints import (
    CONSTRAINT_TYPES,
    validate_constraints,
)
from apps.fixtures.services.repair import RepairConflict, reschedule_match
from apps.fixtures.services.scheduler import (
    MatchSlotReq,
    ScheduleConfig,
    merge_stored_constraints,
    schedule_matches,
    validate_schedule,
)
from apps.matches.models import Match
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()

LEAF = "football.u15"
SAT, SUN, MON = date(2026, 8, 1), date(2026, 8, 2), date(2026, 8, 3)


def _cfg(**over) -> ScheduleConfig:
    base = dict(
        date_start=SAT, date_end=MON,
        daily_start=time(9, 0), daily_end=time(18, 0), slot_minutes=60,
        venues=["Main Ground", "Center Court"],
        rest_minutes=0, max_per_team_per_day=99,
    )
    base.update(over)
    return ScheduleConfig(**base)


def _bracket_reqs():
    return [
        MatchSlotReq(id="s1", round_no=1, match_no=1, home="t1", away="t2",
                     leaf_key=LEAF, stage="knockout"),
        MatchSlotReq(id="s2", round_no=1, match_no=2, home="t3", away="t4",
                     leaf_key=LEAF, stage="knockout"),
        MatchSlotReq(id="final", round_no=2, match_no=3, home=None, away=None,
                     leaf_key=LEAF, stage="knockout"),
    ]


def _pin(**params):
    return {
        "type": "round_pinned_to_window", "scope": f"leaf:{LEAF}",
        "hard": True, "params": {"round": "final", **params},
    }


# ----------------------------------------------------------------- catalog
def test_catalog_params_schema_advertises_venues():
    spec = next(
        c for c in CONSTRAINT_TYPES if c["type"] == "round_pinned_to_window"
    )
    assert spec["params_schema"]["venues"] == "list"


def test_validate_constraints_round_trips_venue_pin():
    [rec] = validate_constraints([_pin(venues=["Center Court"])])
    assert rec["params"]["venues"] == ["Center Court"]


# ---------------------------------------------------------------- placement
def test_pinned_final_lands_only_on_its_venues():
    # Pin to the alphabetically-LATER venue: the slot grid offers
    # "Center Court" first, so passing requires actual venue filtering.
    cfg = _cfg()
    merge_stored_constraints(cfg, [
        {"type": "round_pinned_to_window", "scope": f"leaf:{LEAF}",
         "params": {"round": "final", "date": "last_day", "from": "14:00",
                    "venues": ["Main Ground"]}},
    ])
    res = schedule_matches(_bracket_reqs(), cfg)
    assert not res.unscheduled
    f_dt, f_venue = res.assignments["final"]
    assert f_venue == "Main Ground"
    assert f_dt.date() == MON and f_dt.time() >= time(14, 0)
    for mid in ("s1", "s2"):
        assert res.assignments[mid][0] < f_dt  # earlier rounds back-fill


def test_pin_venue_resolves_sub_venues_of_the_base():
    # "Annex" sorts before the Hall sub-venues — the pin must still route
    # the final onto a "Hall · Tn" unit by resolving the base name.
    cfg = _cfg(venues=["Annex", "Hall"], venue_counts={"Hall": 2})
    merge_stored_constraints(cfg, [
        {"type": "round_pinned_to_window", "scope": f"leaf:{LEAF}",
         "params": {"round": "final", "venues": ["Hall"]}},
    ])
    res = schedule_matches(_bracket_reqs(), cfg)
    assert not res.unscheduled
    assert res.assignments["final"][1].startswith("Hall")


def test_unsatisfiable_venue_pin_surfaces_structured_violation():
    cfg = _cfg(venues=["Main Ground"])  # the pinned venue is not in the pool
    merge_stored_constraints(cfg, [
        {"type": "round_pinned_to_window", "scope": f"leaf:{LEAF}",
         "params": {"round": "final", "venues": ["Center Court"]}},
    ])
    res = schedule_matches(_bracket_reqs(), cfg)
    assert "final" in res.unscheduled
    v = next(x for x in res.violations if x["code"] == "pinned_round_unplaced")
    assert "final" in v["matches"]
    assert v["constraint"]["type"] == "round_pinned_to_window"


# --------------------------------------------------------------- validation
def test_validate_schedule_flags_pinned_match_on_wrong_venue():
    cfg = _cfg()
    merge_stored_constraints(cfg, [
        {"type": "round_pinned_to_window", "scope": f"leaf:{LEAF}",
         "params": {"round": "final", "venues": ["Center Court"]}},
    ])
    reqs = _bracket_reqs()
    bad = validate_schedule(
        {"final": (datetime(2026, 8, 3, 14, 0), "Main Ground")}, reqs, cfg,
    )
    v = next(x for x in bad if x["code"] == "pinned_round_venue")
    assert v["hard"] is True and v["match_id"] == "final"
    assert v["venue"] == "Main Ground"
    assert v["allowed_venues"] == ["Center Court"]
    # the allowed venue is clean; semis are unconstrained
    assert validate_schedule(
        {"final": (datetime(2026, 8, 3, 14, 0), "Center Court"),
         "s1": (datetime(2026, 8, 1, 9, 0), "Main Ground")}, reqs, cfg,
    ) == []


# ----------------------------------------------------------------------- e2e
def _knockout_tournament(admin):
    t = create_tournament(user=admin, name="Finals Cup")
    t.sports = normalize_sports(
        [{"name": "Football", "nodes": [{"name": "U15"}]}]
    )
    t.constraints = [
        {"type": "round_pinned_to_window", "scope": f"leaf:{LEAF}",
         "hard": True, "weight": 5,
         "params": {"round": "final", "date": "last_day", "from": "14:00",
                    "venues": ["Center Court"]}},
    ]
    t.save(update_fields=["sports", "constraints"])
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i}", "leaf_key": LEAF, "sport": "football",
                "players": []} for i in range(4)],
    )
    return t


@pytest.mark.django_db
def test_finals_on_center_court_end_to_end():
    admin = User.objects.create_user(
        email="pin@test.local", password="FixtureDemo2026!", is_active=True,
    )
    admin.email_verified_at = timezone.now()
    admin.save(update_fields=["email_verified_at"])
    t = _knockout_tournament(admin)
    c = APIClient()
    c.force_authenticate(user=admin)
    assert c.post(
        f"/api/tournaments/{t.id}/generate-fixtures/",
        {"format": "knockout", "leaf_key": LEAF}, format="json",
    ).status_code == 201
    r = c.post(
        f"/api/tournaments/{t.id}/schedule/",
        {"date_start": "2026-08-01", "date_end": "2026-08-03",
         "venues": ["Main Ground", "Center Court"], "slot_minutes": 60,
         "rest_minutes": 0, "max_per_team_per_day": 4},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert r.json()["unscheduled"] == []
    tz = ZoneInfo(t.time_zone)
    final = Match.objects.get(tournament=t, round_no=2)
    local = timezone.localtime(final.scheduled_at, tz)
    assert final.venue == "Center Court"
    assert local.date() == MON and local.time() >= time(14, 0)

    # repair validation: moving the final off center court is a hard conflict
    with pytest.raises(RepairConflict) as exc:
        reschedule_match(match=final, by=admin, venue="Main Ground")
    assert any(
        v["code"] == "pinned_round_venue" for v in exc.value.violations
    )
    # forced moves still apply (organizer override), violations ride along
    warnings = reschedule_match(
        match=final, by=admin, venue="Main Ground", force=True,
    )
    assert any(v["code"] == "pinned_round_venue" for v in warnings)
    final.refresh_from_db()
    assert final.venue == "Main Ground"
