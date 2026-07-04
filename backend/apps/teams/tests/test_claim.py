"""P4 — claim-your-school: registrant contact graduates to operator tenant."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.utils import timezone
from rest_framework.test import APIClient

from apps.organizations.models import Organization, OrganizationMembership, OrgKind
from apps.teams.models import Institution, SchoolProfile
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db

CODE = "ABCD2345"


def _setup():
    organizer = User.objects.create_user(
        email="organizer-claim@test.local", password="FixtureDemo2026!",
        is_active=True,
    )
    organizer.email_verified_at = timezone.now()
    organizer.save(update_fields=["email_verified_at"])
    t = create_tournament(user=organizer, name="Claim Cup")
    profile = SchoolProfile.objects.create(
        name="Alpha School", normalized_name="alpha school", region="Dimapur",
    )
    inst = Institution.objects.create(
        organization=t.organization, tournament=t, slug="alpha",
        name="Alpha School", region="Dimapur",
        contact_email="head@alpha.test",
        team_code_hash=make_password(CODE),
        school_profile=profile,
    )
    claimant = User.objects.create_user(
        email="head@alpha.test", password="FixtureDemo2026!", is_active=True,
    )
    claimant.email_verified_at = timezone.now()
    claimant.save(update_fields=["email_verified_at"])
    return t, inst, profile, claimant


def test_claim_mints_operator_org_and_is_idempotent():
    _t, inst, profile, claimant = _setup()
    c = APIClient()
    c.force_authenticate(user=claimant)

    r = c.post(f"/api/institutions/{inst.id}:claim/", {"code": CODE},
               format="json")
    assert r.status_code == 201
    org = Organization.objects.get(id=r.data["organization_id"])
    assert org.kind == OrgKind.INSTITUTION
    assert org.school_profile_id == profile.id
    assert org.is_listed is False  # visibility is a later deliberate switch
    m = OrganizationMembership.objects.get(organization=org, user=claimant)
    assert m.is_org_owner and m.role == "admin"

    # Same claimant again: same org back, no duplicate tenant.
    r2 = c.post(f"/api/institutions/{inst.id}:claim/", {"code": CODE},
                format="json")
    assert r2.status_code == 201
    assert r2.data["organization_id"] == str(org.id)


def test_claim_guards():
    _t, inst, _profile, claimant = _setup()
    c = APIClient()
    c.force_authenticate(user=claimant)

    # Wrong code: refused (and the lockout machinery applies).
    r = c.post(f"/api/institutions/{inst.id}:claim/", {"code": "WRONG123"},
               format="json")
    assert r.status_code == 400

    # A DIFFERENT user with the right code after a successful claim: loud
    # conflict, never a silent merge.
    c.post(f"/api/institutions/{inst.id}:claim/", {"code": CODE}, format="json")
    rival = User.objects.create_user(
        email="rival@test.local", password="FixtureDemo2026!", is_active=True,
    )
    rival.email_verified_at = timezone.now()
    rival.save(update_fields=["email_verified_at"])
    c2 = APIClient()
    c2.force_authenticate(user=rival)
    r = c2.post(f"/api/institutions/{inst.id}:claim/", {"code": CODE},
                format="json")
    assert r.status_code == 400
    assert "already_claimed" in str(r.data["detail"])
