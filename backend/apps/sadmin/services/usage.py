"""Usage telemetry — fire-and-forget writes (v1Users.md §1.7).

Other services call ``emit_usage(...)`` to record analytics events.
Wrapped in try/except + logger.exception so a telemetry failure NEVER
breaks the calling verb. Telemetry is best-effort.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any, Optional

from apps.sadmin.models import UsageEvent

logger = logging.getLogger(__name__)


def emit_usage(
    *,
    event_type: str,
    user=None,
    organization_id: uuid.UUID | str | None = None,
    payload: Optional[dict[str, Any]] = None,
) -> UsageEvent | None:
    """Record one telemetry event. Returns the row, or ``None`` on failure."""
    try:
        return UsageEvent.objects.create(
            user=user if (user is not None and getattr(user, "is_authenticated", False)) else None,
            organization_id=organization_id,
            event_type=event_type[:64],
            payload=payload or {},
        )
    except Exception:
        logger.exception("emit_usage failed for event_type=%s", event_type)
        return None
