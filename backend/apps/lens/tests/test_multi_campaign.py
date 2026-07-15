"""Multiple Guest Lens campaigns per tournament — the list/create endpoints,
per-campaign scoping of the overview, and cross-campaign isolation."""
from __future__ import annotations

import uuid

import pytest
from rest_framework.test import APIClient

from apps.lens.models import LensCampaign
from apps.lens.tests.utils import detail, open_campaign, setup_tournament

pytestmark = pytest.mark.django_db


def _client(user):
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def test_create_multiple_campaigns():
    admin, t, _ = setup_tournament()
    client = _client(admin)
    url = f"/api/tournaments/{t.id}/lens/campaigns/"

    r1 = client.post(url, {"title": "36 Shots", "event_id": str(uuid.uuid4())}, format="json")
    r2 = client.post(url, {"title": "Fun Fair", "event_id": str(uuid.uuid4())}, format="json")
    assert r1.status_code == 201, r1.content
    assert r2.status_code == 201, r2.content
    assert r1.json()["campaign"]["id"] != r2.json()["campaign"]["id"]
    # Both persist — the old one-per-tournament constraint is gone.
    assert LensCampaign.objects.filter(tournament=t).count() == 2


def test_list_campaigns_with_stats():
    admin, t, _ = setup_tournament()
    open_campaign(t, admin, title="Alpha")
    open_campaign(t, admin, title="Beta")  # open_campaign is legacy; make a 2nd
    LensCampaign.objects.create(
        organization=t.organization, tournament=t, title="Beta",
    )
    r = _client(admin).get(f"/api/tournaments/{t.id}/lens/campaigns/")
    assert r.status_code == 200, r.content
    campaigns = r.json()["campaigns"]
    assert len(campaigns) >= 2
    # Every summary carries the light stat fields the picker cards need.
    for c in campaigns:
        assert "photos_total" in c and "photos_pending" in c and "passes_active" in c


def test_create_requires_fixtures():
    admin, t, _ = setup_tournament(with_fixtures=False)
    r = _client(admin).post(
        f"/api/tournaments/{t.id}/lens/campaigns/",
        {"title": "X", "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 400
    assert detail(r) == "fixtures_not_generated"


def test_create_is_idempotent_on_event_id():
    admin, t, _ = setup_tournament()
    client = _client(admin)
    url = f"/api/tournaments/{t.id}/lens/campaigns/"
    eid = str(uuid.uuid4())
    client.post(url, {"title": "Once", "event_id": eid}, format="json")
    client.post(url, {"title": "Once", "event_id": eid}, format="json")
    assert LensCampaign.objects.filter(tournament=t).count() == 1


def test_overview_scopes_to_the_campaign_param():
    admin, t, _ = setup_tournament()
    a = open_campaign(t, admin, title="Alpha")
    b = LensCampaign.objects.create(
        organization=t.organization, tournament=t, title="Beta",
    )
    client = _client(admin)
    ra = client.get(f"/api/tournaments/{t.id}/lens/?campaign={a.id}")
    rb = client.get(f"/api/tournaments/{t.id}/lens/?campaign={b.id}")
    assert ra.json()["campaign"]["title"] == "Alpha"
    assert rb.json()["campaign"]["title"] == "Beta"


def test_settings_patch_targets_the_campaign_id():
    admin, t, _ = setup_tournament()
    a = open_campaign(t, admin, title="Alpha")
    b = LensCampaign.objects.create(
        organization=t.organization, tournament=t, title="Beta",
    )
    r = _client(admin).patch(
        f"/api/tournaments/{t.id}/lens/",
        {"campaign_id": str(b.id), "title": "Beta Renamed"},
        format="json",
    )
    assert r.status_code == 200, r.content
    a.refresh_from_db()
    b.refresh_from_db()
    assert a.title == "Alpha"  # untouched
    assert b.title == "Beta Renamed"


def test_non_manager_cannot_create():
    _admin, t, _ = setup_tournament()
    from apps.lens.tests.utils import verified

    outsider = verified()
    r = _client(outsider).post(
        f"/api/tournaments/{t.id}/lens/campaigns/",
        {"title": "X", "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code in (403, 404)
