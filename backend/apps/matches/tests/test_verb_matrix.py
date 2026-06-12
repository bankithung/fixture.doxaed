"""Control room, increment 5 — verb tightening (spec 2026-06-12 §2.e + §4,
owner decisions 2026-06-12):

- walkover and replay (abandoned→scheduled) are MANAGER-only — any scorer
  could previously reach them through TransitionMatchView;
- referees may transition their ASSIGNED matches (Match.scorer) but never
  record or VOID events — transition-only officials unless explicitly
  granted the scoring console;
- shootout stays scorer-recordable (gate unchanged).

Parametrized over all 6 tournament roles x the control-room verbs."""
from __future__ import annotations

import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.utils import timezone
from rest_framework.test import APIClient

from apps.matches.models import Match, MatchStatus
from apps.teams.services.registration import register_school
from apps.tournaments.models import (
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
)
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db

R = TournamentMembershipRole


def _verified(email: str):
    u = User.objects.create_user(
        email=email, password="FixtureDemo2026!", is_active=True
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _client(user) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _setup(role: str | None = None, *, stage: str = ""):
    """Tournament + one match; optionally an extra member with ``role``."""
    call_command("load_modules")  # role-default modules (two-layer RBAC)
    admin = _verified(f"vm-{uuid.uuid4().hex[:8]}@test.local")
    t = create_tournament(user=admin, name="Verb Cup")
    a, b = register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
    )
    tz = ZoneInfo(t.time_zone)
    m = Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b,
        stage=stage, scheduled_at=datetime(2026, 8, 1, 9, 0, tzinfo=tz),
        venue="G", match_no=1,
    )
    member = None
    if role is not None:
        member = _verified(f"vm-{role}-{uuid.uuid4().hex[:8]}@test.local")
        TournamentMembership.objects.create(
            user=member, tournament=t, role=role,
            status=TournamentMembershipStatus.ACTIVE,
        )
    return admin, t, m, member


# --------------------------------------------------------------- the matrix
# verb -> (request fn, {role: allowed}) — admin/co_organizer are managers.
def _start(c, m):
    return c.post(f"/api/matches/{m.id}/transition/", {"to_status": "live"}, format="json")


def _walkover(c, m):
    return c.post(
        f"/api/matches/{m.id}/transition/",
        {"to_status": "walkover", "winner_team_id": str(m.home_team_id)},
        format="json",
    )


def _replay(c, m):
    m.status = MatchStatus.ABANDONED
    m.save(update_fields=["status"])
    return c.post(
        f"/api/matches/{m.id}/transition/",
        {"to_status": "scheduled", "reason": "floodlights failed"},
        format="json",
    )


def _event(c, m):
    m.status = MatchStatus.LIVE
    m.save(update_fields=["status"])
    return c.post(
        f"/api/matches/{m.id}/events/",
        {"event_type": "goal", "side": "home"},
        format="json",
    )


def _void(c, m):
    m.status = MatchStatus.LIVE
    m.save(update_fields=["status"])
    return c.post(
        f"/api/matches/{m.id}/events/", {"event_type": "void"}, format="json"
    )


def _shootout(c, m):
    m.stage = "knockout"
    m.status = MatchStatus.LIVE
    m.home_score = m.away_score = 1
    m.save(update_fields=["stage", "status", "home_score", "away_score"])
    return c.post(
        f"/api/matches/{m.id}/shootout/",
        {"home_pens": 4, "away_pens": 3},
        format="json",
    )


def _call(c, m):
    return c.post(f"/api/matches/{m.id}/call/", {}, format="json")


def _lock(c, m):
    return c.post(f"/api/matches/{m.id}/lock/", {}, format="json")


_SCORING_ROLES = {R.ADMIN, R.CO_ORGANIZER, R.GAME_COORDINATOR, R.MATCH_SCORER}
_MANAGERS = {R.ADMIN, R.CO_ORGANIZER}
_SCHEDULE_EDITORS = {R.ADMIN, R.CO_ORGANIZER, R.GAME_COORDINATOR}

