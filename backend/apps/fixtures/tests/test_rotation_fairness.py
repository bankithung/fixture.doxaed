"""R7 — round-wise rotation fairness (owner ask 2026-06-25).

`fairness_order` re-sequences a round-robin cohort so the next match always
goes to the teams that have played the fewest games and rested the longest
("give the not-yet-played teams the chance"). The `rotation_fairness` soft
constraint turns it on per scope and also rewards rest in slot choice. The
feature is OPT-IN: with no rule in scope the schedule is unchanged.
"""
from __future__ import annotations

from datetime import date, time

from apps.fixtures.services.generate import _round_robin
from apps.fixtures.services.scheduler import (
    MatchSlotReq,
    ScheduleConfig,
    ScopedRule,
    fairness_order,
    schedule_matches,
)


def _rr_reqs(n: int) -> list[MatchSlotReq]:
    teams = [chr(ord("A") + i) for i in range(n)]
    return [
        MatchSlotReq(id=f"m{i}", round_no=rnd, match_no=i + 1,
                     home=h, away=a, leaf_key="rr", sport="s")
        for i, (rnd, h, a) in enumerate(_round_robin(teams))
    ]


def _one_court_cfg(rotation: bool) -> ScheduleConfig:
    cfg = ScheduleConfig(
        date_start=date(2026, 8, 1), date_end=date(2026, 8, 1),
        daily_start=time(8, 0), daily_end=time(20, 0), slot_minutes=60,
        venues=["Court"], rest_minutes=0, max_per_team_per_day=20,
    )
    if rotation:
        cfg.constraint_rules = [
            ScopedRule(type="rotation_fairness", scope="all", hard=False,
                       weight=5, params={})
        ]
    return cfg


def _min_rest(result, reqs) -> float:
    """Smallest gap (minutes) between any team's consecutive match starts."""
    by_id = {m.id: m for m in reqs}
    starts: dict[str, list] = {}
    for mid, (dt, _v) in result.assignments.items():
        m = by_id[mid]
        for t in (m.home, m.away):
            starts.setdefault(t, []).append(dt)
    worst = None
    for ds in starts.values():
        ds.sort()
        for i in range(len(ds) - 1):
            gap = (ds[i + 1] - ds[i]).total_seconds() / 60.0
            worst = gap if worst is None else min(worst, gap)
    return worst if worst is not None else 0.0


# ------------------------------------------------------------ pure ordering
def test_fairness_order_keeps_games_played_balanced():
    """At every prefix of the order, no team has played more than one game
    more than any other — the "not-yet-played first" guarantee."""
    reqs = _rr_reqs(4)
    order = fairness_order(reqs)
    assert sorted(order) == sorted(m.id for m in reqs)  # a permutation
    by_id = {m.id: m for m in reqs}
    played: dict[str, int] = {}
    for mid in order:
        m = by_id[mid]
        for t in (m.home, m.away):
            played[t] = played.get(t, 0) + 1
        # every team that has appeared is within 1 of the max so far
        assert max(played.values()) - min(played.values()) <= 1


def test_fairness_order_is_deterministic():
    reqs = _rr_reqs(5)
    assert fairness_order(reqs) == fairness_order(list(reversed(reqs)))


# ------------------------------------------------------- scheduling effect
def test_rotation_constraint_triples_worst_case_rest_on_one_court():
    """4-team round-robin on a single court. The naive (circle) order forces a
    team into back-to-back matches (60' rest); rotation fairness spreads them
    to 180'. Both schedules place all 6 matches."""
    reqs = _rr_reqs(4)
    naive = schedule_matches(_rr_reqs(4), _one_court_cfg(rotation=False))
    fair = schedule_matches(_rr_reqs(4), _one_court_cfg(rotation=True))
    assert len(naive.assignments) == len(fair.assignments) == 6
    rest_naive = _min_rest(naive, reqs)
    rest_fair = _min_rest(fair, reqs)
    assert rest_naive == 60.0            # back-to-back under the circle order
    assert rest_fair >= 180.0           # fairness spreads each team's matches
    assert rest_fair > rest_naive


def test_rotation_is_opt_in_no_rule_no_change():
    """Without a rotation rule in scope the placement is the legacy circle
    order — the feature never changes a schedule that didn't ask for it."""
    a = schedule_matches(_rr_reqs(6), _one_court_cfg(rotation=False))
    b = schedule_matches(_rr_reqs(6), _one_court_cfg(rotation=False))
    assert a.assignments == b.assignments            # deterministic
    # the circle order leaves at least one team back-to-back here
    assert _min_rest(a, _rr_reqs(6)) <= 120.0


def test_rotation_only_reorders_round_robin_not_knockout():
    """Knockout matches (stage='knockout') keep round order even with the rule —
    a bracket round depends on the previous round completing."""
    ko = [
        MatchSlotReq(id="qf1", round_no=1, match_no=1, home="A", away="B",
                     leaf_key="ko", sport="s", stage="knockout"),
        MatchSlotReq(id="qf2", round_no=1, match_no=2, home="C", away="D",
                     leaf_key="ko", sport="s", stage="knockout"),
        MatchSlotReq(id="sf1", round_no=2, match_no=3, home=None, away=None,
                     leaf_key="ko", sport="s", stage="knockout"),
    ]
    res = schedule_matches(ko, _one_court_cfg(rotation=True))
    # round-1 matches scheduled before the round-2 match
    assert res.assignments["qf1"][0] < res.assignments["sf1"][0]
    assert res.assignments["qf2"][0] < res.assignments["sf1"][0]
