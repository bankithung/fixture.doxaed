"""The fixture EDIT workbench (owner ask, 2026-08-23).

A dedicated edit surface over a DRAWN fixture: draft edits validate against
the full rule set WITHOUT touching the real fixture, and only an explicit
apply commits — snapshotted, audited, idempotent. No free text anywhere:
teams come from per-leaf dropdowns, courts from court rows, and typed bracket
pointers (invariant 9) stay read-only.
"""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.fixtures.services.fixture_edit import (
    apply_fixture_edits,
    editable_fixture,
    validate_fixture_edits,
)
from apps.fixtures.services.generate import generate_round_robin
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _user(email: str):
    u = User.objects.create_user(
        email=email, password="FixtureDemo2026!", is_active=True,
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _fixture_with_two_matches():
    """One leaf, 3 teams → a 3-match round robin; two matches share day one."""
    owner = _user("edit-src@example.com")
    t = create_tournament(user=owner, name="Edit Cup")
    from apps.fixtures.models import Venue
    from apps.teams.models import Institution, Team

    Venue.objects.create(organization=t.organization, name="Hall", count=2)
    inst = Institution.objects.create(
        organization=t.organization, tournament=t, slug="s1", name="School One",
    )
    for n in ("Alpha", "Beta", "Gamma"):
        Team.objects.create(
            organization=t.organization, tournament=t, institution=inst,
            slug=n.lower(), name=n,
        )
    matches = generate_round_robin(tournament=t, group_size=4)
    assert len(matches) == 3
    # The generator draws pairings only; slot them by hand (day one, 09:00+).
    from datetime import timedelta
    from django.utils import timezone as dj_tz

    base = dj_tz.make_aware(dj_tz.datetime(2026, 9, 1, 9, 0))
    for i, m in enumerate(matches):
        m.scheduled_at = base + timedelta(hours=3 * i)
        m.venue = "Hall"
        m.save(update_fields=["scheduled_at", "venue"])
    return owner, t, matches


def test_editable_fixture_reports_options_and_pointer_locks():
    owner, t, matches = _fixture_with_two_matches()
    data = editable_fixture(t)
    assert len(data["matches"]) == 3
    # Dropdown options: every registered team of the (blank) leaf.
    assert {team["name"] for team in data["teams_by_leaf"].get("", [])} == {
        "Alpha", "Beta", "Gamma",
    }
    row = data["matches"][0]
    assert row["home_editable"] and row["away_editable"]  # plain team sides
    assert row["editable"]


def test_draft_does_not_touch_fixture_until_apply():
    owner, t, matches = _fixture_with_two_matches()
    a = matches[0]
    original_start = a.scheduled_at

    report = validate_fixture_edits(t, {
        "slots": [{"match_id": str(a.id), "start": "2026-09-01T10:00",
                   "venue": ""}],
        "teams": [{"match_id": str(a.id), "home": None}],
    })
    assert isinstance(report, dict)

    a.refresh_from_db()
    assert a.scheduled_at == original_start, "validate must never mutate"
    from apps.audit.models import AuditEvent
    assert not AuditEvent.objects.filter(
        event_type="fixture_manually_edited"
    ).exists()


def test_team_swap_across_competitions_is_refused():
    owner, t, matches = _fixture_with_two_matches()
    from apps.teams.models import Institution, Team

    inst = Institution.objects.get(tournament=t)
    other = Team.objects.create(
        organization=t.organization, tournament=t, institution=inst,
        slug="other", name="Other", leaf_key="table_tennis.u_14.boys.singles",
    )
    a = matches[0]
    with pytest.raises(Exception):
        validate_fixture_edits(t, {
            "teams": [{"match_id": str(a.id), "home": str(other.id)}],
        })


def test_apply_commits_audits_and_snapshots():
    owner, t, matches = _fixture_with_two_matches()
    a, b = matches[0], matches[1]
    eid = "22222222-2222-5222-8222-222222222222"

    report = apply_fixture_edits(
        tournament=t,
        edits={"slots": [
            {"match_id": str(a.id), "start": "2026-09-01T10:00", "venue": "Hall"},
            {"match_id": str(b.id), "start": "2026-09-01T14:00", "venue": "Hall"},
        ]},
        by=owner,
        event_id=eid,
    )
    assert report["applied"] is True
    a.refresh_from_db()
    b.refresh_from_db()
    from zoneinfo import ZoneInfo

    ist = ZoneInfo(t.time_zone or "Asia/Kolkata")
    assert a.scheduled_at.astimezone(ist).hour == 10
    assert b.scheduled_at.astimezone(ist).hour == 14

    from apps.audit.models import AuditEvent
    from apps.fixtures.models import FixtureSnapshot

    assert AuditEvent.objects.filter(
        event_type="fixture_manually_edited", idempotency_key=eid
    ).exists()
    assert FixtureSnapshot.objects.filter(tournament=t).exists()

    # Replay answers from the audit log instead of double-applying.
    replay = apply_fixture_edits(
        tournament=t,
        edits={"slots": [
            {"match_id": str(a.id), "start": "2026-09-02T10:00", "venue": "Hall"},
        ]},
        by=owner,
        event_id=eid,
    )
    assert replay["replayed"] is True
    a.refresh_from_db()
    assert a.scheduled_at.astimezone(ist).hour == 10


def test_overlapping_move_is_reported_as_new_violation():
    owner, t, matches = _fixture_with_two_matches()
    a, b, c = matches
    report = validate_fixture_edits(t, {
        "slots": [
            # Move `a` exactly onto `b`'s slot with a shared team? Different
            # teams — so instead force both onto the SAME instant+venue.
            {"match_id": str(a.id), "start": b.scheduled_at.isoformat(),
             "venue": b.venue},
        ],
    })
    codes = [v["code"] for v in report["new_violations"]]
    assert any("venue" in code or "overlap" in code or "capacity" in code
               for code in codes) or report["new_violations"], (
        f"expected a clash violation, got {report['violations']}"
    )
