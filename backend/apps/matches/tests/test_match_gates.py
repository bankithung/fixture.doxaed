"""Role/permission corrections — owner decisions 2026-08-03.

The load-bearing artefact for the tightening (CLAUDE.md invariant 12 + the
mandatory permission-matrix rule). Four things are proved here:

1. **The full role x action matrix.** All 6 ``TournamentMembershipRole`` values
   crossed with view / score / transition / record event / void event / assign
   scorer / assign official / invite / edit settings. Admin + co-organizer are
   fully flexible; everyone else reads the whole tournament but only acts
   inside their own role.
2. **Strict per-match scoping.** A ``match_scorer`` who does not hold the
   match's scoring seat and is not on its officials board cannot score it —
   Court 1's volunteer can no longer edit Court 4's board.
3. **``MatchOfficial`` finally confers something.** Umpire / referee /
   commissioner may score AND transition THEIR OWN match; linesman /
   assistant / fourth official stay read-only; officials on another match are
   denied.
4. **Idempotency + isolation.** ``assign_scorer`` replays on ``event_id``
   (invariant 3), and every endpoint touched is covered by a cross-org
   isolation test (invariant 2).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.utils import timezone
from rest_framework.test import APIClient

from apps.matches.models import Match, MatchOfficial, MatchStatus
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
MANAGERS = {R.ADMIN, R.CO_ORGANIZER}
CREW_STAFFERS = {R.ADMIN, R.CO_ORGANIZER, R.GAME_COORDINATOR}
EVERYONE = set(R.values)

# The officials-board seats that run the scoreboard, and the ones that do not.
SCORING_SEATS = ("referee", "umpire", "commissioner")
READ_ONLY_SEATS = ("linesman", "assistant", "fourth")


# --------------------------------------------------------------------- harness
def _verified(prefix: str):
    u = User.objects.create_user(
        email=f"{prefix}-{uuid.uuid4().hex[:10]}@test.local",
        password="FixtureDemo2026!",
        is_active=True,
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _client(user) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _member(t, role: str, prefix: str = "m"):
    u = _verified(f"{prefix}-{role}")
    TournamentMembership.objects.create(
        user=u, tournament=t, role=role,
        status=TournamentMembershipStatus.ACTIVE,
    )
    return u


def _match(t, home, away, *, no: int = 1, venue: str = "G", court=None):
    tz = ZoneInfo(t.time_zone)
    return Match.objects.create(
        organization=t.organization, tournament=t, home_team=home, away_team=away,
        scheduled_at=datetime(2026, 8, 1, 9, 0, tzinfo=tz) + timedelta(hours=no),
        venue=venue, court=court, match_no=no,
    )


def _tournament(name: str = "Gate Cup"):
    """A tournament + two teams + one match + a spare member to assign."""
    call_command("load_modules")  # role-default modules (two-layer RBAC)
    admin = _verified("gate-admin")
    t = create_tournament(user=admin, name=name)
    a, b = register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
    )
    m = _match(t, a, b)
    bench = _member(t, R.MATCH_SCORER, prefix="bench")
    return admin, t, m, bench


def _go_live(m: Match) -> Match:
    m.status = MatchStatus.LIVE
    m.save(update_fields=["status"])
    return m


def _seed_event(m: Match, by) -> None:
    """One recorded goal so a VOID has a target at sequence_no 1."""
    from apps.matches.services.events import record_match_event

    _go_live(m)
    record_match_event(
        match=m, event_type="goal", team=m.home_team, by=by, minute=5,
    )


# ------------------------------------------------------------ the action table
# Each action: (name, request fn, allowed roles, ok status codes).
def _a_view(c, ctx):
    return c.get(f"/api/tournaments/{ctx['t'].id}/matches/")


def _a_score(c, ctx):
    return c.post(
        f"/api/matches/{ctx['m'].id}/score/",
        {"home_score": 2, "away_score": 1},
        format="json",
    )


def _a_transition(c, ctx):
    return c.post(
        f"/api/matches/{ctx['m'].id}/transition/", {"to_status": "live"},
        format="json",
    )


def _a_record_event(c, ctx):
    _go_live(ctx["m"])
    return c.post(
        f"/api/matches/{ctx['m'].id}/events/",
        {"event_type": "goal", "side": "home"},
        format="json",
    )


def _a_void_event(c, ctx):
    _seed_event(ctx["m"], ctx["admin"])
    return c.post(
        f"/api/matches/{ctx['m'].id}/events/",
        {"event_type": "void", "voids_seq": 1},
        format="json",
    )


def _a_assign_scorer(c, ctx):
    return c.post(
        f"/api/matches/{ctx['m'].id}/scorer/",
        {"user_id": str(ctx["bench"].id)},
        format="json",
    )


def _a_assign_official(c, ctx):
    return c.post(
        f"/api/matches/{ctx['m'].id}/officials/",
        {"user_id": str(ctx["bench"].id), "role": "referee"},
        format="json",
    )


def _a_invite(c, ctx):
    return c.post(
        f"/api/tournaments/{ctx['t'].id}/invitations/",
        {"email": f"invitee-{uuid.uuid4().hex[:8]}@test.local", "role": "referee"},
        format="json",
    )


def _a_edit_settings(c, ctx):
    return c.patch(
        f"/api/tournaments/{ctx['t'].id}/settings/",
        {"rules": {"match": {"penalties": True}}},
        format="json",
    )


ACTIONS = [
    # Whole tournament stays READABLE for every role.
    ("view", _a_view, EVERYONE, (200,)),
    # Acting on a match you are not assigned to: managers only.
    ("score", _a_score, MANAGERS, (200,)),
    ("transition", _a_transition, MANAGERS, (200,)),
    ("record_event", _a_record_event, MANAGERS, (201,)),
    ("void_event", _a_void_event, MANAGERS, (201,)),
    # Staffing the crew board rides `match.assign_officials` (defect 6).
    ("assign_scorer", _a_assign_scorer, CREW_STAFFERS, (200,)),
    ("assign_official", _a_assign_official, CREW_STAFFERS, (200,)),
    # Governance verbs stay manager-only.
    ("invite", _a_invite, MANAGERS, (201,)),
    ("edit_settings", _a_edit_settings, MANAGERS, (200,)),
]


@pytest.mark.parametrize("role", R.values)
@pytest.mark.parametrize(
    "action,request_fn,allowed,ok_codes", ACTIONS, ids=[a[0] for a in ACTIONS]
)
def test_role_action_matrix(action, request_fn, allowed, ok_codes, role):
    """THE artefact: every tournament role x every governed action."""
    admin, t, m, bench = _tournament()
    member = _member(t, role)
    ctx = {"admin": admin, "t": t, "m": m, "bench": bench}
    r = request_fn(_client(member), ctx)
    if role in allowed:
        assert r.status_code in ok_codes, (action, role, r.status_code, r.content)
    else:
        assert r.status_code == 403, (action, role, r.status_code, r.content)


# ------------------------------------------------- defect 1: unscoped scorer
def test_match_scorer_not_on_this_match_cannot_score():
    """THE headline bug. Six courts, volunteer scorers: the person staffing
    Court 1 must not be able to edit Court 4's board. Fails against the old
    blanket `match_scorer` membership grant."""
    _admin, t, court1, _bench = _tournament()
    a, b = court1.home_team, court1.away_team
    court4 = _match(t, a, b, no=2, venue="Court 4")

    volunteer = _member(t, R.MATCH_SCORER, prefix="vol")
    court1.scorer = volunteer
    court1.save(update_fields=["scorer"])

    c = _client(volunteer)
    # Their own court: yes.
    assert c.post(
        f"/api/matches/{court1.id}/score/",
        {"home_score": 1, "away_score": 0}, format="json",
    ).status_code == 200
    # Somebody else's court: no.
    r = c.post(
        f"/api/matches/{court4.id}/score/",
        {"home_score": 5, "away_score": 0}, format="json",
    )
    assert r.status_code == 403, r.content
    assert "not_allowed_to_score" in r.content.decode()
    court4.refresh_from_db()
    assert court4.home_score is None


def test_match_scorer_denied_transition_and_events_off_their_match():
    _admin, t, m, _bench = _tournament()
    other = _match(t, m.home_team, m.away_team, no=2, venue="Court 4")
    volunteer = _member(t, R.MATCH_SCORER, prefix="vol")
    m.scorer = volunteer
    m.save(update_fields=["scorer"])

    c = _client(volunteer)
    assert c.post(
        f"/api/matches/{other.id}/transition/", {"to_status": "live"}, format="json"
    ).status_code == 403
    _go_live(other)
    assert c.post(
        f"/api/matches/{other.id}/events/",
        {"event_type": "goal", "side": "home"}, format="json",
    ).status_code == 403


def test_role_default_console_module_is_not_enough_but_an_explicit_grant_is():
    """`match.scoring_console` defaults ON for match_scorer/game_coordinator in
    the catalog. Honouring the role DEFAULT here would re-open the hole, so the
    gate reads only EXPLICIT per-member grant rows."""
    from apps.permissions.models import GrantState, Module, TournamentModuleGrant

    _admin, t, m, _bench = _tournament()
    coordinator = _member(t, R.GAME_COORDINATOR, prefix="gc")
    c = _client(coordinator)
    assert c.post(
        f"/api/matches/{m.id}/score/", {"home_score": 1, "away_score": 0},
        format="json",
    ).status_code == 403

    TournamentModuleGrant.objects.create(
        user=coordinator, tournament=t,
        module=Module.objects.get(code="match.scoring_console"),
        state=GrantState.GRANT,
        reason="stands in for the venue scorer all weekend",
    )
    assert c.post(
        f"/api/matches/{m.id}/score/", {"home_score": 1, "away_score": 0},
        format="json",
    ).status_code == 200


# ------------------------------------------- defect 2: MatchOfficial confers
@pytest.mark.parametrize("seat", SCORING_SEATS)
def test_scoring_seat_official_may_score_and_transition_their_match(seat):
    _admin, t, m, _bench = _tournament()
    official = _member(t, R.REFEREE, prefix="off")
    MatchOfficial.objects.create(
        organization=t.organization, match=m, user=official, role=seat,
    )
    c = _client(official)
    assert c.post(
        f"/api/matches/{m.id}/transition/", {"to_status": "live"}, format="json"
    ).status_code == 200, seat
    assert c.post(
        f"/api/matches/{m.id}/score/", {"home_score": 3, "away_score": 1},
        format="json",
    ).status_code == 200, seat


@pytest.mark.parametrize("seat", READ_ONLY_SEATS)
def test_read_only_seat_official_is_denied_scoring(seat):
    """Linesman / assistant / fourth official stay read-only (owner decision)."""
    _admin, t, m, _bench = _tournament()
    official = _member(t, R.TEAM_MANAGER, prefix="ro")
    MatchOfficial.objects.create(
        organization=t.organization, match=m, user=official, role=seat,
    )
    c = _client(official)
    assert c.post(
        f"/api/matches/{m.id}/score/", {"home_score": 3, "away_score": 1},
        format="json",
    ).status_code == 403, seat
    assert c.post(
        f"/api/matches/{m.id}/transition/", {"to_status": "live"}, format="json"
    ).status_code == 403, seat
    # ...but the tournament is still readable to them.
    assert c.get(f"/api/tournaments/{t.id}/matches/").status_code == 200


@pytest.mark.parametrize("seat", SCORING_SEATS)
def test_declined_official_holds_no_scoring_rights(seat):
    """Turning the job down gives the seat back: a DECLINED row must not keep
    granting the match. Defensive — `assign_official` writes every row at
    `assigned` today and the accept flow is unbuilt, so this lands before that
    flow ships rather than after."""
    from apps.matches.models import MatchOfficialStatus

    _admin, t, m, _bench = _tournament()
    official = _member(t, R.REFEREE, prefix="declined")
    MatchOfficial.objects.create(
        organization=t.organization, match=m, user=official, role=seat,
        status=MatchOfficialStatus.DECLINED,
    )
    c = _client(official)
    assert c.post(
        f"/api/matches/{m.id}/score/", {"home_score": 1, "away_score": 0},
        format="json",
    ).status_code == 403, seat
    # ...and the referee-role transition widening does not rescue them either.
    assert c.post(
        f"/api/matches/{m.id}/transition/", {"to_status": "live"}, format="json"
    ).status_code == 403, seat
    # The tournament stays readable — declining a match is not an eviction.
    assert c.get(f"/api/tournaments/{t.id}/matches/").status_code == 200


@pytest.mark.parametrize(
    "status,allowed",
    [("assigned", True), ("accepted", True), ("declined", False)],
)
def test_seat_status_decides_whether_the_board_grants_anything(status, allowed):
    """`assigned` and `accepted` grant; `declined` does not."""
    _admin, t, m, _bench = _tournament()
    official = _member(t, R.REFEREE, prefix="status")
    MatchOfficial.objects.create(
        organization=t.organization, match=m, user=official, role="umpire",
        status=status,
    )
    c = _client(official)
    expected_transition = 200 if allowed else 403
    assert c.post(
        f"/api/matches/{m.id}/transition/", {"to_status": "live"}, format="json"
    ).status_code == expected_transition, status
    expected_score = 200 if allowed else 403
    assert c.post(
        f"/api/matches/{m.id}/score/", {"home_score": 2, "away_score": 1},
        format="json",
    ).status_code == expected_score, status


@pytest.mark.parametrize("seat", READ_ONLY_SEATS)
def test_declined_read_only_seat_does_not_transition_for_a_referee(seat):
    """The `_is_match_official` path (referee role + any seat -> clock) also
    honours the declined filter."""
    from apps.matches.models import MatchOfficialStatus

    _admin, t, m, _bench = _tournament()
    ref = _member(t, R.REFEREE, prefix="declined-ro")
    row = MatchOfficial.objects.create(
        organization=t.organization, match=m, user=ref, role=seat,
        status=MatchOfficialStatus.ASSIGNED,
    )
    c = _client(ref)
    assert c.post(
        f"/api/matches/{m.id}/transition/", {"to_status": "live"}, format="json"
    ).status_code == 200, seat

    m.status = MatchStatus.SCHEDULED
    m.save(update_fields=["status"])
    row.status = MatchOfficialStatus.DECLINED
    row.save(update_fields=["status"])
    assert c.post(
        f"/api/matches/{m.id}/transition/", {"to_status": "live"}, format="json"
    ).status_code == 403, seat


def test_linesman_can_be_bulk_assigned():
    """`linesman` was missing from bulk_assign.OFFICIAL_ROLES, so sepak takraw
    crews could not be staffed in bulk at all."""
    from apps.matches.services.bulk_assign import OFFICIAL_ROLES

    assert "linesman" in OFFICIAL_ROLES

    _admin2, t, m, bench = _tournament()
    admin_c = _client(_member(t, R.ADMIN, prefix="staffer"))
    r = admin_c.post(
        f"/api/tournaments/{t.id}/crew/bulk-assign/",
        {"scope": "court", "key": m.venue, "role": "linesman",
         "user_id": str(bench.id)},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert r.json()["assigned"] == 1
    assert MatchOfficial.objects.filter(
        match=m, user=bench, role="linesman"
    ).exists()
    # ...and the seat still confers no scoring rights.
    assert _client(bench).post(
        f"/api/matches/{m.id}/score/", {"home_score": 1, "away_score": 0},
        format="json",
    ).status_code == 403


@pytest.mark.parametrize("seat", SCORING_SEATS)
def test_official_on_a_different_match_is_denied(seat):
    _admin, t, mine, _bench = _tournament()
    theirs = _match(t, mine.home_team, mine.away_team, no=2, venue="Court 4")
    official = _member(t, R.REFEREE, prefix="off")
    MatchOfficial.objects.create(
        organization=t.organization, match=mine, user=official, role=seat,
    )
    c = _client(official)
    assert c.post(
        f"/api/matches/{theirs.id}/score/", {"home_score": 1, "away_score": 0},
        format="json",
    ).status_code == 403, seat
    assert c.post(
        f"/api/matches/{theirs.id}/transition/", {"to_status": "live"},
        format="json",
    ).status_code == 403, seat


# ------------------------------- defect 3: events vs the referee carve-out
def test_match_level_scoring_official_may_record_and_void_events():
    """THE RULE: a MATCH-LEVEL scoring official is the person with the
    whiteboard, so they write and void their own match's event log — even
    though they also hold the tournament-wide `referee` role, whose blanket
    carve-out would otherwise deny them."""
    _admin, t, m, _bench = _tournament()
    ref = _member(t, R.REFEREE, prefix="board-ref")
    MatchOfficial.objects.create(
        organization=t.organization, match=m, user=ref, role="referee",
    )
    c = _client(ref)
    _go_live(m)
    r = c.post(
        f"/api/matches/{m.id}/events/", {"event_type": "goal", "side": "home"},
        format="json",
    )
    assert r.status_code == 201, r.content
    r2 = c.post(
        f"/api/matches/{m.id}/events/", {"event_type": "void", "voids_seq": 1},
        format="json",
    )
    assert r2.status_code == 201, r2.content


def test_tournament_role_referee_in_the_scoring_seat_still_cannot_write_events():
    """The blanket TOURNAMENT-ROLE carve-out stays: a referee who qualifies
    only through Match.scorer runs the clock but never the event log
    (2026-06-12)."""
    _admin, t, m, _bench = _tournament()
    ref = _member(t, R.REFEREE, prefix="seat-ref")
    m.scorer = ref
    m.save(update_fields=["scorer"])
    c = _client(ref)
    assert c.post(
        f"/api/matches/{m.id}/transition/", {"to_status": "live"}, format="json"
    ).status_code == 200
    assert c.post(
        f"/api/matches/{m.id}/events/", {"event_type": "goal", "side": "home"},
        format="json",
    ).status_code == 403


# ------------------------------------ defect 4: _can_transition's dead clause
@pytest.mark.parametrize("seat", READ_ONLY_SEATS)
def test_referee_role_in_a_non_scoring_seat_may_transition_but_not_score(seat):
    """The clause that replaces the dead one. A qualified referee (tournament
    role) working THIS match from a non-scoring seat runs the clock — but the
    scoreboard stays someone else's job. Fails against the old code, where the
    dead clause could never change the outcome."""
    _admin, t, m, _bench = _tournament()
    ref = _member(t, R.REFEREE, prefix="touchline")
    MatchOfficial.objects.create(
        organization=t.organization, match=m, user=ref, role=seat,
    )
    c = _client(ref)
    r = c.post(
        f"/api/matches/{m.id}/transition/", {"to_status": "live"}, format="json"
    )
    assert r.status_code == 200, (seat, r.content)
    assert c.post(
        f"/api/matches/{m.id}/score/", {"home_score": 1, "away_score": 0},
        format="json",
    ).status_code == 403, seat
    assert c.post(
        f"/api/matches/{m.id}/events/", {"event_type": "goal", "side": "home"},
        format="json",
    ).status_code == 403, seat


def test_non_referee_in_a_non_scoring_seat_cannot_transition():
    """The counterpart: the transition widening is the REFEREE role's, not the
    seat's — a team_manager sitting as fourth official stays read-only."""
    _admin, t, m, _bench = _tournament()
    tm = _member(t, R.TEAM_MANAGER, prefix="tm")
    MatchOfficial.objects.create(
        organization=t.organization, match=m, user=tm, role="fourth",
    )
    assert _client(tm).post(
        f"/api/matches/{m.id}/transition/", {"to_status": "live"}, format="json"
    ).status_code == 403


