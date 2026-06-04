"""DB-level append-only enforcement on audit_event (CLAUDE.md invariant 5).

The 0002_audit_append_only migration installs BEFORE UPDATE OR DELETE
triggers that raise insufficient_privilege. These tests confirm the
triggers fire even for the test runner connecting as a Postgres
superuser (which bypasses GRANT/REVOKE) — proving the invariant cannot
be silently violated by a future contributor or a runaway management
command.
"""
from __future__ import annotations

import uuid

import pytest
from django.db import IntegrityError, connection, transaction
from django.db.utils import InternalError, ProgrammingError

from apps.audit.models import ActorRole, AuditEvent
from apps.audit.services import emit_audit


@pytest.fixture
def seeded_audit() -> AuditEvent:
    """Create one AuditEvent we can attempt to mutate."""
    return emit_audit(
        actor_user=None,
        actor_role=ActorRole.SYSTEM,
        event_type="test_append_only_setup",
        target_type="test",
        target_id=uuid.uuid4(),
        reason="seed for append-only test",
    )


@pytest.mark.django_db(transaction=True)
def test_orm_update_blocked_by_trigger(seeded_audit: AuditEvent) -> None:
    """ORM .save() on an existing row → trigger raises."""
    seeded_audit.reason = "tampered"
    with pytest.raises((InternalError, ProgrammingError, IntegrityError)) as exc_info:
        with transaction.atomic():
            seeded_audit.save(update_fields=["reason"])
    assert "append-only" in str(exc_info.value).lower() or "42501" in str(exc_info.value)


@pytest.mark.django_db(transaction=True)
def test_orm_delete_blocked_by_trigger(seeded_audit: AuditEvent) -> None:
    """ORM .delete() → trigger raises."""
    with pytest.raises((InternalError, ProgrammingError, IntegrityError)) as exc_info:
        with transaction.atomic():
            seeded_audit.delete()
    assert "append-only" in str(exc_info.value).lower() or "42501" in str(exc_info.value)


@pytest.mark.django_db(transaction=True)
def test_raw_update_blocked_by_trigger(seeded_audit: AuditEvent) -> None:
    """Raw SQL UPDATE → trigger raises (proves it isn't ORM-layer enforcement)."""
    with pytest.raises((InternalError, ProgrammingError, IntegrityError)):
        with transaction.atomic(), connection.cursor() as cur:
            cur.execute(
                "UPDATE audit_event SET reason = %s WHERE id = %s",
                ["raw tamper", str(seeded_audit.id)],
            )


@pytest.mark.django_db(transaction=True)
def test_raw_delete_blocked_by_trigger(seeded_audit: AuditEvent) -> None:
    """Raw SQL DELETE → trigger raises."""
    with pytest.raises((InternalError, ProgrammingError, IntegrityError)):
        with transaction.atomic(), connection.cursor() as cur:
            cur.execute(
                "DELETE FROM audit_event WHERE id = %s",
                [str(seeded_audit.id)],
            )


@pytest.mark.django_db(transaction=True)
def test_insert_still_works() -> None:
    """The trigger must NOT block inserts — append-only, not read-only."""
    pre = AuditEvent.objects.count()
    emit_audit(
        actor_user=None,
        actor_role=ActorRole.SYSTEM,
        event_type="test_insert_allowed",
        target_type="test",
        target_id=uuid.uuid4(),
    )
    assert AuditEvent.objects.count() == pre + 1
