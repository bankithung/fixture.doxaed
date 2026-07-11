"""The public shared album: approved-only, status/slug gating, no campaign."""
from __future__ import annotations

import uuid

import pytest
from rest_framework.test import APIClient

from apps.lens.models import LensPhoto
from apps.lens.services.photos import approve_photo, award_photo, hide_photo
from apps.lens.tests.utils import (
    jpeg_file,
    mint_token,
    open_campaign,
    setup_tournament,
)
from apps.tournaments.models import Tournament

pytestmark = pytest.mark.django_db


def _publish(t):
    Tournament.objects.filter(pk=t.pk).update(status="published")


def _album(t):
    return APIClient().get(
        f"/api/public/tournaments/{t.slug}/{t.id}/album/"
    )


def _setup_album(n=3):
    admin, t, _insts = setup_tournament()
    campaign = open_campaign(t, admin)
    _pass, token = mint_token(campaign, admin)
    public = APIClient()
    for _ in range(n):
        r = public.post(
            f"/api/lens/p/{token}/photos/",
            {"file": jpeg_file(), "event_id": str(uuid.uuid4())},
            format="multipart",
        )
        assert r.status_code == 201, r.content
    photos = list(LensPhoto.objects.filter(campaign=campaign).order_by("created_at"))
    return admin, t, campaign, photos


def test_album_lists_only_approved_newest_first():
    admin, t, _c, photos = _setup_album(n=3)
    approved, hidden, pending = photos
    approve_photo(photo=approved, by=admin, event_id=uuid.uuid4())
    hide_photo(photo=hidden, by=admin, event_id=uuid.uuid4())
    _publish(t)

    r = _album(t)
    assert r.status_code == 200, r.content
    body = r.json()
    assert body["campaign"] == {"title": "Guest Lens", "tagline": "36 Shots Challenge"}
    refs = [p["upload_ref"] for p in body["photos"]]
    assert refs == [str(approved.upload_ref)]
    assert str(pending.upload_ref) not in refs
    assert str(hidden.upload_ref) not in refs
    assert body["institutions"] == [
        {"id": str(approved.institution_id), "name": "Springfield High", "count": 1}
    ]
    row = body["photos"][0]
    assert row["thumb_url"].startswith("/media/lens_photos/")
    assert row["institution_name"] == "Springfield High"


def test_album_shows_award_category():
    admin, t, _c, photos = _setup_album(n=1)
    approve_photo(photo=photos[0], by=admin, event_id=uuid.uuid4())
    award_photo(
        photo=photos[0], by=admin, category="Best Team Spirit",
        event_id=uuid.uuid4(),
    )
    _publish(t)
    body = _album(t).json()
    assert body["photos"][0]["award_category"] == "Best Team Spirit"
    assert "Best Team Spirit" in body["award_categories"]


def test_draft_tournament_404():
    admin, t, _c, photos = _setup_album(n=1)
    approve_photo(photo=photos[0], by=admin, event_id=uuid.uuid4())
    # create_tournament leaves the tournament in draft: not public-facing.
    assert _album(t).status_code == 404


def test_unknown_slug_404():
    _admin, t, _c, _photos = _setup_album(n=1)
    _publish(t)
    r = APIClient().get(f"/api/public/tournaments/wrong-slug/{t.id}/album/")
    assert r.status_code == 404


def test_no_campaign_returns_null_album():
    _admin, t, _insts = setup_tournament()
    _publish(t)
    r = _album(t)
    assert r.status_code == 200
    assert r.json() == {
        "campaign": None,
        "award_categories": [],
        "institutions": [],
        "photos": [],
    }
