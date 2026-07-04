"""Claim-your-school (P4): the graduation path from account-less registrant
to institution OPERATOR.

A school's contact proves control with the team access code (the same
Argon2-checked, lockout-protected secret that edits their registration) and
must be a logged-in, email-verified user — a stolen 2h portal token alone
can never seize a tenant (design risk R8). The claim mints an
Organization(kind=institution) linked to the canonical SchoolProfile and
makes the claimant its owning admin. One operator org per school profile:
a second claim is refused loudly, never merged silently.
"""
from __future__ import annotations

from django.core.exceptions import ValidationError
from django.db import transaction

from apps.audit.models import ActorRole
from apps.audit.services import emit_audit
from apps.organizations.models import (
    MembershipRole,
    Organization,
    OrganizationMembership,
    OrgKind,
    OrgStatus,
)
from apps.organizations.services.workspace import pick_unique_org_slug
from apps.teams.models import Institution
from apps.teams.services.access import verify_team_code


def claim_school(*, institution: Institution, code: str, user, request=None) -> Organization:
    if user is None or not getattr(user, "is_authenticated", False):
        raise ValidationError("login_required")
    if not getattr(user, "email_verified_at", None):
        raise ValidationError("verify_email_first")

    ok, err = verify_team_code(institution, code)
    if not ok:
        raise ValidationError(err or "invalid_code")

    profile = institution.school_profile
    if profile is None:
        raise ValidationError("school_profile_missing")

    with transaction.atomic():
        existing = Organization.objects.filter(
            school_profile=profile, kind=OrgKind.INSTITUTION,
        ).first()
        if existing is not None:
            # Idempotent for the SAME claimant; a conflict for anyone else.
            if OrganizationMembership.objects.filter(
                organization=existing, user=user, is_active=True,
            ).exists():
                return existing
            raise ValidationError("school_already_claimed")

        org = Organization.objects.create(
            slug=pick_unique_org_slug(institution.name),
            name=institution.name,
            status=OrgStatus.ACTIVE,
            kind=OrgKind.INSTITUTION,
            is_listed=False,  # visibility is a later, deliberate switch (D6)
            school_profile=profile,
            profile={"region": institution.region, "kind": institution.kind},
            created_by=user,
        )
        OrganizationMembership.objects.create(
            user=user,
            organization=org,
            role=MembershipRole.ADMIN,
            is_active=True,
            is_org_owner=True,
            created_by=user,
        )
        emit_audit(
            actor_user=user,
            actor_role=ActorRole.ADMIN,
            event_type="school_claimed",
            target_type="organization",
            target_id=org.id,
            organization_id=org.id,
            payload_after={
                "school_profile": str(profile.id),
                "institution": str(institution.id),
                "claimed_from_tournament": str(institution.tournament_id),
            },
            request=request,
        )
    return org
