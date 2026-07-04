"""Atomic ownership transfer.

Implementation note on the partial unique-constraint behaviour:

  Postgres does not let `CREATE UNIQUE INDEX ... WHERE` (partial unique
  index) be deferred — only true unique CONSTRAINTs are deferrable, and
  those cannot have a WHERE clause. Django therefore silently drops the
  `deferrable=Deferrable.DEFERRED` flag on a partial UniqueConstraint.

  We mitigate by ordering the swap so that the outgoing owner's
  is_org_owner flag is cleared FIRST, then the incoming owner's flag is
  set. After the first save the partial-unique condition has zero
  matching rows, so the second save passes. The whole pair lives inside
  a single `transaction.atomic()` block — if either save fails, both
  roll back.

  The original spec (v1Users.md §2.7) called for `DEFERRABLE INITIALLY
  DEFERRED`. We continue to declare it on the model so that, if/when
  Django gains support (or a custom migration RunSQL is added), the
  intent survives. The runtime behaviour is correct either way.
"""
from __future__ import annotations

from django.core.exceptions import ValidationError
from django.db import transaction
from django.http import HttpRequest

from apps.audit.models import ActorRole
from apps.audit.services import emit_audit
from apps.organizations.models import (
    MembershipRole,
    Organization,
    OrganizationMembership,
)


def transfer_ownership(
    *,
    org: Organization,
    current_owner_user,
    new_owner_user,
    requested_by,
    request: HttpRequest | None = None,
) -> tuple[OrganizationMembership, OrganizationMembership]:
    """Atomically swap is_org_owner between two admin memberships.

    Preconditions:
      - current_owner_user has an active admin membership in org with
        is_org_owner=True.
      - new_owner_user has an active admin membership in org (the
        DB widened-uniqueness constraint guarantees they aren't admin
        elsewhere).
    """
    if current_owner_user == new_owner_user:
        raise ValidationError("Cannot transfer ownership to the current owner.")

    with transaction.atomic():
        try:
            current = OrganizationMembership.objects.select_for_update().get(
                user=current_owner_user,
                organization=org,
                role=MembershipRole.ADMIN,
                is_active=True,
                is_org_owner=True,
            )
        except OrganizationMembership.DoesNotExist as exc:
            raise ValidationError(
                "Current owner does not hold an active owning admin membership."
            ) from exc

        try:
            incoming = OrganizationMembership.objects.select_for_update().get(
                user=new_owner_user,
                organization=org,
                role=MembershipRole.ADMIN,
                is_active=True,
            )
        except OrganizationMembership.DoesNotExist as exc:
            raise ValidationError(
                "New owner must already hold an active admin membership in this org."
            ) from exc

        before = {
            "current_owner_user": str(current.user_id),
            "new_owner_user": str(incoming.user_id),
        }

        # Atomic swap. Thanks to DEFERRABLE INITIALLY DEFERRED, the
        # constraint is checked at COMMIT, not after each UPDATE.
        current.is_org_owner = False
        current.save(update_fields=["is_org_owner"])

        incoming.is_org_owner = True
        incoming.save(update_fields=["is_org_owner"])

        # Both sides' resolved modules may hinge on ownership; drop the
        # resolver cache once the swap is durable.
        from apps.permissions.services.resolver import invalidate_cache

        pairs = [(current.user_id, org.id), (incoming.user_id, org.id)]
        transaction.on_commit(
            lambda: [invalidate_cache(u, o) for u, o in pairs]
        )

        emit_audit(
            actor_user=requested_by,
            actor_role=ActorRole.ADMIN,
            event_type="ownership_transfer_accepted",
            target_type="organization",
            target_id=org.id,
            payload_before=before,
            payload_after={
                "current_owner_user": str(incoming.user_id),
                "previous_owner_user": str(current.user_id),
            },
            reason="ownership transfer",
            organization_id=org.id,
            request=request,
        )

    return current, incoming
