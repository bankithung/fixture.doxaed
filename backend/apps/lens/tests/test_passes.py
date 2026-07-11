"""QR pass credentials: idempotent mint, sha256-at-rest, rotate-in-place,
revoke, resolve."""
from __future__ import annotations

import hashlib
import uuid

import pytest
from rest_framework.test import APIClient

from apps.lens.models import LensPass
from apps.lens.services.passes import resolve_pass, rotate_pass
from apps.lens.tests.utils import open_campaign, setup_tournament

pytestmark = pytest.mark.django_db


def _client(user):
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def test_mint_creates_cards_and_is_idempotent():
    admin, t, _insts = setup_tournament(
        schools=("Springfield High", "Shelbyville High")
    )
    open_campaign(t, admin)
    client = _client(admin)

    r = client.post(
        f"/api/tournaments/{t.id}/lens/passes/mint/",
        {"event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 200, r.content
    body = r.json()
    assert len(body["cards"]) == 2
    assert body["skipped"] == 0
    card = body["cards"][0]
    assert card["token"]
    assert card["token"] in card["upload_url"]
    assert card["qr_data_uri"].startswith("data:image/png;base64,")

    again = client.post(
        f"/api/tournaments/{t.id}/lens/passes/mint/",
        {"event_id": str(uuid.uuid4())},
        format="json",
    )
    assert again.json()["cards"] == []
    assert again.json()["skipped"] == 2
    assert LensPass.objects.count() == 2


def test_plaintext_never_stored_only_sha256_hash():
    admin, t, _ = setup_tournament()
    c = open_campaign(t, admin)
    client = _client(admin)
    r = client.post(
        f"/api/tournaments/{t.id}/lens/passes/mint/",
        {"event_id": str(uuid.uuid4())},
        format="json",
    )
    token = r.json()["cards"][0]["token"]
    pass_ = LensPass.objects.get(campaign=c)
    assert pass_.token_hash == hashlib.sha256(token.encode()).hexdigest()
    assert token not in pass_.token_hash


def test_rotate_invalidates_old_token_and_keeps_row():
    admin, t, _ = setup_tournament()
    c = open_campaign(t, admin)
    client = _client(admin)
    old_token = client.post(
        f"/api/tournaments/{t.id}/lens/passes/mint/",
        {"event_id": str(uuid.uuid4())},
        format="json",
    ).json()["cards"][0]["token"]
    pass_ = LensPass.objects.get(campaign=c)

    r = client.post(
        f"/api/tournaments/{t.id}/lens/passes/{pass_.id}/rotate/",
        {"event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 200, r.content
    new_token = r.json()["card"]["token"]
    assert new_token != old_token
    assert resolve_pass(old_token) is None
    resolved = resolve_pass(new_token)
    assert resolved is not None and resolved.id == pass_.id
    assert LensPass.objects.count() == 1  # same row, rotated in place


def test_revoke_blocks_resolve_and_rotate_reenables():
    admin, t, _ = setup_tournament()
    c = open_campaign(t, admin)
    client = _client(admin)
    token = client.post(
        f"/api/tournaments/{t.id}/lens/passes/mint/",
        {"event_id": str(uuid.uuid4())},
        format="json",
    ).json()["cards"][0]["token"]
    pass_ = LensPass.objects.get(campaign=c)

    r = client.post(
        f"/api/tournaments/{t.id}/lens/passes/{pass_.id}/revoke/",
        {"event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 200
    assert r.json()["pass"]["is_active"] is False
    assert resolve_pass(token) is None

    pass_.refresh_from_db()
    _p, fresh = rotate_pass(pass_=pass_, by=admin)
    assert resolve_pass(fresh) is not None


def test_resolve_rejects_unknown_token():
    assert resolve_pass("") is None
    assert resolve_pass("definitely-not-a-token") is None


def test_pass_endpoints_cross_org_404():
    admin, t, _ = setup_tournament()
    c = open_campaign(t, admin)
    _client(admin).post(
        f"/api/tournaments/{t.id}/lens/passes/mint/",
        {"event_id": str(uuid.uuid4())},
        format="json",
    )
    pass_ = LensPass.objects.get(campaign=c)
    from apps.lens.tests.utils import verified

    outsider = _client(verified())
    r = outsider.post(
        f"/api/tournaments/{t.id}/lens/passes/{pass_.id}/rotate/",
        {"event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 404
