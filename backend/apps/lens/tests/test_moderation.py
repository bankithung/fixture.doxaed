"""Moderation: approve/hide timestamps + audit, physical quarantine moves,
winner-per-category awards, idempotent replays."""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from django.conf import settings as django_settings
from rest_framework.test import APIClient

from apps.audit.models import AuditEvent
from apps.lens.models import LensPhoto
from apps.lens.tests.utils import (
    detail,
    jpeg_file,
    mint_token,
    open_campaign,
    setup_tournament,
)

pytestmark = pytest.mark.django_db


def _setup_with_photos(n=1, **campaign_settings):
    admin, t, _insts = setup_tournament()
    campaign = open_campaign(t, admin, **campaign_settings)
    _pass, token = mint_token(campaign, admin)
    public = APIClient()
    for _i in range(n):
        r = public.post(
            f"/api/lens/p/{token}/photos/",
            {"file": jpeg_file(), "event_id": str(uuid.uuid4())},
            format="multipart",
        )
        assert r.status_code == 201, r.content
    photos = list(LensPhoto.objects.filter(campaign=campaign).order_by("created_at"))
    client = APIClient()
    client.force_authenticate(user=admin)
    return admin, t, campaign, photos, client


def _paths(photo):
    media = Path(django_settings.MEDIA_ROOT)
    quarantine = Path(django_settings.LENS_QUARANTINE_ROOT)
    return (
        media / photo.image.name,
        media / photo.thumb.name,
        quarantine / photo.image.name,
        quarantine / photo.thumb.name,
    )


def test_approve_sets_timestamp_and_audits():
    admin, t, _c, photos, client = _setup_with_photos()
    p = photos[0]
    r = client.post(
        f"/api/tournaments/{t.id}/lens/photos/{p.id}/approve/",
        {"event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert r.json()["photo"]["status"] == "approved"
    p.refresh_from_db()
    assert p.approved_at is not None
    assert p.approved_by_id == admin.id
    assert AuditEvent.objects.filter(
        event_type="lens_photo_approved", target_id=p.id
    ).count() == 1


def test_hide_moves_files_to_quarantine():
    _admin, t, _c, photos, client = _setup_with_photos()
    p = photos[0]
    img, thumb, q_img, q_thumb = _paths(p)
    assert img.exists() and thumb.exists()

    r = client.post(
        f"/api/tournaments/{t.id}/lens/photos/{p.id}/hide/",
        {"event_id": str(uuid.uuid4()), "reason": "Not appropriate"},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert r.json()["photo"]["status"] == "hidden"
    assert r.json()["photo"]["hidden_reason"] == "Not appropriate"
    # Physical takedown: files left MEDIA_ROOT (nginx now 404s the URLs).
    assert not img.exists() and not thumb.exists()
    assert q_img.exists() and q_thumb.exists()


def test_approve_from_hidden_restores_files():
    _admin, t, _c, photos, client = _setup_with_photos()
    p = photos[0]
    img, thumb, q_img, q_thumb = _paths(p)
    client.post(
        f"/api/tournaments/{t.id}/lens/photos/{p.id}/hide/",
        {"event_id": str(uuid.uuid4())},
        format="json",
    )
    assert q_img.exists()
    r = client.post(
        f"/api/tournaments/{t.id}/lens/photos/{p.id}/approve/",
        {"event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 200
    assert r.json()["photo"]["status"] == "approved"
    assert img.exists() and thumb.exists()
    assert not q_img.exists() and not q_thumb.exists()
    p.refresh_from_db()
    assert p.hidden_at is None and p.hidden_reason == ""


def test_award_assigns_and_steals_from_previous_holder():
    _admin, t, _c, photos, client = _setup_with_photos(n=2)
    a, b = photos
    for p in (a, b):
        client.post(
            f"/api/tournaments/{t.id}/lens/photos/{p.id}/approve/",
            {"event_id": str(uuid.uuid4())},
            format="json",
        )
    cat = "Best Action Shot"
    r1 = client.post(
        f"/api/tournaments/{t.id}/lens/photos/{a.id}/award/",
        {"event_id": str(uuid.uuid4()), "category": cat},
        format="json",
    )
    assert r1.status_code == 200
    assert r1.json()["photo"]["award_category"] == cat

    r2 = client.post(
        f"/api/tournaments/{t.id}/lens/photos/{b.id}/award/",
        {"event_id": str(uuid.uuid4()), "category": cat},
        format="json",
    )
    assert r2.status_code == 200
    a.refresh_from_db()
    b.refresh_from_db()
    assert b.award_category == cat
    assert a.award_category == ""  # winner-per-category (spec D11)

    clear = client.post(
        f"/api/tournaments/{t.id}/lens/photos/{b.id}/award/",
        {"event_id": str(uuid.uuid4()), "category": ""},
        format="json",
    )
    assert clear.status_code == 200
    b.refresh_from_db()
    assert b.award_category == ""


def test_award_rejects_unknown_category_and_non_approved():
    _admin, t, _c, photos, client = _setup_with_photos(n=2)
    a, b = photos
    client.post(
        f"/api/tournaments/{t.id}/lens/photos/{a.id}/approve/",
        {"event_id": str(uuid.uuid4())},
        format="json",
    )
    bad = client.post(
        f"/api/tournaments/{t.id}/lens/photos/{a.id}/award/",
        {"event_id": str(uuid.uuid4()), "category": "Not A Category"},
        format="json",
    )
    assert bad.status_code == 400
    assert detail(bad) == "unknown_category"

    pending = client.post(
        f"/api/tournaments/{t.id}/lens/photos/{b.id}/award/",
        {"event_id": str(uuid.uuid4()), "category": "Best Action Shot"},
        format="json",
    )
    assert pending.status_code == 400
    assert detail(pending) == "not_approved"


def test_moderation_replays_are_idempotent():
    _admin, t, _c, photos, client = _setup_with_photos()
    p = photos[0]
    event_id = str(uuid.uuid4())
    first = client.post(
        f"/api/tournaments/{t.id}/lens/photos/{p.id}/approve/",
        {"event_id": event_id},
        format="json",
    )
    replay = client.post(
        f"/api/tournaments/{t.id}/lens/photos/{p.id}/approve/",
        {"event_id": event_id},
        format="json",
    )
    assert first.status_code == replay.status_code == 200
    assert AuditEvent.objects.filter(event_type="lens_photo_approved").count() == 1

    hide_id = str(uuid.uuid4())
    for _ in range(2):
        r = client.post(
            f"/api/tournaments/{t.id}/lens/photos/{p.id}/hide/",
            {"event_id": hide_id},
            format="json",
        )
        assert r.status_code == 200
    assert AuditEvent.objects.filter(event_type="lens_photo_hidden").count() == 1


def test_hidden_photo_removed_status_on_public_pass_page():
    _admin, t, campaign, photos, client = _setup_with_photos()
    p = photos[0]
    client.post(
        f"/api/tournaments/{t.id}/lens/photos/{p.id}/hide/",
        {"event_id": str(uuid.uuid4()), "reason": "internal note"},
        format="json",
    )
    from apps.lens.models import LensPass

    pass_ = LensPass.objects.get(campaign=campaign)
    # Rotate a fresh token to read the page (plaintext of the first mint is
    # gone by design); resolve via the service to keep the test honest.
    from apps.lens.services.passes import rotate_pass

    _p, token = rotate_pass(pass_=pass_, by=_admin)
    body = APIClient().get(f"/api/lens/p/{token}/").json()
    assert body["photos"][0]["status"] == "removed"
    assert "reason" not in body["photos"][0]
