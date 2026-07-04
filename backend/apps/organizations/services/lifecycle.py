"""Organization lifecycle services: suspend / unsuspend / archive / orphan.

Each verb wraps a state-change in transaction.atomic() and emits an
AuditEvent inline. Notification fan-out / Redis publish is the live
agent's concern; we do not couple to it here.
"""
from __future__ import annotations

from django.core.exceptions import ValidationError
from django.db import transaction
from django.http import HttpRequest
from django.utils import timezone

from apps.audit.models import ActorRole
from apps.audit.services import emit_audit
from apps.organizations.models import (
    MembershipRole,
    Organization,
    OrganizationMembership,
    OrgStatus,
)

# ---------------------------------------------------------------------------
# Org create
# ---------------------------------------------------------------------------


def create_organization(
    *,
    slug: str,
    name: str,
    created_by,
    time_zone: str = "Asia/Kolkata",
    status: str = OrgStatus.PENDING_REVIEW,
    request: HttpRequest | None = None,
) -> Organization:
    """Create an Organization with status defaulting to pending_review.

    Reserved-list / format / uniqueness enforcement happens via
    `services.slug.validate_slug` here at service layer.
    """
    from apps.organizations.services.slug import validate_slug

    slug = validate_slug(slug)
    name = (name or "").strip()
    if not name:
        raise ValidationError("Organization name is required.")

    with transaction.atomic():
        org = Organization.objects.create(
            slug=slug,
            name=name,
            status=status,
            time_zone=time_zone,
            created_by=created_by,
        )
        emit_audit(
            actor_user=created_by,
            actor_role=ActorRole.SUPER_ADMIN,
            event_type="org_created",
            target_type="organization",
            target_id=org.id,
            payload_after={
                "slug": org.slug,
                "name": org.name,
                "status": org.status,
                "time_zone": org.time_zone,
            },
            organization_id=org.id,
            request=request,
        )
    return org


# ---------------------------------------------------------------------------
# Approve / reject (pending_review → active | archived)
# ---------------------------------------------------------------------------


def approve_org(
    *,
    org: Organization,
    approved_by,
    request: HttpRequest | None = None,
) -> Organization:
    """Flip org pending_review → active. Audit. Validates precondition."""
    if org.status != OrgStatus.PENDING_REVIEW:
        raise ValidationError(f"Cannot approve org in status {org.status}")

    with transaction.atomic():
        before = {"status": org.status}
        org.status = OrgStatus.ACTIVE
        org.save(update_fields=["status"])
        emit_audit(
            actor_user=approved_by,
            actor_role=ActorRole.SUPER_ADMIN,
            event_type="org_approved",
            target_type="organization",
            target_id=org.id,
            organization_id=org.id,
            payload_before=before,
            payload_after={"status": org.status},
            request=request,
        )
    return org


def reject_org(
    *,
    org: Organization,
    rejected_by,
    reason: str,
    request: HttpRequest | None = None,
) -> Organization:
    """Flip org pending_review → archived (rejection). Reason required. Audit."""
    if org.status != OrgStatus.PENDING_REVIEW:
        raise ValidationError(f"Cannot reject org in status {org.status}")
    if not reason or len(reason.strip()) < 8:
        raise ValidationError("Reason required (>= 8 chars).")

    reason = reason.strip()

    with transaction.atomic():
        before = {"status": org.status}
        org.status = OrgStatus.ARCHIVED
        org.archived_at = timezone.now()
        org.save(update_fields=["status", "archived_at"])
        emit_audit(
            actor_user=rejected_by,
            actor_role=ActorRole.SUPER_ADMIN,
            event_type="org_rejected",
            target_type="organization",
            target_id=org.id,
            organization_id=org.id,
            payload_before=before,
            payload_after={"status": org.status, "reason": reason},
            reason=reason,
            request=request,
        )
    return org


# ---------------------------------------------------------------------------
# Suspend / unsuspend
# ---------------------------------------------------------------------------


