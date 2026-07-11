"""Public upload pipeline through the pass token: re-encode, quota, guards,
self-delete."""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from django.conf import settings as django_settings
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from rest_framework.test import APIClient

from apps.lens.models import LensPhoto
from apps.lens.services.photos import approve_photo
from apps.lens.tests.utils import (
    detail,
    jpeg_file,
    mint_token,
    open_campaign,
    setup_tournament,
)

pytestmark = pytest.mark.django_db


def _setup(**campaign_settings):
    admin, t, _insts = setup_tournament()
    campaign = open_campaign(t, admin, **campaign_settings)
    pass_, token = mint_token(campaign, admin)
    return admin, t, campaign, pass_, token


def _upload(token, file=None, caption="", category="", event_id=None):
    data = {"event_id": event_id or str(uuid.uuid4())}
    if file is not None:
        data["file"] = file
    if caption:
        data["caption"] = caption
    if category:
        data["category"] = category
    return APIClient().post(f"/api/lens/p/{token}/photos/", data, format="multipart")


def test_upload_happy_path_reencodes_and_thumbs():
    from PIL import Image

    _admin, _t, campaign, _pass, token = _setup()
    r = _upload(token, jpeg_file(size=(3000, 2000)), caption="Kickoff")
    assert r.status_code == 201, r.content
    body = r.json()["photo"]
    assert body["status"] == "pending"
    assert body["caption"] == "Kickoff"

    photo = LensPhoto.objects.get(campaign=campaign)
    media = Path(django_settings.MEDIA_ROOT)
    image_path = media / photo.image.name
    thumb_path = media / photo.thumb.name
    assert image_path.exists() and thumb_path.exists()
    with Image.open(image_path) as img:
        assert img.format == "JPEG"
        assert max(img.size) <= 2560  # capped from 3000
    with Image.open(thumb_path) as th:
        assert max(th.size) <= 480
    assert photo.content_type == "image/jpeg"
    assert photo.width <= 2560 and photo.height <= 2560


def test_exif_orientation_applied():
    _admin, _t, campaign, _pass, token = _setup()
    # Orientation 6 = rotate 90: a landscape source must be stored portrait.
    r = _upload(token, jpeg_file(size=(1200, 800), orientation=6))
    assert r.status_code == 201, r.content
    photo = LensPhoto.objects.get(campaign=campaign)
    assert (photo.width, photo.height) == (800, 1200)


def test_event_id_replay_returns_same_photo():
    _admin, _t, campaign, _pass, token = _setup()
    event_id = str(uuid.uuid4())
    first = _upload(token, jpeg_file(), event_id=event_id)
    replay = _upload(token, jpeg_file(), event_id=event_id)
    assert first.status_code == 201 and replay.status_code == 201
    assert (
        first.json()["photo"]["upload_ref"] == replay.json()["photo"]["upload_ref"]
    )
    assert LensPhoto.objects.filter(campaign=campaign).count() == 1


def test_quota_exceeded_at_cap():
    _admin, _t, _c, _pass, token = _setup(max_photos_per_institution=2)
    assert _upload(token, jpeg_file()).status_code == 201
    assert _upload(token, jpeg_file()).status_code == 201
    third = _upload(token, jpeg_file())
    assert third.status_code == 400
    assert detail(third) == "quota_exceeded"


def test_upload_with_category_stores_it():
    _admin, _t, campaign, _pass, token = _setup()
    r = _upload(token, jpeg_file(), category="Best Action Shot")
    assert r.status_code == 201, r.content
    assert r.json()["photo"]["category"] == "Best Action Shot"
    photo = LensPhoto.objects.get(campaign=campaign)
    assert photo.category == "Best Action Shot"


def test_upload_unknown_category_rejected():
    _admin, _t, _c, _pass, token = _setup()
    r = _upload(token, jpeg_file(), category="Not A Category")
    assert r.status_code == 400
    assert detail(r) == "unknown_category"


def test_category_quota_exceeded_at_category_cap():
    _admin, _t, _c, _pass, token = _setup(
        max_photos_per_institution=10,
        category_limits={"Best Action Shot": 1},
    )
    assert (
        _upload(token, jpeg_file(), category="Best Action Shot").status_code == 201
    )
    second = _upload(token, jpeg_file(), category="Best Action Shot")
    assert second.status_code == 400
    assert detail(second) == "category_quota_exceeded"
    # Other categories and uncategorized uploads are unaffected.
    assert (
        _upload(token, jpeg_file(), category="Best Team Spirit").status_code == 201
    )
    assert _upload(token, jpeg_file()).status_code == 201


