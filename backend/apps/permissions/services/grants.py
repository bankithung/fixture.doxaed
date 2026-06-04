"""Override-grant write paths.

Every write here:
  1. Mutates / upserts a MembershipModuleGrant row.
  2. Invalidates the cached effective_modules entry for (user, org).
  3. Emits exactly one AuditEvent per module changed (B.17).

`event_type="module_grant_changed"` is the audit-taxonomy entry.
payload_before / payload_after both populated with the prior and new
state strings so the audit row is self-contained.
"""
from __future__ import annotations

import uuid
from collections.abc import Iterable

from django.db import transaction
from django.http import HttpRequest

from apps.audit.models import ActorRole
from apps.audit.services import emit_audit
from apps.permissions.models import GrantState, MembershipModuleGrant, Module
from apps.permissions.services.resolver import invalidate_cache

# Service-layer minimum reason length (B.17 + Appendix A.4).
MIN_REASON_LEN = 20


class GrantValidationError(ValueError):
    """Raised when a grant write fails service-layer preconditions."""


def _validate_state(state: str) -> str:
    if state not in {choice for choice, _ in GrantState.choices}:
        raise GrantValidationError(
            f"Invalid grant state: {state!r}. "
            f"Must be one of {[c for c, _ in GrantState.choices]}."
        )
    return state


def _resolve_module(module_or_code) -> Module:
    if isinstance(module_or_code, Module):
        return module_or_code
    try:
        return Module.objects.get(code=module_or_code)
    except Module.DoesNotExist as exc:
        raise GrantValidationError(
            f"Module with code={module_or_code!r} does not exist."
        ) from exc


def set_grant(
    *,
    user,
    organization,
    module,
    state: str,
    granted_by,
    reason: str,
    request: HttpRequest | None = None,
    actor_role: str = ActorRole.ADMIN,
) -> MembershipModuleGrant:
    """Upsert a single (user, org, module) grant.

    `module` may be a Module instance OR a module code string.
    `state` must be one of `GrantState`.
    `reason` must be >= 20 chars (B.17). Pass empty when state is `default`
    if the row is being cleared, but the caller must still pass a reason.

    Emits one `module_grant_changed` audit row with payload_before /
    payload_after.

    Returns the persisted MembershipModuleGrant row.
    """
    state = _validate_state(state)
    module_obj = _resolve_module(module)

    if not reason or len(reason.strip()) < MIN_REASON_LEN:
        raise GrantValidationError(
            f"Reason must be at least {MIN_REASON_LEN} characters (B.17)."
        )

    with transaction.atomic():
        existing = MembershipModuleGrant.objects.filter(
            user=user, organization=organization, module=module_obj
        ).first()
        prior_state = existing.state if existing else GrantState.DEFAULT

        # `default` collapses to row-deletion (recommended pattern).
        if state == GrantState.DEFAULT:
            if existing:
                existing.delete()
                row = None
            else:
                row = None
        else:
            row, _ = MembershipModuleGrant.objects.update_or_create(
                user=user,
                organization=organization,
                module=module_obj,
                defaults={
                    "state": state,
                    "granted_by": granted_by,
                    "reason": reason,
                },
            )

        # Invalidate cache (resolver layer).
        # TODO (Appendix B.3): also publish to Redis pub/sub for cross-worker.
        invalidate_cache(user.id, organization.id)

        emit_audit(
            actor_user=granted_by,
            actor_role=actor_role,
            event_type="module_grant_changed",
            target_type="membership_module_grant",
            target_id=(row.id if row else uuid.uuid4()),
            payload_before={
                "state": prior_state,
                "module_code": module_obj.code,
            },
            payload_after={
                "state": state,
                "module_code": module_obj.code,
            },
            reason=reason,
            organization_id=organization.id,
            request=request,
        )

    return row


def bulk_set_grants(
    *,
    user,
    organization,
    grants: Iterable[tuple[str, str]],
    granted_by,
    reason: str,
    request: HttpRequest | None = None,
    actor_role: str = ActorRole.ADMIN,
) -> list[MembershipModuleGrant]:
    """Atomic bulk upsert.

    `grants` is an iterable of (module_code, state) tuples.
    Emits ONE audit row per module CHANGED (rows whose prior and new
    state are equal are skipped).
    """
    if not reason or len(reason.strip()) < MIN_REASON_LEN:
        raise GrantValidationError(
            f"Reason must be at least {MIN_REASON_LEN} characters (B.17)."
        )

    grants = list(grants)
    out: list[MembershipModuleGrant] = []

    with transaction.atomic():
        for module_code, state in grants:
            state = _validate_state(state)
            module_obj = _resolve_module(module_code)

            existing = MembershipModuleGrant.objects.filter(
                user=user, organization=organization, module=module_obj
            ).first()
            prior_state = existing.state if existing else GrantState.DEFAULT

            if prior_state == state:
                # No change → no audit row.
                if existing:
                    out.append(existing)
                continue

            if state == GrantState.DEFAULT:
                if existing:
                    existing.delete()
                row = None
            else:
                row, _ = MembershipModuleGrant.objects.update_or_create(
                    user=user,
                    organization=organization,
                    module=module_obj,
                    defaults={
                        "state": state,
                        "granted_by": granted_by,
                        "reason": reason,
                    },
                )
                out.append(row)

            emit_audit(
                actor_user=granted_by,
                actor_role=actor_role,
                event_type="module_grant_changed",
                target_type="membership_module_grant",
                target_id=(row.id if row else uuid.uuid4()),
                payload_before={
                    "state": prior_state,
                    "module_code": module_obj.code,
                },
                payload_after={
                    "state": state,
                    "module_code": module_obj.code,
                },
                reason=reason,
                organization_id=organization.id,
                request=request,
            )

        invalidate_cache(user.id, organization.id)

    return out


def clear_grants(
    *,
    user,
    organization,
    granted_by,
    reason: str,
    request: HttpRequest | None = None,
    actor_role: str = ActorRole.ADMIN,
) -> int:
    """Delete every override row for (user, org). One audit row per deletion.

    Returns the count of rows deleted.
    """
    if not reason or len(reason.strip()) < MIN_REASON_LEN:
        raise GrantValidationError(
            f"Reason must be at least {MIN_REASON_LEN} characters (B.17)."
        )

    deleted_count = 0
    with transaction.atomic():
        rows = list(
            MembershipModuleGrant.objects.select_related("module").filter(
                user=user, organization=organization
            )
        )
        for row in rows:
            prior_state = row.state
            module_code = row.module.code
            row_id = row.id
            row.delete()
            deleted_count += 1
            emit_audit(
                actor_user=granted_by,
                actor_role=actor_role,
                event_type="module_grant_changed",
                target_type="membership_module_grant",
                target_id=row_id,
                payload_before={
                    "state": prior_state,
                    "module_code": module_code,
                },
                payload_after={
                    "state": GrantState.DEFAULT,
                    "module_code": module_code,
                },
                reason=reason,
                organization_id=organization.id,
                request=request,
            )

        invalidate_cache(user.id, organization.id)

    return deleted_count
