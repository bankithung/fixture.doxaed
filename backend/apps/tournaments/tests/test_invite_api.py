"""TDD — POST /api/tournaments/{id}/invitations/ (design-selfserve-flow.md §5, §6).

A tournament admin invites anyone by email with a tournament role. The token is
emailed, never returned. Outsiders cannot invite into a tournament they have no
access to (invariant 2 — no existence leak).
"""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.organizations.models import AdminInvitation
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str) -> User:
    user = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    user.email_verified_at = timezone.now()
    user.save(update_fields=["email_verified_at"])
    return user


def test_tournament_admin_can_invite_by_email():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Kohima Cup")
    client = APIClient()
    client.force_authenticate(user=admin)

    resp = client.post(
        f"/api/tournaments/{t.id}/invitations/",
        {"email": "ref@test.local", "role": "referee"},
        format="json",
    )

    assert resp.status_code == 201, resp.content
    inv = AdminInvitation.objects.get(email="ref@test.local")
    assert inv.tournament_id == t.id
    assert inv.role == "referee"
    assert "token" not in resp.json()  # token is emailed, never returned


def test_outsider_cannot_invite_into_others_tournament():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Kohima Cup")
    outsider = _verified("outsider@test.local")
    client = APIClient()
    client.force_authenticate(user=outsider)

    resp = client.post(
        f"/api/tournaments/{t.id}/invitations/",
        {"email": "x@test.local", "role": "referee"},
        format="json",
    )

    assert resp.status_code == 404  # don't reveal the tournament exists
    assert not AdminInvitation.objects.filter(email="x@test.local").exists()
