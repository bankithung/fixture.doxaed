"""Set/game-based scoring (Table Tennis, Sepak Takraw) — compute + API path,
without disturbing football's goal scoring."""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError as DjangoValidationError
from django.utils import timezone
from rest_framework.test import APIClient

from apps.matches.models import Match, MatchStatus
from apps.matches.services.set_scoring import compute_sets, rules_for_match
from apps.teams.models import Team
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.rules import merge_rules

User = get_user_model()
pytestmark = pytest.mark.django_db

TT = {"type": "sets", "points": 11, "win_by": 2, "cap": None, "best_of": 3}
SEPAK = {"type": "sets", "points": 21, "win_by": 2, "cap": 25, "best_of": 3}


def _admin(email="s@test.local"):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _two_teams(t):
    register_school(
        tournament=t, school_name="MH",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
    )
    return list(Team.objects.filter(tournament=t).order_by("name"))


def _match(t, sport=""):
    teams = _two_teams(t)
    return Match.objects.create(
        organization=t.organization, tournament=t, sport=sport,
        home_team=teams[0], away_team=teams[1], status=MatchStatus.SCHEDULED,
    )


def test_compute_sets_table_tennis():
    assert compute_sets([[11, 8], [11, 9]], TT) == (2, 0)
    assert compute_sets([[11, 8], [7, 11], [11, 9]], TT) == (2, 1)


def test_compute_sets_rejects_illegal():
    for bad in (
        [[11, 8], [11, 8], [11, 8]],  # 3-0 impossible in best-of-3
        [[5, 3], [11, 9]],            # set below target (11)
        [[11, 10], [11, 9]],          # win-by < 2 with no cap
        [[11, 8]],                    # match not decided (1-0)
        [[11, 11]],                   # tied set
    ):
        with pytest.raises(Exception):
            compute_sets(bad, TT)


def test_sepak_cap_rules():
    assert compute_sets([[25, 24], [21, 18]], SEPAK) == (2, 0)  # 25-24 wins at cap
    with pytest.raises(Exception):
        compute_sets([[26, 24], [21, 18]], SEPAK)               # above the cap


