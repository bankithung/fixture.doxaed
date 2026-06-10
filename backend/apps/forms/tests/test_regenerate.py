"""Generated-form staleness + regeneration (spec 2026-06-10 P6, invariant 10):
forms stamp an inputs_hash of the sports config at generation; category edits
flip `stale` on the serializer; :regenerate rebuilds the schema from the
CURRENT config; hand-built forms are refused."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.forms.models import Form
from apps.forms.services.generation import generate_institution_form
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()
pytestmark = pytest.mark.django_db


def _admin(email="rg@forms.test"):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _client(user):
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _cup(admin, nodes):
    t = create_tournament(user=admin, name="Hash Cup")
    t.sports = normalize_sports([{"name": "Football", "nodes": nodes}])
    t.save(update_fields=["sports"])
    return t


def test_generated_form_goes_stale_when_categories_change_and_regenerates():
    admin = _admin()
    t = _cup(admin, [{"name": "U15"}])
    form = generate_institution_form(tournament=t, created_by=admin)
    c = _client(admin)

    # fresh: not stale
    listed = c.get(f"/api/tournaments/{t.id}/forms/").json()
    assert listed[0]["stale"] is False

    # category edit → stale
    r = c.put(
        f"/api/tournaments/{t.id}/sports/",
        {"sports": [{"key": "football", "name": "Football",
                     "nodes": [{"key": "u15", "name": "U15"}, {"name": "U17"}]}]},
        format="json",
    )
    assert r.status_code == 200
    listed = c.get(f"/api/tournaments/{t.id}/forms/").json()
    assert listed[0]["stale"] is True

    # regenerate → fresh schema carries the new leaf, stale clears
    rr = c.post(f"/api/forms/{form.id}:regenerate/")
    assert rr.status_code == 200, rr.content
    body = rr.json()
    assert body["stale"] is False
    fields = {f["key"]: f for sec in body["schema"]["sections"]
              for f in sec["fields"]}
    values = [o["value"] for o in fields["categories_football"]["options"]]
    assert values == ["football.u15", "football.u17"]


def test_hand_built_forms_are_never_stale_and_refuse_regenerate():
    admin = _admin("hand@forms.test")
    t = _cup(admin, [{"name": "U15"}])
    form = Form.objects.create(
        organization=t.organization, tournament=t, slug="manual",
        title="Manual", purpose="organization_registration",
        schema={"version": 1, "sections": [{"key": "s", "title": "S", "fields": [
            {"key": "school_name", "type": "short_text", "label": "School"}]}]},
    )
    c = _client(admin)
    listed = c.get(f"/api/tournaments/{t.id}/forms/").json()
    row = next(x for x in listed if x["id"] == str(form.id))
    assert row["stale"] is False
    assert c.post(f"/api/forms/{form.id}:regenerate/").status_code == 400


def test_regenerate_is_manager_or_forms_module_gated():
    admin = _admin("gate@forms.test")
    t = _cup(admin, [{"name": "U15"}])
    form = generate_institution_form(tournament=t, created_by=admin)
    outsider = _admin("noone@forms.test")
    assert _client(outsider).post(
        f"/api/forms/{form.id}:regenerate/"
    ).status_code == 404  # no access → no existence leak
