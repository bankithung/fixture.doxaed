"""Institution → Team hierarchy: register_school auto-links/creates institutions
(backward-compatible), idempotency, de-dup, cross-tournament guard, and the
model constraints (unique name per tournament, PROTECT on delete)."""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.db.models import ProtectedError
from django.utils import timezone

from apps.audit.models import AuditEvent
from apps.teams.models import Institution, Team
from apps.teams.services.registration import get_or_create_institution, register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _admin(email="admin@inst.test"):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _teams(*names):
    return [{"name": n, "players": []} for n in names]


def test_legacy_call_creates_and_links_institution():
    t = create_tournament(user=_admin(), name="Cup")
    teams = register_school(
        tournament=t, school_name="Mount Hermon", teams=_teams("U-14 Boys", "U-16 Boys")
    )
    assert len(teams) == 2
    insts = Institution.objects.filter(tournament=t)
    assert insts.count() == 1
    inst = insts.first()
    assert inst.name == "Mount Hermon"
    assert inst.organization_id == t.organization_id  # org-consistency
    for tm in teams:
        assert tm.institution_id == inst.id
        assert tm.school == "Mount Hermon"  # mirror kept in sync


def test_same_school_name_reuses_one_institution():
    t = create_tournament(user=_admin(), name="Cup")
    register_school(tournament=t, school_name="Don Bosco", teams=_teams("A"))
    register_school(tournament=t, school_name="Don Bosco", teams=_teams("B"))
    assert Institution.objects.filter(tournament=t, name="Don Bosco").count() == 1
    assert Team.objects.filter(tournament=t, institution__name="Don Bosco").count() == 2


def test_institution_id_path_links_and_guards_cross_tournament():
    t1 = create_tournament(user=_admin("a@inst.test"), name="T1")
    t2 = create_tournament(user=_admin("b@inst.test"), name="T2")
    inst1 = get_or_create_institution(tournament=t1, name="School X")
    # linking teams in t1 to inst1 works
    teams = register_school(
        tournament=t1, school_name="ignored", teams=_teams("X1"), institution_id=inst1.id
    )
    assert teams[0].institution_id == inst1.id
    # an institution from another tournament is rejected
    with pytest.raises(ValueError, match="institution_not_in_tournament"):
        register_school(
            tournament=t2, school_name="y", teams=_teams("Y1"), institution_id=inst1.id
        )


def test_idempotent_replay_no_duplicate_institution():
    t = create_tournament(user=_admin(), name="Cup")
    eid = uuid.uuid4()
    first = register_school(
        tournament=t, school_name="Loyola", teams=_teams("A", "B"), event_id=eid
    )
    again = register_school(
        tournament=t, school_name="Loyola", teams=_teams("A", "B"), event_id=eid
    )
    assert {tm.id for tm in first} == {tm.id for tm in again}  # replay returns same
    assert Institution.objects.filter(tournament=t, name="Loyola").count() == 1
    assert Team.objects.filter(tournament=t, deleted_at__isnull=True).count() == 2
    assert AuditEvent.objects.filter(
        event_type="school_registered", idempotency_key=eid
    ).count() == 1


def test_get_or_create_institution_idempotent_and_blank():
    t = create_tournament(user=_admin(), name="Cup")
    a = get_or_create_institution(tournament=t, name="Carmel")
    b = get_or_create_institution(tournament=t, name="Carmel")
    assert a.id == b.id
    assert get_or_create_institution(tournament=t, name="   ") is None


def test_unique_institution_name_per_tournament():
    t = create_tournament(user=_admin(), name="Cup")
    get_or_create_institution(tournament=t, name="Unique High")
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            Institution.objects.create(
                organization=t.organization, tournament=t, slug="dup",
                name="Unique High",
            )


def test_same_name_allowed_in_different_tournament():
    a = create_tournament(user=_admin("a2@inst.test"), name="T1")
    b = create_tournament(user=_admin("b2@inst.test"), name="T2")
    i1 = get_or_create_institution(tournament=a, name="Shared Name")
    i2 = get_or_create_institution(tournament=b, name="Shared Name")
    assert i1.id != i2.id  # tournament-scoped, no collision


def test_protect_institution_with_teams():
    t = create_tournament(user=_admin(), name="Cup")
    register_school(tournament=t, school_name="Protected", teams=_teams("A"))
    inst = Institution.objects.get(tournament=t, name="Protected")
    with pytest.raises(ProtectedError):
        inst.delete()  # has teams -> PROTECT


# --------------------------------------------------------------------------- API
def _client(user):
    from rest_framework.test import APIClient

    c = APIClient()
    c.force_authenticate(user=user)
    return c