def test_referee_role_with_no_seat_at_all_cannot_transition():
    _admin, t, m, _bench = _tournament()
    ref = _member(t, R.REFEREE, prefix="idle")
    assert _client(ref).post(
        f"/api/matches/{m.id}/transition/", {"to_status": "live"}, format="json"
    ).status_code == 403


# --------------------------------------- defect 5: assign_scorer idempotency
def test_assign_scorer_replays_on_event_id_without_double_writing():
    admin, t, m, bench = _tournament()
    other = _member(t, R.MATCH_SCORER, prefix="second")
    c = _client(admin)
    key = str(uuid.uuid4())

    r1 = c.post(
        f"/api/matches/{m.id}/scorer/", {"user_id": str(bench.id), "event_id": key},
        format="json",
    )
    assert r1.status_code == 200, r1.content
    m.refresh_from_db()
    assert m.scorer_id == bench.id

    # Same key, DIFFERENT payload: a replay, not a reassignment.
    r2 = c.post(
        f"/api/matches/{m.id}/scorer/", {"user_id": str(other.id), "event_id": key},
        format="json",
    )
    assert r2.status_code == 200, r2.content  # replay is 200, never 201
    m.refresh_from_db()
    assert m.scorer_id == bench.id, "replay must not re-seat the scorer"

    from apps.audit.models import AuditEvent

    assert AuditEvent.objects.filter(
        idempotency_key=key, event_type="match_scorer_assigned"
    ).count() == 1


