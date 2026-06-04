"""DRF serializers for the accounts API surface.

Kept small and explicit — schema generation by drf-spectacular leans on
these. v1Users.md §A.5 + §2.4 outline the input/output shapes.
"""
from __future__ import annotations

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.accounts.models import User


class SignupSerializer(serializers.Serializer):
    """Public self-signup payload (v1Users.md §2.3 Path B).

    The signup endpoint creates a User AND a pending-review Organization
    plus a pending Admin membership in a single atomic transaction. The
    optional ``org_name`` lets the user choose a display name for their
    new tenant; if omitted, it is derived from the email local-part.

    ``event_id`` (optional, client-generated UUID) is honored for
    idempotent retries per architectural invariant 3 — re-submitting the
    same ``event_id`` short-circuits and returns the existing record.
    """

    email = serializers.EmailField()
    password = serializers.CharField(write_only=True, min_length=12)
    name = serializers.CharField(max_length=200, required=False, allow_blank=True)
    org_name = serializers.CharField(max_length=200, required=False, allow_blank=True)
    event_id = serializers.UUIDField(required=False)


class VerifyEmailSerializer(serializers.Serializer):
    token = serializers.CharField()


class LoginSerializer(serializers.Serializer):
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True)
    totp_code = serializers.CharField(required=False, allow_blank=True)


class ReauthSerializer(serializers.Serializer):
    password = serializers.CharField(write_only=True)


class PasswordResetRequestSerializer(serializers.Serializer):
    email = serializers.EmailField()


class PasswordResetCompleteSerializer(serializers.Serializer):
    token = serializers.CharField()
    new_password = serializers.CharField(write_only=True, min_length=12)


class TwoFAEnrollResponseSerializer(serializers.Serializer):
    otpauth_uri = serializers.CharField()
    qr_data_uri = serializers.CharField(allow_blank=True)
    device_id = serializers.UUIDField()


class TwoFAConfirmSerializer(serializers.Serializer):
    code = serializers.CharField()


class TwoFAConfirmResponseSerializer(serializers.Serializer):
    recovery_codes = serializers.ListField(child=serializers.CharField())


class TwoFADisableSerializer(serializers.Serializer):
    reason = serializers.CharField(required=False, allow_blank=True)


class SoftDeleteSerializer(serializers.Serializer):
    reason = serializers.CharField(required=False, allow_blank=True)


class MembershipSummarySerializer(serializers.Serializer):
    """One per-org membership row consumed by the SPA bootstrap.

    Aggregated across the user's (potentially multiple) role rows in
    the same org so the SPA can render one switcher entry per org and
    a roles-array for in-org role-view toggling (§2.7).
    """

    org_id = serializers.UUIDField()
    org_slug = serializers.CharField()
    org_name = serializers.CharField()
    roles = serializers.ListField(child=serializers.CharField())
    is_org_owner = serializers.BooleanField()
    effective_modules = serializers.ListField(child=serializers.CharField())


class MeSerializer(serializers.ModelSerializer):
    """Used by GET/PATCH /api/accounts/me/.

    Read shape includes `is_superuser`, `memberships[]`, and
    `last_active_org_slug` so the SPA can route directly to a dashboard
    without a second round-trip to /api/orgs/.
    """

    is_superuser = serializers.BooleanField(read_only=True)
    memberships = serializers.SerializerMethodField()
    last_active_org_slug = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = (
            "id",
            "email",
            "name",
            "is_superuser",
            "has_2fa_enrolled",
            "twofa_enrolled_at",
            "email_verified_at",
            "last_active_org_id",
            "last_active_org_slug",
            "memberships",
            "deleted_at",
        )
        read_only_fields = (
            "id",
            "email",
            "is_superuser",
            "has_2fa_enrolled",
            "twofa_enrolled_at",
            "email_verified_at",
            "memberships",
            "last_active_org_slug",
            "deleted_at",
        )

    def _active_memberships(self, user):
        from apps.organizations.models import OrganizationMembership

        return (
            OrganizationMembership.objects.filter(user=user, is_active=True)
            .select_related("organization")
        )

    @extend_schema_field(MembershipSummarySerializer(many=True))
    def get_memberships(self, user):
        from apps.permissions.services.resolver import effective_modules

        # Aggregate (user, org, role) rows into one per-org entry.
        per_org: dict = {}
        for m in self._active_memberships(user):
            entry = per_org.setdefault(
                m.organization_id,
                {
                    "org_id": m.organization_id,
                    "org_slug": m.organization.slug,
                    "org_name": m.organization.name,
                    "roles": [],
                    "is_org_owner": False,
                    "_org": m.organization,
                },
            )
            if m.role not in entry["roles"]:
                entry["roles"].append(m.role)
            if m.is_org_owner:
                entry["is_org_owner"] = True

        # Resolve modules per-org once, after collecting roles.
        rows = []
        for entry in per_org.values():
            org = entry.pop("_org")
            try:
                modules = list(effective_modules(user, org))
            except Exception:
                modules = []
            entry["effective_modules"] = modules
            rows.append(entry)
        return rows

    @extend_schema_field(serializers.CharField(allow_null=True))
    def get_last_active_org_slug(self, user):
        if not user.last_active_org_id:
            return None
        from apps.organizations.models import Organization

        org = Organization.objects.filter(id=user.last_active_org_id).only("slug").first()
        return org.slug if org else None
