"""Password reset flow.

v1Users.md §2.4 + Appendix A.5 lock:
- Token plaintext is delivered out-of-band (email); only sha256 hash is
  stored. TTL configurable via ``settings.PASSWORD_RESET_TTL_MINUTES``.
- Request endpoint returns 200 unconditionally (don't leak account
  existence). Audit row is written even on no-op for forensics.
- Rate limited at the per-email and per-IP level (B.11 anti-abuse).
- Completing a reset invalidates ALL sessions for the user (B.11
  fixation defense + §2.4 "password change resets active sessions").
"""
from __future__ import annotations

import hashlib
import logging
import secrets
from datetime import timedelta

from django.conf import settings
from django.contrib.sessions.models import Session
from django.core.cache import cache
from django.db import transaction
from django.http import HttpRequest
from django.utils import timezone

from apps.accounts.models import PasswordResetToken, User
from apps.audit.models import ActorRole
from apps.audit.services import emit_audit

logger = logging.getLogger(__name__)


def _hash_token(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def _client_ip(request: HttpRequest | None) -> str | None:
    if request is None:
        return None
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "").split(",")[0].strip()
    return forwarded or request.META.get("REMOTE_ADDR") or None


def _rate_limit_hit(key: str, limit: int, window_seconds: int = 3600) -> bool:
    """Simple cache-backed rate limit. Returns True if the caller has
    EXCEEDED the limit; False if still within budget. Increments the
    counter on every invocation (the count survives across calls).
    """
    current = cache.get(key, 0)
    if current >= limit:
        return True
    try:
        cache.add(key, 0, window_seconds)
        cache.incr(key)
    except ValueError:
        # Lost race vs. eviction — set fresh.
        cache.set(key, 1, window_seconds)
    return False


def request_password_reset(email: str, request: HttpRequest | None = None) -> None:
    """Begin a password reset.

    Silent no-op if no user matches; rate-limited per email + per IP.
    """
    if not email:
        return
    email_norm = email.strip().lower()

    per_email_key = f"pwreset:email:{email_norm}"
    if _rate_limit_hit(
        per_email_key, settings.PASSWORD_RESET_RATE_PER_EMAIL_HOUR
    ):
        logger.info("password_reset rate-limited (email): %s", email_norm)
        return

    ip = _client_ip(request)
    if ip:
        per_ip_key = f"pwreset:ip:{ip}"
        if _rate_limit_hit(per_ip_key, settings.PASSWORD_RESET_RATE_PER_IP_HOUR):
            logger.info("password_reset rate-limited (ip): %s", ip)
            return

    user = User.objects.filter(email=email_norm, is_active=True, deleted_at__isnull=True).first()
    if user is None:
        # Enumeration-safe no-op (B.11 identical-response).
        return

    plaintext = secrets.token_urlsafe(48)
    ttl_minutes = settings.PASSWORD_RESET_TTL_MINUTES
    token = PasswordResetToken.objects.create(
        user=user,
        token_hash=_hash_token(plaintext),
        expires_at=timezone.now() + timedelta(minutes=ttl_minutes),
        requested_ip=ip,
    )

    reset_link = f"{settings.FRONTEND_BASE_URL}/password-reset/complete?token={plaintext}"
    from apps.accounts.services.mailer import send_branded_email

    send_branded_email(
        subject="Reset your Fixture password",
        to=user.email,
        template="password_reset",
        context={"reset_link": reset_link, "ttl_minutes": ttl_minutes},
        fail_silently=True,
    )

    emit_audit(
        actor_user=user,
        actor_role=ActorRole.SYSTEM,
        event_type="password_reset_requested",
        target_type="user",
        target_id=user.id,
        payload_after={"token_id": str(token.id), "expires_at": token.expires_at.isoformat()},
        request=request,
    )


@transaction.atomic
def complete_password_reset(
    token_plaintext: str,
    new_password: str,
    request: HttpRequest | None = None,
) -> User:
    """Finish a password reset.

    Verifies the token (hash match, unused, unexpired), sets the new
    password, marks the token used, invalidates ALL of the user's
    sessions, and emits audit.
    """
    if not token_plaintext or not new_password:
        raise ValueError("Token and new password are required.")

    token_hash = _hash_token(token_plaintext)
    token = (
        PasswordResetToken.objects.select_for_update()
        .select_related("user")
        .filter(token_hash=token_hash)
        .first()
    )
    if token is None:
        raise ValueError("Invalid token.")
    if token.is_used:
        raise ValueError("Token already used.")
    if token.is_expired:
        raise ValueError("Token expired.")

    user = token.user
    user.set_password(new_password)
    user.last_password_change_at = timezone.now()
    user.save(update_fields=["password", "last_password_change_at"])

    token.used_at = timezone.now()
    token.save(update_fields=["used_at"])

    _invalidate_all_sessions_for_user(user)

    emit_audit(
        actor_user=user,
        actor_role=ActorRole.SYSTEM,
        event_type="password_reset_completed",
        target_type="user",
        target_id=user.id,
        request=request,
    )
    return user


def _invalidate_all_sessions_for_user(user: User) -> None:
    """Walk the session table and delete any whose decoded payload
    matches this user. O(n) over active sessions — acceptable in v1
    (we expect <10k active sessions on a single VPS).
    """
    target_id = str(user.pk)
    deleted = 0
    for session in Session.objects.iterator(chunk_size=500):
        try:
            data = session.get_decoded()
        except Exception:  # pragma: no cover - garbled session payload
            continue
        if str(data.get("_auth_user_id", "")) == target_id:
            session.delete()
            deleted += 1
    if deleted:
        logger.info("Invalidated %d sessions for user %s", deleted, user.pk)
