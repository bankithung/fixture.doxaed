"""AdminInvitation services.

Verbs:
  - create_invitation: opaque token + sha256 hash; plaintext emailed only.
  - accept_invitation: hash compare + active-membership creation +
    session cycle (B.11 fixation defense).
  - revoke_invitation: status=revoked.

The accounts agent owns the canonical
`apps.accounts.services.session_security.cycle_session_on_role_change`
helper. Until that lands we ship a tiny local stub that mimics the
contract (rotate_token + cleanup of the per-user cookie) so the call
site is stable. The stub is removed once the accounts agent's helper
is importable.
"""
from __future__ import annotations

import hashlib
import secrets
import uuid as _uuid
from typing import Optional, Sequence, Union

from django.core.exceptions import ValidationError
from django.core.mail import send_mail
from django.db import transaction
from django.http import HttpRequest
from django.utils import timezone

from apps.audit.models import ActorRole
from apps.audit.services import emit_audit

from apps.organizations.models import (
    AdminInvitation,
    InviteStatus,
    MembershipRole,
    Organization,
    OrganizationMembership,
    OrgStatus,
)


# Role tier order for picking highest-tier role when a list of roles is
# given. Frontend sends an array; v1 backend stores one role per
# invitation row, so we pick the most powerful role from the list.
_ROLE_RANK: dict[str, int] = {
    MembershipRole.ADMIN: 60,
    MembershipRole.CO_ORGANIZER: 50,
    MembershipRole.GAME_COORDINATOR: 40,
    MembershipRole.MATCH_SCORER: 30,
    MembershipRole.REFEREE: 20,
    MembershipRole.TEAM_MANAGER: 10,
}


# ---------------------------------------------------------------------------
# Session-cycle hook
# ---------------------------------------------------------------------------


def _cycle_session(request: Optional[HttpRequest]) -> None:
    """Call the accounts agent's session-cycle helper if present;
    otherwise fall back to Django's `request.session.cycle_key()`.

    This anti-fixation hook is required on invite-accept (B.11).
    """
    try:
        from apps.accounts.services.session_security import (  # type: ignore[import-not-found]
            cycle_session_on_role_change,
        )

        cycle_session_on_role_change(request)
        return
    except Exception:  # noqa: BLE001 — fallback path; helper not yet shipped
        pass

    if request is not None and hasattr(request, "session"):
        try:
            request.session.cycle_key()
        except Exception:  # noqa: BLE001 — anonymous / no session
            pass


# ---------------------------------------------------------------------------
# Token helpers
# ---------------------------------------------------------------------------


def _generate_token() -> str:
    """Opaque URL-safe token (32 bytes ≈ 256 bits of entropy)."""
    return secrets.token_urlsafe(32)