def test_assign_scorer_without_event_id_still_reassigns():
    admin, t, m, bench = _tournament()
    other = _member(t, R.MATCH_SCORER, prefix="second")
    c = _client(admin)
    c.post(f"/api/matches/{m.id}/scorer/", {"user_id": str(bench.id)}, format="json")
    c.post(f"/api/matches/{m.id}/scorer/", {"user_id": str(other.id)}, format="json")
    m.refresh_from_db()
    assert m.scorer_id == other.id


def test_assign_scorer_rejects_a_malformed_event_id():
    admin, _t, m, bench = _tournament()
    r = _client(admin).post(
        f"/api/matches/{m.id}/scorer/",
        {"user_id": str(bench.id), "event_id": "not-a-uuid"},
        format="json",
    )
    assert r.status_code == 400


# ------------------------------------- defect 6: the catalog and the gate agree
def test_game_coordinator_can_staff_a_match_with_the_module():
    """`match.assign_officials` now means what the catalog says: a game
    coordinator staffs BOTH seats."""
    _admin, t, m, bench = _tournament()
    gc = _member(t, R.GAME_COORDINATOR, prefix="gc")
    c = _client(gc)
    assert c.post(
        f"/api/matches/{m.id}/scorer/", {"user_id": str(bench.id)}, format="json"
    ).status_code == 200
    assert c.post(
        f"/api/matches/{m.id}/officials/",
        {"user_id": str(bench.id), "role": "umpire"}, format="json",
    ).status_code == 200


