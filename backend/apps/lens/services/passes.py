"""Credentials for the Guest Lens (spec D2/D3/D12/D13, reshaped 2026-08-13).

ONE card for the event, not one per school. Two credentials in two shapes,
each hashed to suit its own length:

- The campaign's **share token** — ``secrets.token_urlsafe(24)``, sha256 at
  rest, printed once into the QR on the poster. It identifies the album, not
  a school, so scanning it grants nothing on its own.
- A school's **code** — 8 characters it can read off a slip and type, so it is
  stored under a slow salted password hash and guarded by a per-school lockout
  (``verify_code``), exactly like ``teams.services.access``.

A code check mints a signed, expiring **session token**; that is what the
upload endpoints resolve. Old per-school card tokens no longer resolve at all:
the shared card is the only door in.
"""
from __future__ import annotations

import base64
import hashlib
import io
import logging
import secrets

from django.conf import settings as django_settings
from django.contrib.auth.hashers import check_password, make_password
from django.core import signing
from django.core.cache import cache
from django.db import transaction
from django.utils import timezone

from apps.audit.services import emit_audit
from apps.lens.models import LensPass

logger = logging.getLogger(__name__)

# No 0/O/1/I — a code gets read off a slip and typed on a phone.
_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 8
MAX_FAILURES = 5
LOCKOUT_SECONDS = 15 * 60
SESSION_SALT = "lens-pass-session"
# One long event day: a teacher who signs in at the opening ceremony can still
# upload after the closing one without typing the code again.
SESSION_MAX_AGE = 12 * 60 * 60


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


def rotate_pass(*, pass_, by, event_id=None, request=None):
    """Give ONE school a fresh code on the SAME row: the old code stops
    working, the shared card is untouched, photo FKs stay put. Returns
    ``(pass, plaintext_code)``."""
    # Replay guard (invariant 3): a duplicate event_id must NOT re-rotate and
    # invalidate the code the first call already returned. The empty code is
    # inert — a genuine replay already holds the real one from the first call.
    if _replayed("lens_pass_rotated", event_id):
        return pass_, ""
    code = generate_code()
    with transaction.atomic():
        pass_.code_hash = make_password(code)
        pass_.code_set_at = timezone.now()
        pass_.last_minted_at = timezone.now()
        pass_.is_active = True
        pass_.save(
            update_fields=[
                "code_hash", "code_set_at", "last_minted_at", "is_active",
            ]
        )
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
    cache.delete(_fail_key(pass_.id))
    cache.delete(_lock_key(pass_.id))
    return pass_, code


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


