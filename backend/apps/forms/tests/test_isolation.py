"""Cross-org isolation — outsiders get 404 with no existence leak (invariant #2)."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.forms.models import Form
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def test_outsider_cannot_read_form_404():
    owner = _verified("owner@test.local")
    t = create_tournament(user=owner, name="Cup")
    f = Form.objects.create(organization=t.organization, tournament=t, slug="r", title="R")
    outsider = _verified("out@test.local")
    c = APIClient()
    c.force_authenticate(user=outsider)
    assert c.get(f"/api/forms/{f.id}/").status_code == 404
    assert c.patch(f"/api/forms/{f.id}/", {"title": "x"}, format="json").status_code == 404


def test_outsider_cannot_act_on_form_404():
    owner = _verified("owner@test.local")
    t = create_tournament(user=owner, name="Cup")
    f = Form.objects.create(organization=t.organization, tournament=t, slug="r", title="R",
                            schema={"version": 1, "sections": [
                                {"key": "s", "title": "S", "fields": [
                                    {"key": "n", "type": "short_text", "label": "N"}]}]})
    outsider = _verified("out@test.local")
    c = APIClient()
    c.force_authenticate(user=outsider)
    assert c.post(f"/api/forms/{f.id}:publish/", {}, format="json").status_code == 404
    assert c.post(f"/api/forms/{f.id}:close/", {}, format="json").status_code == 404
    assert c.post(f"/api/forms/{f.id}:duplicate/", {}, format="json").status_code == 404
    assert c.delete(f"/api/forms/{f.id}/").status_code == 404


def test_outsider_cannot_list_forms_on_others_tournament():
    owner = _verified("owner@test.local")
    t = create_tournament(user=owner, name="Cup")
    Form.objects.create(organization=t.organization, tournament=t, slug="r", title="R")
    outsider = _verified("out@test.local")
    c = APIClient()
    c.force_authenticate(user=outsider)
    assert c.get(f"/api/tournaments/{t.id}/forms/").status_code == 404


def test_outsider_cannot_create_form_on_others_tournament():
    owner = _verified("owner@test.local")
    t = create_tournament(user=owner, name="Cup")
    outsider = _verified("out@test.local")
    c = APIClient()
    c.force_authenticate(user=outsider)
    r = c.post(f"/api/tournaments/{t.id}/forms/", {"title": "X", "purpose": "generic"},
               format="json")
    assert r.status_code in (403, 404)
