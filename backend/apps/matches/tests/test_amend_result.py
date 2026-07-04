"""H3 — audited correction of COMPLETED set-sport results.

Before this path existed, a wrong sepak/TT result was permanent the moment
the match completed, and a wrong knockout winner propagated through the
bracket forever (verified finding N3).
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError as DjangoValidationError
from django.utils import timezone
from rest_framework.test import APIClient

from apps.audit.models import AuditEvent
from apps.matches.models import Match, MatchStatus
from apps.matches.services.set_scoring import amend_set_result, record_set_result
from apps.teams.models import Team
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db

TT = {"type": "sets", "points": 11, "win_by": 2, "cap": None, "best_of": 3}


def _admin(email="amend@test.local"):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _completed_match():
    admin = _admin()
    t = create_tournament(user=admin, name="Amend Cup")
    register_school(
        tournament=t, school_name="MH",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
    )
    a, b = list(Team.objects.filter(tournament=t).order_by("name"))
    m = Match.objects.create(
        organization=t.organization, tournament=t, sport="table_tennis",
        home_team=a, away_team=b, status=MatchStatus.SCHEDULED,
    )
    record_set_result(
        match=m, set_scores=[[11, 8], [11, 9]], rules=TT, by=admin,
        event_id=uuid.uuid4(),
    )
    m.refresh_from_db()
    assert (m.home_score, m.away_score) == (2, 0)
    return admin, t, m


def test_amend_flips_result_and_audits_with_reason():
    admin, _t, m = _completed_match()
    amend_set_result(
        match=m, set_scores=[[8, 11], [9, 11]], rules=TT, by=admin,
        reason="Scores were entered for the wrong side.",
        event_id=uuid.uuid4(),
    )
    m.refresh_from_db()
    assert (m.home_score, m.away_score) == (0, 2)
    assert m.set_scores == [[8, 11], [9, 11]]
    assert m.status == MatchStatus.COMPLETED  # amend never reopens the match
    assert m.winner_id == m.away_team_id

    row = AuditEvent.objects.filter(
        event_type="match_result_amended", target_id=m.id
    ).latest("created_at")
    assert row.reason == "Scores were entered for the wrong side."
    assert row.tournament_id == m.tournament_id
    assert row.match_id == m.id
    assert row.payload_before["set_scores"] == [[11, 8], [11, 9]]


def test_amend_refires_advancement_when_winner_flips(
    django_capture_on_commit_callbacks,
):
    admin, t, m = _completed_match()
    # A dependent knockout slot fed by this match.
    dep = Match.objects.create(
        organization=t.organization, tournament=t, sport="table_tennis",
        stage="knockout", home_team=m.home_team,  # filled by the ORIGINAL winner
        home_source={"type": "winner_of", "match_id": str(m.id)},
    )
    with django_capture_on_commit_callbacks(execute=True):
        amend_set_result(
            match=m, set_scores=[[8, 11], [9, 11]], rules=TT, by=admin,
            reason="Sides swapped.", event_id=uuid.uuid4(),
        )
    dep.refresh_from_db()
    assert dep.home_team_id == m.away_team_id  # the CORRECTED winner


def test_amend_guards():
    admin, t, m = _completed_match()
    # Blank reason.
    with pytest.raises(DjangoValidationError, match="amend_reason_required"):
        amend_set_result(
            match=m, set_scores=[[8, 11], [9, 11]], rules=TT, by=admin,
            reason="  ",
        )
    # Undecided result: compute_sets itself rejects the array.
    with pytest.raises(DjangoValidationError):
        amend_set_result(
            match=m, set_scores=[[11, 8], [9, 11]], rules=TT, by=admin,
            reason="x",
        )
    # Only COMPLETED matches.
    fresh = Match.objects.create(
        organization=t.organization, tournament=t, sport="table_tennis",
        home_team=m.home_team, away_team=m.away_team,
        status=MatchStatus.SCHEDULED,
    )
    with pytest.raises(DjangoValidationError, match="only_completed"):
        amend_set_result(
            match=fresh, set_scores=[[8, 11], [9, 11]], rules=TT, by=admin,
            reason="x",
        )


def test_amend_is_idempotent_on_event_id():
    admin, _t, m = _completed_match()
    eid = uuid.uuid4()
    for _ in range(2):
        amend_set_result(
            match=m, set_scores=[[8, 11], [9, 11]], rules=TT, by=admin,
            reason="Sides swapped.", event_id=eid,
        )
    assert AuditEvent.objects.filter(
        event_type="match_result_amended", idempotency_key=eid
    ).count() == 1


def test_amend_api_is_manager_only():
    admin, _t, m = _completed_match()
    outsider = _admin("outsider@test.local")

    c = APIClient()
    c.force_authenticate(user=outsider)
    resp = c.post(
        f"/api/matches/{m.id}/amend/",
        {"set_scores": [[8, 11], [9, 11]], "reason": "nope"},
        format="json",
    )
    assert resp.status_code == 404  # no access -> no existence leak

    c.force_authenticate(user=admin)
    ok = c.post(
        f"/api/matches/{m.id}/amend/",
        {
            "set_scores": [[8, 11], [9, 11]],
            "reason": "Scores entered for the wrong side.",
            "event_id": str(uuid.uuid4()),
        },
        format="json",
    )
    assert ok.status_code == 200
    assert ok.data["home_score"] == 0 and ok.data["away_score"] == 2
