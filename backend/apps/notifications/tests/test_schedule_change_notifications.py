"""Trust layer, increment G — automatic schedule-change notifications.

When a match that ALREADY had a scheduled_at gets a different time/venue via
any repair path or a scheduler re-run, the registered contact users of both
teams' institutions + the tournament admins are notified on
transaction.on_commit. Initial scheduling is silent. One notification per
(user, change-batch) — batch id = the audit row id — so a day shift of N
matches produces at most one notification per user."""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime
from zoneinfo import ZoneInfo

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.fixtures.services.repair import reschedule_match, shift_day
from apps.fixtures.services.scheduler import apply_schedule
from apps.matches.models import Match
from apps.notifications.models import Notification
from apps.teams.models import Institution
from apps.teams.services.registration import register_school
from apps.tournaments.models import (
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
)
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str):
    u = User.objects.create_user(
        email=email, password="FixtureDemo2026!", is_active=True
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _setup(n_teams: int = 4):
    suffix = uuid.uuid4().hex[:8]
    admin = _verified(f"notify-admin-{suffix}@test.local")
    co_org = _verified(f"notify-co-{suffix}@test.local")
    contact = _verified(f"notify-contact-{suffix}@test.local")
    t = create_tournament(user=admin, name="Notify Cup")
    TournamentMembership.objects.create(
        user=co_org, tournament=t,
        role=TournamentMembershipRole.CO_ORGANIZER,
        status=TournamentMembershipStatus.ACTIVE,
    )
    register_school(
        tournament=t,
        school_name="School",
        teams=[{"name": f"Team {i + 1}", "players": []} for i in range(n_teams)],
    )
    inst = Institution.objects.get(tournament=t)
    # Mixed case on purpose — matching must be case-insensitive.
    inst.contact_email = contact.email.title()
    inst.save(update_fields=["contact_email"])

    from apps.fixtures.services.generate import generate_round_robin

    generate_round_robin(tournament=t, group_size=n_teams)
    t.scheduling_config = {
        "date_start": "2026-08-01", "date_end": "2026-08-31",
        "venues": ["G", "G2"], "slot_minutes": 90,
        "rest_minutes": 60, "max_per_team_per_day": 1,
    }
    t.save(update_fields=["scheduling_config"])
    tz = ZoneInfo(t.time_zone)
    matches = list(Match.objects.filter(tournament=t).order_by("match_no"))
    for i, m in enumerate(matches):
        m.scheduled_at = datetime(2026, 8, 1 + i, 9, 0, tzinfo=tz)
        m.venue = "G"
        m.save(update_fields=["scheduled_at", "venue"])
    return admin, co_org, contact, t, matches


def _kinds(user) -> list[Notification]:
    return list(Notification.objects.filter(user=user, kind="schedule_changed"))


def test_reschedule_notifies_contact_and_admins_not_actor(
    django_capture_on_commit_callbacks,
):
    admin, co_org, contact, t, matches = _setup()
    m = matches[0]
    tz = ZoneInfo(t.time_zone)

    with django_capture_on_commit_callbacks(execute=True):
        reschedule_match(
            match=m, by=admin,
            scheduled_at=datetime(2026, 8, 25, 15, 0, tzinfo=tz), venue="G2",
        )

    assert len(_kinds(contact)) == 1
    assert len(_kinds(co_org)) == 1
    assert _kinds(admin) == []  # the actor is never notified of their own edit

    n = _kinds(contact)[0]
    assert n.title == "notification.schedule_changed"  # i18n code, not English
    assert n.tournament_id == t.id
    payload = json.loads(n.body)
    assert payload["changes"][0]["match_id"] == str(m.id)
    assert " vs " in payload["changes"][0]["match_label"]
    assert payload["changes"][0]["old"]["venue"] == "G"
    assert payload["changes"][0]["new"]["venue"] == "G2"
    assert payload["changes"][0]["old"]["scheduled_at"]
    assert payload["changes"][0]["new"]["scheduled_at"]
    assert payload["batch_id"]


def test_initial_scheduling_is_silent(django_capture_on_commit_callbacks):
    admin, _co_org, _contact, t, matches = _setup()
    m = matches[0]
    Match.objects.filter(id=m.id).update(scheduled_at=None)
    m.refresh_from_db()
    tz = ZoneInfo(t.time_zone)

    with django_capture_on_commit_callbacks(execute=True):
        reschedule_match(
            match=m, by=admin,
            scheduled_at=datetime(2026, 8, 25, 15, 0, tzinfo=tz),
        )

    assert Notification.objects.filter(kind="schedule_changed").count() == 0


def test_engine_initial_run_is_silent(django_capture_on_commit_callbacks):
    admin, _co_org, _contact, t, _matches = _setup()
    Match.objects.filter(tournament=t).update(scheduled_at=None, venue="")

    with django_capture_on_commit_callbacks(execute=True):
        apply_schedule(tournament=t, config=dict(t.scheduling_config), by=admin)

    assert Notification.objects.filter(kind="schedule_changed").count() == 0


def test_engine_rerun_notifies_for_moved_matches(
    django_capture_on_commit_callbacks,
):
    admin, co_org, contact, t, _matches = _setup()

    with django_capture_on_commit_callbacks(execute=True):
        apply_schedule(tournament=t, config=dict(t.scheduling_config), by=admin)

    # The manual slots in _setup differ from engine output — affected parties
    # get exactly one batch notification each.
    assert len(_kinds(contact)) == 1
    assert len(_kinds(co_org)) == 1


def test_day_shift_batches_to_one_notification_per_user(
    django_capture_on_commit_callbacks,
):
    admin, co_org, contact, t, matches = _setup()
    tz = ZoneInfo(t.time_zone)
    # Put three matches on the same day so the shift moves a real batch.
    for i, m in enumerate(matches[:3]):
        m.scheduled_at = datetime(2026, 8, 1, 9 + 3 * i, 0, tzinfo=tz)
        m.save(update_fields=["scheduled_at"])

    with django_capture_on_commit_callbacks(execute=True):
        # force: three round-robin matches on one day trip the per-day cap —
        # a forced apply must still notify.
        moved, _, _ = shift_day(
            tournament=t, by=admin,
            from_date=date(2026, 8, 1), to_date=date(2026, 8, 20), force=True,
        )
    assert len(moved) == 3

    assert len(_kinds(contact)) == 1
    assert len(_kinds(co_org)) == 1
    payload = json.loads(_kinds(contact)[0].body)
    assert len(payload["changes"]) == 3


def test_dedupe_is_idempotent_per_user_and_batch():
    admin, co_org, contact, t, matches = _setup()
    from apps.fixtures.services.schedule_changes import (
        _send_slot_change_notifications,
    )

    batch = uuid.uuid4()
    changes = [{
        "match_id": str(matches[0].id),
        "old": {"scheduled_at": "2026-08-01T09:00:00+05:30", "venue": "G"},
        "new": {"scheduled_at": "2026-08-02T09:00:00+05:30", "venue": "G"},
    }]
    _send_slot_change_notifications(t.id, batch, changes, None)
    _send_slot_change_notifications(t.id, batch, changes, None)

    assert len(_kinds(contact)) == 1
    assert len(_kinds(co_org)) == 1
    assert len(_kinds(admin)) == 1  # created_by counts as an admin (no actor)


def test_venue_only_change_notifies(django_capture_on_commit_callbacks):
    admin, _co_org, contact, _t, matches = _setup()

    with django_capture_on_commit_callbacks(execute=True):
        reschedule_match(match=matches[0], by=admin, venue="G2")

    assert len(_kinds(contact)) == 1


def test_noop_reschedule_is_silent(django_capture_on_commit_callbacks):
    admin, _co_org, _contact, _t, matches = _setup()
    m = matches[0]

    with django_capture_on_commit_callbacks(execute=True):
        reschedule_match(
            match=m, by=admin, scheduled_at=m.scheduled_at, venue=m.venue,
        )

    assert Notification.objects.filter(kind="schedule_changed").count() == 0
