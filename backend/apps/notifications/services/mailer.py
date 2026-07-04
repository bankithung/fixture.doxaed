"""School-facing transactional email with a truthful delivery ledger (H6).

Schools have NO accounts — email IS their channel (master plan S6). Every
send is recorded as an append-only audit row (``email_sent`` /
``email_failed``), so admin surfaces can show real delivery state instead of
the fail_silently fiction of finding C21. No schema change: the audit log is
the ledger.
"""
from __future__ import annotations

import logging
import uuid
from collections.abc import Mapping
from typing import Any

from apps.accounts.services.mailer import send_branded_email
from apps.audit.models import ActorRole
from apps.audit.services import emit_audit

logger = logging.getLogger(__name__)


def send_school_email(
    *,
    kind: str,
    to: str,
    subject: str,
    template: str,
    context: Mapping[str, Any],
    target_type: str,
    target_id: uuid.UUID,
    organization_id: uuid.UUID | None = None,
    tournament_id: uuid.UUID | None = None,
) -> bool:
    """Send one branded email and record the real outcome. Never raises —
    a mail hiccup must not break the write that triggered it (these run in
    ``transaction.on_commit`` hooks)."""
    to = (to or "").strip()
    if not to:
        return False
    ok = send_branded_email(
        subject=subject, to=to, template=template, context=context,
        fail_silently=True,
    )
    try:
        emit_audit(
            actor_user=None,
            actor_role=ActorRole.SYSTEM,
            event_type="email_sent" if ok else "email_failed",
            target_type=target_type,
            target_id=target_id,
            organization_id=organization_id,
            tournament_id=tournament_id,
            payload_after={"kind": kind, "to": to, "subject": subject},
        )
    except Exception:  # noqa: BLE001 — the ledger must not break the send
        logger.exception("email ledger write failed (%s to %s)", kind, to)
    return ok
