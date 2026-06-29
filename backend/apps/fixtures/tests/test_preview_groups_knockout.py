"""TDD — the dry-run preview includes the WHOLE two-stage groups→knockout plan
with times (Gap 1/3): the group round-robin AND a PLACEHOLDER knockout drawn
from group-position pointers, timed after the groups (stage_no=1), for BOTH a
flat ``format="groups_knockout"`` and an explicit ``stages`` plan — and with
best-thirds the placeholder bracket carries the eventual committed SIZE. Pure:
nothing is persisted (``Match.objects.count() == 0`` after every call)."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.fixtures.services.preview import preview_fixtures
from apps.matches.models import Match
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()
pytestmark = pytest.mark.django_db

LEAF = "football.u15"

SCHEDULE = {
    "date_start": "2026-08-01", "date_end": "2026-08-14",
    "daily_start": "09:00", "daily_end": "18:00", "slot_minutes": 60,
    "venues": ["G"], "rest_minutes": 0, "max_per_team_per_day": 6,
}


def _verified(email):
    u = User.objects.create_user(
        email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _tournament(admin):
    t = create_tournament(user=admin, name="Cup")
    t.sports = normalize_sports([{"name": "Football", "nodes": [{"name": "U15"}]}])
    t.save(update_fields=["sports"])
    return t


def _register(t, n, *, school="S"):
    register_school(
        tournament=t, school_name=school,
        teams=[{"name": f"{school} T{i}", "leaf_key": LEAF, "sport": "football",
                "players": []} for i in range(n)],
    )


def _assert_two_stage(out):
    """Shared assertions for a previewed two-stage groups→knockout draw."""
    groups = [m for m in out["matches"] if m["stage"] == "group"]
    knockout = [m for m in out["matches"] if m["stage"] == "knockout"]
    assert groups, "the group stage must be previewed"
    assert knockout, "the placeholder knockout must be previewed"

    # Round-1 knockout sides are typed group-position pointers (filled live).
    r1 = [m for m in knockout if m["round_no"] == 1]
    assert r1
    for m in r1:
        for side in (m["home"], m["away"]):
            src = side["source"]
            assert src["type"] == "group_position"
            # a normal qualifier carries group_label + position; a best-third
            # carries best_third + rank instead.
            assert ("group_label" in src and "position" in src) \
                or (src.get("best_third") and "rank" in src)

    # Every knockout match is scheduled, and after the last group match.
    assert all(m["scheduled_at"] for m in knockout)
    assert all(m["scheduled_at"] for m in groups)
    last_group = max(m["scheduled_at"] for m in groups)
    assert min(m["scheduled_at"] for m in knockout) >= last_group


def test_flat_groups_knockout_previews_placeholder_knockout_with_times():
    admin = _verified("a@test.local")
    t = _tournament(admin)
    _register(t, 6)  # group_size 3 → 2 groups of 3
    out = preview_fixtures(
        tournament=t, leaf_key=LEAF,
        draw={"format": "groups_knockout", "group_size": 3,
              "advance_per_group": 2},
        schedule=SCHEDULE, include_schedule=True,
    )
    _assert_two_stage(out)
    # 2 groups of 3 → 4 qualifiers → a 4-team bracket (2 semis + final).
    knockout = [m for m in out["matches"] if m["stage"] == "knockout"]
    assert len([m for m in knockout if m["round_no"] == 1]) == 2
    assert Match.objects.count() == 0  # nothing persisted (tenet 3)


def test_explicit_stages_groups_knockout_previews_placeholder_knockout():
    admin = _verified("a@test.local")
    t = _tournament(admin)
    _register(t, 6)
    t.draw_config = {LEAF: {"stages": [
        {"id": "grp", "type": "round_robin", "group_size": 3},
        {"id": "ko", "type": "knockout",
         "from": {"stage": "grp", "advance_per_group": 2}},
    ]}}
    t.save(update_fields=["draw_config"])
    out = preview_fixtures(
        tournament=t, leaf_key=LEAF, schedule=SCHEDULE, include_schedule=True,
    )
    _assert_two_stage(out)
    knockout = [m for m in out["matches"] if m["stage"] == "knockout"]
    assert len([m for m in knockout if m["round_no"] == 1]) == 2
    assert Match.objects.count() == 0


def test_best_thirds_placeholder_bracket_has_committed_size():
    admin = _verified("a@test.local")
    t = _tournament(admin)
    _register(t, 9)  # group_size 3 → 3 groups of 3
    out = preview_fixtures(
        tournament=t, leaf_key=LEAF,
        draw={"format": "groups_knockout", "group_size": 3,
              "advance_per_group": 2, "advance_best_thirds": 2},
        include_schedule=False,
    )
    knockout = [m for m in out["matches"] if m["stage"] == "knockout"]
    # 2*3 + 2 = 8 qualifiers → a full 8-team bracket: 4 first-round matches.
    assert len([m for m in knockout if m["round_no"] == 1]) == 4

    # Exactly the two best-third placeholder tokens are present and labelled.
    best_thirds = [
        side["source"]
        for m in knockout for side in (m["home"], m["away"])
        if side.get("source", {}).get("best_third")
    ]
    assert len(best_thirds) == 2
    assert {s["rank"] for s in best_thirds} == {1, 2}
    assert all("group_label" not in s for s in best_thirds)
    assert Match.objects.count() == 0


def test_overall_reseed_previews_same_size_as_cross():
    """``knockout_seeding="overall"`` cannot know true overall rank pre-results,
    so preview reuses the positional cross-seed placement — same bracket size."""
    admin = _verified("a@test.local")
    t = _tournament(admin)
    _register(t, 6)
    out = preview_fixtures(
        tournament=t, leaf_key=LEAF,
        draw={"format": "groups_knockout", "group_size": 3,
              "advance_per_group": 2, "knockout_seeding": "overall"},
        include_schedule=False,
    )
    knockout = [m for m in out["matches"] if m["stage"] == "knockout"]
    assert len([m for m in knockout if m["round_no"] == 1]) == 2
    for m in knockout:
        if m["round_no"] == 1:
            assert m["home"]["source"]["type"] == "group_position"
    assert Match.objects.count() == 0
