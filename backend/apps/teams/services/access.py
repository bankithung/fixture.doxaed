"""Team-registration access codes (Stage 2 security).

When team registration opens, every registered institution's contact is
emailed the public form link plus a short access code. Submitting (or
editing) teams for an institution that has a code REQUIRES proving it:
the public page exchanges (institution, code) for a short-lived signed
access token, and the submit endpoint verifies that token.

Security properties:
- Only a salted, slow Django password hash of the code is stored
  (``make_password``/``check_password``, Argon2id here — constant-time verify).
- Codes use an unambiguous A-Z/2-9 alphabet from ``secrets`` (~40 bits).
- Verification is cache-throttled per institution (5 failures → 15 min
  lockout) on top of the per-IP endpoint throttle.
- The access token is a signed, salted, expiring payload
  (``django.core.signing``) — the raw code never rides on submissions.
"""
from __future__ import annotations

import secrets

from django.conf import settings as django_settings
from django.contrib.auth.hashers import check_password, make_password
from django.core import signing
from django.core.cache import cache
from django.core.mail import send_mail
from django.utils import timezone

from apps.audit.services import emit_audit
from apps.audit.models import ActorRole
from apps.teams.models import Institution

# No 0/O/1/I — codes get typed from an email on a phone.
_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 8
TOKEN_SALT = "team-registration-access"
TOKEN_MAX_AGE = 2 * 60 * 60  # 2h — enough to fill a roster, short enough to limit replay
MAX_FAILURES = 5
LOCKOUT_SECONDS = 15 * 60


def generate_code() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(CODE_LENGTH))


def issue_team_access_codes(
    *, tournament, form, only_missing: bool = True, institution_ids=None,
    request=None, actor=None,
) -> dict:
    """Generate + email an access code to active institution contacts.

    ``only_missing`` skips institutions that already hold a code (so a re-run
    after late registrations never invalidates codes already in inboxes);
    pass False to rotate. ``institution_ids`` (optional) restricts to a chosen
    set AND forces a fresh code for each (an explicit per-school send/resend).
    Returns counts for the admin UI."""
    qs = Institution.objects.filter(
        tournament=tournament, deleted_at__isnull=True
    ).exclude(status__in=["withdrawn", "rejected"])
    if institution_ids:
        qs = qs.filter(id__in=list(institution_ids))
        only_missing = False  # an explicit pick always (re)issues
    sent, no_email, skipped = 0, 0, 0
    no_email_institutions: list[dict] = []
    base = getattr(django_settings, "PUBLIC_BASE_URL", "https://fixture.doxaed.com")
    url = f"{base}/f/{form.id}"
    for inst in qs:
        if only_missing and inst.team_code_hash:
            skipped += 1
            continue
        if not (inst.contact_email or "").strip():
            no_email += 1
            # Surfaced to the admin: add an email manually, or mint that
            # school a temporary edit link so they fix their own details.
            no_email_institutions.append({"id": str(inst.id), "name": inst.name})
            continue
        code = generate_code()
        inst.team_code_hash = make_password(code)
        inst.team_code_sent_at = timezone.now()
        inst.save(update_fields=["team_code_hash", "team_code_sent_at", "updated_at"])
        send_mail(
            subject=f"{tournament.name} · team registration code for {inst.name}",
            message=(
                f"Hello {inst.contact_name or inst.name},\n\n"
                f"Team registration for {tournament.name} is open.\n\n"
                f"Register (or update) your teams here:\n{url}\n\n"
                f"Select \"{inst.name}\" and enter your access code:\n\n"
                f"    {code}\n\n"
                "Keep this code private — anyone with it can edit your "
                "school's team registration. You can come back with the same "
                "code to update your teams while registration stays open.\n"
            ),
            from_email=None,  # DEFAULT_FROM_EMAIL
            recipient_list=[inst.contact_email.strip()],
            fail_silently=True,
        )
        sent += 1
    emit_audit(
        actor_user=actor,
        actor_role=ActorRole.SYSTEM if actor is None else ActorRole.ADMIN,
        event_type="team_access_codes_issued",
        target_type="tournament",
        target_id=tournament.id,
        organization_id=tournament.organization_id,
        payload_after={"sent": sent, "no_email": no_email, "skipped": skipped,
                       "form_id": str(form.id)},
        request=request,
    )
    return {
        "sent": sent,
        "no_email": no_email,
        "skipped": skipped,
        "no_email_institutions": no_email_institutions,
    }


def _lock_key(inst_id) -> str:
    return f"team-access-lock:{inst_id}"


def _fail_key(inst_id) -> str:
    return f"team-access-fails:{inst_id}"


def verify_team_code(inst: Institution, code: str) -> tuple[bool, str | None]:
    """Constant-time code check with per-institution lockout.

    Returns ``(ok, error_code)`` — error is ``locked`` or ``invalid_code``."""
    if cache.get(_lock_key(inst.id)):
        return False, "locked"
    if not inst.team_code_hash or not check_password(
        (code or "").strip().upper(), inst.team_code_hash
    ):
        fails = (cache.get(_fail_key(inst.id)) or 0) + 1
        cache.set(_fail_key(inst.id), fails, LOCKOUT_SECONDS)
        if fails >= MAX_FAILURES:
            cache.set(_lock_key(inst.id), True, LOCKOUT_SECONDS)
        return False, "invalid_code"
    cache.delete(_fail_key(inst.id))
    return True, None


def make_access_token(inst: Institution, form) -> str:
    return signing.dumps({"i": str(inst.id), "f": str(form.id)}, salt=TOKEN_SALT)


def read_access_token(token: str) -> dict | None:
    """Verified payload of an access token, or None (bad/expired)."""
    try:
        return signing.loads(token, salt=TOKEN_SALT, max_age=TOKEN_MAX_AGE)
    except signing.BadSignature:
        return None