def test_api_admin_add_and_list_institutions():
    admin = _admin()
    t = create_tournament(user=admin, name="Cup")
    r = _client(admin).post(
        f"/api/tournaments/{t.id}/institutions/",
        {"name": "Greenwood High", "kind": "school", "region": "Kohima",
         "contact_email": "head@greenwood.edu"},
        format="json",
    )
    assert r.status_code == 201, r.content
    assert r.json()["name"] == "Greenwood High"
    lst = _client(admin).get(f"/api/tournaments/{t.id}/institutions/").json()
    assert any(i["name"] == "Greenwood High" and i["team_count"] == 0 for i in lst)


def test_api_institution_isolation_and_manager_gate():
    owner = _admin("o@inst.test")
    t = create_tournament(user=owner, name="Cup")
    outsider = _admin("x@inst.test")
    # outsider: 404 (no existence leak)
    assert _client(outsider).get(
        f"/api/tournaments/{t.id}/institutions/"
    ).status_code == 404
    assert _client(outsider).post(
        f"/api/tournaments/{t.id}/institutions/", {"name": "X"}, format="json"
    ).status_code == 404


def test_api_patch_withdraw_institution():
    admin = _admin()
    t = create_tournament(user=admin, name="Cup")
    inst = get_or_create_institution(tournament=t, name="WD High")
    r = _client(admin).patch(
        f"/api/tournaments/{t.id}/institutions/{inst.id}/",
        {"status": "withdrawn"}, format="json",
    )
    assert r.status_code == 200, r.content
    inst.refresh_from_db()
    assert inst.status == "withdrawn"


