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


def test_regenerate_preserves_custom_fields_and_label_edits():
    """Smart rebuild keeps the admin's current form: a bespoke question and a
    renamed category label both survive, while the category options refresh."""
    admin = _admin("merge@forms.test")
    t = _cup(admin, [{"name": "U15"}])
    form = generate_institution_form(tournament=t, created_by=admin)

    schema = form.schema
    for sec in schema["sections"]:
        if sec["key"] == "school":
            sec["fields"].append(
                {"key": "tshirt", "type": "short_text", "label": "T-shirt size"}
            )
        for f in sec["fields"]:
            if f["key"] == "categories_football":
                f["label"] = "Pick your Football grade"  # admin rename
    form.schema = schema
    form.save(update_fields=["schema"])

    c = _client(admin)
    c.put(
        f"/api/tournaments/{t.id}/sports/",
        {"sports": [{"key": "football", "name": "Football",
                     "nodes": [{"key": "u15", "name": "U15"}, {"name": "U17"}]}]},
        format="json",
    )
    body = c.post(f"/api/forms/{form.id}:regenerate/").json()
    fields = {f["key"]: f for sec in body["schema"]["sections"]
              for f in sec["fields"]}

    # The custom question survives the rebuild...
    assert fields.get("tshirt", {}).get("label") == "T-shirt size"
    # ...the admin's label edit is kept...
    assert fields["categories_football"]["label"] == "Pick your Football grade"
    # ...but its options are refreshed with the newly-added leaf.
    assert [o["value"] for o in fields["categories_football"]["options"]] == [
        "football.u15", "football.u17",
    ]


def test_regenerate_drops_removed_and_adds_new_competitions():
    admin = _admin("merge2@forms.test")
    t = _cup(admin, [{"name": "U15"}, {"name": "U17"}])
    form = generate_institution_form(tournament=t, created_by=admin)

    c = _client(admin)
    # Drop U17, add a whole new sport (Basketball / U19).
    c.put(
        f"/api/tournaments/{t.id}/sports/",
        {"sports": [
            {"key": "football", "name": "Football", "nodes": [{"key": "u15", "name": "U15"}]},
            {"key": "basketball", "name": "Basketball", "nodes": [{"name": "U19"}]},
        ]},
        format="json",
    )
    body = c.post(f"/api/forms/{form.id}:regenerate/").json()
    fields = {f["key"]: f for sec in body["schema"]["sections"]
              for f in sec["fields"]}

    # Removed leaf drops out of the retained question.
    assert [o["value"] for o in fields["categories_football"]["options"]] == [
        "football.u15",
    ]
    # The new sport is selectable and gets its own (newly inserted) question.
    assert {o["value"] for o in fields["sports"]["options"]} == {
        "football", "basketball",
    }
    assert [o["value"] for o in fields["categories_basketball"]["options"]] == [
        "basketball.u19",
    ]


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
