"""TDD — responses list/export/status + Stage-2 link minting (Increment 5, 5.2).

Plus the REQUIRED end-to-end idempotency test that drives the PUBLIC submit flow
for a ``team_registration`` form WITH an ``event_id`` to prove the audit-key
collision + double-map are handled (submit + audit + mapping all idempotent).
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.forms.models import Form, FormResponse, FormShareLink
from apps.teams.models import Team
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _setup():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    f = Form.objects.create(organization=t.organization, tournament=t, slug="r", title="R",
                            purpose="organization_registration")
    FormResponse.objects.create(form=f, organization=t.organization, tournament=t,
                                title="MH", respondent_email="a@b.com")
    return admin, t, f


def test_list_and_csv_export():
    admin, _t, f = _setup()
    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.get(f"/api/forms/{f.id}/responses/")
    assert r.status_code == 200
    assert len(r.json()) == 1
    csv = c.get(f"/api/forms/{f.id}/responses/?export=csv")
    assert csv.status_code == 200 and csv["Content-Type"].startswith("text/csv")
    assert b"MH" in csv.content


def test_csv_includes_schema_field_columns():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    schema = {"version": 1, "sections": [{"key": "s", "title": "S", "fields": [
        {"key": "school", "type": "short_text", "label": "School", "role": "title"},
        {"key": "note", "type": "section_text", "label": "Read me"},
        {"key": "size", "type": "number", "label": "Size"}]}]}
    f = Form.objects.create(organization=t.organization, tournament=t, slug="r", title="R",
                            purpose="organization_registration", schema=schema)
    FormResponse.objects.create(form=f, organization=t.organization, tournament=t,
                                title="MH", answers={"school": "MH", "size": 11})
    c = APIClient()
    c.force_authenticate(user=admin)
    csv = c.get(f"/api/forms/{f.id}/responses/?export=csv")
    body = csv.content.decode()
    header = body.splitlines()[0]
    # schema field keys present; display-only section_text excluded
    assert "school" in header and "size" in header
    assert "note" not in header
    assert "11" in body


def test_accept_response():
    admin, _t, f = _setup()
    rid = FormResponse.objects.filter(form=f).first().id
    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.patch(f"/api/forms/{f.id}/responses/{rid}/", {"status": "accepted"}, format="json")
    assert r.status_code == 200 and r.json()["status"] == "accepted"


@pytest.mark.parametrize("status", ["accepted", "rejected", "waitlisted", "submitted"])
def test_status_transitions_valid(status):
    admin, _t, f = _setup()
    rid = FormResponse.objects.filter(form=f).first().id
    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.patch(f"/api/forms/{f.id}/responses/{rid}/", {"status": status}, format="json")
    assert r.status_code == 200 and r.json()["status"] == status


def test_invalid_status_rejected():
    admin, _t, f = _setup()
    rid = FormResponse.objects.filter(form=f).first().id
    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.patch(f"/api/forms/{f.id}/responses/{rid}/", {"status": "bogus"}, format="json")
    assert r.status_code == 400


def test_rejecting_org_response_hides_school_from_public_directory():
    """Reported bug: rejecting a Stage-1 submission in "Review raw submissions"
    left the school on the PUBLIC directory, because the public surfaces gate on
    Institution.status, not FormResponse.status. The review must propagate."""
    from apps.teams.models import Institution, InstitutionStatus

    admin, t, f = _setup()
    f.status = "open"  # directory is exposed once published (open/closed), not draft
    f.save(update_fields=["status"])
    resp = FormResponse.objects.filter(form=f).first()
    inst = Institution.objects.create(
        organization=t.organization, tournament=t, slug="mh", name="MH",
        status=InstitutionStatus.REGISTERED, source_response_id=resp.id,
    )
    resp.mapped_entities = {"institution_id": str(inst.id)}
    resp.save(update_fields=["mapped_entities"])

    c = APIClient()
    c.force_authenticate(user=admin)

    # Visible while registered.
    body = APIClient().get(f"/api/forms/{f.id}/directory/").json()
    assert [e["name"] for e in body["entries"]] == ["MH"]

    # Reject the raw submission -> institution flips to rejected -> gone publicly.
    r = c.patch(f"/api/forms/{f.id}/responses/{resp.id}/", {"status": "rejected"}, format="json")
    assert r.status_code == 200
    inst.refresh_from_db()
    assert inst.status == InstitutionStatus.REJECTED
    body = APIClient().get(f"/api/forms/{f.id}/directory/").json()
    assert body["entries"] == []

    # Un-reject (accept) -> restored to registered -> visible again.
    c.patch(f"/api/forms/{f.id}/responses/{resp.id}/", {"status": "accepted"}, format="json")
    inst.refresh_from_db()
    assert inst.status == InstitutionStatus.REGISTERED


def test_rejecting_org_response_leaves_a_withdrawn_school_withdrawn():
    """A deliberate withdraw (school pulled out) outranks a raw-submission
    reject — both hide it, but we don't silently rewrite the reason."""
    from apps.teams.models import Institution, InstitutionStatus

    admin, t, f = _setup()
    resp = FormResponse.objects.filter(form=f).first()
    inst = Institution.objects.create(
        organization=t.organization, tournament=t, slug="mh", name="MH",
        status=InstitutionStatus.WITHDRAWN, source_response_id=resp.id,
    )
    resp.mapped_entities = {"institution_id": str(inst.id)}
    resp.save(update_fields=["mapped_entities"])

    c = APIClient()
    c.force_authenticate(user=admin)
    c.patch(f"/api/forms/{f.id}/responses/{resp.id}/", {"status": "rejected"}, format="json")
    inst.refresh_from_db()
    assert inst.status == InstitutionStatus.WITHDRAWN


