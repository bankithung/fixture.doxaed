"""Signed, capability-based access to form file uploads.

A :class:`~apps.forms.models.FormFileUpload` is served by ``ServeUploadView``
only to the holder of a valid signed token (minted into the admin roster-detail
payload and the public-form prefill) **or** to an authenticated tournament
manager. Possession of the signed URL *is* the capability — the same pattern as
the team calendar/edit links — so one URL works in both the admin (manager
session) and the public form (no session) without a per-request auth dance.
"""
from __future__ import annotations

import uuid as _uuid

from django.core import signing

_SALT = "forms.file-upload.v1"
# Generous: these URLs are embedded in admin tables and form prefill, both of
# which re-fetch on load. 30 days keeps a tab left open overnight working.
MAX_AGE = 30 * 24 * 60 * 60


def sign_upload(upload_ref) -> str:
    return signing.TimestampSigner(salt=_SALT).sign(str(upload_ref))


def verify_upload_token(token: str, max_age: int = MAX_AGE) -> str | None:
    """Return the ``upload_ref`` the token authorizes, or None if it is invalid
    or expired (``SignatureExpired`` subclasses ``BadSignature``)."""
    try:
        return signing.TimestampSigner(salt=_SALT).unsign(token, max_age=max_age)
    except signing.BadSignature:
        return None


def upload_url(upload_ref) -> str:
    """Relative, same-origin URL the SPA links to / fetches."""
    return f"/api/forms/uploads/{upload_ref}/?t={sign_upload(upload_ref)}"


def _collect_refs(value) -> set[str]:
    """Every scalar string reachable in an answers value (recurses dict/list) —
    file fields store their ``upload_ref`` directly, and they live inside
    repeatable team/player groups, so the walk must be deep."""
    out: set[str] = set()
    if isinstance(value, str):
        out.add(value)
    elif isinstance(value, list):
        for v in value:
            out |= _collect_refs(v)
    elif isinstance(value, dict):
        for v in value.values():
            out |= _collect_refs(v)
    return out


def _as_uuid(value: str):
    try:
        return _uuid.UUID(value)
    except (ValueError, AttributeError, TypeError):
        return None


def file_meta_for(form, answers) -> dict[str, dict]:
    """Map ``{upload_ref: {name, url, content_type}}`` for every uploaded file
    referenced anywhere in ``answers`` (signed URLs the renderer can show)."""
    from apps.forms.models import FormFileUpload

    refs = {r for r in (_as_uuid(s) for s in _collect_refs(answers)) if r is not None}
    if not refs:
        return {}
    out: dict[str, dict] = {}
    for up in FormFileUpload.objects.filter(form=form, upload_ref__in=refs):
        ref = str(up.upload_ref)
        out[ref] = {
            "name": up.original_name,
            # The respondent's document name ("Aadhaar card") when given.
            "label": up.label or "",
            "url": upload_url(ref),
            "content_type": up.content_type or "",
        }
    return out
