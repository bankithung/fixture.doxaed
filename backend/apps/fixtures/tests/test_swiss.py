"""TDD — Swiss system (deferred-formats increment P): ROUND-AT-A-TIME
generation. ``format="swiss"`` draws only round 1 (seed-halves: top half vs
bottom half); ``POST /api/tournaments/{id}/fixtures/next-round/`` pairs the
next round by standings (points then GD), avoiding rematches via greedy
backtracking, refusing while the current round has unfinished matches
(``round_incomplete``), idempotent per round on ``event_id``. Odd entrant
counts give one team a BYE per round — no phantom Match rows (compute_standings
skips None-team matches, so a bye Match would count for nothing): byes are
stored in ``draw_config[leaf]["swiss_byes"]`` and credit full win points
inside the Swiss pairing standings."""
from __future__ import annotations

import random
import uuid
from collections import Counter
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.fixtures.services.generate import (
    _swiss_pairs,
    default_swiss_rounds,
    generate_swiss,
    generate_swiss_next_round,
)
from apps.matches.models import Match
from apps.matches.services.scoring import record_score
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str = "org@test.local") -> User:
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _swiss(admin, n: int, **kwargs):
    t = create_tournament(user=admin, name="Swiss Cup")
    teams = register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i + 1}", "players": []} for i in range(n)],
    )
    matches = generate_swiss(tournament=t, teams=teams, **kwargs)
    return t, teams, matches


def _names(m: Match) -> frozenset:
    return frozenset((m.home_team.name, m.away_team.name))


def test_default_swiss_rounds_is_ceil_log2_capped():
    assert default_swiss_rounds(2) == 1
    assert default_swiss_rounds(3) == 2  # ceil(log2 3) = 2 = cap (n-1)
    assert default_swiss_rounds(4) == 2
    assert default_swiss_rounds(5) == 3
    assert default_swiss_rounds(6) == 3
    assert default_swiss_rounds(8) == 3
    assert default_swiss_rounds(9) == 4
    assert default_swiss_rounds(16) == 4


def test_round1_pairs_seed_halves():
    admin = _verified()
    _t, _teams, matches = _swiss(admin, 8)
    assert len(matches) == 4  # ONLY round 1 — Swiss is round-at-a-time
    assert all(m.stage == "swiss" and m.round_no == 1 for m in matches)
    assert all(m.group_label == "Swiss" for m in matches)
    ordered = sorted(matches, key=lambda m: m.match_no)
    # top half (1-4) vs bottom half (5-8), in seed order
    assert [(m.home_team.name, m.away_team.name) for m in ordered] == [
        ("T1", "T5"), ("T2", "T6"), ("T3", "T7"), ("T4", "T8"),
    ]
    assert ordered[0].home_source == {
        "type": "team", "team_id": str(ordered[0].home_team_id)
    }


def test_round1_idempotent_per_scope():
    admin = _verified()
    t, teams, matches = _swiss(admin, 4)
    again = generate_swiss(tournament=t, teams=teams)
    assert {m.id for m in again} == {m.id for m in matches}
    assert Match.objects.filter(tournament=t, deleted_at__isnull=True).count() == 2


def test_next_round_refuses_while_round_unfinished():
    admin = _verified()
    t, _teams, matches = _swiss(admin, 4)
    with pytest.raises(ValueError, match="round_incomplete"):
        generate_swiss_next_round(tournament=t)
    record_score(match=matches[0], home_score=1, away_score=0, by=admin)
    with pytest.raises(ValueError, match="round_incomplete"):
        generate_swiss_next_round(tournament=t)


def test_next_round_refuses_before_round1():
    admin = _verified()
    t = create_tournament(user=admin, name="Empty Swiss")
    with pytest.raises(ValueError, match="swiss_not_started"):
        generate_swiss_next_round(tournament=t)