def test_category_without_limit_only_bounded_by_overall_cap():
    _admin, _t, _c, _pass, token = _setup(
        max_photos_per_institution=2,
        category_limits={"Best Team Spirit": 1},
    )
    assert (
        _upload(token, jpeg_file(), category="Best Action Shot").status_code == 201
    )
    assert (
        _upload(token, jpeg_file(), category="Best Action Shot").status_code == 201
    )
    third = _upload(token, jpeg_file(), category="Best Action Shot")
    assert detail(third) == "quota_exceeded"


def test_delete_own_pending_frees_category_quota():
    _admin, _t, _campaign, _pass, token = _setup(
        category_limits={"Best Action Shot": 1},
    )
    first = _upload(token, jpeg_file(), category="Best Action Shot")
    ref = first.json()["photo"]["upload_ref"]
    blocked = _upload(token, jpeg_file(), category="Best Action Shot")
    assert detail(blocked) == "category_quota_exceeded"
    d = APIClient().delete(f"/api/lens/p/{token}/photos/{ref}/")
    assert d.status_code == 200
    assert (
        _upload(token, jpeg_file(), category="Best Action Shot").status_code == 201
    )


def test_campaign_closed_blocks_upload():
    _admin, _t, campaign, _pass, token = _setup()
    campaign.closed_at = timezone.now()
    campaign.save(update_fields=["closed_at"])
    r = _upload(token, jpeg_file())
    assert r.status_code == 400
    assert detail(r) == "campaign_closed"


def test_revoked_pass_404():
    _admin, _t, _c, pass_, token = _setup()
    pass_.is_active = False
    pass_.save(update_fields=["is_active"])
    r = _upload(token, jpeg_file())
    assert r.status_code == 404
    assert APIClient().get(f"/api/lens/p/{token}/").status_code == 404


def test_file_too_large():
    _admin, _t, _c, _pass, token = _setup()
    big = SimpleUploadedFile(
        "big.jpg", b"\0" * (10 * 1024 * 1024 + 1), content_type="image/jpeg"
    )
    r = _upload(token, big)
    assert r.status_code == 400
    assert detail(r) == "file_too_large"


def test_unsupported_type():
    _admin, _t, _c, _pass, token = _setup()
    pdf = SimpleUploadedFile("doc.pdf", b"%PDF-1.4", content_type="application/pdf")
    r = _upload(token, pdf)
    assert r.status_code == 400
    assert detail(r) == "unsupported_type"


def test_invalid_image_garbage_bytes():
    _admin, _t, _c, _pass, token = _setup()
    fake = SimpleUploadedFile(
        "fake.jpg", b"not an image at all", content_type="image/jpeg"
    )
    r = _upload(token, fake)
    assert r.status_code == 400
    assert detail(r) == "invalid_image"


def test_no_file():
    _admin, _t, _c, _pass, token = _setup()
    r = _upload(token, None)
    assert r.status_code == 400
    assert detail(r) == "no_file"


def test_delete_own_pending_frees_quota():
    _admin, _t, campaign, _pass, token = _setup(max_photos_per_institution=1)
    first = _upload(token, jpeg_file())
    assert first.status_code == 201
    ref = first.json()["photo"]["upload_ref"]
    assert detail(_upload(token, jpeg_file())) == "quota_exceeded"

    d = APIClient().delete(f"/api/lens/p/{token}/photos/{ref}/")
    assert d.status_code == 200
    assert d.json() == {"removed": True}
    assert LensPhoto.objects.filter(campaign=campaign).count() == 0
    assert _upload(token, jpeg_file()).status_code == 201


def test_delete_approved_is_locked():
    admin, _t, campaign, _pass, token = _setup()
    first = _upload(token, jpeg_file())
    ref = first.json()["photo"]["upload_ref"]
    photo = LensPhoto.objects.get(campaign=campaign)
    approve_photo(photo=photo, by=admin, event_id=uuid.uuid4())
    d = APIClient().delete(f"/api/lens/p/{token}/photos/{ref}/")
    assert d.status_code == 400
    assert detail(d) == "photo_locked"


def test_pass_context_payload():
    _admin, t, _campaign, pass_, token = _setup(
        category_limits={"Best Action Shot": 5},
    )
    _upload(token, jpeg_file(), caption="One", category="Best Action Shot")
    r = APIClient().get(f"/api/lens/p/{token}/")
    assert r.status_code == 200
    body = r.json()
    assert body["tournament"]["id"] == str(t.id)
    assert body["institution"]["name"] == pass_.institution.name
    assert body["campaign"]["is_open"] is True
    assert body["campaign"]["category_limits"] == {"Best Action Shot": 5}
    assert "Best Action Shot" in body["campaign"]["award_categories"]
    assert body["quota"] == {
        "used": 1,
        "max": 36,
        "by_category": {"Best Action Shot": 1},
    }
    assert body["photos"][0]["status"] == "pending"
    assert body["photos"][0]["category"] == "Best Action Shot"
