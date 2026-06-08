"""accounts app URLs.

AIP-136 colon-syntax for verb actions per v1Users.md B.3.
"""
from __future__ import annotations

from django.urls import path

from apps.accounts import views

app_name = "accounts"

urlpatterns = [
    # Auth
    path("auth/signup/", views.signup, name="signup"),
    path("auth/verify_email/", views.verify_email, name="verify_email"),
    path("auth/verify-email/", views.verify_email),  # SPA hyphen alias
    path(
        "auth/resend-verification/",
        views.resend_verification,
        name="resend_verification",
    ),
    path("auth/login/", views.login_view, name="login"),
    path("auth/logout/", views.logout_view, name="logout"),
    path("auth/reauth/", views.reauth_view, name="reauth"),
    path(
        "auth/password_reset_request/",
        views.password_reset_request_view,
        name="password_reset_request",
    ),
    path("auth/password-reset-request/", views.password_reset_request_view),
    path(
        "auth/password_reset_complete/",
        views.password_reset_complete_view,
        name="password_reset_complete",
    ),
    path("auth/password-reset-complete/", views.password_reset_complete_view),
    # 2FA
    path("auth/2fa/enroll/", views.twofa_enroll_view, name="twofa_enroll"),
    path("auth/2fa/confirm/", views.twofa_confirm_view, name="twofa_confirm"),
    path("auth/2fa/disable/", views.twofa_disable_view, name="twofa_disable"),
    path(
        "auth/2fa/recovery_codes:regenerate/",
        views.twofa_recovery_regenerate_view,
        name="twofa_recovery_regenerate",
    ),
    # Self-service
    path("me/", views.me_view, name="me"),
    # Super-admin verbs (AIP-136 colon-syntax)
    path(
        "users/<uuid:user_id>:soft_delete/",
        views.user_soft_delete_view,
        name="user_soft_delete",
    ),
]
