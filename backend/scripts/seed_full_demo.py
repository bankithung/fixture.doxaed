"""Idempotent full-demo seed for Phase 1A SPA testing.

Run with:  python manage.py shell < scripts/seed_full_demo.py

Creates (or upserts):
  - Organization slug='doxaed', name='DoxaEd Sports', status=active
  - 6 demo users (one per in-org role) all with active membership in
    the doxaed Org, plus consistent passwords for manual login testing.
  - Super-admin (graceschooledu@gmail.com) — created if missing using
    SUPERUSER_EMAIL / SUPERUSER_PASSWORD from .env, with
    ``email_verified_at`` filled and ``has_2fa_enrolled`` synced to
    whatever TOTP devices the SA has actually confirmed (P2 audit fix).
    The SA holds NO Org membership — they live cross-org under /sadmin/.

Demo users created:
  - admin@doxaed.test         | role=admin (is_org_owner=True)
  - coorg@doxaed.test         | role=co_organizer
  - coord@doxaed.test         | role=game_coordinator
  - scorer@doxaed.test        | role=match_scorer
  - referee@doxaed.test       | role=referee
  - manager@doxaed.test       | role=team_manager

Idempotency contract:
  - Re-running fixes drift: passwords are reset, is_active is forced to
    True, email_verified_at is filled if missing, last_active_org_id is
    set to the doxaed Org id.
  - For each user, the canonical (user, org, role) membership is upserted
    to is_active=True. Other roles for the same user are NOT pruned
    here — this script only owns the rows it explicitly creates.

Safe to re-run.
"""
from __future__ import annotations

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from apps.accounts.models import TwoFactorDevice, User
from apps.organizations.models import (
    MembershipRole,
    OrgStatus,
    Organization,
    OrganizationMembership,
)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

ORG_SLUG = "doxaed"
ORG_NAME = "DoxaEd Sports"
ORG_TZ = "Asia/Kolkata"