def test_next_round_pairs_by_standings_avoiding_rematches():
    admin = _verified()
    t, teams, matches = _swiss(admin, 8)
    by_name = {tm.name: tm for tm in teams}
    # Home (top-half) wins with descending margins → standings
    # T1(gd4) T2(gd3) T3(gd2) T4(gd1) then T8(-1) T7(-2) T6(-3) T5(-4).
    margins = {"T1": 4, "T2": 3, "T3": 2, "T4": 1}
    for m in matches:
        record_score(
            match=m, home_score=margins[m.home_team.name], away_score=0, by=admin
        )
    created = generate_swiss_next_round(tournament=t)
    assert all(m.round_no == 2 and m.stage == "swiss" for m in created)
    pairs = {_names(m) for m in created}
    assert pairs == {
        frozenset(("T1", "T2")), frozenset(("T3", "T4")),
        frozenset(("T8", "T7")), frozenset(("T6", "T5")),
    }
    # no rematches against round 1
    r1 = {_names(m) for m in matches}
    assert not pairs & r1
    assert by_name["T1"].id  # sanity: teams resolved


def test_swiss_pairs_backtracks_over_greedy_dead_end():
    a, b, c, d = (
        SimpleNamespace(id=i, name=n)
        for i, n in enumerate(["A", "B", "C", "D"])
    )
    played = {frozenset((c.id, d.id))}
    # Greedy would take (A,B) and strand the played pair (C,D); backtracking
    # swaps to (A,C),(B,D).
    assert _swiss_pairs([a, b, c, d], played) == [(a, c), (b, d)]
    # No rematch-free perfect matching → None (caller falls back + warns)
    assert _swiss_pairs([a, b], {frozenset((a.id, b.id))}) is None


def test_unavoidable_rematch_falls_back_with_warning():
    admin = _verified()
    t, _teams, matches = _swiss(admin, 2)
    record_score(match=matches[0], home_score=1, away_score=0, by=admin)
    warnings: list = []
    created = generate_swiss_next_round(
        tournament=t, swiss_rounds=2, warnings=warnings
    )
    assert len(created) == 1 and created[0].round_no == 2
    assert any(w["code"] == "swiss_rematch_unavoidable" for w in warnings)


def test_odd_count_byes_stored_and_credited():
    admin = _verified()
    t, teams, matches = _swiss(admin, 5)
    assert len(matches) == 2  # (T1,T3),(T2,T4) — T5 (lowest seed) sits out
    by_name = {tm.name: tm for tm in teams}
    byes = (t.draw_config or {}).get("*", {}).get("swiss_byes")
    assert byes == [{"round": 1, "team_id": str(by_name["T5"].id)}]

    ordered = sorted(matches, key=lambda m: m.match_no)
    assert [_names(m) for m in ordered] == [
        frozenset(("T1", "T3")), frozenset(("T2", "T4")),
    ]
    record_score(match=ordered[0], home_score=4, away_score=0, by=admin)  # T1
    record_score(match=ordered[1], home_score=1, away_score=0, by=admin)  # T2
    created = generate_swiss_next_round(tournament=t)
    t.refresh_from_db()
    # Bye credit: T5 pairs as a 3-point team (order T1,T2,T5,T4) — without the
    # credit it would sit bottom and the round-2 bye would fall elsewhere.
    assert {_names(m) for m in created} == {
        frozenset(("T1", "T2")), frozenset(("T5", "T4")),
    }
    # Round-2 bye: fewest byes first (T5 excluded), lowest standing → T3.
    assert (t.draw_config or {}).get("*", {}).get("swiss_byes")[1] == {
        "round": 2, "team_id": str(by_name["T3"].id)
    }


def test_swiss_complete_after_final_round():
    admin = _verified()
    t, _teams, matches = _swiss(admin, 2)  # default rounds = 1
    record_score(match=matches[0], home_score=2, away_score=1, by=admin)
    with pytest.raises(ValueError, match="swiss_complete"):
        generate_swiss_next_round(tournament=t)


