from __future__ import annotations

import io
import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.forms.models import Form, FormFileUpload, FormResponse
from apps.forms.services.links import create_share_link
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db

SCHEMA = {"version": 1, "sections": [{"key": "s", "title": "S", "fields": [
    {"key": "school", "type": "short_text", "label": "School", "required": True, "role": "title"},
    {"key": "email", "type": "email", "label": "Email", "required": True, "role": "email"}]}]}


def _verified(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _open_form(t):
    return Form.objects.create(
        organization=t.organization, tournament=t, slug="r", title="Reg",
        schema=SCHEMA, status="open", opens_at=timezone.now(),
        confirmation_message="Thanks!")


def test_public_get_open_form_and_submit():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = _open_form(t)
    c = APIClient()  # public
    g = c.get(f"/api/forms/{f.id}/public/")
    assert g.status_code == 200 and g.json()["form"]["title"] == "Reg"

    p = c.post(f"/api/forms/{f.id}/public/",
               {"answers": {"school": "MH", "email": "a@b.com"}, "event_id": str(uuid.uuid4())},
               format="json")
    assert p.status_code == 201, p.content
    body = p.json()
    assert "response_id" in body and body["message"] == "Thanks!"


def test_public_get_closed_form_returns_closed():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = Form.objects.create(organization=t.organization, tournament=t, slug="r", title="Reg",
                            schema=SCHEMA, status="draft")
    c = APIClient()
    g = c.get(f"/api/forms/{f.id}/public/")
    assert g.status_code == 200 and g.json().get("closed") is True


def test_closed_org_form_exposes_directory():
    """A closed institution-registration form points the public at its directory
    of registered institutions instead of being a dead end."""
    t = create_tournament(user=_verified("b@test.local"), name="Cup")
    f = Form.objects.create(
        organization=t.organization, tournament=t, slug="orgreg", title="Org reg",
        purpose="organization_registration", stage="org_registration",
        schema=SCHEMA, status="closed",
    )
    body = APIClient().get(f"/api/forms/{f.id}/public/").json()
    assert body["closed"] is True
    assert body["has_directory"] is True
    assert body["form_id"] == str(f.id)


def test_public_submit_to_closed_form_400():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = Form.objects.create(organization=t.organization, tournament=t, slug="r", title="Reg",
                            schema=SCHEMA, status="draft")
    c = APIClient()
    p = c.post(f"/api/forms/{f.id}/public/",
               {"answers": {"school": "MH", "email": "a@b.com"}}, format="json")
    assert p.status_code == 400


def test_public_submit_invalid_answer_400():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = _open_form(t)
    c = APIClient()
    p = c.post(f"/api/forms/{f.id}/public/",
               {"answers": {"school": "MH", "email": "not-email"}}, format="json")
    assert p.status_code == 400


def test_public_get_missing_form_404():
    c = APIClient()
    g = c.get(f"/api/forms/{uuid.uuid4()}/public/")
    assert g.status_code == 404


def test_public_submit_via_token():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = _open_form(t)
    link, token = create_share_link(form=f)
    c = APIClient()
    g = c.get(f"/api/forms/r/{token}/")
    assert g.status_code == 200 and g.json()["form"]["title"] == "Reg"

    p = c.post(f"/api/forms/r/{token}/",
               {"answers": {"school": "MH", "email": "a@b.com"}, "event_id": str(uuid.uuid4())},
               format="json")
    assert p.status_code == 201, p.content
    resp = FormResponse.objects.get(id=p.json()["response_id"])
    assert resp.submitted_via_id == link.id
    link.refresh_from_db()
    assert link.submission_count == 1


def test_public_get_invalid_token_404():
    c = APIClient()
    g = c.get("/api/forms/r/not-a-real-token/")
    assert g.status_code == 404


def test_upload_accepts_pdf_and_submit_claims_it():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = _open_form(t)
    c = APIClient()
    pdf = io.BytesIO(b"%PDF-1.4 dummy")
    pdf.name = "roster.pdf"
    u = c.post(f"/api/forms/{f.id}/uploads/",
               {"file": pdf, "field_key": "doc"}, format="multipart")
    assert u.status_code == 201, u.content
    upload_ref = u.json()["upload_ref"]
    assert FormFileUpload.objects.filter(upload_ref=upload_ref, response__isnull=True).exists()

    p = c.post(f"/api/forms/{f.id}/public/",
               {"answers": {"school": "MH", "email": "a@b.com"},
                "event_id": str(uuid.uuid4()), "upload_refs": {"doc": upload_ref}},
               format="json")
    assert p.status_code == 201, p.content
    resp = FormResponse.objects.get(id=p.json()["response_id"])
    assert FormFileUpload.objects.filter(upload_ref=upload_ref, response=resp).exists()


def test_upload_rejects_unsupported_type():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = _open_form(t)
    c = APIClient()
    bad = io.BytesIO(b"#!/bin/sh\necho hi")
    bad.name = "evil.sh"
    u = c.post(f"/api/forms/{f.id}/uploads/",
               {"file": bad, "field_key": "doc", "content_type": "application/x-sh"},
               format="multipart")
    assert u.status_code == 400


def test_upload_to_closed_form_404():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = Form.objects.create(organization=t.organization, tournament=t, slug="r", title="Reg",
                            schema=SCHEMA, status="draft")
    c = APIClient()
    pdf = io.BytesIO(b"%PDF-1.4 dummy")
    pdf.name = "roster.pdf"
    u = c.post(f"/api/forms/{f.id}/uploads/",
               {"file": pdf, "field_key": "doc"}, format="multipart")
    assert u.status_code == 404
