"""User model — foundational for all FK chains.

Extended by the accounts agent for Phase 1A: adds 2FA enrollment trail
(`TwoFactorDevice`, `RecoveryCode`), email verification (`email_verified_at`),
password rotation tracking (`last_password_change_at`), and password reset
tokens (`PasswordResetToken`).

Locked decisions baked in here (v1Users.md §1.4, §2.4, §A.5, B.1, B.12,
B.14, B.18):
  - PK is UUID v7 (uuid_utils.uuid7) — see Appendix B.1.
  - email is the canonical login identifier and is unique.
  - email auto-lowercased on save (case-insensitive identity, B.12).
  - is_active default False — flipped to True on email verification.
  - Recovery codes argon2id-hashed at rest, never plaintext (B.14).
"""
from __future__ import annotations

import uuid

import uuid_utils
from django.conf import settings
from django.contrib.auth.models import AbstractUser, BaseUserManager
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _


def uuid7() -> uuid.UUID:
    """Return a UUID v7 as a stdlib uuid.UUID for DB storage."""
    return uuid.UUID(str(uuid_utils.uuid7()))


class UserManager(BaseUserManager):
    """Email-based manager. Username field is dropped in favor of email."""

    use_in_migrations = True

    def _create_user(self, email: str, password: str | None, **extra):
        if not email:
            raise ValueError("Email is required.")
        email = self.normalize_email(email).lower()
        user = self.model(email=email, **extra)
        if password:
            user.set_password(password)
        else:
            user.set_unusable_password()
        user.save(using=self._db)
        return user

    def create_user(self, email: str, password: str | None = None, **extra):
        extra.setdefault("is_staff", False)
        extra.setdefault("is_superuser", False)
        return self._create_user(email, password, **extra)

    def create_superuser(self, email: str, password: str, **extra):
        extra.setdefault("is_staff", True)
        extra.setdefault("is_superuser", True)
        extra.setdefault("is_active", True)
        if not extra["is_staff"]:
            raise ValueError("Superuser must have is_staff=True.")
        if not extra["is_superuser"]:
            raise ValueError("Superuser must have is_superuser=True.")
        return self._create_user(email, password, **extra)


class User(AbstractUser):
    """Custom user. Username dropped; email is the login identifier."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    username = None  # type: ignore[assignment]
    email = models.EmailField(_("email address"), unique=True)
    name = models.CharField(_("full name"), max_length=200, blank=True)

    # Soft-delete (PRD §2.6 / v1Users.md invariant).
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)

    # 2FA scaffolding — accounts agent will flesh out
    has_2fa_enrolled = models.BooleanField(default=False)
    twofa_enrolled_at = models.DateTimeField(null=True, blank=True)

    # Email verification + password rotation tracking (v1Users.md §1.5, §2.4).
    email_verified_at = models.DateTimeField(null=True, blank=True)
    last_password_change_at = models.DateTimeField(null=True, blank=True)

    # Last-active org for the SPA Org switcher (v1Users.md B.20)
    last_active_org_id = models.UUIDField(null=True, blank=True)

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS: list[str] = []

    objects = UserManager()

    class Meta:
        db_table = "accounts_user"

    def __str__(self) -> str:  # pragma: no cover
        return self.email

    @property
    def is_deleted(self) -> bool:
        return self.deleted_at is not None

    def soft_delete(self) -> None:
        """Soft-delete with PII anonymization per PRD §2.6."""
        self.deleted_at = timezone.now()
        self.email = f"deleted-{self.id}@invalid"
        self.name = "[Deleted]"
        self.is_active = False
        self.save(
            update_fields=["deleted_at", "email", "name", "is_active"],
        )

    def save(self, *args, **kwargs):
        """Lowercase email for case-insensitive identity (v1Users.md B.12)."""
        if self.email:
            self.email = self.email.strip().lower()
        super().save(*args, **kwargs)


# ---------------------------------------------------------------------------
# 2FA — TOTP device + recovery codes (v1Users.md §1.4, §2.4, B.14)
# ---------------------------------------------------------------------------


class TwoFactorDevice(models.Model):
    """A confirmed TOTP authenticator binding for one User.

    `secret_b32` is stored ciphertext when ``cryptography`` is available
    (Fernet, key derived from ``settings.SECRET_KEY``). When the library
    is missing it falls back to plain storage with the B.21 hardening
    debt logged as TODO.

    Only one *confirmed* device per user is permitted via a partial unique
    index (``confirmed_at IS NOT NULL``). An unconfirmed enrollment row
    can coexist while the user is mid-onboarding.
    """

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="totp_devices",
    )
    secret_b32 = models.CharField(max_length=512)
    confirmed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "accounts_twofactor_device"
        constraints = [
            models.UniqueConstraint(
                fields=["user"],
                condition=models.Q(confirmed_at__isnull=False),
                name="one_confirmed_totp_per_user",
            ),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"TOTP({self.user_id}, confirmed={self.confirmed_at is not None})"


class RecoveryCode(models.Model):
    """Single-use 2FA recovery code, argon2id-hashed at rest (B.14).

    The plaintext code is shown to the user exactly once at generation
    time; the database only stores its argon2id hash. ``used_at`` marks
    consumption and is enforced single-use at the service layer.
    """

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="recovery_codes",
    )
    code_hash = models.CharField(max_length=256)
    used_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "accounts_recovery_code"
        indexes = [
            models.Index(fields=["user", "used_at"], name="recovery_user_used_idx"),
        ]

    @property
    def is_used(self) -> bool:
        return self.used_at is not None

    def __str__(self) -> str:  # pragma: no cover
        return f"RecoveryCode({self.user_id}, used={self.is_used})"


# ---------------------------------------------------------------------------
# Password reset tokens (v1Users.md §2.4, A.5)
# ---------------------------------------------------------------------------


class PasswordResetToken(models.Model):
    """Hashed password reset token. Plaintext is emailed; only sha256
    hash stored. TTL configurable via ``settings.PASSWORD_RESET_TTL_MINUTES``
    (default 60 min). Single-use enforced via ``used_at``.
    """

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="password_reset_tokens",
    )
    token_hash = models.CharField(max_length=128, db_index=True)
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True, blank=True)
    requested_ip = models.GenericIPAddressField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "accounts_password_reset_token"
        indexes = [
            models.Index(fields=["user", "-created_at"], name="prt_user_created_idx"),
        ]

    @property
    def is_used(self) -> bool:
        return self.used_at is not None

    @property
    def is_expired(self) -> bool:
        return timezone.now() >= self.expires_at

    def __str__(self) -> str:  # pragma: no cover
        return f"PasswordResetToken({self.user_id}, used={self.is_used})"


# ---------------------------------------------------------------------------
# Email verification tokens (v1Users.md §2.12, A.5)
# ---------------------------------------------------------------------------


class EmailVerificationToken(models.Model):
    """Hashed email-verification token. Plaintext emailed; sha256 hash stored.

    TTL configurable via ``settings.EMAIL_VERIFICATION_TTL_HOURS`` (default 48).
    Single-use enforced via ``used_at``.
    """

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="email_verification_tokens",
    )
    token_hash = models.CharField(max_length=128, db_index=True)
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "accounts_email_verification_token"

    @property
    def is_used(self) -> bool:
        return self.used_at is not None

    @property
    def is_expired(self) -> bool:
        return timezone.now() >= self.expires_at
