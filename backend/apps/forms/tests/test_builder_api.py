from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db

SCHEMA = {"version": 1, "sections": [{"key": "s", "title": "S", "fields": [
    {"key": "name", "type": "short_text", "label": "Name", "required": True, "role": "title"}]}]}


def _verified(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def test_create_list_and_publish_form():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    c = APIClient()
    c.force_authenticate(user=admin)

    r = c.post(f"/api/tournaments/{t.id}/forms/",
               {"title": "School registration", "purpose": "organization_registration"},
               format="json")
    assert r.status_code == 201, r.content
    fid = r.json()["id"]

    r = c.patch(f"/api/forms/{fid}/", {"schema": SCHEMA}, format="json")
    assert r.status_code == 200, r.content

    r = c.post(f"/api/forms/{fid}:publish/", {}, format="json")
    assert r.status_code == 200 and r.json()["status"] == "open"

    r = c.get(f"/api/tournaments/{t.id}/forms/")
    assert r.status_code == 200 and len(r.json()) == 1


def test_publish_empty_form_is_rejected():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.post(f"/api/tournaments/{t.id}/forms/",
               {"title": "Empty", "purpose": "generic"}, format="json")
    fid = r.json()["id"]
    r = c.post(f"/api/forms/{fid}:publish/", {}, format="json")
    assert r.status_code == 400


def test_patch_invalid_schema_400():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.post(f"/api/tournaments/{t.id}/forms/",
               {"title": "X", "purpose": "generic"}, format="json")
    fid = r.json()["id"]
    bad = {"version": 1, "sections": [{"key": "s", "title": "S", "fields": [
        {"key": "k", "type": "wat", "label": "A"}]}]}
    r = c.patch(f"/api/forms/{fid}/", {"schema": bad}, format="json")
    assert r.status_code == 400


def test_close_and_duplicate():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.post(f"/api/tournaments/{t.id}/forms/",
               {"title": "Reg", "purpose": "generic", "schema": SCHEMA}, format="json")
    fid = r.json()["id"]
    c.post(f"/api/forms/{fid}:publish/", {}, format="json")

    r = c.post(f"/api/forms/{fid}:close/", {}, format="json")
    assert r.status_code == 200 and r.json()["status"] == "closed"

    r = c.post(f"/api/forms/{fid}:duplicate/", {}, format="json")
    assert r.status_code == 201
    assert r.json()["id"] != fid and r.json()["status"] == "draft"
    # both forms now visible in the list
    r = c.get(f"/api/tournaments/{t.id}/forms/")
    assert len(r.json()) == 2


def test_soft_delete_form():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.post(f"/api/tournaments/{t.id}/forms/",
               {"title": "Reg", "purpose": "generic"}, format="json")
    fid = r.json()["id"]
    assert c.delete(f"/api/forms/{fid}/").status_code == 204
    assert c.get(f"/api/forms/{fid}/").status_code == 404
    assert len(c.get(f"/api/tournaments/{t.id}/forms/").json()) == 0


def test_field_types_catalog_is_public_to_authed():
    admin = _verified("a@test.local")
    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.get("/api/forms/field-types/")
    assert r.status_code == 200
    assert any(ft["type"] == "single_choice" for ft in r.json())
    sc = next(ft for ft in r.json() if ft["type"] == "single_choice")
    assert sc["has_options"] is True