def test_swiss_rounds_override_allows_extra_round():
    admin = _verified()
    t, _teams, matches = _swiss(admin, 4)  # default = 2 rounds
    record_score(match=matches[0], home_score=1, away_score=0, by=admin)
    record_score(match=matches[1], home_score=0, away_score=1, by=admin)
    r2 = generate_swiss_next_round(tournament=t)
    for m in r2:
        record_score(match=m, home_score=1, away_score=0, by=admin)
    with pytest.raises(ValueError, match="swiss_complete"):
        generate_swiss_next_round(tournament=t)
    r3 = generate_swiss_next_round(tournament=t, swiss_rounds=3)
    assert all(m.round_no == 3 for m in r3)
    # round 3 is the forced complement — no rematches across all 3 rounds
    seen = [
        _names(m)
        for m in Match.objects.filter(tournament=t, deleted_at__isnull=True)
        .select_related("home_team", "away_team")
    ]
    assert len(seen) == len(set(seen)) == 6  # full round robin, no repeats


def test_generate_api_swiss_round_at_a_time():
    from apps.fixtures.services.draw_config import update_draw_config

    admin = _verified()
    t = create_tournament(user=admin, name="API Swiss")
    t.sports = normalize_sports([{"name": "Football", "nodes": [{"name": "U15"}]}])
    t.save(update_fields=["sports"])
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i + 1}", "leaf_key": "football.u15",
                "sport": "football", "players": []} for i in range(8)],
    )
    update_draw_config(
        tournament=t, leaf_key="football.u15",
        partial={"format": "swiss", "swiss_rounds": 3},
        by=admin, event_id=uuid.uuid4(),
    )
    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.post(
        f"/api/tournaments/{t.id}/generate-fixtures/",
        {"leaf_key": "football.u15"}, format="json",
    )
    assert r.status_code == 201, r.content
    assert r.json() == {**r.json(), "generated": 4, "format": "swiss"}
    matches = Match.objects.filter(tournament=t, deleted_at__isnull=True)
    assert matches.count() == 4  # round 1 only
    assert all(m.group_label == "Football — U15 — Swiss" for m in matches)

    # readiness gate: next round refuses while round 1 is unfinished
    r = c.post(
        f"/api/tournaments/{t.id}/fixtures/next-round/",
        {"leaf_key": "football.u15"}, format="json",
    )
    assert r.status_code == 400
    assert "round_incomplete" in r.content.decode()

    for m in matches:
        record_score(match=m, home_score=2, away_score=0, by=admin)
    r = c.post(
        f"/api/tournaments/{t.id}/fixtures/next-round/",
        {"leaf_key": "football.u15"}, format="json",
    )
    assert r.status_code == 201, r.content
    body = r.json()
    assert body["generated"] == 4 and body["round_no"] == 2
    assert len(body["matches"]) == 4
    assert Match.objects.filter(
        tournament=t, deleted_at__isnull=True, round_no=2
    ).count() == 4
    # swiss_rounds from the STORED draw config gates the round count: rounds
    # 2 and 3 exist, a 4th refuses with swiss_complete.
    for m in Match.objects.filter(tournament=t, round_no=2):
        record_score(match=m, home_score=1, away_score=0, by=admin)
    assert c.post(
        f"/api/tournaments/{t.id}/fixtures/next-round/",
        {"leaf_key": "football.u15"}, format="json",
    ).status_code == 201
    for m in Match.objects.filter(tournament=t, round_no=3):
        record_score(match=m, home_score=1, away_score=0, by=admin)
    r = c.post(
        f"/api/tournaments/{t.id}/fixtures/next-round/",
        {"leaf_key": "football.u15"}, format="json",
    )
    assert r.status_code == 400
    assert "swiss_complete" in r.content.decode()