def _hash_token(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Verbs
# ---------------------------------------------------------------------------


def _pick_highest_role(roles: Sequence[str]) -> str:
    """Return the most-privileged role from a non-empty list."""
    return max(roles, key=lambda r: _ROLE_RANK.get(r, -1))


def create_invitation(
    *,
    org: Organization,
    email: str,
    role: Optional[str] = None,
    roles: Optional[Sequence[str]] = None,
    invited_by,
    request: Optional[HttpRequest] = None,
    event_id: Optional[Union[str, _uuid.UUID]] = None,
    tournament=None,
) -> tuple[AdminInvitation, str]:
    """Create an invitation row + return (invitation, plaintext_token).

    Plaintext token is emailed only. The DB stores sha256(token).

    Either ``role`` (single string) or ``roles`` (list) may be given.
    When ``roles`` is a list, the highest-tier role wins (admin >
    co_organizer > game_coordinator > match_scorer > referee >
    team_manager). The frontend SPA sends ``roles`` as an array.

    ``event_id`` is the client-generated idempotency key (UUID). If
    given, it's forwarded to the audit row; replays with the same
    event_id return the existing invitation rather than creating a
    duplicate.
    """
    email = (email or "").strip().lower()
    if not email:
        raise ValidationError("Email is required.")

    # Resolve the effective role.
    if roles is not None:
        if not isinstance(roles, (list, tuple)) or len(roles) == 0:
            raise ValidationError("roles must be a non-empty list.")
        for r in roles:
            if r not in MembershipRole.values:
                raise ValidationError(f"Invalid role '{r}'.")
        effective_role = _pick_highest_role(list(roles))
    else:
        effective_role = role if role is not None else MembershipRole.CO_ORGANIZER
        if effective_role not in MembershipRole.values:
            raise ValidationError(f"Invalid role '{effective_role}'.")

    # Coerce event_id to UUID if given.
    idempotency_key: Optional[_uuid.UUID] = None
    if event_id is not None:
        try:
            idempotency_key = (
                event_id if isinstance(event_id, _uuid.UUID) else _uuid.UUID(str(event_id))
            )
        except (ValueError, TypeError) as exc:
            raise ValidationError("event_id must be a valid UUID.") from exc

    # Idempotency replay: if we've already processed this event_id, return
    # the invitation row that audit row points at.
    if idempotency_key is not None:
        from apps.audit.models import AuditEvent

        prior = AuditEvent.objects.filter(idempotency_key=idempotency_key).first()
        if prior is not None and prior.target_type == "admin_invitation":
            existing_inv = AdminInvitation.objects.filter(pk=prior.target_id).first()
            if existing_inv is not None:
                return existing_inv, ""

    if org.status not in (OrgStatus.ACTIVE, OrgStatus.PENDING_REVIEW):
        raise ValidationError(
            f"Cannot send invites for an org in status '{org.status}'."
        )

    if tournament is not None and tournament.organization_id != org.id:
        raise ValidationError("Tournament does not belong to this organization.")

    # One pending invite per (org, tournament, email) — enforced by partial
    # unique constraint at the DB layer; surface a clean message at the service
    # layer so callers don't crash on IntegrityError.
    existing = AdminInvitation.objects.filter(
        organization=org, tournament=tournament, email=email, status=InviteStatus.PENDING
    ).first()
    if existing is not None:
        raise ValidationError(
            f"A pending invitation for {email} already exists for this organization."
        )

    plaintext = _generate_token()
    token_hash = _hash_token(plaintext)

    with transaction.atomic():
        inv = AdminInvitation.objects.create(
            organization=org,
            tournament=tournament,
            email=email,
            role=effective_role,
            invited_by=invited_by,
            token_hash=token_hash,
        )
        emit_audit(
            actor_user=invited_by,
            actor_role=ActorRole.ADMIN,
            event_type="member_invite_sent",
            target_type="admin_invitation",
            target_id=inv.id,
            payload_after={
                "email": email,
                "role": effective_role,
                "expires_at": inv.expires_at.isoformat(),
            },
            organization_id=org.id,
            request=request,
            idempotency_key=idempotency_key,
        )
        # Send token to the invitee. Console backend in dev.
        try:
            send_mail(
                subject=f"You've been invited to {org.name}",
                message=(
                    f"You've been invited to join {org.name} on Fixture Platform.\n\n"
                    f"Use this token to accept: {plaintext}\n\n"
                    f"This invitation expires at {inv.expires_at.isoformat()}."
                ),
                from_email=None,  # uses DEFAULT_FROM_EMAIL
                recipient_list=[email],
                fail_silently=True,
            )
        except Exception:  # noqa: BLE001 — never break the verb on email
            pass

    return inv, plaintext


def accept_invitation(
    *,
    token_plaintext: str,
    accepting_user,
    request: Optional[HttpRequest] = None,
) -> OrganizationMembership:
    """Accept an invitation. Atomic across:
      - hash lookup + status / expiry check
      - membership create-or-fetch
      - invitation status=accepted
      - session cycle (B.11)
      - audit emit
    """
    if not token_plaintext:
        raise ValidationError("Token is required.")
    token_hash = _hash_token(token_plaintext)

    # Pre-check + materialize expiry OUTSIDE of any later atomic block so the
    # status flip survives a subsequent ValidationError rollback.
    pre_inv = AdminInvitation.objects.filter(token_hash=token_hash).first()
    if pre_inv is None:
        raise ValidationError("Invalid invitation token.")
    if pre_inv.status == InviteStatus.PENDING and pre_inv.is_expired():
        AdminInvitation.objects.filter(pk=pre_inv.pk, status=InviteStatus.PENDING).update(
            status=InviteStatus.EXPIRED
        )
        raise ValidationError("Invitation has expired.")

    with transaction.atomic():
        try:
            inv = AdminInvitation.objects.select_for_update().get(
                token_hash=token_hash
            )
        except AdminInvitation.DoesNotExist as exc:
            raise ValidationError("Invalid invitation token.") from exc

        if inv.status == InviteStatus.ACCEPTED:
            raise ValidationError("Invitation has already been accepted.")
        if inv.status == InviteStatus.REVOKED:
            raise ValidationError("Invitation has been revoked.")
        if inv.status == InviteStatus.EXPIRED or inv.is_expired():
            # Materialized above; just raise.
            raise ValidationError("Invitation has expired.")

        org = inv.organization
        if org.status not in (OrgStatus.ACTIVE, OrgStatus.PENDING_REVIEW):
            raise ValidationError(
                f"Cannot accept an invitation for an org in status '{org.status}'."
            )

        # Idempotent membership creation. Tournament-scoped invites create a
        # TournamentMembership (no org-wide membership — preserves isolation:
        # an invited scorer gets only that tournament, not the whole org).
        # Org-level invites keep the existing OrganizationMembership behavior.
        from django.db import IntegrityError

        if inv.tournament_id:
            from apps.tournaments.models import (
                TournamentMembership,
                TournamentMembershipStatus,
            )

            result = TournamentMembership.objects.filter(
                user=accepting_user, tournament_id=inv.tournament_id, role=inv.role
            ).first()
            if result is None:
                try:
                    result = TournamentMembership.objects.create(
                        user=accepting_user,
                        tournament_id=inv.tournament_id,
                        role=inv.role,
                        status=TournamentMembershipStatus.ACTIVE,
                        assigned_by=inv.invited_by,
                    )
                except IntegrityError as exc:
                    raise ValidationError("membership_conflict") from exc
            elif result.status != TournamentMembershipStatus.ACTIVE:
                result.status = TournamentMembershipStatus.ACTIVE
                result.revoked_at = None
                result.save(update_fields=["status", "revoked_at"])
            audit_target_type = "tournament_membership"
            audit_payload = {
                "user_id": str(accepting_user.id),
                "tournament_id": str(inv.tournament_id),
                "role": inv.role,
            }
        else:
            result = OrganizationMembership.objects.filter(
                user=accepting_user, organization=org, role=inv.role
            ).first()
            if result is None:
                try:
                    result = OrganizationMembership.objects.create(
                        user=accepting_user,
                        organization=org,
                        role=inv.role,
                        is_active=True,
                        created_by=inv.invited_by,
                    )
                except IntegrityError as exc:
                    raise ValidationError("membership_conflict") from exc
            elif not result.is_active:
                result.is_active = True
                result.removed_at = None
                result.save(update_fields=["is_active", "removed_at"])
            audit_target_type = "organization_membership"
            audit_payload = {
                "user_id": str(accepting_user.id),
                "organization_id": str(org.id),
                "role": inv.role,
            }

        inv.status = InviteStatus.ACCEPTED
        inv.accepted_at = timezone.now()
        inv.accepted_by_user = accepting_user
        inv.save(update_fields=["status", "accepted_at", "accepted_by_user"])

        emit_audit(
            actor_user=accepting_user,
            actor_role=ActorRole.SYSTEM,
            event_type="member_invite_accepted",
            target_type=audit_target_type,
            target_id=result.id,
            payload_after=audit_payload,
            organization_id=org.id,
            request=request,
        )

    # Session-cycle outside the transaction so it survives commit.
    _cycle_session(request)

    return result


def revoke_invitation(
    *,
    invitation: AdminInvitation,
    revoked_by,
    reason: str = "",
    request: Optional[HttpRequest] = None,
) -> AdminInvitation:
    if invitation.status != InviteStatus.PENDING:
        raise ValidationError(
            f"Cannot revoke an invitation in status '{invitation.status}'."
        )
    with transaction.atomic():
        before = {"status": invitation.status}
        invitation.status = InviteStatus.REVOKED
        invitation.revoked_at = timezone.now()
        invitation.revoked_reason = (reason or "").strip()
        invitation.save(update_fields=["status", "revoked_at", "revoked_reason"])

        emit_audit(
            actor_user=revoked_by,
            actor_role=ActorRole.ADMIN,
            event_type="member_invite_revoked",
            target_type="admin_invitation",
            target_id=invitation.id,
            payload_before=before,
            payload_after={"status": invitation.status},
            reason=reason,
            organization_id=invitation.organization_id,
            request=request,
        )
    return invitation


def get_invitation_by_token(token_plaintext: str) -> Optional[AdminInvitation]:
    """Look up an invitation by plaintext token (no mutation). Returns None if
    not found. Used by the AllowAny accept view to read the invite's email +
    tournament before establishing/creating the accepting user's session.
    """
    if not token_plaintext:
        return None
    return AdminInvitation.objects.filter(token_hash=_hash_token(token_plaintext)).first()