def test_api_records_set_scores_for_tt_match():
    admin = _admin()
    t = create_tournament(user=admin, name="TT Cup")
    m = _match(t, sport="table_tennis")
    c = APIClient()
    c.force_authenticate(user=admin)

    r = c.post(
        f"/api/matches/{m.id}/score/",
        {"set_scores": [[11, 8], [9, 11], [11, 6]], "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 200, r.content
    m.refresh_from_db()
    assert m.status == MatchStatus.COMPLETED
    assert (m.home_score, m.away_score) == (2, 1)  # sets won
    assert m.set_scores == [[11, 8], [9, 11], [11, 6]]


VOLLEY = {"type": "sets", "points": 25, "win_by": 2, "cap": None, "best_of": 5,
          "deciding": {"points": 15, "win_by": 2, "cap": None}}
SEPAK_FULL = {"type": "sets", "points": 21, "win_by": 2, "cap": 25, "best_of": 3,
              "deciding": {"points": 15, "win_by": 2, "cap": 17}}


def test_volleyball_profile_exists_and_is_set_based():
    from apps.matches.services.set_scoring import (
        SPORT_PROFILES,
        is_set_based,
        scoring_rules,
    )

    assert is_set_based("volleyball")
    rules = scoring_rules("volleyball")
    assert rules["best_of"] == 5 and rules["points"] == 25
    assert rules["deciding"]["points"] == 15
    assert SPORT_PROFILES["football"]["scoring"]["type"] == "goals"
    assert SPORT_PROFILES["sepak_takraw"]["scoring"]["deciding"] == {
        "points": 15, "win_by": 2, "cap": 17,
    }


def test_deciding_set_uses_its_own_numbers():
    # volleyball: 5th set to 15 (win by 2) — full-length deciders are valid
    assert compute_sets(
        [[25, 20], [20, 25], [25, 23], [23, 25], [15, 13]], VOLLEY
    ) == (3, 2)
    # a 13-point 5th set is below the deciding target
    with pytest.raises(DjangoValidationError):
        compute_sets([[25, 20], [20, 25], [25, 23], [23, 25], [13, 11]], VOLLEY)
    # sepak takraw tiebreak: to 15 cap 17 — a 21-point 3rd set is illegal
    assert compute_sets([[21, 18], [19, 21], [15, 13]], SEPAK_FULL) == (2, 1)
    assert compute_sets([[21, 18], [19, 21], [17, 16]], SEPAK_FULL) == (2, 1)
    with pytest.raises(DjangoValidationError):
        compute_sets([[21, 18], [19, 21], [21, 19]], SEPAK_FULL)


def test_sets_after_decision_rejected():
    # 2-0 already decides a best-of-3; a third set is physically impossible
    with pytest.raises(DjangoValidationError):
        compute_sets([[11, 8], [11, 8], [11, 5]], TT)


# --- per-game (leaf) scoring resolution (owner: "everything is per game") ----

def _tt_match_with(t, *, leaf_key, sport="table_tennis"):
    m = _match(t, sport=sport)
    m.leaf_key = leaf_key
    m.save(update_fields=["leaf_key"])
    return Match.objects.select_related("tournament").get(pk=m.pk)


def test_rules_for_match_leaf_override_beats_sport():
    admin = _admin()
    t = create_tournament(user=admin, name="TT Cup")
    # per-SPORT default = best-of-3 to 21; per-GAME override = best-of-3 to 15 cap 17
    t.sports = [{"key": "table_tennis", "label": "Table Tennis",
                 "scoring": {"type": "sets", "best_of": 3, "points": 21,
                             "win_by": 2, "cap": None}}]
    t.rules = merge_rules({"by_leaf": {"tt.open": {"scoring": {
        "type": "sets", "best_of": 3, "points": 15, "win_by": 2, "cap": 17}}}})
    t.save(update_fields=["sports", "rules"])
    m = _tt_match_with(t, leaf_key="tt.open")
    rules = rules_for_match(m)
    assert rules["points"] == 15 and rules["cap"] == 17  # the game's own rule wins


def test_rules_for_match_falls_back_to_sport_without_leaf_override():
    admin = _admin()
    t = create_tournament(user=admin, name="TT Cup")
    t.sports = [{"key": "table_tennis", "label": "Table Tennis",
                 "scoring": {"type": "sets", "best_of": 3, "points": 21,
                             "win_by": 2, "cap": None}}]
    t.save(update_fields=["sports"])
    m = _tt_match_with(t, leaf_key="tt.u14")  # no by_leaf entry for this game
    assert rules_for_match(m)["points"] == 21  # the per-sport default


def test_rules_for_match_leaf_goals_override_turns_set_sport_goal_based():
    admin = _admin()
    t = create_tournament(user=admin, name="TT Cup")
    t.sports = [{"key": "table_tennis", "label": "Table Tennis",
                 "scoring": {"type": "sets", "best_of": 3, "points": 21,
                             "win_by": 2, "cap": None}}]
    t.rules = merge_rules({"by_leaf": {"tt.open": {"scoring": {"type": "goals"}}}})
    t.save(update_fields=["sports", "rules"])
    m = _tt_match_with(t, leaf_key="tt.open")
    assert rules_for_match(m) is None  # goal-based → no set rules


def test_set_sport_requires_set_scores_on_goal_path():
    admin = _admin()
    t = create_tournament(user=admin, name="TT Cup")
    m = _match(t, sport="table_tennis")
    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.post(
        f"/api/matches/{m.id}/score/",
        {"home_score": 2, "away_score": 1, "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "set_scores_required"
    m.refresh_from_db()
    assert m.status == MatchStatus.SCHEDULED  # untouched


def test_goal_events_blocked_on_set_based_match():
    admin = _admin()
    t = create_tournament(user=admin, name="TT Cup")
    m = _match(t, sport="table_tennis")
    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.post(
        f"/api/matches/{m.id}/events/",
        {"event_type": "goal", "side": "home", "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 400
    m.refresh_from_db()
    assert (m.home_score, m.away_score) == (None, None)  # mirror not clobbered


def test_tournament_override_changes_rules_and_serializer_exposes_them():
    admin = _admin()
    t = create_tournament(user=admin, name="VB Cup")
    t.sports = [{"key": "volleyball", "name": "Volleyball", "custom": False,
                 "scoring": {"type": "sets", "best_of": 3, "points": 25,
                             "win_by": 2, "cap": None,
                             "deciding": {"points": 15}}}]
    t.save(update_fields=["sports"])
    m = _match(t, sport="volleyball")
    c = APIClient()
    c.force_authenticate(user=admin)

    # school short format (Bo3) from the override; 3rd set to 15
    r = c.post(
        f"/api/matches/{m.id}/score/",
        {"set_scores": [[25, 20], [23, 25], [15, 11]],
         "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 200, r.content
    body = r.json()
    assert body["scoring"]["best_of"] == 3  # resolved rules on the payload
    m.refresh_from_db()
    assert (m.home_score, m.away_score) == (2, 1)


def test_set_result_publishes_live_update(django_capture_on_commit_callbacks):
    from unittest import mock

    from apps.matches.services.set_scoring import record_set_result

    admin = _admin()
    t = create_tournament(user=admin, name="TT Cup")
    m = _match(t, sport="table_tennis")
    with mock.patch(
        "apps.matches.services.events.publish_match_event"
    ) as pub:
        with django_capture_on_commit_callbacks(execute=True):
            record_set_result(
                match=m, set_scores=[[11, 8], [11, 9]], rules=TT, by=admin,
            )
    # Dual fan-out (control room spec 2026-06-12 §2.c): the match WS room
    # message (event_id=None → snapshot refetch) + a tournament "score" tick.
    pub.assert_called_once_with(m.id, None, m.tournament_id, kind="score")


def test_goal_sport_rejects_sets_but_goals_still_work():
    admin = _admin()
    t = create_tournament(user=admin, name="FB")
    m = _match(t, sport="")  # no sport -> goal-based
    c = APIClient()
    c.force_authenticate(user=admin)

    # set_scores rejected for a non-set sport
    assert c.post(
        f"/api/matches/{m.id}/score/",
        {"set_scores": [[11, 8], [11, 9]]}, format="json",
    ).status_code == 400

    # goal scoring still works
    r = c.post(
        f"/api/matches/{m.id}/score/",
        {"home_score": 3, "away_score": 1, "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 200, r.content
    m.refresh_from_db()
    assert (m.home_score, m.away_score) == (3, 1)
    assert m.status == MatchStatus.COMPLETED


# ---- Live tap scoring (progress mode, owner 2026-07-03) --------------------


def _live_tt_match(admin):
    t = create_tournament(user=admin, name="TT Live Cup")
    m = _match(t, sport="table_tennis")
    m.status = MatchStatus.LIVE
    m.save(update_fields=["status"])
    return m


def test_progress_updates_points_without_completing():
    admin = _admin()
    m = _live_tt_match(admin)
    c = APIClient()
    c.force_authenticate(user=admin)

    # Mid-set points: tied/in-progress sets are legal in progress mode.
    r = c.post(
        f"/api/matches/{m.id}/score/",
        {"set_scores": [[5, 3]], "progress": True, "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 200, r.content
    m.refresh_from_db()
    assert m.status == MatchStatus.LIVE  # NOT completed
    assert m.set_scores == [[5, 3]]
    assert (m.home_score, m.away_score) == (0, 0)  # no set decided yet

    # First set decided, second under way -> sets-won mirrors 1-0 live.
    r = c.post(
        f"/api/matches/{m.id}/score/",
        {"set_scores": [[11, 7], [2, 2]], "progress": True,
         "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 200, r.content
    m.refresh_from_db()
    assert m.status == MatchStatus.LIVE
    assert m.set_scores == [[11, 7], [2, 2]]
    assert (m.home_score, m.away_score) == (1, 0)


def test_progress_rejected_unless_live():
    admin = _admin()
    t = create_tournament(user=admin, name="TT Sched")
    m = _match(t, sport="table_tennis")  # scheduled
    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.post(
        f"/api/matches/{m.id}/score/",
        {"set_scores": [[1, 0]], "progress": True, "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 400


def test_progress_idempotent_on_event_id():
    admin = _admin()
    m = _live_tt_match(admin)
    c = APIClient()
    c.force_authenticate(user=admin)
    eid = str(uuid.uuid4())
    payload = {"set_scores": [[7, 5]], "progress": True, "event_id": eid}
    assert c.post(f"/api/matches/{m.id}/score/", payload, format="json").status_code == 200
    # Replay with the SAME event_id but different points: no change applied.
    replay = {"set_scores": [[9, 9]], "progress": True, "event_id": eid}
    assert c.post(f"/api/matches/{m.id}/score/", replay, format="json").status_code == 200
    m.refresh_from_db()
    assert m.set_scores == [[7, 5]]


def test_progress_publishes_score_tick(django_capture_on_commit_callbacks):
    from unittest.mock import patch

    admin = _admin()
    m = _live_tt_match(admin)
    from apps.matches.services.set_scoring import update_set_progress

    with patch("apps.matches.services.events.publish_match_event") as pub:
        with django_capture_on_commit_callbacks(execute=True):
            update_set_progress(
                match=m, set_scores=[[3, 1]], rules=TT, by=admin,
            )
    pub.assert_called_once_with(m.id, None, m.tournament_id, kind="score")


def test_progress_still_leaves_completion_to_record_result():
    """The finish flow is unchanged: after live progress, recording the full
    result completes the match with validated sets."""
    admin = _admin()
    m = _live_tt_match(admin)
    c = APIClient()
    c.force_authenticate(user=admin)
    c.post(
        f"/api/matches/{m.id}/score/",
        {"set_scores": [[11, 7], [10, 8]], "progress": True,
         "event_id": str(uuid.uuid4())},
        format="json",
    )
    r = c.post(
        f"/api/matches/{m.id}/score/",
        {"set_scores": [[11, 7], [11, 8]], "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 200, r.content
    m.refresh_from_db()
    assert m.status == MatchStatus.COMPLETED
    assert (m.home_score, m.away_score) == (2, 0)


def test_sets_won_raw_counts_leads():
    from apps.matches.services.set_scoring import sets_won_raw

    assert sets_won_raw([[12, 7], [11, 10], [8, 6]]) == (3, 0)
    assert sets_won_raw([[5, 7], [9, 3]]) == (1, 1)
    assert sets_won_raw([]) == (0, 0)


def test_completion_derives_raw_set_leads_when_rules_never_satisfied():
    """Owner report 2026-07-04: sepak sets entered to 12/11/8 (below the
    21-point target) kept the lenient live mirror at 0-0, and ending the
    match completed a clearly decided 3-0 as a phantom draw. Completion now
    falls back to raw per-set leads."""
    from apps.matches.services.state import transition_match

    admin = _admin("raw@test.local")
    t = create_tournament(user=admin, name="Raw Sepak")
    m = _match(t, sport="sepak_takraw")
    transition_match(match=m, to_status=MatchStatus.LIVE, by=admin)
    Match.objects.filter(pk=m.pk).update(
        set_scores=[[12, 7], [11, 10], [8, 6]], home_score=0, away_score=0,
    )
    m.refresh_from_db()
    transition_match(match=m, to_status=MatchStatus.COMPLETED, by=admin)
    m.refresh_from_db()
    assert (m.home_score, m.away_score) == (3, 0)
