"""Team-registration access codes (Stage 2 security).

When team registration opens, every registered institution's contact is
emailed the public form link plus a short access code. Submitting (or
editing) teams for an institution that has a code REQUIRES proving it:
the public page exchanges (institution, code) for a short-lived signed
access token, and the submit endpoint verifies that token.

Security properties:
- Verification ALWAYS reads a salted, slow Django password hash
  (``make_password``/``check_password``, Argon2id here — constant-time verify).
- A second, reversibly-encrypted copy is kept so a tournament manager can read
  the code back and hand it over by phone (owner 2026-08-19). It is never an
  auth input and never leaves a manager-gated endpoint. This grants the host
  nothing they lacked: they can already point a school's contact email at
  themselves and resend. It does not weaken the boundary that matters, which
  is school-to-school and school-to-public.
- Codes use an unambiguous A-Z/2-9 alphabet from ``secrets`` (~40 bits).
- Verification is cache-throttled per institution (5 failures → 15 min
  lockout) on top of the per-IP endpoint throttle.
- The access token is a signed, salted, expiring payload
  (``django.core.signing``) — the raw code never rides on submissions.
"""
from __future__ import annotations

import secrets
from datetime import timedelta

from django.conf import settings as django_settings
from django.contrib.auth.hashers import check_password, make_password
from django.core import signing
from django.core.cache import cache
from django.utils import timezone

from apps.accounts.services._crypto import decrypt_for, encrypt_for
from apps.audit.models import ActorRole
from apps.audit.services import emit_audit
from apps.teams.models import Institution

#: Key-derivation scope for the readable copy — see ``_crypto.encrypt_for``.
_CODE_PURPOSE = "team_access_code"

# No 0/O/1/I — codes get typed from an email on a phone.
_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 8
TOKEN_SALT = "team-registration-access"
TOKEN_MAX_AGE = 2 * 60 * 60  # 2h — enough to fill a roster, short enough to limit replay
MAX_FAILURES = 5
LOCKOUT_SECONDS = 15 * 60


def generate_code() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(CODE_LENGTH))


#: A replaced code keeps working this long, so re-issuing one to make it
#: readable never strands a school that is holding the emailed original.
GRACE_DAYS = 7


def set_team_code(inst: Institution, code: str, *, grace_days: int = GRACE_DAYS) -> None:
    """Put ``code`` on ``inst``: hash it for auth, encrypt it for reading back,
    and keep the code it replaces alive for ``grace_days``.

    The grace window is what makes "show me the codes" safe on a running
    event. Every already-issued code is an Argon2 hash with no plaintext
    anywhere, so the only way to display one is to mint a new one — and
    without grace that would lock out a school mid-registration, which is
    exactly the school most likely to be typing its code right now."""
    prev_hash = inst.team_code_hash
    inst.team_code_hash = make_password(code)
    inst.team_code_enc = encrypt_for(_CODE_PURPOSE, code)
    if prev_hash and grace_days > 0:
        inst.team_code_prev_hash = prev_hash
        inst.team_code_prev_until = timezone.now() + timedelta(days=grace_days)
    else:
        inst.team_code_prev_hash = ""
        inst.team_code_prev_until = None
    inst.save(update_fields=[
        "team_code_hash", "team_code_enc",
        "team_code_prev_hash", "team_code_prev_until", "updated_at",
    ])
    # A school locked out while trying the OLD code must not inherit that
    # lockout on the new one (the lens pass flow already did this; we did not).
    cache.delete(_fail_key(inst.id))
    cache.delete(_lock_key(inst.id))


def read_team_code(inst: Institution) -> str:
    """The institution's current code if it is readable, else ``""``.

    Empty means "issued before codes were readable, and unrecoverable" — the
    admin panel says exactly that rather than pretending the school has none."""
    return decrypt_for(_CODE_PURPOSE, inst.team_code_enc or "")


