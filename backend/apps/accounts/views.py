"""DRF views for the accounts app.

Single style: function-based ``@api_view`` plus drf-spectacular
``@extend_schema`` annotations (v1Users.md B.3 + OpenAPI commitment).

Endpoint summary (all under ``/api/accounts/``):
- ``POST auth/signup/``                — create pending user + email token
- ``POST auth/verify_email/``          — flip is_active=True
- ``POST auth/login/``                 — session + 2FA gate
- ``POST auth/logout/``                — flush session
- ``POST auth/reauth/``                — refresh sensitive-verb timer
- ``POST auth/password_reset_request/``
- ``POST auth/password_reset_complete/``
- ``POST auth/2fa/enroll/``            — start TOTP enrollment
- ``POST auth/2fa/confirm/``           — confirm + emit recovery codes
- ``POST auth/2fa/disable/``           — strip 2FA
- ``POST auth/2fa/recovery_codes:regenerate/``
- ``GET/PATCH me/``
- ``POST users/{uuid}:soft_delete/``   — Super-admin only
"""
from __future__ import annotations

import hashlib
import logging

from axes.helpers import get_client_ip_address
from django.conf import settings
from django.contrib.auth import authenticate, login, logout
from django.core.mail import send_mail
from django.db import transaction
from django.utils import timezone
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from apps.accounts.models import EmailVerificationToken, User
from apps.accounts.serializers import (
    LoginSerializer,
    MeSerializer,
    PasswordResetCompleteSerializer,
    PasswordResetRequestSerializer,
    ReauthSerializer,
    SignupSerializer,
    SoftDeleteSerializer,
    TwoFAConfirmResponseSerializer,
    TwoFAConfirmSerializer,
    TwoFADisableSerializer,
    TwoFAEnrollResponseSerializer,
    VerifyEmailSerializer,
)
from apps.accounts.services import password_reset as password_reset_svc
from apps.accounts.services import signup as signup_svc
from apps.accounts.services import twofa as twofa_svc
from apps.accounts.services.session_security import cycle_session_on_role_change
from apps.accounts.throttling import SignupRateThrottle
from apps.audit.models import ActorRole
from apps.audit.services import emit_audit

logger = logging.getLogger(__name__)


def _hash_token(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def _actor_role(user: User | None) -> ActorRole:
    if user is None or not user.is_authenticated:
        return ActorRole.SYSTEM
    if user.is_superuser:
        return ActorRole.SUPER_ADMIN
    return ActorRole.ADMIN


# ---------------------------------------------------------------------------
# Signup + email verification
# ---------------------------------------------------------------------------


@extend_schema(
    request=SignupSerializer,
    responses={201: OpenApiResponse(description="Pending account; check email.")},
    tags=["accounts"],
)
@api_view(["POST"])
@permission_classes([AllowAny])
@throttle_classes([SignupRateThrottle])
def signup(request: Request) -> Response:
    """Public Path B signup (v1Users.md §2.3).

    Creates a User + a pending-review Organization + a pending Admin
    membership in one atomic transaction. Path A (invite-accept) is
    handled by ``apps.organizations.views.invitation_accept`` and is
    NOT routed through here — invited users are joining an existing
    Org, not creating one.

    Idempotency: clients may send a UUID ``event_id``; replay returns
    200 (existing record) instead of 201 (newly created), per
    architectural invariant 3.

    Rate limit: ``SignupRateThrottle`` enforces 3/hr/IP per B.11.
    """
    serializer = SignupSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)

    result = signup_svc.perform_signup(
        email=serializer.validated_data["email"],
        password=serializer.validated_data["password"],
        name=serializer.validated_data.get("name", ""),
        org_name=serializer.validated_data.get("org_name", ""),
        event_id=serializer.validated_data.get("event_id"),
        request=request._request,
    )

    # Idempotent replay → return 200 with same status payload.
    if not result.created and not result.duplicate_email:
        return Response({"status": "pending_verification"}, status=status.HTTP_200_OK)

    # Duplicate-email path is enumeration-safe per B.11: identical 201.
    # We deliberately do NOT touch the existing user. No email is sent.
    if result.duplicate_email:
        return Response(
            {"status": "pending_verification"}, status=status.HTTP_201_CREATED
        )

    # Fresh signup — fire verification email best-effort.
    plaintext = result.verification_token_plaintext
    if plaintext:
        ttl_hours = getattr(settings, "EMAIL_VERIFICATION_TTL_HOURS", 48)
        try:
            send_mail(
                subject="Verify your Fixture Platform email",
                message=(
                    f"Verify your email within {ttl_hours} hours: "
                    f"/auth/verify?token={plaintext}"
                ),
                from_email=getattr(
                    settings, "DEFAULT_FROM_EMAIL", "no-reply@fixture.local"
                ),
                recipient_list=[result.user.email],
                fail_silently=True,
            )
        except Exception:  # pragma: no cover
            logger.exception("Failed to send verification email")

    return Response({"status": "pending_verification"}, status=status.HTTP_201_CREATED)


