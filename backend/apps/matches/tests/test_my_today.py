"""The dashboard command-center feed: live + today across tournaments."""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.matches.models import Match, MatchStatus
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def test_my_today_aggregates_across_tournaments():
    admin = User.objects.create_user(
        email=f"td-{uuid.uuid4().hex[:8]}@test.local",
        password="FixtureDemo2026!", is_active=True,
    )
    admin.email_verified_at = timezone.now()
    admin.save(update_fields=["email_verified_at"])

    now = timezone.now()
    rows = []
    for name in ("Cup A", "Cup B"):
        t = create_tournament(user=admin, name=name)
        a, b = register_school(
            tournament=t, school_name="S",
            teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
        )
        rows.append(Match.objects.create(
            organization=t.organization, tournament=t, home_team=a, away_team=b,
            match_no=1, scheduled_at=now + timedelta(hours=2),
        ))
    Match.objects.filter(pk=rows[0].pk).update(status=MatchStatus.LIVE)

    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.get("/api/me/today/")
    assert r.status_code == 200
    names = {m["tournament_name"] for m in r.data["matches"]}
    assert names == {"Cup A", "Cup B"}
    assert any(m["live"] for m in r.data["matches"])
    # The scheduled match has no scorer: it surfaces in the needs strip.
    assert any(n["kind"] == "no_scorer" for n in r.data["needs"])
