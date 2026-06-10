"""Tournament multi-sport selection: GET/PUT /api/tournaments/{id}/sports/."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.tournaments.models import (
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
)
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _client(user):
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def test_manager_sets_and_reads_sports():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Multi")

    resp = _client(admin).put(
        f"/api/tournaments/{t.id}/sports/",
        {"sports": [
            {"name": "Football"},
            {"key": "sepak_takraw", "name": "Sepak Takraw"},
            {"name": "   "},          # blank -> dropped
            {"name": "Football"},      # duplicate -> dropped
            {"name": "My Custom Sport", "custom": True},
        ]},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    sports = resp.json()["sports"]
    assert [s["name"] for s in sports] == [
        "Football", "Sepak Takraw", "My Custom Sport",
    ]
    assert sports[0]["key"] == "football"
    assert sports[2]["custom"] is True

    # GET returns the saved list.
    g = _client(admin).get(f"/api/tournaments/{t.id}/sports/")
    assert g.status_code == 200
    assert g.json()["sports"] == sports


def test_non_manager_member_cannot_set_sports():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Multi")
    ref = _verified("ref@test.local")
    TournamentMembership.objects.create(
        user=ref, tournament=t, role=TournamentMembershipRole.REFEREE,
        status=TournamentMembershipStatus.ACTIVE,
    )
    resp = _client(ref).put(
        f"/api/tournaments/{t.id}/sports/", {"sports": [{"name": "X"}]}, format="json"
    )
    assert resp.status_code == 403
    # referee CAN read (any member).
    assert _client(ref).get(f"/api/tournaments/{t.id}/sports/").status_code == 200


def test_outsider_cannot_access_sports():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Multi")
    outsider = _verified("z@test.local")
    assert _client(outsider).get(f"/api/tournaments/{t.id}/sports/").status_code == 404
    assert (
        _client(outsider)
        .put(f"/api/tournaments/{t.id}/sports/", {"sports": []}, format="json")
        .status_code
        == 404
    )


def test_put_rejects_non_list():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Multi")
    resp = _client(admin).put(
        f"/api/tournaments/{t.id}/sports/", {"sports": "football"}, format="json"
    )
    assert resp.status_code == 400


def test_categories_and_subcategories_preserved():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Multi")
    _client(admin).put(
        f"/api/tournaments/{t.id}/sports/",
        {"sports": [
            {"name": "Football", "categories": [
                {"name": "U-14", "subcategories": ["5v5", "11v11", "5v5"]},  # dup sub dropped
                {"name": "U-14"},   # dup category dropped
                "U-16",             # legacy string -> object
            ]},
        ]},
        format="json",
    )
    sports = _client(admin).get(f"/api/tournaments/{t.id}/sports/").json()["sports"]
    assert sports[0]["categories"] == [
        {"name": "U-14", "subcategories": ["5v5", "11v11"]},
        {"name": "U-16", "subcategories": []},
    ]


def test_generate_institution_form_branches_subcategories():
    """W2-A: subcategories become a follow-up question revealed by the parent
    pick (progressive disclosure), not flattened labels in one field."""
    from apps.forms.services.generation import generate_institution_form
    from apps.forms.services.schema import validate_schema

    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Multi")
    t.sports = [
        {"key": "football", "name": "Football", "categories": [
            {"name": "U-14", "subcategories": ["5v5", "11v11"]},
        ]},
        {"key": "sepak_takraw", "name": "Sepak Takraw", "categories": [
            {"name": "U-14 Boys", "subcategories": []},
        ]},
    ]
    t.save(update_fields=["sports"])

    form = generate_institution_form(tournament=t, created_by=admin)
    validate_schema(form.schema)  # generated schema is valid
    assert form.purpose == "organization_registration"
    assert form.stage == "org_registration"
    fields = {f["key"]: f for sec in form.schema["sections"] for f in sec["fields"]}
    assert "sports" in fields
    # top level offers the category; its subcategories live one level deeper
    fb = fields["categories_football"]
    assert [o["label"] for o in fb["options"]] == ["U-14"]
    sub = fields["categories_football_u_14"]
    assert [o["label"] for o in sub["options"]] == ["5v5", "11v11"]
    assert sub["visibility"] == {"field": "categories_football",
                                 "op": "includes", "value": "football.u_14"}
    # no subcategories → the category itself is the leaf, single question
    sp_labels = [o["label"] for o in fields["categories_sepak_takraw"]["options"]]
    assert sp_labels == ["U-14 Boys"]


def test_generate_institution_endpoint_manager_only():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Multi")
    t.sports = [{"key": "football", "name": "Football", "categories": ["U-14"]}]
    t.save(update_fields=["sports"])

    r = _client(admin).post(
        f"/api/tournaments/{t.id}/forms/generate-institution/"
    )
    assert r.status_code == 201, r.content

    outsider = _verified("z@test.local")
    r2 = _client(outsider).post(
        f"/api/tournaments/{t.id}/forms/generate-institution/"
    )
    assert r2.status_code == 404


def test_deleting_last_tournament_archives_workspace_and_hides_it():
    """W2: the auto-provisioned workspace org dies with its last tournament —
    no more ghost entries in the org switcher."""
    from apps.organizations.models import OrgStatus

    admin = _verified("ghost@test.local")
    t = create_tournament(user=admin, name="Ghost Cup")
    org = t.organization
    c = _client(admin)

    before = c.get("/api/accounts/me/").json()
    assert any(m["org_slug"] == org.slug for m in before["memberships"])

    assert c.delete(f"/api/tournaments/{t.id}/").status_code == 204
    org.refresh_from_db()
    assert org.status == OrgStatus.ARCHIVED

    after = c.get("/api/accounts/me/").json()
    assert not any(m["org_slug"] == org.slug for m in after["memberships"])