@extend_schema(request=VerifyEmailSerializer, responses={200: None}, tags=["accounts"])
@api_view(["POST"])
@permission_classes([AllowAny])
@transaction.atomic
def verify_email(request: Request) -> Response:
    serializer = VerifyEmailSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    plaintext = serializer.validated_data["token"]
    token = (
        EmailVerificationToken.objects.select_for_update()
        .select_related("user")
        .filter(token_hash=_hash_token(plaintext))
        .first()
    )
    if token is None or token.is_used or token.is_expired:
        return Response(
            {"detail": "invalid_or_expired_token"},
            status=status.HTTP_400_BAD_REQUEST,
        )
    user = token.user
    now = timezone.now()
    user.is_active = True
    user.email_verified_at = now
    user.save(update_fields=["is_active", "email_verified_at"])
    token.used_at = now
    token.save(update_fields=["used_at"])

    emit_audit(
        actor_user=user,
        actor_role=ActorRole.SYSTEM,
        event_type="email_verified",
        target_type="user",
        target_id=user.id,
        request=request,
    )
    return Response({"status": "verified"})


# ---------------------------------------------------------------------------
# Login / logout / reauth
# ---------------------------------------------------------------------------


@extend_schema(request=LoginSerializer, responses={200: None}, tags=["accounts"])
@api_view(["POST"])
@permission_classes([AllowAny])
def login_view(request: Request) -> Response:
    serializer = LoginSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    email = serializer.validated_data["email"].strip().lower()
    password = serializer.validated_data["password"]
    totp_code = serializer.validated_data.get("totp_code", "")

    # ``axes`` requires a username kwarg matching USERNAME_FIELD.
    user = authenticate(request, username=email, password=password)
    if user is None:
        try:
            target = User.objects.filter(email=email).only("id").first()
            if target is not None:
                emit_audit(
                    actor_user=None,
                    actor_role=ActorRole.SYSTEM,
                    event_type="user_login_failed",
                    target_type="user",
                    target_id=target.id,
                    request=request,
                )
        except Exception:  # pragma: no cover
            logger.exception("Failed to emit login_failed audit")
        return Response({"detail": "invalid_credentials"}, status=status.HTTP_400_BAD_REQUEST)

    if not user.is_active or user.deleted_at is not None:
        return Response({"detail": "account_inactive"}, status=status.HTTP_403_FORBIDDEN)

    if user.has_2fa_enrolled:
        if twofa_svc.twofa_is_locked(user):
            emit_audit(
                actor_user=user,
                actor_role=_actor_role(user),
                event_type="user_login_failed",
                target_type="user",
                target_id=user.id,
                payload_after={"reason": "2fa_locked"},
                request=request,
            )
            return Response(
                {"detail": "twofa_locked"},
                status=status.HTTP_429_TOO_MANY_REQUESTS,
            )
        if not totp_code:
            return Response(
                {"requires_2fa": True},
                status=status.HTTP_200_OK,
            )
        if not twofa_svc.verify_totp_or_recovery(user, totp_code, request=request):
            twofa_svc.twofa_record_failure(user)
            emit_audit(
                actor_user=user,
                actor_role=_actor_role(user),
                event_type="user_login_failed",
                target_type="user",
                target_id=user.id,
                payload_after={"reason": "2fa_failed"},
                request=request,
            )
            locked = twofa_svc.twofa_is_locked(user)
            return Response(
                {"detail": "twofa_locked" if locked else "invalid_2fa"},
                status=(
                    status.HTTP_429_TOO_MANY_REQUESTS
                    if locked
                    else status.HTTP_400_BAD_REQUEST
                ),
            )
        twofa_svc.twofa_reset_attempts(user)

    login(request, user)
    cycle_session_on_role_change(request)  # B.11 fixation defense
    emit_audit(
        actor_user=user,
        actor_role=_actor_role(user),
        event_type="user_login_success",
        target_type="user",
        target_id=user.id,
        request=request,
    )
    return Response({"status": "ok"})


@extend_schema(request=None, responses={200: None}, tags=["accounts"])
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def logout_view(request: Request) -> Response:
    user = request.user
    if user.is_authenticated:
        emit_audit(
            actor_user=user,
            actor_role=_actor_role(user),
            event_type="user_logout",
            target_type="user",
            target_id=user.id,
            request=request,
        )
    logout(request)
    return Response({"status": "ok"})


@extend_schema(request=ReauthSerializer, responses={200: None}, tags=["accounts"])
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def reauth_view(request: Request) -> Response:
    serializer = ReauthSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    password = serializer.validated_data["password"]
    user = request.user
    if not user.check_password(password):
        return Response({"detail": "invalid_password"}, status=status.HTTP_400_BAD_REQUEST)
    request.session["last_password_reauth"] = timezone.now().isoformat()
    return Response({"status": "ok"})


# ---------------------------------------------------------------------------
# Password reset
# ---------------------------------------------------------------------------