def test_next_round_endpoint_idempotent_on_event_id():
    admin = _verified()
    t, _teams, matches = _swiss(admin, 4)
    for m in matches:
        record_score(match=m, home_score=2, away_score=1, by=admin)
    c = APIClient()
    c.force_authenticate(user=admin)
    eid = str(uuid.uuid4())
    first = c.post(
        f"/api/tournaments/{t.id}/fixtures/next-round/",
        {"event_id": eid}, format="json",
    )
    assert first.status_code == 201, first.content
    # replay (invariant 3): 200, same payload, NO third round-2 pairings
    replay = c.post(
        f"/api/tournaments/{t.id}/fixtures/next-round/",
        {"event_id": eid}, format="json",
    )
    assert replay.status_code == 200
    assert replay.json() == first.json()
    assert Match.objects.filter(
        tournament=t, deleted_at__isnull=True, round_no=2
    ).count() == 2


def test_no_rematch_property_full_8_team_3_round_run():
    """Spec property: a full 8-team, 3-round Swiss run (deterministic seeded
    results) repeats NO pairing, plays every team exactly once per round and
    refuses a 4th round."""
    admin = _verified()
    t, _teams, _matches = _swiss(admin, 8)
    rng = random.Random(20260612)
    all_pairs: list[frozenset] = []
    for round_no in (1, 2, 3):
        current = list(
            Match.objects.filter(
                tournament=t, round_no=round_no, deleted_at__isnull=True
            ).select_related("home_team", "away_team")
        )
        assert len(current) == 4
        all_pairs += [_names(m) for m in current]
        for m in current:
            record_score(
                match=m, home_score=rng.randrange(0, 5),
                away_score=rng.randrange(0, 5), by=admin,
            )
        if round_no < 3:
            warnings: list = []
            created = generate_swiss_next_round(tournament=t, warnings=warnings)
            assert len(created) == 4
            assert not warnings  # rematch-free pairing always exists here
    assert len(all_pairs) == 12
    assert len(set(all_pairs)) == 12  # the no-rematch property
    counts = Counter(name for pair in all_pairs for name in pair)
    assert set(counts.values()) == {3}  # every team plays each round
    with pytest.raises(ValueError, match="swiss_complete"):
        generate_swiss_next_round(tournament=t)


def test_draw_config_validates_swiss_keys():
    from apps.fixtures.services.draw_config import merge_draw_config

    assert merge_draw_config({"format": "swiss"})["format"] == "swiss"
    assert merge_draw_config({"swiss_rounds": 5})["swiss_rounds"] == 5
    assert merge_draw_config({"swiss_rounds": None})["swiss_rounds"] is None
    with pytest.raises(ValueError):
        merge_draw_config({"swiss_rounds": 0})
    with pytest.raises(ValueError):
        merge_draw_config({"swiss_byes": "nope"})


def test_swiss_byes_excluded_from_inputs_hash():
    from apps.fixtures.services.generate import compute_inputs_hash

    admin = _verified()
    t, _teams, _matches = _swiss(admin, 5)  # persists a round-1 bye
    before = compute_inputs_hash(t, None)
    t.refresh_from_db()
    assert (t.draw_config or {}).get("*", {}).get("swiss_byes")
    assert compute_inputs_hash(t, None) == before  # bookkeeping, not an input


def test_preview_plans_swiss_round1_without_persisting():
    from apps.fixtures.services.preview import preview_fixtures

    admin = _verified()
    t = create_tournament(user=admin, name="Preview Swiss")
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i + 1}", "players": []} for i in range(8)],
    )
    body = preview_fixtures(
        tournament=t, draw={"format": "swiss"}, include_schedule=False,
    )
    swiss = [m for m in body["matches"] if m["stage"] == "swiss"]
    assert len(swiss) == 4 and all(m["round_no"] == 1 for m in swiss)
    assert Match.objects.filter(tournament=t).count() == 0  # pure simulate