def test_module_denied_takes_the_scorer_seat_away_from_a_coordinator():
    from apps.permissions.models import GrantState, Module, TournamentModuleGrant

    _admin, t, m, bench = _tournament()
    gc = _member(t, R.GAME_COORDINATOR, prefix="gc")
    TournamentModuleGrant.objects.create(
        user=gc, tournament=t,
        module=Module.objects.get(code="match.assign_officials"),
        state=GrantState.DENY,
        reason="coordinator is not staffing crew for this event",
    )
    r = _client(gc).post(
        f"/api/matches/{m.id}/scorer/", {"user_id": str(bench.id)}, format="json"
    )
    assert r.status_code == 403
    assert "not_allowed_to_assign_officials" in r.content.decode()


def test_bulk_scorer_assignment_rides_the_module_too():
    _admin, t, _m, bench = _tournament()
    gc = _member(t, R.GAME_COORDINATOR, prefix="gc")
    r = _client(gc).post(
        f"/api/tournaments/{t.id}/crew/bulk-assign/",
        {"scope": "court", "key": "G", "role": "scorer", "user_id": str(bench.id)},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert r.json()["assigned"] == 1


def test_module_catalog_description_matches_the_gate():
    """The catalog text and the code gate must agree (defect 6)."""
    import json
    from pathlib import Path

    path = (
        Path(__file__).resolve().parents[2]
        / "permissions" / "fixtures" / "modules.json"
    )
    entry = next(
        e for e in json.loads(path.read_text(encoding="utf-8"))
        if e["code"] == "match.assign_officials"
    )
    desc = entry["description"].lower()
    assert "scoring seat" in desc  # the gate really does cover scorers
    assert "schedule_editor" in desc  # courts ride elsewhere — say so
    assert set(entry["default_for_roles"]) == {
        "admin", "co_organizer", "game_coordinator"
    }


# ---------------------------------- defect 7: bulk_assign court scope via FK
def _court(t, name: str, venue_name: str = "Main Hall"):
    from apps.fixtures.models import Court, Venue

    venue, _ = Venue.objects.get_or_create(
        organization=t.organization, name=venue_name, defaults={"count": 4}
    )
    return Court.objects.create(
        organization=t.organization, venue=venue, name=name,
        index=int(name[-1]) if name[-1].isdigit() else 1,
    )


def test_bulk_assign_court_scope_selects_by_fk():
    admin, t, m1, bench = _tournament()
    a, b = m1.home_team, m1.away_team
    t1, t4 = _court(t, "Main Hall · T1"), _court(t, "Main Hall · T4")

    m1.court, m1.venue = t1, t1.name
    m1.save(update_fields=["court", "venue"])
    m2 = _match(t, a, b, no=2, venue=t1.name, court=t1)
    m3 = _match(t, a, b, no=3, venue=t4.name, court=t4)

    r = _client(admin).post(
        f"/api/tournaments/{t.id}/crew/bulk-assign/",
        {"scope": "court", "key": str(t1.id), "role": "scorer",
         "user_id": str(bench.id)},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert r.json()["assigned"] == 2
    for m in (m1, m2, m3):
        m.refresh_from_db()
    assert m1.scorer_id == bench.id
    assert m2.scorer_id == bench.id
    assert m3.scorer_id is None, "another court must be untouched"


def test_bulk_assign_court_scope_still_reaches_legacy_null_court_rows():
    """Rows written before the FK existed carry only the denormalised venue
    string — a court-id scope must still pick them up."""
    admin, t, legacy, bench = _tournament()
    t1 = _court(t, "Main Hall · T1")
    legacy.court = None
    legacy.venue = t1.name
    legacy.save(update_fields=["court", "venue"])
    modern = _match(t, legacy.home_team, legacy.away_team, no=2,
                    venue=t1.name, court=t1)

    r = _client(admin).post(
        f"/api/tournaments/{t.id}/crew/bulk-assign/",
        {"scope": "court", "key": str(t1.id), "role": "scorer",
         "user_id": str(bench.id)},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert r.json()["assigned"] == 2
    legacy.refresh_from_db()
    modern.refresh_from_db()
    assert legacy.scorer_id == bench.id
    assert modern.scorer_id == bench.id


def test_bulk_assign_court_scope_accepts_a_legacy_venue_string_key():
    """Back-compat: a non-UUID key is still the venue display string."""
    admin, t, m, bench = _tournament()
    m.venue = "Old Ground"
    m.save(update_fields=["venue"])
    r = _client(admin).post(
        f"/api/tournaments/{t.id}/crew/bulk-assign/",
        {"scope": "court", "key": "Old Ground", "role": "scorer",
         "user_id": str(bench.id)},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert r.json()["assigned"] == 1


# ---------------------------------------- invariant 2: cross-org isolation
def _outsider_client():
    """An admin of a DIFFERENT workspace — full rights over their own org."""
    call_command("load_modules")
    other_admin = _verified("other-org-admin")
    create_tournament(user=other_admin, name="Other Cup")
    return _client(other_admin), other_admin


@pytest.mark.parametrize(
    "path_fn,method,body",
    [
        (lambda t, m, u: f"/api/matches/{m.id}/score/", "post",
         {"home_score": 1, "away_score": 0}),
        (lambda t, m, u: f"/api/matches/{m.id}/transition/", "post",
         {"to_status": "live"}),
        (lambda t, m, u: f"/api/matches/{m.id}/events/", "post",
         {"event_type": "goal", "side": "home"}),
        (lambda t, m, u: f"/api/matches/{m.id}/scorer/", "post", {"user_id": None}),
        (lambda t, m, u: f"/api/matches/{m.id}/officials/", "post",
         {"role": "referee"}),
        (lambda t, m, u: f"/api/tournaments/{t.id}/crew/bulk-assign/", "post",
         {"scope": "court", "key": "G", "role": "scorer"}),
        (lambda t, m, u: f"/api/tournaments/{t.id}/matches/", "get", None),
    ],
    ids=["score", "transition", "events", "scorer", "officials", "bulk", "list"],
)
def test_cross_org_isolation(path_fn, method, body):
    """A user in org X cannot reach org Y's matches — 404, no existence leak."""
    _admin, t, m, bench = _tournament()
    client, _outsider = _outsider_client()
    payload = dict(body or {})
    if "user_id" in payload:
        payload["user_id"] = str(bench.id)
    url = path_fn(t, m, bench)
    r = (
        client.get(url) if method == "get"
        else client.post(url, payload, format="json")
    )
    assert r.status_code == 404, (url, r.status_code, r.content)


def test_cross_org_official_seat_confers_nothing_elsewhere():
    """A MatchOfficial row is meaningless outside its own org (belt and
    braces on the new grant path)."""
    _admin_a, t_a, m_a, bench_a = _tournament("Cup A")
    _admin_b, _t_b, m_b, _bench_b = _tournament("Cup B")
    # bench_a is umpire on Cup A's match only.
    MatchOfficial.objects.create(
        organization=t_a.organization, match=m_a, user=bench_a, role="umpire",
    )
    c = _client(bench_a)
    assert c.post(
        f"/api/matches/{m_a.id}/score/", {"home_score": 1, "away_score": 0},
        format="json",
    ).status_code == 200
    assert c.post(
        f"/api/matches/{m_b.id}/score/", {"home_score": 1, "away_score": 0},
        format="json",
    ).status_code == 404