def issue_team_access_codes(
    *, tournament, form, only_missing: bool = True, institution_ids=None,
    request=None, actor=None, send_email: bool = True,
    only_unreadable: bool = False,
) -> dict:
    """Generate + email an access code to active institution contacts.

    ``only_missing`` skips institutions that already hold a code (so a re-run
    after late registrations never invalidates codes already in inboxes);
    pass False to rotate. ``institution_ids`` (optional) restricts to a chosen
    set AND forces a fresh code for each (an explicit per-school send/resend).
    ``send_email=False`` mints without mailing — used by "make the codes
    readable", where the host is about to read them out themselves and a
    second email would only confuse a school that already has one.
    ``only_unreadable`` skips schools whose code can ALREADY be read back, so
    pressing "make them readable" twice churns nobody's code.
    Returns counts for the admin UI."""
    qs = Institution.objects.filter(
        tournament=tournament, deleted_at__isnull=True
    ).exclude(status__in=["withdrawn", "rejected"])
    if institution_ids:
        qs = qs.filter(id__in=list(institution_ids))
        only_missing = False  # an explicit pick always (re)issues
    sent, no_email, skipped, failed, minted = 0, 0, 0, 0, 0
    no_email_institutions: list[dict] = []
    failed_institutions: list[dict] = []
    base = getattr(django_settings, "PUBLIC_BASE_URL", "https://fixture.doxaed.com")
    url = f"{base}/f/{form.id}"
    for inst in qs:
        if only_missing and inst.team_code_hash:
            skipped += 1
            continue
        if only_unreadable and read_team_code(inst):
            skipped += 1
            continue
        if send_email and not (inst.contact_email or "").strip():
            no_email += 1
            # Surfaced to the admin: add an email manually, or mint that
            # school a temporary edit link so they fix their own details.
            no_email_institutions.append({"id": str(inst.id), "name": inst.name})
            continue
        code = generate_code()
        set_team_code(inst, code)
        minted += 1
        if not send_email:
            # Minted to be read on screen, not mailed. `team_code_sent_at` is
            # deliberately left alone: it means "the mail left", and no mail
            # left here.
            continue
        # C21: sent_at is stamped ONLY when the mail actually left — a failed
        # send used to be shown as delivered. Outcome lands in the email
        # ledger either way.
        from apps.accounts.services.mailer import send_branded_email

        delivered = send_branded_email(
            subject=f"{tournament.name} · team registration code for {inst.name}",
            to=inst.contact_email.strip(),
            template="team_access_code",
            context={
                "tournament_name": tournament.name,
                "institution_name": inst.name,
                "contact_name": inst.contact_name or inst.name,
                "form_url": url,
                "code": code,
            },
            fail_silently=True,
        )
        if delivered:
            inst.team_code_sent_at = timezone.now()
            inst.save(update_fields=["team_code_sent_at", "updated_at"])
            sent += 1
        else:
            failed += 1
            failed_institutions.append({"id": str(inst.id), "name": inst.name})
        emit_audit(
            actor_user=actor,
            actor_role=ActorRole.SYSTEM if actor is None else ActorRole.ADMIN,
            event_type="email_sent" if delivered else "email_failed",
            target_type="institution",
            target_id=inst.id,
            organization_id=tournament.organization_id,
            tournament_id=tournament.id,
            payload_after={
                "kind": "team_access_code", "to": inst.contact_email.strip(),
            },
        )
    emit_audit(
        actor_user=actor,
        actor_role=ActorRole.SYSTEM if actor is None else ActorRole.ADMIN,
        event_type="team_access_codes_issued",
        target_type="tournament",
        target_id=tournament.id,
        organization_id=tournament.organization_id,
        payload_after={"sent": sent, "failed": failed, "no_email": no_email,
                       "skipped": skipped, "minted": minted,
                       "emailed": send_email, "form_id": str(form.id)},
        request=request,
    )
    return {
        "sent": sent,
        "failed": failed,
        "no_email": no_email,
        "skipped": skipped,
        "minted": minted,
        "no_email_institutions": no_email_institutions,
        "failed_institutions": failed_institutions,
    }


def _lock_key(inst_id) -> str:
    return f"team-access-lock:{inst_id}"


def _fail_key(inst_id) -> str:
    return f"team-access-fails:{inst_id}"


def _grace_open(inst: Institution) -> bool:
    return bool(
        inst.team_code_prev_hash
        and inst.team_code_prev_until
        and inst.team_code_prev_until > timezone.now()
    )


def verify_team_code(inst: Institution, code: str) -> tuple[bool, str | None]:
    """Constant-time code check with per-institution lockout.

    Returns ``(ok, error_code)`` — error is ``locked`` or ``invalid_code``."""
    if cache.get(_lock_key(inst.id)):
        return False, "locked"
    attempt = (code or "").strip().upper()
    ok = bool(inst.team_code_hash) and check_password(attempt, inst.team_code_hash)
    if not ok and _grace_open(inst):
        # The code this one replaced, still inside its window. Costs one extra
        # Argon2 verify on the miss path only, behind a 15/hour IP throttle.
        ok = check_password(attempt, inst.team_code_prev_hash)
    if not ok:
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
