"""Service-layer audit emission. THE ONLY way to write AuditEvent rows.

v1Users.md B.4 lock: service-layer call (NOT signals). Every verb
calls emit_audit() at the same call site that performs the state
change. Reason, payload_before, payload_after are explicit at the
call site so a developer reading the verb sees the audit shape.

Idempotency: the `idempotency_key` arg is the same UUID the client
supplied for the verb (PRD §7.6 idempotent writes). Re-submission
returns the existing row instead of creating a duplicate.
"""
from __future__ import annotations

import uuid
from typing import Any

from django.db import transaction
from django.http import HttpRequest

from apps.accounts.models import User
from apps.audit.models import ActorRole, AuditEvent


def emit_audit(
    *,
    actor_user: User | None,
    actor_role: ActorRole | str,
    event_type: str,
    target_type: str,
    target_id: uuid.UUID,
    payload_before: dict[str, Any] | None = None,
    payload_after: dict[str, Any] | None = None,
    reason: str = "",
    organization_id: uuid.UUID | None = None,
    tournament_id: uuid.UUID | None = None,
    match_id: uuid.UUID | None = None,
    impersonating_user_id: uuid.UUID | None = None,
    idempotency_key: uuid.UUID | None = None,
    request: HttpRequest | None = None,
) -> AuditEvent:
    """Emit an AuditEvent row inside the current transaction.

    Idempotent on idempotency_key when provided.
    """
    if idempotency_key:
        existing = AuditEvent.objects.filter(idempotency_key=idempotency_key).first()
        if existing:
            return existing

    ip = ""
    ua = ""
    if request is not None:
        ip = (
            request.META.get("HTTP_X_FORWARDED_FOR", "").split(",")[0].strip()
            or request.META.get("REMOTE_ADDR", "")
        )
        ua = request.META.get("HTTP_USER_AGENT", "")[:255]

    role_value = actor_role.value if isinstance(actor_role, ActorRole) else actor_role

    return AuditEvent.objects.create(
        idempotency_key=idempotency_key,
        actor_user=actor_user,
        actor_role=role_value,
        impersonating_user_id=impersonating_user_id,
        organization_id=organization_id,
        tournament_id=tournament_id,
        match_id=match_id,
        event_type=event_type,
        target_type=target_type,
        target_id=target_id,
        payload_before=payload_before,
        payload_after=payload_after,
        reason=reason,
        ip_address=ip or None,
        user_agent=ua,
    )


def emit_audit_on_commit(**kwargs):
    """Defer audit emission until transaction commit.

    Usage: where the verb's state change must be persisted before the
    audit row is meaningful. Most callers want the inline emit_audit()
    instead so the audit + state change share atomicity.
    """
    transaction.on_commit(lambda: emit_audit(**kwargs))
