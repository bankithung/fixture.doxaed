"""The ONE shared card and the per-school codes behind it: mint, issue,
sign in, rotate, revoke, lock out.

The old per-school QR cards are gone (owner 2026-08-13) — everyone scans the
same poster and proves which school they are with a code, so what these tests
protect is the door, not the printing.
"""
from __future__ import annotations

import hashlib
import uuid

import pytest
from django.core.cache import cache
from rest_framework.test import APIClient

from apps.lens.models import LensCampaign, LensPass
from apps.lens.services.passes import (
    MAX_FAILURES,
    make_session_token,
    resolve_pass,
    resolve_share,
    rotate_pass,
)
from apps.lens.tests.utils import open_campaign, setup_tournament, share_token

pytestmark = pytest.mark.django_db


def _client(user):
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture(autouse=True)
def _clear_lockouts():
    # Lockouts live in the cache and would leak between tests.
    cache.clear()
    yield
    cache.clear()


def _issue(client, t, **body):
    return client.post(
        f"/api/tournaments/{t.id}/lens/passes/codes/",
        {"event_id": str(uuid.uuid4()), **body},
        format="json",
    )


# --- the card ---------------------------------------------------------------

def test_share_card_is_one_qr_for_the_whole_event():
    admin, t, _insts = setup_tournament(
        schools=("Springfield High", "Shelbyville High")
    )
    c = open_campaign(t, admin)
    client = _client(admin)

    r = client.post(
        f"/api/tournaments/{t.id}/lens/share-card/",
        {"event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 200, r.content
    card = r.json()["card"]
    assert card["token"]
    assert card["join_url"].endswith(f"/lens/join/{card['token']}")
    assert card["qr_data_uri"].startswith("data:image/png;base64,")

    # One card, not one per school: minting it does not depend on how many
    # institutions are registered.
    c.refresh_from_db()
    assert c.share_token_hash == hashlib.sha256(card["token"].encode()).hexdigest()
    assert card["token"] not in c.share_token_hash
    assert resolve_share(card["token"]).id == c.id


def test_re_minting_the_card_retires_the_poster_on_the_wall():
    admin, t, _ = setup_tournament()
    c = open_campaign(t, admin)
    old = share_token(c, admin)
    new = share_token(c, admin)
    assert new != old
    assert resolve_share(old) is None
    assert resolve_share(new) is not None


def test_resolve_share_rejects_nonsense():
    assert resolve_share("") is None
    assert resolve_share("definitely-not-a-token") is None


# --- the codes --------------------------------------------------------------

def test_codes_are_issued_once_and_kept_on_re_run():
    admin, t, _ = setup_tournament(schools=("Springfield High", "Shelbyville High"))
    open_campaign(t, admin)
    client = _client(admin)

    r = _issue(client, t)
    assert r.status_code == 200, r.content
    rows = r.json()["codes"]
    assert len(rows) == 2
    assert all(len(row["code"]) == 8 for row in rows)
    assert r.json()["skipped"] == 0

    # A late-registration re-run must not invalidate codes already handed out.
    again = _issue(client, t)
    assert again.json()["codes"] == []
    assert again.json()["skipped"] == 2
    assert LensPass.objects.count() == 2


def test_code_is_hashed_slowly_never_stored_in_the_clear():
    admin, t, _ = setup_tournament()
    c = open_campaign(t, admin)
    code = _issue(_client(admin), t).json()["codes"][0]["code"]
    pass_ = LensPass.objects.get(campaign=c)

    assert code not in pass_.code_hash
    # An 8-character code under sha256 is brute-forceable offline; this must be
    # a salted password hash, like the team-registration codes.
    assert pass_.code_hash.startswith("argon2")
    assert pass_.code_hash != hashlib.sha256(code.encode()).hexdigest()
    # The manager list says whether a code exists, never what it is.
    row = next(
        p
        for p in _client(admin).get(f"/api/tournaments/{t.id}/lens/").json()["passes"]
        if p["id"] == str(pass_.id)
    )
    assert row["has_code"] is True
    assert code not in str(row)


def test_issue_for_chosen_schools_rotates_only_those():
    admin, t, insts = setup_tournament(
        schools=("Springfield High", "Shelbyville High")
    )
    c = open_campaign(t, admin)
    client = _client(admin)
    first = {r["institution_name"]: r["code"] for r in _issue(client, t).json()["codes"]}

    target = next(i for i in insts if i.name == "Springfield High")
    r = _issue(client, t, institution_ids=[str(target.id)])
    rows = r.json()["codes"]
    assert [row["institution_name"] for row in rows] == ["Springfield High"]
    assert rows[0]["code"] != first["Springfield High"]

    # The school that was not picked keeps the code it was given.
    other = LensPass.objects.get(
        campaign=c, institution__name="Shelbyville High"
    )
    from django.contrib.auth.hashers import check_password

    assert check_password(first["Shelbyville High"], other.code_hash)


# --- signing in -------------------------------------------------------------

def test_scan_then_code_opens_that_school_and_nothing_else():
    admin, t, _ = setup_tournament(schools=("Springfield High", "Shelbyville High"))
    c = open_campaign(t, admin)
    token = share_token(c, admin)
    rows = _issue(_client(admin), t).json()["codes"]
    mine = rows[0]

    anon = APIClient()
    ctx = anon.get(f"/api/lens/join/{token}/")
    assert ctx.status_code == 200, ctx.content
    body = ctx.json()
    assert body["campaign"]["is_open"] is True
    # The picker names the schools and says nothing else about them.
    assert [i["name"] for i in body["institutions"]] == [
        "Shelbyville High",
        "Springfield High",
    ]
    # The picker carries names and ids, never a code or a hash.
    assert all(set(i) == {"id", "name"} for i in body["institutions"])
    assert "code_hash" not in str(body)

    r = anon.post(
        f"/api/lens/join/{token}/",
        {"institution_id": mine["institution_id"], "code": mine["code"]},
        format="json",
    )
    assert r.status_code == 200, r.content
    session = r.json()["token"]
    assert r.json()["institution"]["name"] == mine["institution_name"]

    resolved = resolve_pass(session)
    assert resolved is not None
    assert str(resolved.institution_id) == mine["institution_id"]


def test_code_is_case_insensitive_and_trims():
    admin, t, _ = setup_tournament()
    c = open_campaign(t, admin)
    token = share_token(c, admin)
    row = _issue(_client(admin), t).json()["codes"][0]

    r = APIClient().post(
        f"/api/lens/join/{token}/",
        {"institution_id": row["institution_id"], "code": f"  {row['code'].lower()} "},
        format="json",
    )
    assert r.status_code == 200, r.content


def test_wrong_code_and_unknown_school_answer_identically():
    admin, t, _ = setup_tournament()
    c = open_campaign(t, admin)
    token = share_token(c, admin)
    row = _issue(_client(admin), t).json()["codes"][0]
    anon = APIClient()

    wrong = anon.post(
        f"/api/lens/join/{token}/",
        {"institution_id": row["institution_id"], "code": "WRONGWRO"},
        format="json",
    )
    unknown = anon.post(
        f"/api/lens/join/{token}/",
        {"institution_id": str(uuid.uuid4()), "code": "WRONGWRO"},
        format="json",
    )
    # Same status AND same body: the picker must not become a way to learn who
    # is registered, or whether a school has been revoked.
    assert wrong.status_code == unknown.status_code == 400
    assert wrong.json() == unknown.json()
    assert "invalid_code" in str(wrong.json())


def test_five_wrong_codes_lock_that_school_out():
    admin, t, _ = setup_tournament()
    c = open_campaign(t, admin)
    token = share_token(c, admin)
    row = _issue(_client(admin), t).json()["codes"][0]
    anon = APIClient()

    for _ in range(MAX_FAILURES):
        anon.post(
            f"/api/lens/join/{token}/",
            {"institution_id": row["institution_id"], "code": "WRONGWRO"},
            format="json",
        )
    # Even the RIGHT code is refused while the lockout holds.
    r = anon.post(
        f"/api/lens/join/{token}/",
        {"institution_id": row["institution_id"], "code": row["code"]},
        format="json",
    )
    assert r.status_code == 400
    assert "locked" in str(r.json())


def test_retired_per_school_card_tokens_no_longer_open_anything():
    admin, t, _ = setup_tournament()
    c = open_campaign(t, admin)
    _issue(_client(admin), t)
    pass_ = LensPass.objects.get(campaign=c)
    # A card printed under the old scheme carried a raw token in the URL.
    pass_.token_hash = hashlib.sha256(b"old-printed-token").hexdigest()
    pass_.save(update_fields=["token_hash"])

    assert resolve_pass("old-printed-token") is None
    assert APIClient().get("/api/lens/p/old-printed-token/").status_code == 404


def test_session_token_dies_with_the_school_it_names():
    admin, t, _ = setup_tournament()
    c = open_campaign(t, admin)
    _issue(_client(admin), t)
    pass_ = LensPass.objects.get(campaign=c)
    session = make_session_token(pass_)
    assert resolve_pass(session) is not None

    pass_.is_active = False
    pass_.save(update_fields=["is_active"])
    assert resolve_pass(session) is None


def test_resolve_pass_rejects_forged_and_empty_tokens():
    assert resolve_pass("") is None
    assert resolve_pass("definitely-not-a-token") is None
    assert resolve_pass("a.b.c") is None


# --- rotate / revoke --------------------------------------------------------

def test_rotate_gives_one_school_a_new_code_and_keeps_its_row():
    admin, t, _ = setup_tournament()
    c = open_campaign(t, admin)
    client = _client(admin)
    old = _issue(client, t).json()["codes"][0]["code"]
    pass_ = LensPass.objects.get(campaign=c)
    token = share_token(c, admin)

    r = client.post(
        f"/api/tournaments/{t.id}/lens/passes/{pass_.id}/rotate/",
        {"event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 200, r.content
    new = r.json()["code"]["code"]
    assert new != old
    assert LensPass.objects.count() == 1  # same row, rotated in place

    anon = APIClient()
    stale = anon.post(
        f"/api/lens/join/{token}/",
        {"institution_id": str(pass_.institution_id), "code": old},
        format="json",
    )
    assert stale.status_code == 400
    fresh = anon.post(
        f"/api/lens/join/{token}/",
        {"institution_id": str(pass_.institution_id), "code": new},
        format="json",
    )
    assert fresh.status_code == 200, fresh.content


def test_rotate_clears_a_lockout_so_a_stuck_school_can_be_rescued():
    admin, t, _ = setup_tournament()
    c = open_campaign(t, admin)
    client = _client(admin)
    row = _issue(client, t).json()["codes"][0]
    token = share_token(c, admin)
    anon = APIClient()
    for _ in range(MAX_FAILURES):
        anon.post(
            f"/api/lens/join/{token}/",
            {"institution_id": row["institution_id"], "code": "WRONGWRO"},
            format="json",
        )

    pass_ = LensPass.objects.get(campaign=c)
    _p, fresh = rotate_pass(pass_=pass_, by=admin)
    r = anon.post(
        f"/api/lens/join/{token}/",
        {"institution_id": row["institution_id"], "code": fresh},
        format="json",
    )
    assert r.status_code == 200, r.content


def test_revoked_school_drops_out_of_the_picker_and_cannot_sign_in():
    admin, t, _ = setup_tournament()
    c = open_campaign(t, admin)
    client = _client(admin)
    row = _issue(client, t).json()["codes"][0]
    token = share_token(c, admin)
    pass_ = LensPass.objects.get(campaign=c)

    r = client.post(
        f"/api/tournaments/{t.id}/lens/passes/{pass_.id}/revoke/",
        {"event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 200
    assert r.json()["pass"]["is_active"] is False

    anon = APIClient()
    assert anon.get(f"/api/lens/join/{token}/").json()["institutions"] == []
    assert (
        anon.post(
            f"/api/lens/join/{token}/",
            {"institution_id": row["institution_id"], "code": row["code"]},
            format="json",
        ).status_code
        == 400
    )


# --- scope ------------------------------------------------------------------

def test_pass_endpoints_cross_org_404():
    admin, t, _ = setup_tournament()
    c = open_campaign(t, admin)
    _issue(_client(admin), t)
    pass_ = LensPass.objects.get(campaign=c)
    from apps.lens.tests.utils import verified

    outsider = _client(verified())
    for path in (
        f"/api/tournaments/{t.id}/lens/passes/{pass_.id}/rotate/",
        f"/api/tournaments/{t.id}/lens/share-card/",
        f"/api/tournaments/{t.id}/lens/passes/codes/",
    ):
        r = outsider.post(path, {"event_id": str(uuid.uuid4())}, format="json")
        assert r.status_code == 404, path


def test_card_of_a_deleted_tournament_stops_opening():
    admin, t, _ = setup_tournament()
    c = open_campaign(t, admin)
    token = share_token(c, admin)
    assert APIClient().get(f"/api/lens/join/{token}/").status_code == 200

    from django.utils import timezone

    t.deleted_at = timezone.now()
    t.save(update_fields=["deleted_at"])
    assert LensCampaign.objects.filter(id=c.id).exists()
    assert APIClient().get(f"/api/lens/join/{token}/").status_code == 404
