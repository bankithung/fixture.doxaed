"""Super-admin verbs (v1Users.md §1.6 — 13 named, audit-logged actions).

Every verb here:

* Performs the state change inside a Django transaction.
* Calls ``apps.audit.services.emit_audit`` inline at the same call site
  (B.4 lock — never via signals).
* Sets ``actor_role=super_admin`` and (when impersonating) carries
  ``impersonating_user_id`` so the audit row is unambiguous (B.19).
* Optional reason is attached to the audit row.

Some verbs (``approve_org``, ``reject_org``, ``unlock_account``,
``force_password_reset``) call into other apps' services. Those calls
are guarded with try/import-and-fallback so the verbs remain runnable
even if a sibling app's service hasn't shipped yet (deferral noted
inline). Callers in views must always pass ``request``.
"""
from __future__ import annotations

import logging
import uuid

from django.contrib.sessions.models import Session
from django.core.cache import cache
from django.db import transaction
from django.http import HttpRequest
from django.utils import timezone

from apps.audit.models import ActorRole
from apps.audit.services import emit_audit

logger = logging.getLogger(__name__)


# B.21 alarm thresholds (Phase 1A: log warning, do NOT block)
_FORCE_LOGOUT_RATE_PER_HOUR = 20
_SUSPEND_USER_RATE_PER_HOUR = 50


def _bump_rate_counter(key: str, window_seconds: int = 3600) -> int:
    """Cache-backed counter; returns the post-increment count."""
    try:
        cache.add(key, 0, window_seconds)
        return int(cache.incr(key))
    except ValueError:
        cache.set(key, 1, window_seconds)
        return 1
    except Exception:
        logger.exception("rate-counter increment failed (key=%s)", key)
        return 0


def _impersonating_id(request: HttpRequest | None) -> uuid.UUID | None:
    if request is None:
        return None
    raw = request.session.get("impersonating_user_id") if hasattr(request, "session") else None
    if not raw:
        return None
    try:
        return uuid.UUID(str(raw))
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Org verbs (call into apps.organizations.services where available)
# ---------------------------------------------------------------------------


def approve_org(*, org, approved_by, request: HttpRequest | None = None):
    """Flip an org from pending_review → active. Audited.

    Thin delegate over ``apps.organizations.services.lifecycle.approve_org``
    — that service owns the state transition AND emits the
    ``org_approved`` audit row inline.
    """
    from apps.organizations.services.lifecycle import approve_org as svc_approve

    return svc_approve(org=org, approved_by=approved_by, request=request)


def reject_org(*, org, rejected_by, reason: str = "", request: HttpRequest | None = None):
    """Reject a pending Org → archived. Audited with reason.

    Thin delegate over ``apps.organizations.services.lifecycle.reject_org``.
    """
    from apps.organizations.services.lifecycle import reject_org as svc_reject

    return svc_reject(org=org, rejected_by=rejected_by, reason=reason, request=request)


@transaction.atomic
def suspend_org(*, org, suspended_by, reason: str = "", request: HttpRequest | None = None):
    """Suspend an Org. Reason ≥20 chars per §1.6 (enforced at view layer).

    Delegates to ``apps.organizations.services.lifecycle.suspend_org``
    when available — that service already emits the ``org_suspended``
    audit row, so no second emission here. Inline fallback path emits
    its own audit row.
    """
    from apps.organizations.models import OrgStatus

    try:
        from apps.organizations.services.lifecycle import suspend_org as svc_suspend  # type: ignore

        return svc_suspend(org=org, suspended_by=suspended_by, reason=reason, request=request)
    except (ImportError, AttributeError):
        before = {"status": org.status}
        org.status = OrgStatus.SUSPENDED
        org.suspended_at = timezone.now()
        org.suspended_reason = reason
        org.save(update_fields=["status", "suspended_at", "suspended_reason"])
        emit_audit(
            actor_user=suspended_by,
            actor_role=ActorRole.SUPER_ADMIN,
            event_type="org_suspended",
            target_type="organization",
            target_id=org.id,
            organization_id=org.id,
            payload_before=before,
            payload_after={"status": org.status},
            reason=reason,
            impersonating_user_id=_impersonating_id(request),
            request=request,
        )
        return org


