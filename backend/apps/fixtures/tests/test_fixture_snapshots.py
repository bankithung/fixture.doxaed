"""Fixture versions: every fixture a tournament has had, and a way back to one.

A fixture is drawn, scheduled, repaired and re-drawn, and each pass used to
overwrite the last with nothing kept. These pin the three things that make the
history trustworthy rather than decorative:

* a version is captured automatically when a fixture is GENERATED, so the
  history exists without anyone remembering to save;
* a restore puts the SAME match rows back — ids and all — because a bracket
  restored with fresh ids is a bracket whose winner_of pointers all dangle;
* a restore is refused once anything has been played, and the fixture it
  replaces is frozen first so the restore itself can be undone.
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.fixtures.models import FixtureSnapshot
from apps.fixtures.services.snapshots import RestoreBlocked, capture, restore
from apps.matches.models import Match, MatchStatus
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(prefix: str = "snap"):
    u = User.objects.create_user(
        email=f"{prefix}-{uuid.uuid4().hex[:8]}@test.local",
        password="FixtureDemo2026!", is_active=True,
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _client(user) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _drawn(name="Snapshot Cup", n_teams: int = 4):
    """A tournament whose fixture has been generated through the real endpoint,
    so the automatic capture is exercised rather than simulated."""
    admin = _verified()
    t = create_tournament(user=admin, name=name)
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i}", "players": []} for i in range(n_teams)],
    )
    r = _client(admin).post(
        f"/api/tournaments/{t.id}/generate-fixtures/",
        {"format": "round_robin", "group_size": n_teams}, format="json",
    )
    assert r.status_code == 201, r.data
    return admin, t


def test_generating_a_fixture_captures_a_version_without_being_asked():
    admin, t = _drawn()
    snaps = FixtureSnapshot.objects.filter(tournament=t)
    assert snaps.count() == 1
    s = snaps.first()
    assert s.kind == FixtureSnapshot.Kind.GENERATED
    assert s.match_count == Match.objects.filter(
        tournament=t, deleted_at__isnull=True,
    ).count()
    # The payload carries each match's own id — that is what makes a restore
    # put the bracket's pointers back pointing at something.
    assert {row["id"] for row in s.payload} == {
        str(m.id) for m in Match.objects.filter(tournament=t, deleted_at__isnull=True)
    }
    assert s.summary["competition_count"] >= 0


def test_the_list_endpoint_is_org_scoped_and_newest_first():
    admin, t = _drawn()
    capture(t, kind=FixtureSnapshot.Kind.MANUAL, label="second", by=admin)
    r = _client(admin).get(f"/api/tournaments/{t.id}/fixture-versions/")
    assert r.status_code == 200
    versions = r.data["versions"]
    assert len(versions) == 2
    assert versions[0]["label"] == "second"          # newest first
    assert versions[0]["created_by"]["id"] == str(admin.id)

    # invariant 2: another org's admin cannot see this tournament at all.
    outsider = _verified("outsider")
    assert _client(outsider).get(
        f"/api/tournaments/{t.id}/fixture-versions/"
    ).status_code == 404


def test_restore_puts_the_same_match_rows_back():
    admin, t = _drawn()
    snap = FixtureSnapshot.objects.get(tournament=t)
    before = {
        str(m.id): (m.round_no, m.match_no, m.venue)
        for m in Match.objects.filter(tournament=t, deleted_at__isnull=True)
    }
    # The fixture moves on: one match is edited, another removed entirely.
    victim = Match.objects.filter(tournament=t, deleted_at__isnull=True).first()
    victim.venue = "Somewhere else"
    victim.save(update_fields=["venue"])
    gone = Match.objects.filter(tournament=t, deleted_at__isnull=True).last()
    gone.deleted_at = timezone.now()
    gone.save(update_fields=["deleted_at"])

    counts = restore(snap, by=admin)
    after = {
        str(m.id): (m.round_no, m.match_no, m.venue)
        for m in Match.objects.filter(tournament=t, deleted_at__isnull=True)
    }
    assert after == before                      # same ids, same values
    assert counts["restored"] == len(before)


def test_restoring_freezes_what_it_replaces_so_it_can_be_undone():
    admin, t = _drawn()
    snap = FixtureSnapshot.objects.get(tournament=t)
    m = Match.objects.filter(tournament=t, deleted_at__isnull=True).first()
    m.venue = "Court Z"
    m.save(update_fields=["venue"])

    restore(snap, by=admin)
    undo = FixtureSnapshot.objects.filter(
        tournament=t, kind=FixtureSnapshot.Kind.RESTORED,
    ).first()
    assert undo is not None
    # It holds the fixture as it was a moment BEFORE the restore, not after.
    assert any(row["venue"] == "Court Z" for row in undo.payload)


def test_restore_is_refused_once_a_match_has_been_played():
    admin, t = _drawn()
    snap = FixtureSnapshot.objects.get(tournament=t)
    m = Match.objects.filter(tournament=t, deleted_at__isnull=True).first()
    m.status = MatchStatus.COMPLETED
    m.home_score, m.away_score = 3, 1
    m.save(update_fields=["status", "home_score", "away_score"])

    with pytest.raises(RestoreBlocked):
        restore(snap, by=admin)
    # ...and through the API it is a 400 that says why, not a 500.
    r = _client(admin).post(f"/api/fixture-versions/{snap.id}/restore/")
    assert r.status_code == 400
    assert "result" in str(r.data).lower()
    # the result is untouched
    m.refresh_from_db()
    assert m.status == MatchStatus.COMPLETED and m.home_score == 3


def test_a_version_can_be_read_in_full_without_restoring_it():
    admin, t = _drawn()
    snap = FixtureSnapshot.objects.get(tournament=t)
    r = _client(admin).get(f"/api/fixture-versions/{snap.id}/")
    assert r.status_code == 200
    assert len(r.data["matches"]) == snap.match_count
    assert _client(_verified("nope")).get(
        f"/api/fixture-versions/{snap.id}/"
    ).status_code == 404