def test_responses_outsider_404():
    _admin, _t, f = _setup()
    outsider = _verified("out@test.local")
    c = APIClient()
    c.force_authenticate(user=outsider)
    assert c.get(f"/api/forms/{f.id}/responses/").status_code == 404


def test_send_stage2_mints_links_for_accepted_only():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    src = Form.objects.create(organization=t.organization, tournament=t, slug="src", title="Src",
                              purpose="organization_registration")
    target = Form.objects.create(organization=t.organization, tournament=t, slug="tgt", title="Tgt",
                                 purpose="team_registration")
    r_acc = FormResponse.objects.create(form=src, organization=t.organization, tournament=t,
                                        title="Accepted School", respondent_email="acc@b.com",
                                        status="accepted")
    FormResponse.objects.create(form=src, organization=t.organization, tournament=t,
                                title="Pending School", status="submitted")
    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.post(f"/api/forms/{src.id}:send-stage2/",
               {"target_form_id": str(target.id)}, format="json")
    assert r.status_code == 201, r.content
    body = r.json()
    assert body["sent"] == 1
    assert body["links"][0]["response_id"] == str(r_acc.id)
    assert body["links"][0]["path"].startswith("/r/")
    # one share-link minted against the TARGET form
    assert FormShareLink.objects.filter(form=target).count() == 1


def test_send_stage2_unknown_target_400():
    admin, _t, f = _setup()
    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.post(f"/api/forms/{f.id}:send-stage2/",
               {"target_form_id": str(uuid.uuid4())}, format="json")
    assert r.status_code == 400


# --- REQUIRED end-to-end idempotency test ----------------------------------
# Drives the PUBLIC submit flow for a team_registration form WITH an event_id to
# prove submit + audit (derived key) + mapping are all idempotent end-to-end.

TEAM_REG_SCHEMA = {"version": 1, "sections": [{"key": "s", "title": "S", "fields": [
    {"key": "school", "type": "short_text", "label": "School", "required": True, "role": "title"},
    {"key": "team", "type": "short_text", "label": "Team", "required": True},
    {"key": "email", "type": "email", "label": "Email", "required": True, "role": "email"}]}]}


def _team_reg_form(t):
    return Form.objects.create(
        organization=t.organization, tournament=t, slug="roster", title="Roster",
        purpose="team_registration", status="open", opens_at=timezone.now(),
        settings={"bindings": {"school_name": "school", "team_name": "team"}},
        schema=TEAM_REG_SCHEMA,
    )


def test_public_team_registration_submit_and_replay_no_duplicate_team():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = _team_reg_form(t)
    c = APIClient()  # public, unauthenticated
    eid = str(uuid.uuid4())
    payload = {"answers": {"school": "Mount Hermon", "team": "MH A", "email": "mh@b.com"},
               "event_id": eid}

    p1 = c.post(f"/api/forms/{f.id}/public/", payload, format="json")
    assert p1.status_code == 201, p1.content
    assert Team.objects.filter(tournament=t, school="Mount Hermon").count() == 1
    assert FormResponse.objects.filter(form=f).count() == 1

    # Replay with the SAME event_id: clean 2xx, no duplicate team, no duplicate response.
    p2 = c.post(f"/api/forms/{f.id}/public/", payload, format="json")
    assert p2.status_code == 201, p2.content  # idempotent replay, not 500
    assert Team.objects.filter(tournament=t, school="Mount Hermon").count() == 1
    assert FormResponse.objects.filter(form=f).count() == 1
    # same response returned on replay
    assert p1.json()["response_id"] == p2.json()["response_id"]
