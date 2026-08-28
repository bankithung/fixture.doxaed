"""Crest/upload URLs must be STABLE so the browser can cache them.

2026-08-28 (Dimapur live event): every live-board payload re-minted its crest
URLs with a per-second ``TimestampSigner`` stamp, so each score tick handed the
browser a *new* URL per logo and it re-downloaded every crest through Django on
every tick. The token stamp is now bucketed to a day and the file response is
cacheable; the capability check and ``MAX_AGE`` expiry are unchanged.
"""
from __future__ import annotations

import time
import uuid as _uuid
from unittest import mock

from django.core import signing

from apps.forms.services import uploads as svc


def test_same_ref_gets_same_url_within_a_day():
    ref = _uuid.uuid4()
    base = 1_800_000_000  # some second, mid-bucket
    with mock.patch.object(time, "time", return_value=base):
        first = svc.upload_url(ref)
    with mock.patch.object(time, "time", return_value=base + 3600):
        later = svc.upload_url(ref)
    assert first == later
    assert first.startswith(f"/api/forms/uploads/{ref}/?t=")


def test_url_changes_across_bucket_boundary():
    ref = _uuid.uuid4()
    bucket = svc.TOKEN_BUCKET_SECONDS
    with mock.patch.object(time, "time", return_value=bucket * 1000):
        a = svc.upload_url(ref)
    with mock.patch.object(time, "time", return_value=bucket * 1001):
        b = svc.upload_url(ref)
    assert a != b


def test_bucketed_token_verifies_and_still_expires():
    ref = str(_uuid.uuid4())
    token = svc.sign_upload(ref)
    assert svc.verify_upload_token(token) == ref
    # Bucketing only ever makes a token look OLDER, so expiry is never late:
    # at MAX_AGE + one bucket past minting it must be rejected...
    with mock.patch.object(
        time, "time", return_value=time.time() + svc.MAX_AGE + svc.TOKEN_BUCKET_SECONDS + 1
    ):
        assert svc.verify_upload_token(token) is None
    # ...and a tampered token is rejected outright.
    assert svc.verify_upload_token(token[:-2] + "xx") is None


def test_legacy_per_second_token_still_verifies():
    """URLs minted before the change (plain TimestampSigner) keep working —
    a tab left open across the deploy must not lose its crests."""
    ref = str(_uuid.uuid4())
    legacy = signing.TimestampSigner(salt=svc._SALT).sign(ref)
    assert svc.verify_upload_token(legacy) == ref