# (email, password, name, role, is_org_owner)
DEMO_USERS: list[tuple[str, str, str, str, bool]] = [
    ("admin@doxaed.test",   "Admin123!@",   "Admin User",            MembershipRole.ADMIN,            True),
    ("coorg@doxaed.test",   "Coorg123!@",   "Co-organizer User",     MembershipRole.CO_ORGANIZER,     False),
    ("coord@doxaed.test",   "Coord123!@",   "Game-coordinator User", MembershipRole.GAME_COORDINATOR, False),
    ("scorer@doxaed.test",  "Scorer123!@",  "Match-scorer User",     MembershipRole.MATCH_SCORER,     False),
    ("referee@doxaed.test", "Referee123!@", "Referee User",          MembershipRole.REFEREE,          False),
    ("manager@doxaed.test", "Manager123!@", "Team-manager User",     MembershipRole.TEAM_MANAGER,     False),
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def upsert_org() -> tuple[Organization, bool]:
    """Get or create the demo Organization. Force status=active."""
    org, created = Organization.objects.get_or_create(
        slug=ORG_SLUG,
        defaults={
            "name": ORG_NAME,
            "status": OrgStatus.ACTIVE,
            "time_zone": ORG_TZ,
        },
    )
    dirty: list[str] = []
    if org.status != OrgStatus.ACTIVE:
        org.status = OrgStatus.ACTIVE
        dirty.append("status")
    if org.deleted_at is not None:
        org.deleted_at = None
        dirty.append("deleted_at")
    if dirty:
        org.save(update_fields=dirty)
    return org, created


def upsert_user(email: str, password: str, name: str, org: Organization) -> tuple[User, bool]:
    """Idempotently create or update a demo user.

    On re-run this resets the password (so drifted passwords are fixed),
    forces is_active=True, fills email_verified_at if missing, and pins
    last_active_org_id to the demo Org so the SPA bootstrap routes there.
    """
    user = User.objects.filter(email=email.lower()).first()
    created = False
    if user is None:
        user = User.objects.create_user(
            email=email,
            password=password,
            name=name,
            is_active=True,
            email_verified_at=timezone.now(),
        )
        created = True
    else:
        user.is_active = True
        user.name = name
        if user.email_verified_at is None:
            user.email_verified_at = timezone.now()
        user.set_password(password)
        user.save()

    # Always sync last_active_org_id so the SPA lands on the org dashboard.
    if user.last_active_org_id != org.id:
        user.last_active_org_id = org.id
        user.save(update_fields=["last_active_org_id"])

    return user, created


def upsert_super_admin() -> tuple[User | None, bool]:
    """Idempotently ensure the Super-admin user exists and is fully set up.

    Reads ``SUPERUSER_EMAIL`` / ``SUPERUSER_PASSWORD`` from settings (.env).
    If either is missing, returns ``(None, False)`` — running without an
    SA configured is fine for unit tests but means manual logins to
    ``/sadmin/`` won't work until ``createsuperuser`` is run.

    On re-run this fixes drift:
      - sets ``email_verified_at`` if null (P2 audit fix);
      - syncs ``has_2fa_enrolled`` / ``twofa_enrolled_at`` to whatever
        confirmed ``TwoFactorDevice`` rows exist for the SA;
      - keeps ``is_active=True`` and ``is_superuser/is_staff=True``;
      - resets the password to the .env value so credential drift is
        recoverable from a single source of truth.
    """
    email = getattr(settings, "SUPERUSER_EMAIL", None)
    password = getattr(settings, "SUPERUSER_PASSWORD", None)
    if not email or not password:
        return None, False

    email = email.strip().lower()
    user = User.objects.filter(email=email).first()
    created = False
    if user is None:
        user = User.objects.create_superuser(
            email=email,
            password=password,
            email_verified_at=timezone.now(),
        )
        created = True
    else:
        # Drift fixes — preserve identity, fix flags + verification.
        dirty: list[str] = []
        if not user.is_active:
            user.is_active = True
            dirty.append("is_active")
        if not user.is_superuser:
            user.is_superuser = True
            dirty.append("is_superuser")
        if not user.is_staff:
            user.is_staff = True
            dirty.append("is_staff")
        if user.email_verified_at is None:
            user.email_verified_at = timezone.now()
            dirty.append("email_verified_at")
        if user.deleted_at is not None:
            user.deleted_at = None
            dirty.append("deleted_at")
        if dirty:
            user.save(update_fields=dirty)
        # Reset the SA password from .env so drift between env and DB
        # never strands manual /sadmin/ logins.
        user.set_password(password)
        user.save(update_fields=["password"])

    # Sync 2FA flags to actual TOTP enrollment state (P2 audit fix).
    confirmed = (
        TwoFactorDevice.objects.filter(user=user, confirmed_at__isnull=False)
        .order_by("confirmed_at")
        .first()
    )
    has_2fa = confirmed is not None
    enrolled_at = confirmed.confirmed_at if confirmed else None
    twofa_dirty: list[str] = []
    if user.has_2fa_enrolled != has_2fa:
        user.has_2fa_enrolled = has_2fa
        twofa_dirty.append("has_2fa_enrolled")
    if user.twofa_enrolled_at != enrolled_at:
        user.twofa_enrolled_at = enrolled_at
        twofa_dirty.append("twofa_enrolled_at")
    if twofa_dirty:
        user.save(update_fields=twofa_dirty)

    return user, created


def upsert_membership(
    user: User,
    org: Organization,
    role: str,
    is_org_owner: bool,
) -> tuple[OrganizationMembership, bool]:
    """Idempotently upsert (user, org, role) -> is_active=True.

    The DB constraint `unique_active_role_per_user_per_org` covers the
    (user, org, role) tuple while is_active=True, so we key on those
    three columns.
    """
    membership, created = OrganizationMembership.objects.get_or_create(
        user=user,
        organization=org,
        role=role,
        defaults={
            "is_active": True,
            "is_org_owner": is_org_owner,
        },
    )
    dirty: list[str] = []
    if not membership.is_active:
        membership.is_active = True
        dirty.append("is_active")
    if membership.is_org_owner != is_org_owner:
        membership.is_org_owner = is_org_owner
        dirty.append("is_org_owner")
    if membership.removed_at is not None:
        membership.removed_at = None
        dirty.append("removed_at")
    if dirty:
        membership.save(update_fields=dirty)
    return membership, created


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------


def run() -> dict:
    """Idempotent seed entrypoint. Returns a summary dict for callers."""
    summary: dict = {
        "org": None,
        "org_created": False,
        "users_created": [],
        "users_updated": [],
        "memberships_created": [],
        "memberships_updated": [],
        "super_admin": None,
        "super_admin_created": False,
    }

    with transaction.atomic():
        # Super-admin first — independent of the demo Org.
        sa_user, sa_created = upsert_super_admin()
        if sa_user is not None:
            summary["super_admin"] = {
                "email": sa_user.email,
                "email_verified_at": (
                    sa_user.email_verified_at.isoformat()
                    if sa_user.email_verified_at
                    else None
                ),
                "has_2fa_enrolled": sa_user.has_2fa_enrolled,
            }
            summary["super_admin_created"] = sa_created

        org, org_created = upsert_org()
        summary["org"] = {"slug": org.slug, "id": str(org.id), "status": org.status}
        summary["org_created"] = org_created

        for email, password, name, role, is_org_owner in DEMO_USERS:
            user, user_created = upsert_user(email, password, name, org)
            (
                summary["users_created"]
                if user_created
                else summary["users_updated"]
            ).append({"email": user.email, "role": role})

            membership, mem_created = upsert_membership(
                user=user,
                org=org,
                role=role,
                is_org_owner=is_org_owner,
            )
            (
                summary["memberships_created"]
                if mem_created
                else summary["memberships_updated"]
            ).append(
                {
                    "email": user.email,
                    "role": membership.role,
                    "is_org_owner": membership.is_org_owner,
                }
            )

    return summary


# ---------------------------------------------------------------------------
# Script entrypoint (stdin → manage.py shell)
# ---------------------------------------------------------------------------

result = run()

print("OK")
sa = result.get("super_admin")
if sa is None:
    print("  super-admin: SKIPPED (set SUPERUSER_EMAIL / SUPERUSER_PASSWORD in .env)")
else:
    print(
        f"  super-admin: {sa['email']} created={result['super_admin_created']} "
        f"verified={sa['email_verified_at']} 2fa={sa['has_2fa_enrolled']}"
    )
print(f"  org: {result['org']['slug']} ({result['org']['id']}) status={result['org']['status']} created={result['org_created']}")
print(f"  users created   ({len(result['users_created'])}): {[u['email'] for u in result['users_created']]}")
print(f"  users updated   ({len(result['users_updated'])}): {[u['email'] for u in result['users_updated']]}")
print(f"  memberships new ({len(result['memberships_created'])}): {[(m['email'], m['role']) for m in result['memberships_created']]}")
print(f"  memberships upd ({len(result['memberships_updated'])}): {[(m['email'], m['role']) for m in result['memberships_updated']]}")
print()
print("Login passwords (for CREDENTIALS.md reference):")
for email, password, _name, role, _owner in DEMO_USERS:
    print(f"  {email:30s}  role={role:20s}  password={password}")
