"""Public access tokens for a form (generalizes ``teams.RegistrationLink``).

A share link is a sha256-hashed, opaque token granting public submission access
to a single form, optionally bound to a prefilled entity, with an expiry and a
submission cap. Mirrors ``apps/teams/services/registration.py``'s token pattern:
only the hash is stored, the plaintext is returned once at creation time.
"""
from __future__ import annotations

import hashlib
import secrets

from django.utils import timezone

from apps.forms.models import Form, FormShareLink


def _hash(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def create_share_link(
    *, form: Form, created_by=None, label: str = "", expires_at=None,
    max_submissions=None, bound_entity=None, prefill=None,
):
    """Create a shareable link for ``form``. Returns ``(link, plaintext_token)``."""
    token = secrets.token_urlsafe(24)
    link = FormShareLink.objects.create(
        organization=form.organization,
        form=form,
        token_hash=_hash(token),
        label=(label or "")[:120],
        expires_at=expires_at,
        max_submissions=max_submissions,
        bound_entity=bound_entity or {},
        prefill=prefill or {},
        created_by=created_by,
    )
    return link, token


def resolve_share_link(token_plaintext: str):
    """Resolve an active, non-expired, under-cap link by plaintext token, or None."""
    if not token_plaintext:
        return None
    link = (
        FormShareLink.objects.filter(
            token_hash=_hash(token_plaintext),
            is_active=True,
            form__deleted_at__isnull=True,
        )
        .select_related("form", "form__tournament", "form__organization")
        .first()
    )
    if link is None:
        return None
    if link.expires_at is not None and link.expires_at <= timezone.now():
        return None
    if (
        link.max_submissions is not None
        and link.submission_count >= link.max_submissions
    ):
        return None
    return link