def suspend_org(
    *,
    org: Organization,
    suspended_by,
    reason: str,
    request: HttpRequest | None = None,
) -> Organization:
    if org.status == OrgStatus.SUSPENDED:
        return org
    if org.status not in (OrgStatus.ACTIVE, OrgStatus.PENDING_REVIEW, OrgStatus.ORPHANED):
        raise ValidationError(
            f"Cannot suspend an org in status '{org.status}'."
        )
    if not reason or len(reason.strip()) < 3:
        raise ValidationError("A reason of at least 3 characters is required.")

    with transaction.atomic():
        before = {"status": org.status, "suspended_reason": org.suspended_reason}
        org.status = OrgStatus.SUSPENDED
        org.suspended_at = timezone.now()
        org.suspended_reason = reason.strip()
        org.save(update_fields=["status", "suspended_at", "suspended_reason"])

        emit_audit(
            actor_user=suspended_by,
            actor_role=ActorRole.SUPER_ADMIN,
            event_type="org_suspended",
            target_type="organization",
            target_id=org.id,
            payload_before=before,
            payload_after={"status": org.status, "suspended_reason": org.suspended_reason},
            reason=reason,
            organization_id=org.id,
            request=request,
        )
    return org


def unsuspend_org(
    *,
    org: Organization,
    unsuspended_by,
    request: HttpRequest | None = None,
) -> Organization:
    if org.status != OrgStatus.SUSPENDED:
        raise ValidationError(
            f"Cannot unsuspend an org in status '{org.status}'."
        )

    with transaction.atomic():
        before = {"status": org.status, "suspended_reason": org.suspended_reason}
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
            payload_before=before,
            payload_after={"status": org.status},
            organization_id=org.id,
            request=request,
        )
    return org


# ---------------------------------------------------------------------------
# Archive
# ---------------------------------------------------------------------------


def archive_org(
    *,
    org: Organization,
    archived_by,
    reason: str,
    request: HttpRequest | None = None,
) -> Organization:
    if org.status == OrgStatus.ARCHIVED:
        return org
    if not reason or len(reason.strip()) < 3:
        raise ValidationError("A reason of at least 3 characters is required.")

    with transaction.atomic():
        before = {"status": org.status, "archived_at": org.archived_at}
        org.status = OrgStatus.ARCHIVED
        org.archived_at = timezone.now()
        org.save(update_fields=["status", "archived_at"])

        emit_audit(
            actor_user=archived_by,
            actor_role=ActorRole.ADMIN,
            event_type="org_deleted",
            target_type="organization",
            target_id=org.id,
            payload_before=before,
            payload_after={"status": org.status, "archived_at": org.archived_at.isoformat()},
            reason=reason,
            organization_id=org.id,
            request=request,
        )
    return org


# ---------------------------------------------------------------------------
# Orphan detection
# ---------------------------------------------------------------------------


def detect_orphaned() -> int:
    """Mark every active Organization with no active admin membership as
    `orphaned`. Returns the count of orgs flipped.

    Intended to be called by a manage.py cron command (no Celery in 1A).
    """
    flipped = 0
    candidates = Organization.objects.filter(
        status=OrgStatus.ACTIVE, deleted_at__isnull=True
    )
    for org in candidates:
        has_admin = OrganizationMembership.objects.filter(
            organization=org,
            role=MembershipRole.ADMIN,
            is_active=True,
        ).exists()
        if not has_admin:
            with transaction.atomic():
                before = {"status": org.status}
                org.status = OrgStatus.ORPHANED
                org.save(update_fields=["status"])
                emit_audit(
                    actor_user=None,
                    actor_role=ActorRole.SYSTEM,
                    event_type="org_orphaned",
                    target_type="organization",
                    target_id=org.id,
                    payload_before=before,
                    payload_after={"status": org.status},
                    reason="auto-detected: no active admin",
                    organization_id=org.id,
                )
                flipped += 1
    return flipped
