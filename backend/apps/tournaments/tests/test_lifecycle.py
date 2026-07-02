"""S1 — tournament lifecycle spine (PRD §5.2): scheduled → live → completed.

The tail of the lifecycle used to be dead (nothing ever set LIVE/COMPLETED).
These tests pin the spine: first kickoff flips LIVE, the last terminal match
flips COMPLETED, deferred multi-stage remainders block auto-completion, and
the manual "Wrap up" verb guards in-play matches and outstanding fixtures.
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.utils import timezone
from rest_framework.test import APIClient

from apps.audit.models import AuditEvent
from apps.matches.models import Match, MatchStatus
from apps.matches.services.scoring import record_score
from apps.teams.services.registration import register_school
from apps.tournaments.models import Tournament, TournamentStatus
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.state import (
    StageTransitionError,
    complete_tournament,
    mark_tournament_live,
    maybe_complete_tournament,
)

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str | None = None) -> User:
    u = User.objects.create_user(
        email=email or f"lc-{uuid.uuid4().hex[:8]}@test.local",
        password="FixtureDemo2026!", is_active=True,
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _setup(status: str = TournamentStatus.SCHEDULED, n_matches: int = 2):
    admin = _verified()
    t = create_tournament(user=admin, name="Lifecycle Cup")
    Tournament.objects.filter(pk=t.pk).update(status=status)
    t.refresh_from_db()
    a, b = register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
    )
    matches = [
        Match.objects.create(
            organization=t.organization, tournament=t,
            home_team=a, away_team=b, match_no=i + 1,
        )
        for i in range(n_matches)
    ]
    return admin, t, matches


# ------------------------------------------------------------ scheduled → live
def test_first_kickoff_marks_tournament_live():
    _admin, t, _ms = _setup()
    assert mark_tournament_live(t.id) is True
    t.refresh_from_db()
    assert t.status == TournamentStatus.LIVE
    assert AuditEvent.objects.filter(
        event_type="tournament_lifecycle_changed", target_id=t.id
    ).exists()


def test_mark_live_is_forward_only_and_idempotent():
    _admin, t, _ms = _setup(status=TournamentStatus.DRAFT)
    assert mark_tournament_live(t.id) is False  # draft never jumps to live
    t.refresh_from_db()
    assert t.status == TournamentStatus.DRAFT

    Tournament.objects.filter(pk=t.pk).update(status=TournamentStatus.COMPLETED)
    assert mark_tournament_live(t.id) is False  # never moves backward
    t.refresh_from_db()
    assert t.status == TournamentStatus.COMPLETED


# --------------------------------------------------------- live → completed
def test_completes_when_all_matches_terminal():
    admin, t, (m1, m2) = _setup(status=TournamentStatus.LIVE)
    record_score(match=m1, home_score=2, away_score=0, by=admin)
    assert maybe_complete_tournament(t.id) is False  # m2 still scheduled
    record_score(match=m2, home_score=1, away_score=3, by=admin)
    assert maybe_complete_tournament(t.id) is True
    t.refresh_from_db()
    assert t.status == TournamentStatus.COMPLETED


@pytest.mark.parametrize(
    "blocking", [MatchStatus.POSTPONED, MatchStatus.ABANDONED, MatchStatus.LIVE]
)
def test_open_match_statuses_block_completion(blocking):
    admin, t, (m1, m2) = _setup(status=TournamentStatus.LIVE)
    record_score(match=m1, home_score=2, away_score=0, by=admin)
    Match.objects.filter(pk=m2.pk).update(status=blocking)
    assert maybe_complete_tournament(t.id) is False
    t.refresh_from_db()
    assert t.status == TournamentStatus.LIVE


def test_no_matches_never_completes():
    _admin, t, _ = _setup(status=TournamentStatus.LIVE, n_matches=0)
    assert maybe_complete_tournament(t.id) is False


def test_pending_multi_stage_blocks_completion():
    """Deferred materialization: all EXISTING matches terminal, but the leaf's
    plan has an undrawn later stage — the tournament is not over."""
    admin, t, (m1, m2) = _setup(status=TournamentStatus.LIVE)
    Tournament.objects.filter(pk=t.pk).update(
        draw_config={
            "leafX": {
                "stages": [
                    {"id": "s0", "type": "round_robin"},
                    {"id": "s1", "type": "knockout", "from": {"stage": "s0"}},
                ]
            }
        }
    )
    Match.objects.filter(pk__in=[m1.pk, m2.pk]).update(leaf_key="leafX", stage_no=0)
    t.refresh_from_db()
    record_score(match=m1, home_score=2, away_score=0, by=admin)
    record_score(match=m2, home_score=1, away_score=3, by=admin)
    assert maybe_complete_tournament(t.id) is False  # knockout not drawn yet
    t.refresh_from_db()
    assert t.status == TournamentStatus.LIVE

    # Once the final stage exists and finishes, completion goes through.
    a, b = m1.home_team, m1.away_team
    final = Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b,
        leaf_key="leafX", stage_no=1, match_no=99,
    )
    record_score(match=final, home_score=1, away_score=0, by=admin)
    assert maybe_complete_tournament(t.id) is True


# ------------------------------------------------------------- manual wrap-up
def test_wrap_up_blocked_while_match_in_play():
    admin, t, (m1, _m2) = _setup(status=TournamentStatus.LIVE)
    Match.objects.filter(pk=m1.pk).update(status=MatchStatus.LIVE)
    with pytest.raises(ValidationError):
        complete_tournament(tournament=t, by=admin)


def test_wrap_up_outstanding_requires_force_and_reason():
    admin, t, _ms = _setup(status=TournamentStatus.LIVE)
    with pytest.raises(StageTransitionError) as exc:
        complete_tournament(tournament=t, by=admin)
    assert exc.value.detail == "outstanding_matches"

    with pytest.raises(ValidationError):
        complete_tournament(tournament=t, by=admin, force=True)  # no reason

    done = complete_tournament(
        tournament=t, by=admin, force=True, reason="rain washed out day 3"
    )
    assert done.status == TournamentStatus.COMPLETED


def test_wrap_up_idempotent_on_event_id():
    admin, t, _ms = _setup(status=TournamentStatus.LIVE)
    eid = uuid.uuid4()
    complete_tournament(tournament=t, by=admin, force=True, reason="done", event_id=eid)
    again = complete_tournament(
        tournament=t, by=admin, force=True, reason="done", event_id=eid
    )
    assert again.status == TournamentStatus.COMPLETED
    assert (
        AuditEvent.objects.filter(
            idempotency_key=eid, event_type="tournament_lifecycle_changed"
        ).count()
        == 1
    )


# ------------------------------------------------------------------ endpoints
def test_complete_endpoint_and_real_delete_guard():
    admin, t, _ms = _setup(status=TournamentStatus.LIVE)
    c = APIClient()
    c.force_authenticate(user=admin)

    # Live tournament: delete is now genuinely blocked (guard was dead code).
    r = c.delete(f"/api/tournaments/{t.id}/")
    assert r.status_code == 409

    # Wrap up over the API: 409 until forced, then completed.
    r = c.post(f"/api/tournaments/{t.id}/complete/", {}, format="json")
    assert r.status_code == 409
    r = c.post(
        f"/api/tournaments/{t.id}/complete/",
        {"force": True, "reason": "season closed"},
        format="json",
    )
    assert r.status_code == 200
    assert r.data["status"] == TournamentStatus.COMPLETED


@pytest.mark.django_db(transaction=True)
def test_end_to_end_hooks_drive_lifecycle():
    """record_score's post-commit hooks flip the tournament without any manual
    service calls: last result in → COMPLETED."""
    admin, t, (m1, m2) = _setup(status=TournamentStatus.LIVE)
    record_score(match=m1, home_score=2, away_score=0, by=admin)
    t.refresh_from_db()
    assert t.status == TournamentStatus.LIVE  # one match still open
    record_score(match=m2, home_score=0, away_score=1, by=admin)
    t.refresh_from_db()
    assert t.status == TournamentStatus.COMPLETED