_MATRIX = [
    ("start", _start, _SCORING_ROLES),
    ("walkover", _walkover, _MANAGERS),  # tightened §2.e
    ("replay", _replay, _MANAGERS),  # tightened §2.e
    ("event", _event, _SCORING_ROLES),
    ("void", _void, _SCORING_ROLES),  # referees: NO voids (owner decision)
    ("shootout", _shootout, _SCORING_ROLES),  # stays scorer-recordable
    ("call", _call, _SCHEDULE_EDITORS),
    ("lock", _lock, _SCHEDULE_EDITORS),
]


@pytest.mark.parametrize("role", TournamentMembershipRole.values)
@pytest.mark.parametrize("verb,request_fn,allowed_roles", _MATRIX, ids=[r[0] for r in _MATRIX])
def test_verb_matrix(verb, request_fn, allowed_roles, role):
    _admin, _t, m, member = _setup(role=role)
    r = request_fn(_client(member), m)
    if role in allowed_roles:
        assert r.status_code in (200, 201), (verb, role, r.content)
    else:
        assert r.status_code == 403, (verb, role, r.content)


def test_walkover_and_replay_still_work_for_org_admin():
    """The tournament creator is an org-workspace admin → manager path."""
    admin, _t, m, _ = _setup()
    c = _client(admin)
    assert _walkover(c, m).status_code == 200
    m.refresh_from_db()
    assert m.status == MatchStatus.WALKOVER
    assert _replay(c, m).status_code == 200


def test_scorer_blocked_from_walkover_gets_explicit_code():
    _admin, _t, m, scorer = _setup(role=R.MATCH_SCORER)
    r = _walkover(_client(scorer), m)
    assert r.status_code == 403
    assert "manager_only_transition" in r.content.decode()


# ----------------------------------------------------- assigned-referee rules
def _assigned_referee():
    admin, t, m, ref = _setup(role=R.REFEREE)
    m.scorer = ref
    m.save(update_fields=["scorer"])
    return admin, t, m, ref


def test_assigned_referee_may_transition_their_match():
    _admin, _t, m, ref = _assigned_referee()
    r = _start(_client(ref), m)
    assert r.status_code == 200, r.content
    assert r.json()["status"] == "live"


def test_assigned_referee_cannot_record_or_void_events():
    """Owner decision 2026-06-12: referees run the state machine on their
    matches but never write or void events — being the assigned official
    (Match.scorer) no longer grants the event log."""
    _admin, _t, m, ref = _assigned_referee()
    c = _client(ref)
    assert _event(c, m).status_code == 403
    assert _void(c, m).status_code == 403


def test_unassigned_referee_cannot_transition():
    _admin, _t, m, ref = _setup(role=R.REFEREE)
    assert _start(_client(ref), m).status_code == 403


def test_assigned_scorer_keeps_full_access():
    """Regression guard: a non-referee assigned scorer (here a team_manager
    assigned per-match) keeps transitions AND the event log."""
    _admin, _t, m, tm = _setup(role=R.TEAM_MANAGER)
    m.scorer = tm
    m.save(update_fields=["scorer"])
    c = _client(tm)
    assert _event(c, m).status_code == 201
    r = c.post(
        f"/api/matches/{m.id}/transition/", {"to_status": "half_time"},
        format="json",
    )
    assert r.status_code == 200


def test_referee_with_explicit_console_grant_may_record():
    """The module layer stays the escape hatch: an explicit per-member
    scoring_console grant restores event access for a referee."""
    from apps.permissions.models import GrantState, Module, TournamentModuleGrant

    _admin, t, m, ref = _assigned_referee()
    TournamentModuleGrant.objects.create(
        user=ref,
        tournament=t,
        module=Module.objects.get(code="match.scoring_console"),
        state=GrantState.GRANT,
        reason="venue scorer is unavailable for this fixture",
    )
    assert _event(_client(ref), m).status_code == 201