def test_api_admin_add_team_under_institution():
    admin = _admin()
    t = create_tournament(user=admin, name="Cup")
    inst = get_or_create_institution(tournament=t, name="Hosting High")
    r = _client(admin).post(
        f"/api/tournaments/{t.id}/teams/",
        {"institution_id": str(inst.id), "name": "U-16 Boys", "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 201, r.content
    team = Team.objects.get(tournament=t, name="U-16 Boys")
    assert team.institution_id == inst.id


def test_copyable_lists_templates_and_copy_from_populates_form():
    from apps.forms.models import Form

    admin = _admin()
    t = create_tournament(user=admin, name="Cup")
    blank = Form.objects.create(
        organization=t.organization, tournament=t, slug="blank", title="Blank",
        purpose="organization_registration", status="draft",
        schema={"version": 1, "sections": []},
    )
    c = _client(admin)

    r = c.get("/api/forms/copyable/")
    assert r.status_code == 200, r.content
    assert any(tpl["id"].startswith("template:") for tpl in r.json()["templates"])

    r2 = c.post(
        f"/api/forms/{blank.id}:copy-from/",
        {"template_id": "template:institution-registration"}, format="json",
    )
    assert r2.status_code == 200, r2.content
    blank.refresh_from_db()
    assert blank.schema["sections"]  # populated from the template
    assert blank.settings.get("bindings", {}).get("institution_name")


def test_auto_generate_team_form_and_multi_category_mapping():
    from apps.forms.models import Form, FormResponse
    from apps.forms.services.generation import generate_team_form_template
    from apps.forms.services.mapping import map_response

    admin = _admin()
    t = create_tournament(user=admin, name="Cup")
    Form.objects.create(
        organization=t.organization, tournament=t, slug="org", title="Org",
        purpose="organization_registration", stage="org_registration", status="open",
        schema={"sections": [{"key": "s", "title": "S", "fields": [
            {"key": "categories", "type": "multi_choice", "label": "Categories",
             "options": ["U14", "U16"]},
        ]}]},
    )
    inst = get_or_create_institution(tournament=t, name="Hilltop School")

    team = generate_team_form_template(tournament=t, created_by=admin)
    assert team.purpose == "team_registration" and team.stage == "team_registration"
    keys = [s["key"] for s in team.schema["sections"]]
    assert "institution" in keys and any(k.startswith("cat_") for k in keys)
    cg = team.settings["bindings"]["category_groups"]
    assert len(cg) == 2

    # A school that selected only U14 submits two teams.
    u14 = next(c for c in cg if c["category"] == "U14")
    resp = FormResponse.objects.create(
        form=team, organization=t.organization, tournament=t,
        answers={
            "institution_id": str(inst.id),
            "categories": ["U14"],
            u14["group"]: [{u14["team_name"]: "Hilltop A"}, {u14["team_name"]: "Hilltop B"}],
        },
    )
    map_response(resp)
    made = Team.objects.filter(tournament=t, institution=inst, deleted_at__isnull=True)
    assert made.count() == 2
    assert set(made.values_list("pool", flat=True)) == {"U14"}


def test_form_create_rejects_invalid_stage():
    admin = _admin()
    t = create_tournament(user=admin, name="Cup")
    c = _client(admin)
    bad = c.post(
        f"/api/tournaments/{t.id}/forms/",
        {"title": "X", "purpose": "organization_registration", "stage": "bogus_stage"},
        format="json",
    )
    assert bad.status_code == 400, bad.content
    ok = c.post(
        f"/api/tournaments/{t.id}/forms/",
        {"title": "Y", "purpose": "organization_registration", "stage": "org_registration"},
        format="json",
    )
    assert ok.status_code == 201


def test_org_registration_whitespace_name_falls_back_not_none():
    from apps.forms.models import Form, FormResponse
    from apps.forms.services.mapping import map_response

    t = create_tournament(user=_admin(), name="Cup")
    form = Form.objects.create(
        organization=t.organization, tournament=t, slug="org", title="Org",
        purpose="organization_registration", stage="org_registration", status="open",
        schema={"sections": []},
    )
    resp = FormResponse.objects.create(
        form=form, organization=t.organization, tournament=t,
        answers={"institution_name": "   "}, title="   ",
    )
    map_response(resp)
    resp.refresh_from_db()
    # Whitespace-only name must NOT silently yield institution_id=None.
    assert resp.mapped_entities["institution_id"] is not None
    inst = Institution.objects.get(id=resp.mapped_entities["institution_id"])
    assert inst.name == "Institution"


def test_team_form_institution_field_is_live_data_bound():
    """The auto-gen team form's "select your institution" field is populated from
    the CURRENT institutions when the public form is fetched (not a snapshot)."""
    from rest_framework.test import APIClient

    from apps.forms.services.generation import generate_team_form_template

    admin = _admin()
    t = create_tournament(user=admin, name="Cup")
    inst = get_or_create_institution(tournament=t, name="Late Joiner High")
    team = generate_team_form_template(tournament=t, created_by=admin)
    # publish so the public endpoint serves it
    _client(admin).post(f"/api/forms/{team.id}:publish/")

    payload = APIClient().get(f"/api/forms/{team.id}/public/").json()
    inst_field = next(
        f
        for s in payload["form"]["schema"]["sections"]
        for f in s["fields"]
        if f["key"] == "institution_id"
    )
    values = [o["value"] for o in inst_field["options"]]
    assert str(inst.id) in values  # live-bound, not empty


def test_public_directory_lists_institutions_with_dynamic_filters():
    from rest_framework.test import APIClient

    from apps.forms.models import Form, FormResponse
    from apps.forms.services.mapping import map_response

    t = create_tournament(user=_admin(), name="Cup")
    form = Form.objects.create(
        organization=t.organization, tournament=t, slug="org", title="Org reg",
        purpose="organization_registration", stage="org_registration", status="open",
        schema={"sections": [{"key": "s", "title": "S", "fields": [
            {"key": "sport", "type": "single_choice", "label": "Sport",
             "options": ["Football", "Cricket"]},
        ]}]},
    )
    resp = FormResponse.objects.create(
        form=form, organization=t.organization, tournament=t,
        answers={"institution_name": "Green High", "sport": "Football",
                 "contact_email": "x@green.edu"},
        title="Green High",
    )
    map_response(resp)

    r = APIClient().get(f"/api/forms/{form.id}/directory/")  # no auth — public
    assert r.status_code == 200, r.content
    body = r.json()
    assert body["count"] == 1
    assert any(f["key"] == "sport" for f in body["filters"])
    e = body["entries"][0]
    assert e["name"] == "Green High" and e["values"].get("sport") == "Football"
    assert "contact_email" not in e["values"]  # private fields excluded


def test_org_registration_form_creates_institution():
    from apps.forms.models import Form, FormResponse
    from apps.forms.services.mapping import map_response

    t = create_tournament(user=_admin(), name="Cup")
    form = Form.objects.create(
        organization=t.organization, tournament=t, slug="org", title="Org reg",
        purpose="organization_registration", status="open", schema={"sections": []},
    )
    resp = FormResponse.objects.create(
        form=form, organization=t.organization, tournament=t,
        answers={"institution_name": "Riverside College", "kind": "college",
                 "contact_email": "admin@riverside.edu"},
        title="Riverside College",
    )
    map_response(resp)
    resp.refresh_from_db()
    inst = Institution.objects.get(tournament=t, name="Riverside College")
    assert resp.mapped_entities["institution_id"] == str(inst.id)
    assert inst.source_response_id == resp.id
    assert inst.kind == "college"
    assert inst.contact_email == "admin@riverside.edu"
    # replay is idempotent — no duplicate
    map_response(resp)
    assert Institution.objects.filter(tournament=t, name="Riverside College").count() == 1
