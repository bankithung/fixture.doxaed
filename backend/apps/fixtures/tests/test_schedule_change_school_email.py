"""H6 — schedule changes reach ACCOUNTLESS school contacts by email.

Delivery previously targeted User rows only (finding N6, critical): a school
whose contact address had no platform account heard nothing when its match
moved. Contacts with accounts keep getting in-app notifications, not emails.
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.core import mail
from django.utils import timezone

from apps.fixtures.services.schedule_changes import _send_slot_change_notifications
from apps.matches.models import Match
from apps.notifications.models import Notification
from apps.teams.models import Institution, Team
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _setup(contact_email: str, with_account: bool):
    admin = User.objects.create_user(
        email="ops-h6@test.local", password="FixtureDemo2026!", is_active=True
    )
    admin.email_verified_at = timezone.now()
    admin.save(update_fields=["email_verified_at"])
    t = create_tournament(user=admin, name="Change Cup")
    register_school(
        tournament=t, school_name="Alpha School",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
    )
    inst = Institution.objects.filter(tournament=t).first()
    inst.contact_email = contact_email
    inst.save(update_fields=["contact_email"])
    if with_account:
        u = User.objects.create_user(
            email=contact_email, password="FixtureDemo2026!", is_active=True
        )
        u.email_verified_at = timezone.now()
        u.save(update_fields=["email_verified_at"])
    a, b = list(Team.objects.filter(tournament=t).order_by("name"))
    m = Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b
    )
    return admin, t, m


def _fire(t, m, actor_id):
    _send_slot_change_notifications(
        t.id,
        uuid.uuid4(),
        [{
            "match_id": str(m.id),
            "old": {"scheduled_at": "2026-08-29T09:30:00Z", "venue": "Court 1"},
            "new": {"scheduled_at": "2026-08-29T10:10:00Z", "venue": "Court 2"},
        }],
        actor_id,
    )


def test_accountless_contact_gets_an_email():
    admin, t, m = _setup("noaccount@school.test", with_account=False)
    _fire(t, m, actor_id=admin.id)

    sent = [x for x in mail.outbox if x.to == ["noaccount@school.test"]]
    assert len(sent) == 1
    assert "Schedule updated" in sent[0].subject
    assert "10:10" in sent[0].body


def test_contact_with_account_gets_notification_not_email():
    admin, t, m = _setup("hasaccount@school.test", with_account=True)
    _fire(t, m, actor_id=admin.id)

    assert [x for x in mail.outbox if x.to == ["hasaccount@school.test"]] == []
    contact_user = User.objects.get(email="hasaccount@school.test")
    assert Notification.objects.filter(user=contact_user).exists()