@transaction.atomic
def unsuspend_org(*, org, unsuspended_by, request: HttpRequest | None = None):
    """Lift a suspension on an Org. Delegates as in ``suspend_org``."""
    from apps.organizations.models import OrgStatus

    try:
        from apps.organizations.services.lifecycle import (
            unsuspend_org as svc_unsuspend,  # type: ignore
        )

        return svc_unsuspend(org=org, unsuspended_by=unsuspended_by, request=request)
    except (ImportError, AttributeError):
        before = {"status": org.status}
        org.status = OrgStatus.ACTIVE
        org.suspended_at = None
        org.suspended_reason = ""
        org.save(update_fields=["status", "suspended_at", "suspended_reason"])
        emit_audit(
            actor_user=unsuspended_by,
            actor_role=ActorRole.SUPER_ADMIN,
            event_type="org_unsuspended",
            target_type="organization",
            target_id=org.id,
            organization_id=org.id,
            payload_before=before,
            payload_after={"status": org.status},
            impersonating_user_id=_impersonating_id(request),
            request=request,
        )
        return org


# ---------------------------------------------------------------------------
# User verbs
# ---------------------------------------------------------------------------


@transaction.atomic
def suspend_user(*, user, suspended_by, reason: str = "", request: HttpRequest | None = None):
    """Suspend a user (sets is_active=False) + force-logout sessions.

    B.21 alarm: log warning if rate exceeds 50/hour for the same SA.
    """
    if suspended_by is not None:
        key = f"sadmin:suspend_user:{suspended_by.id}"
        count = _bump_rate_counter(key)
        if count > _SUSPEND_USER_RATE_PER_HOUR:
            logger.warning(
                "B.21 ALARM: super-admin %s exceeded suspend_user rate "
                "(%d in last hour)",
                suspended_by.id, count,
            )

    before = {"is_active": user.is_active}
    user.is_active = False
    user.save(update_fields=["is_active"])
    _delete_sessions_for_user(user.id)

    emit_audit(
        actor_user=suspended_by,
        actor_role=ActorRole.SUPER_ADMIN,
        event_type="user_suspended",
        target_type="user",
        target_id=user.id,
        payload_before=before,
        payload_after={"is_active": False},
        reason=reason,
        impersonating_user_id=_impersonating_id(request),
        request=request,
    )
    return user


@transaction.atomic
def unsuspend_user(*, user, unsuspended_by, request: HttpRequest | None = None):
    before = {"is_active": user.is_active}
    user.is_active = True
    user.save(update_fields=["is_active"])

    emit_audit(
        actor_user=unsuspended_by,
        actor_role=ActorRole.SUPER_ADMIN,
        event_type="user_unsuspended",
        target_type="user",
        target_id=user.id,
        payload_before=before,
        payload_after={"is_active": True},
        impersonating_user_id=_impersonating_id(request),
        request=request,
    )
    return user


def _delete_sessions_for_user(user_id) -> int:
    """Delete every Session row whose decoded payload references this user."""
    target_id = str(user_id)
    deleted = 0
    for session in Session.objects.iterator(chunk_size=500):
        try:
            data = session.get_decoded()
        except Exception:  # pragma: no cover - garbled session
            continue
        if str(data.get("_auth_user_id", "")) == target_id:
            session.delete()
            deleted += 1
    return deleted


@transaction.atomic
def force_logout_all(
    *,
    user,
    requested_by,
    reason: str = "",
    request: HttpRequest | None = None,
):
    """Delete every Session row for this user. Audited.

    B.21 alarm: log warning if same SA exceeds 20/hour.
    """
    if requested_by is not None:
        key = f"sadmin:force_logout_all:{requested_by.id}"
        count = _bump_rate_counter(key)
        if count > _FORCE_LOGOUT_RATE_PER_HOUR:
            logger.warning(
                "B.21 ALARM: super-admin %s exceeded force_logout_all rate "
                "(%d in last hour)",
                requested_by.id, count,
            )

    deleted = _delete_sessions_for_user(user.id)
    emit_audit(
        actor_user=requested_by,
        actor_role=ActorRole.SUPER_ADMIN,
        event_type="user_force_logged_out",
        target_type="user",
        target_id=user.id,
        payload_after={"sessions_deleted": deleted},
        reason=reason,
        impersonating_user_id=_impersonating_id(request),
        request=request,
    )
    return deleted


@transaction.atomic
def force_password_reset(
    *,
    user,
    requested_by,
    reason: str = "",
    request: HttpRequest | None = None,
):
    """Issue a password reset on behalf of a user. Audited."""
    try:
        from apps.accounts.services.password_reset import request_password_reset

        request_password_reset(user.email, request=request)
    except Exception:
        logger.exception("force_password_reset: underlying service failed")

    emit_audit(
        actor_user=requested_by,
        actor_role=ActorRole.SUPER_ADMIN,
        event_type="force_password_reset_issued",
        target_type="user",
        target_id=user.id,
        reason=reason,
        impersonating_user_id=_impersonating_id(request),
        request=request,
    )
    return user