def _live_pass(**filters):
    """One usable pass row, or None. No existence leak: unknown, revoked,
    expired and deleted-tournament all look identical to the caller."""
    pass_ = (
        LensPass.objects.filter(
            is_active=True,
            campaign__tournament__deleted_at__isnull=True,
            institution__deleted_at__isnull=True,
            **filters,
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


def resolve_pass(token_plaintext: str):
    """Resolve the upload session behind a join token.

    The credential the upload endpoints see is no longer a printed per-school
    token: it is the signed, expiring token the join page hands back once a
    school has typed its code (see ``make_session_token``). Old card tokens
    deliberately do NOT resolve — the shared card is the only door in.
    """
    payload = read_session_token(token_plaintext)
    if payload is None:
        return None
    return _live_pass(id=payload["p"], campaign_id=payload["c"])


# --- the one shared card ---------------------------------------------------

def share_url(token: str) -> str:
    return f"{_base_url()}/lens/join/{token}"


def mint_share_card(*, campaign, by, event_id=None, request=None):
    """Mint (or re-mint) the campaign's single card. Rotating it invalidates
    the poster already on the wall, so it is an explicit act, never a
    side effect of opening the campaign. Returns ``(campaign, token)``."""
    if _replayed("lens_share_card_minted", event_id):
        return campaign, ""
    token = secrets.token_urlsafe(24)
    with transaction.atomic():
        campaign.share_token_hash = _hash(token)
        campaign.share_minted_at = timezone.now()
        campaign.share_token_encrypted = _encrypt(token)
        campaign.save(
            update_fields=[
                "share_token_hash",
                "share_minted_at",
                "share_token_encrypted",
            ]
        )
        emit_audit(
            actor_user=by,
            actor_role="admin",
            event_type="lens_share_card_minted",
            target_type="lens_campaign",
            target_id=campaign.id,
            organization_id=campaign.organization_id,
            tournament_id=campaign.tournament_id,
            idempotency_key=event_id,
            request=request,
        )
    return campaign, token


def share_card_payload(campaign, token: str) -> dict:
    """The printable poster payload (plaintext token included, once)."""
    url = share_url(token)
    return {
        "campaign_id": str(campaign.id),
        "title": campaign.title,
        "tagline": campaign.tagline,
        "join_url": url,
        "token": token,
        "qr_data_uri": _qr_data_uri(url),
    }


# --- recoverable card (owner 2026-08-25) -------------------------------------
# The hash-at-rest rule made the QR a one-time reveal, which meant a host who
# lost the printout had to REPLACE the card — retiring a poster that was
# still on the wall. The token is now also stored ENCRYPTED at rest
# (Fernet, keyed off the deployment secret), so the manager can re-view and
# re-print the SAME card forever. The hash stays the verification path; the
# ciphertext is only ever readable through the manager-gated endpoint.

from cryptography.fernet import Fernet  # noqa: E402
from django.core.exceptions import ImproperlyConfigured  # noqa: E402

_FERNET_KEY = None


def _fernet() -> Fernet:
    global _FERNET_KEY
    if _FERNET_KEY is None:
        secret = django_settings.SECRET_KEY
        if not secret:
            raise ImproperlyConfigured("SECRET_KEY required for lens cards")
        digest = hashlib.sha256(secret.encode()).digest()
        _FERNET_KEY = base64.urlsafe_b64encode(digest)
    return Fernet(_FERNET_KEY)


def _encrypt(token: str) -> str:
    return _fernet().encrypt(token.encode()).decode()


def current_card(campaign):
    """The card in use, decrypted for the manager — or None. This is what
    makes the poster re-viewable and re-printable after any refresh."""
    if not campaign.share_token_encrypted or not campaign.share_token_hash:
        return None
    try:
        token = _fernet().decrypt(
            campaign.share_token_encrypted.encode()
        ).decode()
    except Exception:
        return None
    return share_card_payload(campaign, token)


def resolve_share(token_plaintext: str):
    """The open campaign behind a scanned card, or None."""
    if not token_plaintext:
        return None
    from apps.lens.models import LensCampaign

    return (
        LensCampaign.objects.filter(
            share_token_hash=_hash(token_plaintext),
            tournament__deleted_at__isnull=True,
        )
        .select_related("tournament", "organization")
        .first()
    )


# --- per-school codes ------------------------------------------------------

def generate_code() -> str:
    """Eight characters a teacher reads off a slip and types on a phone: no
    0/O/1/I, ~40 bits. Same alphabet as the team-registration codes so the
    two never look like different kinds of thing to a school."""
    return "".join(secrets.choice(_CODE_ALPHABET) for _ in range(CODE_LENGTH))


def issue_codes(
    *, campaign, by, institution_ids=None, only_missing=True,
    event_id=None, request=None,
):
    """Give every registered institution a pass row and a code.

    ``only_missing`` keeps codes already handed out working when a late school
    registers; an explicit ``institution_ids`` pick always re-issues. Returns
    ``(rows, skipped)`` where each row carries the plaintext code — this call
    is the ONLY place it exists, exactly like the old card tokens.
    """
    from apps.teams.models import Institution

    insts = (
        Institution.objects.filter(
            tournament=campaign.tournament, deleted_at__isnull=True
        )
        .exclude(status__in=["withdrawn", "rejected"])
        .order_by("name")
    )
    if institution_ids:
        insts = insts.filter(id__in=list(institution_ids))
        only_missing = False
    existing = {
        p.institution_id: p
        for p in LensPass.objects.filter(campaign=campaign)
    }
    rows: list[dict] = []
    skipped = 0
    with transaction.atomic():
        for inst in insts:
            pass_ = existing.get(inst.id)
            if pass_ is not None and pass_.code_hash and only_missing:
                skipped += 1
                continue
            code = generate_code()
            if pass_ is None:
                pass_ = LensPass.objects.create(
                    organization=campaign.organization,
                    campaign=campaign,
                    institution=inst,
                    token_hash="",
                    code_hash=make_password(code),
                    code_set_at=timezone.now(),
                    last_minted_at=timezone.now(),
                )
            else:
                pass_.code_hash = make_password(code)
                pass_.code_set_at = timezone.now()
                pass_.is_active = True
                pass_.last_minted_at = timezone.now()
                pass_.save(
                    update_fields=[
                        "code_hash", "code_set_at", "is_active", "last_minted_at",
                    ]
                )
            # A rotated code must not leave a school signed in on the old one.
            cache.delete(_fail_key(pass_.id))
            cache.delete(_lock_key(pass_.id))
            rows.append({
                "pass_id": str(pass_.id),
                "institution_id": str(inst.id),
                "institution_name": inst.name,
                "code": code,
            })
        emit_audit(
            actor_user=by,
            actor_role="admin",
            event_type="lens_codes_issued",
            target_type="lens_campaign",
            target_id=campaign.id,
            payload_after={"issued": len(rows), "skipped": skipped},
            organization_id=campaign.organization_id,
            tournament_id=campaign.tournament_id,
            idempotency_key=event_id,
            request=request,
        )
    return rows, skipped


def _lock_key(pass_id) -> str:
    return f"lens-code-lock:{pass_id}"


def _fail_key(pass_id) -> str:
    return f"lens-code-fails:{pass_id}"


def verify_code(pass_, code: str) -> tuple[bool, str | None]:
    """Constant-time code check with a per-school lockout on top of the
    endpoint's per-IP throttle. Returns ``(ok, error)`` — ``locked`` or
    ``invalid_code``. Mirrors ``teams.services.access.verify_team_code``."""
    if cache.get(_lock_key(pass_.id)):
        return False, "locked"
    if not pass_.code_hash or not check_password(
        (code or "").strip().upper(), pass_.code_hash
    ):
        fails = (cache.get(_fail_key(pass_.id)) or 0) + 1
        cache.set(_fail_key(pass_.id), fails, LOCKOUT_SECONDS)
        if fails >= MAX_FAILURES:
            cache.set(_lock_key(pass_.id), True, LOCKOUT_SECONDS)
        return False, "invalid_code"
    cache.delete(_fail_key(pass_.id))
    return True, None


def make_session_token(pass_) -> str:
    """The upload credential, issued only after a code check. Signed, salted
    and expiring, so it cannot be printed, guessed or replayed tomorrow."""
    return signing.dumps(
        {"p": str(pass_.id), "c": str(pass_.campaign_id)}, salt=SESSION_SALT
    )


def read_session_token(token: str) -> dict | None:
    if not token:
        return None
    try:
        return signing.loads(token, salt=SESSION_SALT, max_age=SESSION_MAX_AGE)
    except signing.BadSignature:
        return None
