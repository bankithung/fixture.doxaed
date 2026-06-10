"""WS-D: per-institution, prefilled + locked Stage-2 share links.

The team form is admin-built/editable and never identical, so prefill + lock are
BINDING-DRIVEN (keyed off the form's own ``settings['bindings']``), never
hardcoded field names. A bound link locks the institution and pre-fills whatever
identity/contact roles the form declares; the server is authoritative for the
institution on submit.
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.forms.models import FormResponse, FormShareLink
from apps.forms.services.forms import publish_form
from apps.forms.services.generation import generate_team_form_template
from apps.forms.services.links import mint_institution_links
from apps.teams.models import Institution
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _inst(t, name, **kw):
    return Institution.objects.create(
        organization=t.organization, tournament=t,
        slug=name.lower().replace(" ", "-"), name=name, kind="school", **kw,
    )


def _open_team_form(t, admin):
    f = generate_team_form_template(tournament=t, created_by=admin)
    publish_form(f)  # OPEN so token GET/POST resolve
    f.refresh_from_db()
    return f


def test_mint_creates_bound_prefilled_link_per_institution():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    a = _inst(t, "Springfield High", contact_name="Skinner", contact_email="s@spring.edu")
    b = _inst(t, "Shelbyville High")  # no contact
    form = _open_team_form(t, admin)

    res = mint_institution_links(form=form, created_by=admin)
    by_id = {r["institution_id"]: r for r in res}
    assert by_id[str(a.id)]["minted"] is True and by_id[str(a.id)].get("token")
    assert by_id[str(b.id)]["minted"] is True

    links = {
        link.bound_entity["institution_id"]: link
        for link in FormShareLink.objects.filter(form=form)
    }
    # Identity always; contact only when the institution has it (binding-driven).
    assert links[str(a.id)].prefill["institution_id"] == str(a.id)
    assert links[str(a.id)].prefill["contact_email"] == "s@spring.edu"
    assert "contact_email" not in links[str(b.id)].prefill


def test_mint_is_idempotent():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    _inst(t, "Springfield High")
    form = _open_team_form(t, admin)
    mint_institution_links(form=form, created_by=admin)
    second = mint_institution_links(form=form, created_by=admin)
    assert all(r["minted"] is False for r in second)
    assert FormShareLink.objects.filter(form=form).count() == 1


def test_mint_excludes_withdrawn_and_rejected():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    _inst(t, "Active High")
    _inst(t, "Gone High", status="withdrawn")
    form = _open_team_form(t, admin)
    res = mint_institution_links(form=form, created_by=admin)
    assert {r["name"] for r in res} == {"Active High"}


def test_bound_link_get_returns_prefill_and_lock():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    a = _inst(t, "Springfield High", contact_email="s@spring.edu")
    form = _open_team_form(t, admin)
    token = mint_institution_links(form=form, created_by=admin)[0]["token"]

    body = APIClient().get(f"/api/forms/r/{token}/").json()
    assert body["prefill"]["institution_id"] == str(a.id)
    assert body["prefill"]["contact_email"] == "s@spring.edu"
    assert body["locked"] == ["institution_id"]
    assert body["bound"]["label"] == "Springfield High"


def test_bound_link_submit_is_authoritative_for_institution():
    """Even if the client omits/tampers with the locked institution field, the
    server stamps it from the link binding so the submission maps to the right
    school."""
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    a = _inst(t, "Springfield High")
    form = _open_team_form(t, admin)
    token = mint_institution_links(form=form, created_by=admin)[0]["token"]

    p = APIClient().post(
        f"/api/forms/r/{token}/",
        {"answers": {}, "event_id": str(uuid.uuid4())},  # institution omitted
        format="json",
    )
    assert p.status_code in (200, 201), p.content
    resp = FormResponse.objects.filter(form=form).first()
    assert resp is not None
    assert resp.answers.get("institution_id") == str(a.id)


def test_mint_endpoint_manager_only():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    _inst(t, "Springfield High")
    form = _open_team_form(t, admin)

    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.post(f"/api/forms/{form.id}:institution-links/")
    assert r.status_code == 201, r.content
    assert r.json()["minted"] == 1

    outsider = APIClient()
    outsider.force_authenticate(user=_verified("z@test.local"))
    r2 = outsider.post(f"/api/forms/{form.id}:institution-links/")
    assert r2.status_code in (403, 404)  # cross-org: no existence leak