@extend_schema(
    request=PasswordResetRequestSerializer, responses={200: None}, tags=["accounts"]
)
@api_view(["POST"])
@permission_classes([AllowAny])
def password_reset_request_view(request: Request) -> Response:
    serializer = PasswordResetRequestSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    password_reset_svc.request_password_reset(
        serializer.validated_data["email"], request=request._request
    )
    return Response({"status": "ok"})


@extend_schema(
    request=PasswordResetCompleteSerializer, responses={200: None}, tags=["accounts"]
)
@api_view(["POST"])
@permission_classes([AllowAny])
def password_reset_complete_view(request: Request) -> Response:
    serializer = PasswordResetCompleteSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    try:
        password_reset_svc.complete_password_reset(
            token_plaintext=serializer.validated_data["token"],
            new_password=serializer.validated_data["new_password"],
            request=request._request,
        )
    except ValueError as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    return Response({"status": "ok"})


# ---------------------------------------------------------------------------
# 2FA
# ---------------------------------------------------------------------------


@extend_schema(
    request=None,
    responses={200: TwoFAEnrollResponseSerializer},
    tags=["accounts"],
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def twofa_enroll_view(request: Request) -> Response:
    payload = twofa_svc.enroll_totp(request.user)
    return Response(
        {
            "otpauth_uri": payload["otpauth_uri"],
            "qr_data_uri": payload["qr_data_uri"],
            "device_id": str(payload["device"].id),
        }
    )


@extend_schema(
    request=TwoFAConfirmSerializer,
    responses={200: TwoFAConfirmResponseSerializer},
    tags=["accounts"],
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def twofa_confirm_view(request: Request) -> Response:
    serializer = TwoFAConfirmSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    try:
        codes = twofa_svc.confirm_totp(
            request.user, serializer.validated_data["code"], request=request._request
        )
    except ValueError as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    cycle_session_on_role_change(request)  # auth-state change → cycle
    return Response({"recovery_codes": codes})


@extend_schema(request=TwoFADisableSerializer, responses={200: None}, tags=["accounts"])
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def twofa_disable_view(request: Request) -> Response:
    serializer = TwoFADisableSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    twofa_svc.disable_2fa(
        request.user,
        actor=request.user,
        reason=serializer.validated_data.get("reason", ""),
        request=request._request,
    )
    cycle_session_on_role_change(request)
    return Response({"status": "ok"})


@extend_schema(
    request=None,
    responses={200: TwoFAConfirmResponseSerializer},
    tags=["accounts"],
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def twofa_recovery_regenerate_view(request: Request) -> Response:
    codes = twofa_svc.regenerate_recovery_codes(
        request.user, actor=request.user, request=request._request
    )
    return Response({"recovery_codes": codes})


# ---------------------------------------------------------------------------
# /me endpoint
# ---------------------------------------------------------------------------


@extend_schema(
    methods=["GET"],
    request=None,
    responses={200: MeSerializer},
    tags=["accounts"],
)
@extend_schema(
    methods=["PATCH"],
    request=MeSerializer,
    responses={200: MeSerializer},
    tags=["accounts"],
)
@api_view(["GET", "PATCH"])
@permission_classes([IsAuthenticated])
def me_view(request: Request) -> Response:
    user = request.user
    if request.method == "GET":
        return Response(MeSerializer(user).data)

    serializer = MeSerializer(user, data=request.data, partial=True)
    serializer.is_valid(raise_exception=True)
    before = {"name": user.name, "last_active_org_id": str(user.last_active_org_id) if user.last_active_org_id else None}
    serializer.save()
    after = {
        "name": user.name,
        "last_active_org_id": str(user.last_active_org_id) if user.last_active_org_id else None,
    }
    emit_audit(
        actor_user=user,
        actor_role=_actor_role(user),
        event_type="user_self_update",
        target_type="user",
        target_id=user.id,
        payload_before=before,
        payload_after=after,
        request=request._request,
    )
    return Response(MeSerializer(user).data)


# ---------------------------------------------------------------------------
# Soft-delete (Super-admin only) — AIP-136 colon syntax
# ---------------------------------------------------------------------------


@extend_schema(request=SoftDeleteSerializer, responses={200: None}, tags=["accounts"])
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def user_soft_delete_view(request: Request, user_id) -> Response:
    actor = request.user
    if not actor.is_superuser:
        return Response({"detail": "forbidden"}, status=status.HTTP_403_FORBIDDEN)
    serializer = SoftDeleteSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    target = User.objects.filter(pk=user_id).first()
    if target is None:
        return Response({"detail": "not_found"}, status=status.HTTP_404_NOT_FOUND)
    before = {"email": target.email, "deleted_at": None}
    target.soft_delete()
    emit_audit(
        actor_user=actor,
        actor_role=ActorRole.SUPER_ADMIN,
        event_type="user_soft_deleted",
        target_type="user",
        target_id=target.id,
        payload_before=before,
        payload_after={"deleted_at": target.deleted_at.isoformat()},
        reason=serializer.validated_data.get("reason", ""),
        request=request._request,
    )
    return Response({"status": "ok"})


# Imports kept at module bottom for static-analyzers. ``get_client_ip_address``
# is unused at present but kept available for future extension wiring axes.
_ = get_client_ip_address
