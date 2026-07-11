"""Campaign lifecycle: fixtures gate, idempotent open, close/reopen, settings
patch, cross-org isolation and the manager gate."""
from __future__ import annotations

import uuid

import pytest
from rest_framework.test import APIClient

from apps.audit.models import AuditEvent
from apps.lens.models import LensCampaign
from apps.lens.tests.utils import detail, setup_tournament, verified
from apps.tournaments.models import (
    TournamentMembership,
    TournamentMembershipRole,
)

pytestmark = pytest.mark.django_db


def _client(user):
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def test_open_blocked_before_fixtures_generated():
    admin, t, _ = setup_tournament(with_fixtures=False)
    r = _client(admin).post(
        f"/api/tournaments/{t.id}/lens/open/",
        {"event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 400, r.content
    assert detail(r) == "fixtures_not_generated"
    assert not LensCampaign.objects.filter(tournament=t).exists()


def test_open_creates_campaign_with_defaults():
    admin, t, _ = setup_tournament()
    r = _client(admin).post(
        f"/api/tournaments/{t.id}/lens/open/",
        {"event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 201, r.content
    c = r.json()["campaign"]
    assert c["title"] == "Guest Lens"
    assert c["tagline"] == "36 Shots Challenge"
    assert c["max_photos_per_institution"] == 36
    assert len(c["award_categories"]) == 5
    assert c["is_open"] is True


def test_open_is_idempotent_on_event_id_and_existing():
    admin, t, _ = setup_tournament()
    client = _client(admin)
    event_id = str(uuid.uuid4())
    first = client.post(
        f"/api/tournaments/{t.id}/lens/open/", {"event_id": event_id}, format="json"
    )
    replay = client.post(
        f"/api/tournaments/{t.id}/lens/open/", {"event_id": event_id}, format="json"
    )
    fresh = client.post(
        f"/api/tournaments/{t.id}/lens/open/",
        {"event_id": str(uuid.uuid4())},
        format="json",
    )
    assert first.status_code == 201
    assert replay.status_code == 200
    assert fresh.status_code == 200
    ids = {r.json()["campaign"]["id"] for r in (first, replay, fresh)}
    assert len(ids) == 1
    assert LensCampaign.objects.filter(tournament=t).count() == 1
    assert (
        AuditEvent.objects.filter(event_type="lens_campaign_opened").count() == 1
    )


def test_close_and_reopen():
    admin, t, _ = setup_tournament()
    client = _client(admin)
    client.post(
        f"/api/tournaments/{t.id}/lens/open/",
        {"event_id": str(uuid.uuid4())},
        format="json",
    )
    closed = client.post(
        f"/api/tournaments/{t.id}/lens/close/",
        {"event_id": str(uuid.uuid4())},
        format="json",
    )
    assert closed.status_code == 200
    assert closed.json()["campaign"]["is_open"] is False
    reopened = client.post(
        f"/api/tournaments/{t.id}/lens/reopen/",
        {"event_id": str(uuid.uuid4())},
        format="json",
    )
    assert reopened.status_code == 200
    assert reopened.json()["campaign"]["is_open"] is True
    assert AuditEvent.objects.filter(event_type="lens_campaign_closed").exists()
    assert AuditEvent.objects.filter(event_type="lens_campaign_reopened").exists()


def test_settings_patch():
    admin, t, _ = setup_tournament()
    client = _client(admin)
    client.post(
        f"/api/tournaments/{t.id}/lens/open/",
        {"event_id": str(uuid.uuid4())},
        format="json",
    )
    r = client.patch(
        f"/api/tournaments/{t.id}/lens/",
        {
            "event_id": str(uuid.uuid4()),
            "title": "School Lens",
            "max_photos_per_institution": 12,
            "award_categories": ["Best Action Shot"],
        },
        format="json",
    )
    assert r.status_code == 200, r.content
    c = r.json()["campaign"]
    assert c["title"] == "School Lens"
    assert c["max_photos_per_institution"] == 12
    assert c["award_categories"] == ["Best Action Shot"]
    bad = client.patch(
        f"/api/tournaments/{t.id}/lens/",
        {"event_id": str(uuid.uuid4()), "max_photos_per_institution": 0},
        format="json",
    )
    assert bad.status_code == 400
    assert detail(bad) == "invalid_max_photos"


def test_category_limits_patch_validation_and_pruning():
    admin, t, _ = setup_tournament()
    client = _client(admin)
    client.post(
        f"/api/tournaments/{t.id}/lens/open/",
        {"event_id": str(uuid.uuid4())},
        format="json",
    )
    r = client.patch(
        f"/api/tournaments/{t.id}/lens/",
        {
            "event_id": str(uuid.uuid4()),
            "category_limits": {"Best Action Shot": 10, "Best Team Spirit": 5},
        },
        format="json",
    )
    assert r.status_code == 200, r.content
    assert r.json()["campaign"]["category_limits"] == {
        "Best Action Shot": 10,
        "Best Team Spirit": 5,
    }

    # A limit for a category not on the campaign is silently dropped.
    r = client.patch(
        f"/api/tournaments/{t.id}/lens/",
        {
            "event_id": str(uuid.uuid4()),
            "category_limits": {"Best Action Shot": 10, "Ghost Category": 3},
        },
        format="json",
    )
    assert r.json()["campaign"]["category_limits"] == {"Best Action Shot": 10}

    # Removing a category drops its stored limit too.
    r = client.patch(
        f"/api/tournaments/{t.id}/lens/",
        {"event_id": str(uuid.uuid4()), "award_categories": ["Best Team Spirit"]},
        format="json",
    )
    assert r.json()["campaign"]["category_limits"] == {}

    for bad_value in (
        ["Best Team Spirit"],
        {"Best Team Spirit": 0},
        {"Best Team Spirit": 501},
        {"Best Team Spirit": True},
        {"Best Team Spirit": "many"},
        {"": 5},
    ):
        bad = client.patch(
            f"/api/tournaments/{t.id}/lens/",
            {"event_id": str(uuid.uuid4()), "category_limits": bad_value},
            format="json",
        )
        assert bad.status_code == 400, bad_value
        assert detail(bad) == "invalid_category_limits"


def test_cross_org_isolation_404():
    admin, t, _ = setup_tournament()
    _client(admin).post(
        f"/api/tournaments/{t.id}/lens/open/",
        {"event_id": str(uuid.uuid4())},
        format="json",
    )
    outsider = _client(verified())
    assert outsider.get(f"/api/tournaments/{t.id}/lens/").status_code == 404
    assert (
        outsider.post(
            f"/api/tournaments/{t.id}/lens/open/",
            {"event_id": str(uuid.uuid4())},
            format="json",
        ).status_code
        == 404
    )


def test_non_manager_member_denied_403():
    _admin, t, _ = setup_tournament()
    scorer = verified()
    TournamentMembership.objects.create(
        user=scorer, tournament=t, role=TournamentMembershipRole.MATCH_SCORER
    )
    client = _client(scorer)
    assert client.get(f"/api/tournaments/{t.id}/lens/").status_code == 403
    r = client.post(
        f"/api/tournaments/{t.id}/lens/open/",
        {"event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 403
    assert detail(r) == "not_tournament_manager"


def test_overview_before_open():
    admin, t, insts = setup_tournament()
    r = _client(admin).get(f"/api/tournaments/{t.id}/lens/")
    assert r.status_code == 200
    body = r.json()
    assert body["campaign"] is None
    assert body["fixtures_ready"] is True
    assert body["stats"]["institutions_total"] == len(insts)
    assert body["passes"] == []
