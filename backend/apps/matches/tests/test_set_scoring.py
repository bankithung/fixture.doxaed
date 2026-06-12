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
from apps.matches.services.set_scoring import compute_sets
from apps.teams.models import Team
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

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
