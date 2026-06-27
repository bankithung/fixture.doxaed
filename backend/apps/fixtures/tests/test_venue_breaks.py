"""TDD — break timings (owner ask 2026-06-27).

Two ways to keep matches off the calendar during a break:
  * an OVERALL daily break (all venues) — a ``recurring_blackout_window``
    constraint at ``scope:"all"`` with empty ``days`` (every day); already cut
    from the grid in ``build_slots``.
  * a PER-VENUE break — ``Venue.breaks`` ([{from,to}]) flows through
    ``config_from_dict`` into ``cfg.venue_breaks`` and is subtracted from THAT
    venue's grid only.

Both are structural holes in the slot grid: no slot starts inside the window.
"""
from __future__ import annotations

from datetime import time

from apps.fixtures.services.scheduler import (
    ScopedRule,
    build_slots,
    config_from_dict,
)

DAY = "2026-08-01"


def test_per_venue_break_cuts_only_that_venue():
    cfg = config_from_dict({
        "date_start": DAY, "date_end": DAY,
        "daily_start": "09:00", "daily_end": "18:00", "slot_minutes": 60,
        "venues": [
            {"name": "A", "breaks": [{"from": "12:00", "to": "13:00"}]},
            {"name": "B"},
        ],
    })
    assert cfg.venue_breaks == {"A": [(time(12, 0), time(13, 0))]}
    starts = {(v, dt.time()) for dt, v, _ in build_slots(cfg)}
    # Venue A: the noon hour is gone, the surrounding slots remain.
    assert ("A", time(11, 0)) in starts
    assert ("A", time(12, 0)) not in starts
    assert ("A", time(13, 0)) in starts
    # Venue B (no break) is unaffected — a match CAN sit at noon there.
    assert ("B", time(12, 0)) in starts


def test_overall_break_cuts_every_venue():
    cfg = config_from_dict({
        "date_start": DAY, "date_end": DAY,
        "daily_start": "09:00", "daily_end": "18:00", "slot_minutes": 60,
        "venues": ["A", "B"],
    })
    # Overall daily break: every day (empty `days`), all venues.
    cfg.constraint_rules.append(ScopedRule(
        "recurring_blackout_window", "all", True, 5,
        {"days": [], "from": time(12, 0), "to": time(13, 0)},
    ))
    starts = {(v, dt.time()) for dt, v, _ in build_slots(cfg)}
    assert ("A", time(12, 0)) not in starts
    assert ("B", time(12, 0)) not in starts
    assert ("A", time(11, 0)) in starts
    assert ("B", time(13, 0)) in starts


def test_overall_and_per_venue_breaks_compose():
    cfg = config_from_dict({
        "date_start": DAY, "date_end": DAY,
        "daily_start": "09:00", "daily_end": "18:00", "slot_minutes": 60,
        "venues": [
            {"name": "A", "breaks": [{"from": "15:00", "to": "16:00"}]},
            {"name": "B"},
        ],
    })
    cfg.constraint_rules.append(ScopedRule(
        "recurring_blackout_window", "all", True, 5,
        {"days": [], "from": time(12, 0), "to": time(13, 0)},
    ))
    starts = {(v, dt.time()) for dt, v, _ in build_slots(cfg)}
    # A loses BOTH the global noon break and its own 3pm break.
    assert ("A", time(12, 0)) not in starts
    assert ("A", time(15, 0)) not in starts
    assert ("A", time(14, 0)) in starts
    # B loses only the global noon break.
    assert ("B", time(12, 0)) not in starts
    assert ("B", time(15, 0)) in starts


def test_blank_or_malformed_breaks_are_ignored():
    cfg = config_from_dict({
        "date_start": DAY, "date_end": DAY, "slot_minutes": 60,
        "venues": [
            {"name": "A", "breaks": []},
            {"name": "B", "breaks": [{"from": "", "to": ""}]},
            {"name": "C", "breaks": [{"from": "12:00"}]},  # missing `to`
        ],
    })
    assert cfg.venue_breaks == {}