@transaction.atomic
def unlock_account(*, user, requested_by, request: HttpRequest | None = None):
    """Clear axes lockout state for a user, if axes is installed."""
    cleared = 0
    try:
        from axes.utils import reset

        cleared = reset(username=user.email)
    except Exception:
        logger.exception("unlock_account: axes.reset failed (axes optional)")

    emit_audit(
        actor_user=requested_by,
        actor_role=ActorRole.SUPER_ADMIN,
        event_type="user_unlocked",
        target_type="user",
        target_id=user.id,
        payload_after={"axes_cleared": cleared},
        impersonating_user_id=_impersonating_id(request),
        request=request,
    )
    return user


# ---------------------------------------------------------------------------
# Impersonation (B.19)
# ---------------------------------------------------------------------------


@transaction.atomic
def impersonate_start(
    *,
    target_user,
    requested_by,
    reason: str = "",
    request: HttpRequest | None = None,
):
    """Begin an impersonation session. Stores the target id in the SA's
    session and writes an audit row. The impersonation banner middleware
    (rendered by templates) reads ``session["impersonating_user_id"]``.
    """
    if request is not None:
        request.session["impersonating_user_id"] = str(target_user.id)
        request.session["impersonating_started_at"] = timezone.now().isoformat()

    emit_audit(
        actor_user=requested_by,
        actor_role=ActorRole.SUPER_ADMIN,
        event_type="impersonation_started",
        target_type="user",
        target_id=target_user.id,
        reason=reason,
        impersonating_user_id=target_user.id,
        request=request,
    )
    return target_user


@transaction.atomic
def impersonate_stop(*, request: HttpRequest):
    """End the current impersonation session."""
    target = request.session.pop("impersonating_user_id", None)
    request.session.pop("impersonating_started_at", None)

    actor = getattr(request, "user", None)
    target_id: uuid.UUID | None = None
    if target:
        try:
            target_id = uuid.UUID(str(target))
        except (ValueError, TypeError):
            target_id = None

    emit_audit(
        actor_user=actor if getattr(actor, "is_authenticated", False) else None,
        actor_role=ActorRole.SUPER_ADMIN,
        event_type="impersonation_stopped",
        target_type="user",
        target_id=target_id or (actor.id if actor and getattr(actor, "is_authenticated", False) else uuid.uuid4()),
        impersonating_user_id=target_id,
        request=request,
    )


# ---------------------------------------------------------------------------
# Misc verbs
# ---------------------------------------------------------------------------


@transaction.atomic
def bulk_email(
    *,
    target_filter: dict,
    subject: str,
    body: str,
    requested_by,
    request: HttpRequest | None = None,
):
    """Phase 1A: just record a 'drafted' audit; actual send is deferred.

    Returns dict with recipient count for the preview UI.
    """
    recipients = 0
    try:
        from apps.accounts.models import User

        qs = User.objects.filter(deleted_at__isnull=True, is_active=True)
        if target_filter:
            for k, v in target_filter.items():
                qs = qs.filter(**{k: v})
        recipients = qs.count()
    except Exception:
        logger.exception("bulk_email recipient count failed")

    emit_audit(
        actor_user=requested_by,
        actor_role=ActorRole.SUPER_ADMIN,
        event_type="bulk_email_drafted",
        target_type="bulk_email",
        target_id=uuid.uuid4(),
        payload_after={
            "recipient_count": recipients,
            "subject": subject[:200],
            "filter": target_filter or {},
        },
        impersonating_user_id=_impersonating_id(request),
        request=request,
    )
    return {"recipients": recipients, "subject": subject, "body": body}


def system_health() -> dict:
    """Read-only health probe. No audit row (read-only)."""
    info: dict = {"db": False, "redis": None, "tables": {}}
    try:
        from django.db import connection

        with connection.cursor() as cur:
            cur.execute("SELECT 1")
            info["db"] = cur.fetchone()[0] == 1
    except Exception as e:
        info["db_error"] = str(e)

    # Redis ping — only meaningful if a redis cache is configured.
    try:
        from django.core.cache import cache as _cache

        _cache.set("sadmin_health_probe", "1", 5)
        info["redis"] = _cache.get("sadmin_health_probe") == "1"
    except Exception:
        info["redis"] = False

    try:
        from apps.accounts.models import User
        from apps.audit.models import AuditEvent

        info["tables"]["users"] = User.objects.count()
        info["tables"]["audit_events"] = AuditEvent.objects.count()
    except Exception:
        logger.exception("system_health table counts failed")

    try:
        from apps.organizations.models import Organization

        info["tables"]["organizations"] = Organization.objects.count()
    except Exception:
        info["tables"]["organizations"] = None

    return info
