"""QR pass credentials for the Guest Lens (spec D2/D3/D12/D13).

Family-A token: ``secrets.token_urlsafe(24)``, sha256 at rest, plaintext
returned ONCE from the mint/rotate call — the passes table never shows URLs.
Mirrors ``apps/forms/services/links.py`` (create/mint/resolve) with rotation
in place so the photo FK stays stable across reprints.
"""
from __future__ import annotations

import base64
import hashlib
import io
import logging
import secrets

from django.conf import settings as django_settings
from django.db import transaction
from django.utils import timezone

from apps.audit.services import emit_audit
from apps.lens.models import LensPass

logger = logging.getLogger(__name__)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _replayed(event_type: str, event_id) -> bool:
    """True if this verb+event_id already produced an audit row (invariant 3
    replay guard, mirroring ``photos._replayed``)."""
    if not event_id:
        return False
    from apps.audit.models import AuditEvent

    return AuditEvent.objects.filter(
        idempotency_key=event_id, event_type=event_type
    ).exists()


def _base_url() -> str:
    return getattr(
        django_settings, "PUBLIC_BASE_URL", "https://fixture.doxaed.com"
    ).rstrip("/")


def upload_url(token: str) -> str:
    return f"{_base_url()}/lens/{token}"


def _qr_data_uri(url: str) -> str:
    """Base64 PNG data URI (the ``accounts/services/twofa.py`` idiom) — never
    a cached file under /media/ (it contains the secret)."""
    try:
        import qrcode

        img = qrcode.make(url)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode(
            "ascii"
        )
    except Exception:  # pragma: no cover - QR is best-effort
        logger.exception("Failed to render lens pass QR code")
        return ""


def card_payload(pass_: LensPass, token: str) -> dict:
    """The one-time printable card payload (plaintext token included)."""
    url = upload_url(token)
    return {
        "pass_id": str(pass_.id),
        "institution_id": str(pass_.institution_id),
        "institution_name": pass_.institution.name,
        "upload_url": url,
        "token": token,
        "qr_data_uri": _qr_data_uri(url),
    }


def mint_passes(*, campaign, by, event_id=None, request=None):
    """Mint a pass for every registered institution lacking one.

    Idempotent-skip: an institution that already has a pass row (active or
    revoked — rotate re-enables revoked ones) is skipped, so re-running only
    mints for newcomers. Returns ``(cards, skipped)`` — plaintext tokens are
    present ONLY for passes minted in this call.
    """
    from apps.teams.models import Institution

    insts = (
        Institution.objects.filter(
            tournament=campaign.tournament, deleted_at__isnull=True
        )
        .exclude(status__in=["withdrawn", "rejected"])
        .order_by("name")
    )
    have = set(
        LensPass.objects.filter(campaign=campaign).values_list(
            "institution_id", flat=True
        )
    )
    cards: list[dict] = []
    skipped = 0
    with transaction.atomic():
        for inst in insts:
            if inst.id in have:
                skipped += 1
                continue
            token = secrets.token_urlsafe(24)
            pass_ = LensPass.objects.create(
                organization=campaign.organization,
                campaign=campaign,
                institution=inst,
                token_hash=_hash(token),
                last_minted_at=timezone.now(),
            )
            cards.append(card_payload(pass_, token))
        emit_audit(
            actor_user=by,
            actor_role="admin",
            event_type="lens_passes_minted",
            target_type="lens_campaign",
            target_id=campaign.id,
            payload_after={"minted": len(cards), "skipped": skipped},
            organization_id=campaign.organization_id,
            tournament_id=campaign.tournament_id,
            idempotency_key=event_id,
            request=request,
        )
    return cards, skipped


def rotate_pass(*, pass_, by, event_id=None, request=None):
    """Issue a fresh token on the SAME row (reprint = rotate, spec D12): the
    old token stops resolving, photo FKs stay put. Returns
    ``(pass, plaintext_token)``."""
    # Replay guard (invariant 3): a duplicate event_id must NOT re-rotate and
    # invalidate the token the first call already returned. The empty token is
    # inert — a genuine replay already holds the real one from the first call.
    if _replayed("lens_pass_rotated", event_id):
        return pass_, ""
    token = secrets.token_urlsafe(24)
    with transaction.atomic():
        pass_.token_hash = _hash(token)
        pass_.last_minted_at = timezone.now()
        pass_.is_active = True
        pass_.save(update_fields=["token_hash", "last_minted_at", "is_active"])
        emit_audit(
            actor_user=by,
            actor_role="admin",
            event_type="lens_pass_rotated",
            target_type="lens_pass",
            target_id=pass_.id,
            payload_after={"institution_id": str(pass_.institution_id)},
            organization_id=pass_.organization_id,
            tournament_id=pass_.campaign.tournament_id,
            idempotency_key=event_id,
            request=request,
        )
    return pass_, token


def revoke_pass(*, pass_, by, event_id=None, request=None):
    with transaction.atomic():
        if pass_.is_active:
            pass_.is_active = False
            pass_.save(update_fields=["is_active"])
        emit_audit(
            actor_user=by,
            actor_role="admin",
            event_type="lens_pass_revoked",
            target_type="lens_pass",
            target_id=pass_.id,
            payload_after={"institution_id": str(pass_.institution_id)},
            organization_id=pass_.organization_id,
            tournament_id=pass_.campaign.tournament_id,
            idempotency_key=event_id,
            request=request,
        )
    return pass_


def resolve_pass(token_plaintext: str):
    """Resolve an active pass by plaintext token, or None (no existence leak:
    unknown, revoked, expired and deleted-tournament all look identical)."""
    if not token_plaintext:
        return None
    pass_ = (
        LensPass.objects.filter(
            token_hash=_hash(token_plaintext),
            is_active=True,
            campaign__tournament__deleted_at__isnull=True,
            institution__deleted_at__isnull=True,
        )
        .select_related(
            "campaign", "campaign__tournament", "institution", "organization"
        )
        .first()
    )
    if pass_ is None:
        return None
    if pass_.expires_at is not None and pass_.expires_at <= timezone.now():
        return None
    return pass_
