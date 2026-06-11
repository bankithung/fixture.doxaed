"""TDD — minimal team-withdrawal executor (redesign spec §7 inc 16, §9 A7).

withdraw_team marks the team withdrawn and walkovers its remaining *scheduled*
matches via the existing transition (the advance.py ripple is free);
compute_standings honors ``rules.withdrawal_policy.rr_results``
(void_if_under_half_played); a walkover-loser semifinalist never auto-fills a
``loser_of`` third-place slot — the slot resolves as a walkover for the other
side, whichever semifinal finishes first.
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.audit.models import AuditEvent
from apps.fixtures.services.advance import advance_from_match
from apps.fixtures.services.generate import (
    generate_round_robin,
    generate_single_elimination,
)
from apps.matches.models import Match, MatchStatus
from apps.matches.services.scoring import record_score
from apps.matches.services.standings import compute_standings
from apps.teams.models import Team, TeamStatus
from apps.teams.services.registration import register_school
from apps.teams.services.withdrawal import withdraw_team
from apps.tournaments.models import (
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
)
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str = "org@test.local") -> User:
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _client(user) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _rr_group(admin, names=("A", "B", "C", "D")):
    t = create_tournament(user=admin, name=f"RR Cup {uuid.uuid4().hex[:6]}")
    teams = register_school(
        tournament=t, school_name="S",
        teams=[{"name": n, "players": []} for n in names],
    )
    generate_round_robin(tournament=t, group_size=len(names))
    return t, {tm.name: tm for tm in teams}


def _match_between(t, a, b) -> Match:
    return Match.objects.get(
        tournament=t, deleted_at__isnull=True,
        home_team__in=[a, b], away_team__in=[a, b],
    )


def _complete(t, winner, loser, by, ws=2, ls=0) -> Match:
    m = _match_between(t, winner, loser)
    if m.home_team_id == winner.id:
        record_score(match=m, home_score=ws, away_score=ls, by=by)
    else:
        record_score(match=m, home_score=ls, away_score=ws, by=by)
    return m


# ---------------------------------------------------------------------------
# Service — walkover the remaining scheduled matches
# ---------------------------------------------------------------------------

def test_withdraw_marks_team_and_walkovers_scheduled_matches():
    admin = _verified()
    t, by_name = _rr_group(admin)
    d = by_name["D"]

    result = withdraw_team(team=d, by=admin, event_id=uuid.uuid4(), reason="left")

    d.refresh_from_db()
    assert d.status == TeamStatus.WITHDRAWN
    assert result["walkover_matches"] == 3
    for other in ("A", "B", "C"):
        m = _match_between(t, d, by_name[other])
        m.refresh_from_db()
        assert m.status == MatchStatus.WALKOVER
        # the opponent is awarded the conventional w/o scoreline
        assert m.winner_id == by_name[other].id
        assert {m.home_score, m.away_score} == {3, 0}
    # matches NOT involving D are untouched
    assert _match_between(t, by_name["A"], by_name["B"]).status == MatchStatus.SCHEDULED
    assert AuditEvent.objects.filter(
        event_type="team_withdrawn", target_id=d.id
    ).count() == 1


def test_withdraw_leaves_completed_results_intact():
    admin = _verified()
    t, by_name = _rr_group(admin)
    d, a = by_name["D"], by_name["A"]
    _complete(t, d, a, admin)  # D already beat A 2-0

    result = withdraw_team(team=d, by=admin, event_id=uuid.uuid4())

    m = _match_between(t, d, a)
    m.refresh_from_db()
    assert m.status == MatchStatus.COMPLETED  # history is not rewritten
    assert result["walkover_matches"] == 2  # only the still-scheduled ones


def test_withdraw_is_idempotent_on_event_id_and_on_status():
    admin = _verified()
    _t, by_name = _rr_group(admin)
    d = by_name["D"]
    eid = uuid.uuid4()

    first = withdraw_team(team=d, by=admin, event_id=eid)
    replay = withdraw_team(team=d, by=admin, event_id=eid)
    assert first["replayed"] is False
    assert replay["replayed"] is True
    assert replay["walkover_matches"] == first["walkover_matches"]
    assert AuditEvent.objects.filter(
        event_type="team_withdrawn", idempotency_key=eid
    ).count() == 1

    # naturally idempotent without an event_id too
    again = withdraw_team(team=d, by=admin, event_id=uuid.uuid4())
    assert again["replayed"] is True
    assert AuditEvent.objects.filter(
        event_type="team_withdrawn", target_id=d.id
    ).count() == 1


def test_unsupported_fixtures_policy_is_rejected_not_silently_ignored():
    admin = _verified()
    t, by_name = _rr_group(admin)
    t.rules = {"withdrawal_policy": {"fixtures": "replay_all"}}
    t.save(update_fields=["rules"])
    with pytest.raises(ValueError):
        withdraw_team(team=by_name["D"], by=admin, event_id=uuid.uuid4())


# ---------------------------------------------------------------------------
# Standings — rules.withdrawal_policy.rr_results (§2.6 ships with its consumer)
# ---------------------------------------------------------------------------

def test_standings_void_results_when_under_half_played():
    admin = _verified()
    t, by_name = _rr_group(admin)
    a, b, c, d = (by_name[k] for k in "ABCD")
    _complete(t, d, a, admin)            # D's only real result (1 of 3)
    _complete(t, a, b, admin, 1, 0)
    _complete(t, a, c, admin, 2, 1)
    _complete(t, b, c, admin, 3, 0)
    withdraw_team(team=d, by=admin, event_id=uuid.uuid4())

    rows = {r["name"]: r for r in compute_standings(t)}
    assert "D" not in rows               # voided: under half played
    assert rows["A"]["P"] == 2           # the loss to D is annulled
    assert rows["A"]["Pts"] == 6
    assert rows["B"]["P"] == 2           # B's walkover win vs D is annulled too
    assert rows["B"]["Pts"] == 3
    assert rows["C"]["P"] == 2 and rows["C"]["Pts"] == 0


def test_standings_keep_results_when_at_least_half_played():
    admin = _verified()
    t, by_name = _rr_group(admin)
    a, b, c, d = (by_name[k] for k in "ABCD")
    _complete(t, d, a, admin)            # D played 2 of 3 — retained
    _complete(t, d, b, admin, 1, 0)
    _complete(t, a, b, admin, 1, 0)
    _complete(t, a, c, admin, 2, 1)
    _complete(t, b, c, admin, 3, 0)
    withdraw_team(team=d, by=admin, event_id=uuid.uuid4())  # D-C walkovers

    rows = {r["name"]: r for r in compute_standings(t)}
    assert rows["D"]["P"] == 3           # 2 real results + 1 walkover loss
    assert rows["D"]["Pts"] == 6
    assert rows["C"]["P"] == 3           # walkover win counts 3-0 for C
    assert rows["C"]["Pts"] == 3
    assert rows["C"]["GF"] == 4 and rows["C"]["GA"] == 5


# ---------------------------------------------------------------------------
# Third-place edge (§9 A7) — a walkover loser never fills a loser_of slot
# ---------------------------------------------------------------------------

def _ko_with_third(admin, n=4):
    t = create_tournament(user=admin, name=f"KO {uuid.uuid4().hex[:6]}")
    teams = register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i + 1}", "players": []} for i in range(n)],
    )
    matches = generate_single_elimination(tournament=t, teams=teams, third_place=True)
    semis = sorted([m for m in matches if m.round_no == 1], key=lambda m: m.match_no)
    third = next(m for m in matches if m.group_label == "3rd Place")
    final = next(m for m in matches if m.round_no == 2 and m.group_label == "")
    return t, semis, third, final


def test_walkover_loser_does_not_fill_third_place_slot_played_semi_first():
    admin = _verified()
    _t, semis, third, final = _ko_with_third(admin)
    record_score(match=semis[0], home_score=2, away_score=0, by=admin)
    advance_from_match(semis[0].id)  # on_commit doesn't fire inside the test txn
    third.refresh_from_db()
    loser1 = third.home_team_id
    assert loser1 == semis[0].away_team_id

    withdrawn = Team.objects.get(id=semis[1].home_team_id)
    withdraw_team(team=withdrawn, by=admin, event_id=uuid.uuid4())
    semis[1].refresh_from_db()
    assert semis[1].status == MatchStatus.WALKOVER
    advance_from_match(semis[1].id)

    third.refresh_from_db()
    final.refresh_from_db()
    assert final.away_team_id == semis[1].away_team_id  # winner advances normally
    assert third.away_team_id is None                   # withdrawn loser NOT placed
    assert (third.away_source or {}).get("walkover_vacated") is True
    assert third.status == MatchStatus.WALKOVER         # slot → w/o for the other side
    assert third.winner_id == loser1


def test_walkover_loser_does_not_fill_third_place_slot_walkover_semi_first():
    admin = _verified()
    _t, semis, third, _final = _ko_with_third(admin)
    withdrawn = Team.objects.get(id=semis[1].away_team_id)
    withdraw_team(team=withdrawn, by=admin, event_id=uuid.uuid4())
    advance_from_match(semis[1].id)
    third.refresh_from_db()
    assert third.status == MatchStatus.SCHEDULED        # other side not known yet
    assert (third.away_source or {}).get("walkover_vacated") is True

    record_score(match=semis[0], home_score=0, away_score=1, by=admin)
    advance_from_match(semis[0].id)
    third.refresh_from_db()
    assert third.home_team_id == semis[0].home_team_id
    assert third.status == MatchStatus.WALKOVER
    assert third.winner_id == semis[0].home_team_id


def test_withdrawn_team_in_a_slot_with_tbd_opponent_walkovers_on_fill():
    admin = _verified()
    t = create_tournament(user=admin, name="KO no3rd")
    teams = register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i + 1}", "players": []} for i in range(4)],
    )
    matches = generate_single_elimination(tournament=t, teams=teams)
    semis = sorted([m for m in matches if m.round_no == 1], key=lambda m: m.match_no)
    final = next(m for m in matches if m.round_no == 2)

    record_score(match=semis[0], home_score=2, away_score=0, by=admin)
    advance_from_match(semis[0].id)
    final.refresh_from_db()
    w1 = Team.objects.get(id=final.home_team_id)

    # W1 withdraws while the final's other slot is still TBD: nothing to
    # walkover yet — the fill is what resolves it.
    result = withdraw_team(team=w1, by=admin, event_id=uuid.uuid4())
    assert result["walkover_matches"] == 0
    final.refresh_from_db()
    assert final.status == MatchStatus.SCHEDULED

    record_score(match=semis[1], home_score=1, away_score=0, by=admin)
    advance_from_match(semis[1].id)
    final.refresh_from_db()
    assert final.status == MatchStatus.WALKOVER
    assert final.winner_id == semis[1].home_team_id


# ---------------------------------------------------------------------------
# Endpoint — POST /api/tournaments/{id}/teams/{team_id}/withdraw/
# ---------------------------------------------------------------------------

def test_withdraw_endpoint_manager_only_and_audited():
    admin = _verified()
    t, by_name = _rr_group(admin)
    d = by_name["D"]
    eid = str(uuid.uuid4())

    r = _client(admin).post(
        f"/api/tournaments/{t.id}/teams/{d.id}/withdraw/",
        {"event_id": eid, "reason": "school pulled out"}, format="json",
    )
    assert r.status_code == 200, r.content
    body = r.json()
    assert body["status"] == TeamStatus.WITHDRAWN
    assert body["walkover_matches"] == 3
    d.refresh_from_db()
    assert d.status == TeamStatus.WITHDRAWN

    # replay (invariant 3): same event_id → same outcome, one audit row
    r2 = _client(admin).post(
        f"/api/tournaments/{t.id}/teams/{d.id}/withdraw/",
        {"event_id": eid}, format="json",
    )
    assert r2.status_code == 200
    assert r2.json()["replayed"] is True
    assert AuditEvent.objects.filter(
        event_type="team_withdrawn", idempotency_key=eid
    ).count() == 1


def test_withdraw_endpoint_permissions_and_isolation():
    admin = _verified()
    referee = _verified("ref@test.local")
    outsider = _verified("out@test.local")
    t, by_name = _rr_group(admin)
    d = by_name["D"]
    TournamentMembership.objects.create(
        user=referee, tournament=t, role=TournamentMembershipRole.REFEREE,
        status=TournamentMembershipStatus.ACTIVE, assigned_by=admin,
    )
    url = f"/api/tournaments/{t.id}/teams/{d.id}/withdraw/"

    # member without bracket_editor → 403
    assert _client(referee).post(url, {}, format="json").status_code == 403
    # cross-org outsider → 404, no existence leak (invariant 2)
    assert _client(outsider).post(url, {}, format="json").status_code == 404
    # unknown team in a reachable tournament → 404
    r = _client(admin).post(
        f"/api/tournaments/{t.id}/teams/{uuid.uuid4()}/withdraw/",
        {}, format="json",
    )
    assert r.status_code == 404
    d.refresh_from_db()
    assert d.status == TeamStatus.REGISTERED  # nothing happened
