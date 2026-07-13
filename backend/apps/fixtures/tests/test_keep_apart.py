"""Pairing-time ``keep_apart_until_round`` (redesign spec §4.6): the
institution-separation pass generalizes to a key grammar — school | district |
seed_pot | tag:<k> — resolved from stored constraint records. Same-key teams
avoid each other in the opening round and spread across pools; infeasible
records degrade to best-effort with a NAMED warning (never an error), and
teams missing the key datum are excluded with a warning (§9 A8)."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.fixtures.services.generate import (
    _bracket_order,
    _keep_apart_key_map,
    _opening_pairs_bracket,
    _repair_same_institution_pairs,
    _separate_bracket_by_key,
    _separate_by_key,
    generate_round_robin_by_category,
    generate_single_elimination,
    plan_round_robin,
    plan_single_elimination,
)
from apps.fixtures.services.scheduler import ScheduleConfig, merge_stored_constraints
from apps.teams.models import Institution, Team
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()
pytestmark = pytest.mark.django_db

LEAF = "football.u15"


def _admin(email="ka@test.local"):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!",
                                 is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _cup(admin, name="KA Cup"):
    t = create_tournament(user=admin, name=name)
    t.sports = normalize_sports([{"name": "Football", "nodes": [{"name": "U15"}]}])
    t.save(update_fields=["sports"])
    return t


def _team(t, school, name, district=None, attributes=None, seed=None):
    (team,) = register_school(
        tournament=t, school_name=school,
        teams=[{"name": name, "sport": "football", "leaf_key": LEAF,
                "players": []}],
    )
    inst = Institution.objects.get(tournament=t, name=school)
    changed = []
    if district is not None:
        inst.region = district
        changed.append("region")
    if attributes is not None:
        inst.attributes = {**(inst.attributes or {}), **attributes}
        changed.append("attributes")
    if changed:
        inst.save(update_fields=changed)
    if seed is not None:
        Team.objects.filter(id=team.id).update(seed=seed)
        team.refresh_from_db()
    return team


def _keep_apart(t, key, scope="all"):
    t.constraints = [{
        "type": "keep_apart_until_round", "scope": scope, "hard": True,
        "weight": 5, "params": {"key": key, "until_round": 1},
    }]
    t.save(update_fields=["constraints"])


def _opening(matches):
    return [m for m in matches
            if m.round_no == 1 and m.home_team_id and m.away_team_id]


# ----------------------------------------------------------------- key maps
def test_key_map_district_reads_stage1_data_and_warns_on_missing():
    admin = _admin()
    t = _cup(admin)
    a = _team(t, "A School", "A", district="Kohima")
    b = _team(t, "B School", "B", attributes={"district": "Mon"})
    c = _team(t, "C School", "C")  # never answered a district
    warnings: list = []
    km = _keep_apart_key_map(t, [a, b, c], "district", warnings)
    assert km[a.id] == "kohima" and km[b.id] == "mon"
    assert km[c.id] is None  # excluded from the constraint (§9 A8)
    w = next(x for x in warnings if x["code"] == "keep_apart_missing_district")
    assert "C" in w["teams"]


def test_key_map_seed_pot_quartiles_and_missing_seed_warning():
    admin = _admin("pots@test.local")
    t = _cup(admin, "Pot Cup")
    teams = [_team(t, f"S{i}", f"T{i}", seed=i + 1) for i in range(8)]
    unseeded = _team(t, "S9", "T9")
    warnings: list = []
    km = _keep_apart_key_map(t, [*teams, unseeded], "seed_pot", warnings)
    pots = [km[tm.id] for tm in teams]
    assert pots == [1, 1, 2, 2, 3, 3, 4, 4]
    assert km[unseeded.id] is None
    assert any(x["code"] == "keep_apart_missing_seed" for x in warnings)


def test_key_map_tag_reads_institution_attributes():
    admin = _admin("tags@test.local")
    t = _cup(admin, "Tag Cup")
    a = _team(t, "A School", "A", attributes={"zone": "North"})
    b = _team(t, "B School", "B", attributes={"zone": "north"})  # same, case-folded
    c = _team(t, "C School", "C")
    km = _keep_apart_key_map(t, [a, b, c], "tag:zone", [])
    assert km[a.id] == km[b.id] == "north"
    assert km[c.id] is None


def test_unknown_key_warns_and_is_skipped():
    admin = _admin("unk@test.local")
    t = _cup(admin, "Unk Cup")
    a = _team(t, "A School", "A")
    warnings: list = []
    assert _keep_apart_key_map(t, [a], "galaxy", warnings) is None
    assert any(x["code"] == "keep_apart_unknown_key" for x in warnings)


# ----------------------------------------------------- pure separation core
def test_separate_by_key_uses_the_key_map_not_institutions():
    class T:  # minimal stand-in (the helper only touches .id / .institution_id)
        def __init__(self, id):
            self.id = id
            self.institution_id = None

    a, b, c, d = (T(i) for i in range(4))
    km = {a.id: "x", b.id: "x", c.id: "y", d.id: "y"}
    pairs = _opening_pairs_bracket(4)  # (0,3), (1,2)
    out = _separate_by_key([a, c, d, b], pairs, km)  # a-b and c-d would meet
    for i, j in pairs:
        assert km[out[i].id] != km[out[j].id]


# -------------------------------------------------------------- generation
def test_knockout_keeps_same_district_schools_apart_in_round_one():
    admin = _admin("d-ko@test.local")
    t = _cup(admin, "District KO")
    # 4 distinct schools (so the built-in school pass is a no-op), two per
    # district, registered in an order whose bracket pairs same districts.
    a = _team(t, "A School", "A", district="Kohima")
    c = _team(t, "C School", "C", district="Mon")
    d = _team(t, "D School", "D", district="Mon")
    b = _team(t, "B School", "B", district="Kohima")
    _keep_apart(t, "district")
    created = generate_single_elimination(
        tournament=t, teams=[a, c, d, b], leaf_key=LEAF,
    )
    dist = {tm.id: ("kohima" if tm in (a, b) else "mon") for tm in (a, b, c, d)}
    for m in _opening(created):
        assert dist[m.home_team_id] != dist[m.away_team_id], (
            "round 1 pairs two teams from the same district"
        )


def test_round_robin_keeps_same_tag_teams_apart_in_opening_round():
    admin = _admin("tag-rr@test.local")
    t = _cup(admin, "Tag RR")
    a = _team(t, "A School", "A", attributes={"zone": "north"})
    c = _team(t, "C School", "C", attributes={"zone": "south"})
    d = _team(t, "D School", "D", attributes={"zone": "south"})
    b = _team(t, "B School", "B", attributes={"zone": "north"})
    _keep_apart(t, "tag:zone", scope=f"leaf:{LEAF}")
    created = generate_round_robin_by_category(tournament=t, leaf_key=LEAF)
    zone = {tm.id: ("north" if tm in (a, b) else "south") for tm in (a, b, c, d)}
    opening = [m for m in created if m.round_no == 1]
    assert opening
    for m in opening:
        assert zone[m.home_team_id] != zone[m.away_team_id]


def test_infeasible_keep_apart_degrades_to_named_warning():
    admin = _admin("inf@test.local")
    t = _cup(admin, "Infeasible Cup")
    for i, school in enumerate(["A School", "B School", "C School", "D School"]):
        _team(t, school, f"T{i}", district="Kohima")  # everyone same district
    _keep_apart(t, "district")
    warnings: list = []
    created = generate_round_robin_by_category(
        tournament=t, leaf_key=LEAF, warnings=warnings,
    )
    assert created  # best-effort placement, never an error
    w = next(x for x in warnings if x["code"] == "keep_apart_relaxed")
    assert w["key"] == "district" and w["pairs"]


def test_out_of_scope_records_do_not_apply():
    admin = _admin("scope@test.local")
    t = _cup(admin, "Scope Cup")
    for i, school in enumerate(["A School", "B School", "C School", "D School"]):
        _team(t, school, f"T{i}", district="Kohima")
    _keep_apart(t, "district", scope="leaf:table_tennis")  # other competition
    warnings: list = []
    generate_round_robin_by_category(tournament=t, leaf_key=LEAF,
                                     warnings=warnings)
    assert not warnings  # the record never engaged


def test_generate_api_surfaces_keep_apart_warnings():
    from rest_framework.test import APIClient

    admin = _admin("api@test.local")
    t = _cup(admin, "API Warn Cup")
    for i, school in enumerate(["A School", "B School", "C School", "D School"]):
        _team(t, school, f"T{i}", district="Kohima")
    _keep_apart(t, "district")
    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.post(f"/api/tournaments/{t.id}/generate-fixtures/",
               {"format": "by_category", "leaf_key": LEAF}, format="json")
    assert r.status_code == 201, r.content
    codes = {w["code"] for w in r.json().get("warnings") or []}
    assert "keep_apart_relaxed" in codes


# ----------------------------------------------- until_round is consumed now


class _T:
    """Stand-in — the bracket helper touches .id / .institution_id / .name."""

    def __init__(self, id):
        self.id = id
        self.institution_id = None
        self.name = f"t{id}"


def _bracket_meet(out, km, key) -> int:
    """First round the two `key` teams can meet in the returned seed list."""
    size = 1
    while size < len(out):
        size *= 2
    order = _bracket_order(size)
    a, b = (i for i, tm in enumerate(out) if km.get(tm.id) == key)
    return (order.index(a + 1) ^ order.index(b + 1)).bit_length()


def test_until_round_permits_meetings_at_its_round():
    """``until_round=2`` = apart through round 1 only: an arrangement whose
    same-key pair first meets in round 2 is already legal and stays UNTOUCHED
    (maximal separation would push it to the final instead)."""
    teams = [_T(i) for i in range(8)]
    km = {0: "x", 3: "x"}  # seeds 1+4: same half, first meeting = round 2
    out, conflicts = _separate_bracket_by_key(teams, km, 2)
    assert out == teams and conflicts == []
    # the same input under MAXIMAL separation moves the pair to opposite halves
    out2, conflicts2 = _separate_bracket_by_key(teams, km, None)
    assert _bracket_meet(out2, km, "x") == 3 and conflicts2 == []


def test_until_round_1_still_means_opening_round_separation():
    """Legacy records wrote ``until_round=1`` for the historical opening-round
    repair — 1 aliases 2, so a round-1 same-key pair is still broken up."""
    teams = [_T(i) for i in range(8)]
    km = {3: "x", 4: "x"}  # seeds 4+5 pair up in round 1
    out, conflicts = _separate_bracket_by_key(teams, km, 1)
    assert _bracket_meet(out, km, "x") >= 2 and conflicts == []


def test_stored_school_record_until_round_overrides_builtin_depth():
    admin = _admin("ovr@test.local")
    t = _cup(admin, "Override Cup")
    a1 = _team(t, "A School", "A1")
    b = _team(t, "B School", "B")
    c = _team(t, "C School", "C")
    (a2,) = register_school(
        tournament=t, school_name="A School",
        teams=[{"name": "A2", "sport": "football", "leaf_key": LEAF,
                "players": []}],
    )
    others = [_team(t, f"S{i}", f"s{i}") for i in range(4)]
    teams = [a1, b, c, a2, *others]  # A pair = seeds 1+4: meet at the semi
    record = {"type": "keep_apart_until_round", "scope": "all",
              "params": {"key": "school", "until_round": 2}}
    km = _keep_apart_key_map(t, teams, "school", [])
    warnings: list = []
    plans = plan_single_elimination(
        teams, separators=[(record, km)], warnings=warnings,
    )
    r1_of = {
        tid: p.ref for p in plans if p.round_no == 1
        for tid in (p.home_team_id, p.away_team_id)
    }
    # a semi meeting is legal at until_round=2: both A teams stay in the top
    # half (refs 0+1), untouched, and nothing is relaxed
    assert {r1_of[a1.id], r1_of[a2.id]} == {0, 1}
    assert not any(w.get("code") == "keep_apart_relaxed" for w in warnings)
    # without the record the BUILT-IN pass is maximal: opposite halves
    plans2 = plan_single_elimination(teams)
    r1_of2 = {
        tid: p.ref for p in plans2 if p.round_no == 1
        for tid in (p.home_team_id, p.away_team_id)
    }
    assert (r1_of2[a1.id] < 2) != (r1_of2[a2.id] < 2)


# ---------------------------------------------- groups→knockout cross-seed


def test_repair_same_institution_pairs_swaps_within_clean_pairs():
    """A school winning group 0 and running up group 1 used to meet itself in
    round 1 — the repair swaps it out without re-pairing a group."""
    seeds = ["a1", "y", "x", "a2"]  # bracket pairs: (a1, a2) and (y, x)
    inst_of = {"a1": "A", "a2": "A", "x": None, "y": None}
    group_of = {"a1": 0, "x": 0, "y": 1, "a2": 1}
    _repair_same_institution_pairs(seeds, inst_of, group_of)
    for i, j in _opening_pairs_bracket(4):
        assert inst_of[seeds[i]] is None or inst_of[seeds[i]] != inst_of[seeds[j]]
        assert group_of[seeds[i]] != group_of[seeds[j]]


def test_same_school_qualifiers_from_two_groups_avoid_round_one():
    from apps.fixtures.services.generate import (
        generate_knockout_from_groups,
        generate_round_robin,
    )
    from apps.matches.models import Match
    from apps.matches.services.scoring import record_score

    admin = _admin("gko@test.local")
    t = create_tournament(user=admin, name="GKO Cup")
    register_school(tournament=t, school_name="Alpha",
                    teams=[{"name": "Alpha Blues", "players": []},
                           {"name": "Alpha Reds", "players": []}])
    register_school(tournament=t, school_name="Xavier",
                    teams=[{"name": "Xavier", "players": []}])
    register_school(tournament=t, school_name="York",
                    teams=[{"name": "York", "players": []}])
    generate_round_robin(tournament=t, group_size=2)
    # institution spread puts one Alpha team in each group; score the groups
    # so Alpha WINS one and RUNS UP the other (the cross-seed collision case)
    alpha = {"Alpha Blues", "Alpha Reds"}
    for m in Match.objects.filter(
        tournament=t, stage="group", deleted_at__isnull=True,
    ).select_related("home_team", "away_team"):
        names = {m.home_team.name, m.away_team.name}
        assert len(names & alpha) == 1  # sanity: the spread worked
        alpha_home = m.home_team.name in alpha
        if "Xavier" in names:  # Alpha loses to Xavier, beats York
            hs, as_ = (0, 1) if alpha_home else (1, 0)
        else:
            hs, as_ = (1, 0) if alpha_home else (0, 1)
        record_score(match=m, home_score=hs, away_score=as_, by=admin)
    ko = generate_knockout_from_groups(tournament=t, advance_per_group=2)
    teams = {tm.id: tm for tm in Team.objects.filter(tournament=t)}
    for m in _opening(ko):
        home, away = teams[m.home_team_id], teams[m.away_team_id]
        assert home.institution_id != away.institution_id, (
            f"KO round 1 pairs {home.name} vs {away.name} from one school"
        )


# --------------------------------------------------- grouped-RR pigeonhole


def test_grouped_round_robin_warns_when_pigeonhole_shares_a_group():
    """4 same-district schools into 2 groups of 2: every group co-locates a
    same-key pair — the spread can't fix it, so the record relaxes with a
    named warning (grouping itself is unchanged)."""
    admin = _admin("pig@test.local")
    t = _cup(admin, "Pigeon Cup")
    teams = [_team(t, f"{c} School", c, district="Kohima")
             for c in ("A", "B", "C", "D")]
    record = {"type": "keep_apart_until_round", "scope": "all",
              "params": {"key": "district", "until_round": 1}}
    km = _keep_apart_key_map(t, teams, "district", [])
    warnings: list = []
    plan_round_robin(teams, group_size=2, separators=[(record, km)],
                     warnings=warnings)
    w = next(x for x in warnings if x.get("code") == "keep_apart_relaxed")
    assert w["key"] == "district" and len(w["pairs"]) == 2  # one per group


# ------------------------------------------------------------- scheduler note
def test_scheduler_no_longer_emits_the_pairing_noop_note():
    from datetime import date

    cfg = ScheduleConfig(date_start=date(2026, 8, 1), date_end=date(2026, 8, 1))
    notes = merge_stored_constraints(cfg, [
        {"type": "keep_apart_until_round", "params": {"key": "school",
                                                      "until_round": 1}},
    ])
    assert notes == []  # pairing-layer record: silently out of scope here
