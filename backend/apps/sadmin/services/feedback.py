"""Feedback service — submit, triage, archive, and email-redact.

v1Users.md §1.7 + B.11. Body redaction is applied at INSERT time (B.11)
so the DB never carries the unredacted PII payloads.
"""
from __future__ import annotations

import re
import uuid as _uuid
from typing import Optional

from django.http import HttpRequest
from django.utils import timezone

from apps.audit.models import ActorRole, AuditEvent
from apps.audit.services import emit_audit
from apps.sadmin.models import Feedback, FeedbackCategory, FeedbackStatus

# B.11 PII patterns — applied to body on insert.
_PII_PATTERNS = [
    re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),  # emails
    re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b"),  # JWTs
    re.compile(r"\b[A-Fa-f0-9]{32,}\b"),  # long hex tokens
    re.compile(r"(?i)\b(password|otp|recovery[-_]?code)\s*[:=]\s*\S+"),
]


def redact_body(body: str) -> str:
    """Strip emails / JWTs / hex tokens / password=... from feedback body."""
    out = body or ""
    for pattern in _PII_PATTERNS:
        out = pattern.sub("[REDACTED]", out)
    return out


def redact_email(email: str | None, viewing_user) -> str:
    """Redact an email for display.

    * If ``viewing_user`` is a Super-admin, returns the email unchanged.
    * Otherwise returns ``j***@example.com`` style. (Phase 1A only SA sees
      feedback, but per B.11 the helper exists for future surfaces.)
    """
    if not email:
        return ""
    if viewing_user is not None and getattr(viewing_user, "is_superuser", False):
        return email
    if "@" not in email:
        return "***"
    local, _, domain = email.partition("@")
    if not local:
        return "***@" + domain
    head = local[0]
    return f"{head}***@{domain}"


def submit_feedback(
    *,
    user,
    category: str,
    subject: str,
    body: str,
    request: Optional[HttpRequest] = None,
    event_id: Optional[_uuid.UUID] = None,
) -> Feedback:
    """Insert a Feedback row.

    Anonymous submitters: pass ``user=None``. Body is PII-redacted at
    INSERT (B.11). Audit row emitted with event_type=``feedback_submitted``.

    Idempotency: when ``event_id`` is supplied AND a prior audit row
    carries the same ``idempotency_key`` for this event_type, we
    return the existing Feedback row instead of inserting a duplicate.
    """
    if event_id is not None:
        prior = AuditEvent.objects.filter(
            idempotency_key=event_id, event_type="feedback_submitted"
        ).first()
        if prior is not None:
            existing = Feedback.objects.filter(pk=prior.target_id).first()
            if existing is not None:
                return existing

    cat = category if category in FeedbackCategory.values else FeedbackCategory.OTHER
    fb = Feedback.objects.create(
        submitted_by=user if (user is not None and getattr(user, "is_authenticated", False)) else None,
        category=cat,
        subject=(subject or "")[:200],
        body=redact_body(body or ""),
    )
    emit_audit(
        actor_user=user if getattr(user, "is_authenticated", False) else None,
        actor_role=ActorRole.SYSTEM,
        event_type="feedback_submitted",
        target_type="feedback",
        target_id=fb.id,
        payload_after={"category": fb.category, "subject": fb.subject},
        idempotency_key=event_id,
        request=request,
    )
    return fb


def triage_feedback(
    *,
    feedback: Feedback,
    triaged_by,
    status: str,
    internal_notes: str = "",
    request: Optional[HttpRequest] = None,
) -> Feedback:
    """Triage / set status on a Feedback row. Audit-logged."""
    if status not in FeedbackStatus.values:
        raise ValueError(f"Invalid feedback status: {status!r}")

    before = {
        "status": feedback.status,
        "triaged_by": str(feedback.triaged_by_id) if feedback.triaged_by_id else None,
    }
    feedback.status = status
    feedback.triaged_by = triaged_by
    feedback.triaged_at = timezone.now()
    if internal_notes:
        feedback.internal_notes = internal_notes
    if status == FeedbackStatus.RESOLVED:
        feedback.resolved_at = timezone.now()
    feedback.save(
        update_fields=[
            "status",
            "triaged_by",
            "triaged_at",
            "resolved_at",
            "internal_notes",
            "updated_at",
        ]
    )

    emit_audit(
        actor_user=triaged_by,
        actor_role=ActorRole.SUPER_ADMIN,
        event_type="feedback_triaged",
        target_type="feedback",
        target_id=feedback.id,
        payload_before=before,
        payload_after={"status": feedback.status},
        request=request,
    )
    return feedback


def archive_feedback(
    *,
    feedback: Feedback,
    archived_by,
    request: Optional[HttpRequest] = None,
) -> Feedback:
    """Archive a feedback row (sets status=resolved, audited)."""
    before = {"status": feedback.status}
    feedback.status = FeedbackStatus.RESOLVED
    feedback.triaged_by = archived_by
    feedback.triaged_at = timezone.now()
    feedback.resolved_at = timezone.now()
    feedback.internal_notes = (feedback.internal_notes or "") + "\n[archived]"
    feedback.save(
        update_fields=[
            "status",
            "triaged_by",
            "triaged_at",
            "resolved_at",
            "internal_notes",
            "updated_at",
        ]
    )
    emit_audit(
        actor_user=archived_by,
        actor_role=ActorRole.SUPER_ADMIN,
        event_type="feedback_archived",
        target_type="feedback",
        target_id=feedback.id,
        payload_before=before,
        payload_after={"status": feedback.status},
        reason="archived",
        request=request,
    )
    return feedback
