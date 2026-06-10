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


def test_directory_exposes_competitions_grouping():
    """W2-E: the public directory carries each institution's competitions
    (structural leaves, labelled) plus per-competition counts, so the page
    can group by sport -> category without re-parsing answers."""
    from apps.forms.services.generation import generate_institution_form
    from apps.forms.services.mapping import map_response
    from apps.tournaments.services.sports import normalize_sports

    admin = _verified("dir@test.local")
    t = create_tournament(user=admin, name="Dir Cup")
    t.sports = normalize_sports([
        {"name": "Football", "nodes": [{"name": "U15"}]},
        {"name": "Badminton"},
    ])
    t.save(update_fields=["sports"])
    form = generate_institution_form(tournament=t, created_by=admin)
    form.status = "open"
    form.save(update_fields=["status"])

    resp = FormResponse.objects.create(
        form=form, organization=t.organization, tournament=t, title="Don Bosco",
        answers={"school_name": "Don Bosco", "contact_name": "Fr. K",
                 "contact_phone": "9876543210",
                 "sports": ["football", "badminton"],
                 "categories_football": ["football.u15"]},
    )
    map_response(resp)
    # link the institution to its source response so values/competitions join
    from apps.teams.models import Institution
    inst = Institution.objects.get(tournament=t, name="Don Bosco")
    inst.source_response_id = resp.id
    inst.save(update_fields=["source_response_id"])

    body = APIClient().get(f"/api/forms/{form.id}/directory/").json()
    assert body["count"] == 1
    entry = body["entries"][0]
    assert {c["leaf_key"] for c in entry["competitions"]} == {
        "football.u15", "badminton",
    }
    comps = {c["leaf_key"]: c for c in body["competitions"]}
    assert comps["football.u15"]["count"] == 1
    assert comps["football.u15"]["label"] == "Football — U15"
    assert comps["badminton"]["count"] == 1
    # Default headline KPI preference: total + per-game registrations.
    assert body["kpi_mode"] == "games"


def test_team_form_scopes_competitions_to_selected_institution():
    """The public team-form payload carries (a) each institution option's
    registered competition leaves and (b) the competition-scoped field keys,
    so the renderer can show a school ONLY the sports/categories it
    registered — pre-selected, no admin regeneration needed."""
    from apps.forms.services.generation import (
        generate_institution_form,
        generate_team_form_template,
    )
    from apps.forms.services.mapping import map_response
    from apps.tournaments.services.sports import normalize_sports

    admin = _verified("scope@test.local")
    t = create_tournament(user=admin, name="Scope Cup")
    t.sports = normalize_sports([
        {"name": "Football", "nodes": [{"name": "U15"}]},
        {"name": "Badminton"},
    ])
    t.save(update_fields=["sports"])
    org = generate_institution_form(tournament=t, created_by=admin)
    org.status = "open"
    org.save(update_fields=["status"])
    resp = FormResponse.objects.create(
        form=org, organization=t.organization, tournament=t, title="Don Bosco",
        answers={"school_name": "Don Bosco", "contact_name": "Fr. K",
                 "contact_phone": "9876543210",
                 "sports": ["football"],
                 "categories_football": ["football.u15"]},
    )
    map_response(resp)

    team = generate_team_form_template(tournament=t, created_by=admin)
    team.status = "open"
    team.save(update_fields=["status"])

    body = APIClient().get(f"/api/forms/{team.id}/public/").json()
    # The institution dropdown options carry the registered leaves.
    inst_field = next(
        f
        for s in body["form"]["schema"]["sections"]
        for f in s["fields"]
        if (f.get("data_source") or {}).get("type") == "institution_list"
    )
    opt = next(o for o in inst_field["options"] if o["label"] == "Don Bosco")
    assert opt["leaves"] == ["football.u15"]
    # The sport + category-chain questions are flagged as competition-scoped.
    assert "sports" in body["competition_fields"]
    assert len(body["competition_fields"]) >= 2  # sports + ≥1 chain level
    # Team-name field pairs ride along for inline duplicate validation.
    assert body["team_groups"], "expected team_groups for a team form"
    assert all(g["group"] and g["field"] for g in body["team_groups"])


def test_team_submit_same_name_across_categories_ok_duplicates_rejected():
    """One school reuses a team name across competitions (allowed since names
    are unique per LEAF), while duplicates inside one competition — or a name
    already taken there — fail the submit with a field error keyed by the
    group, BEFORE any response is recorded (no more silent zero-team maps)."""
    from apps.forms.services.generation import (
        generate_institution_form,
        generate_team_form_template,
    )
    from apps.forms.services.mapping import map_response
    from apps.teams.models import Institution, Team
    from apps.tournaments.services.sports import normalize_sports

    admin = _verified("teams@test.local")
    t = create_tournament(user=admin, name="Names Cup")
    t.sports = normalize_sports([
        {"name": "Football", "nodes": [{"name": "U15"}]},
        {"name": "Badminton"},
    ])
    t.save(update_fields=["sports"])
    org = generate_institution_form(tournament=t, created_by=admin)
    org.status = "open"
    org.save(update_fields=["status"])
    resp = FormResponse.objects.create(
        form=org, organization=t.organization, tournament=t, title="Don Bosco",
        answers={"school_name": "Don Bosco", "contact_name": "Fr. K",
                 "contact_phone": "9876543210",
                 "sports": ["football", "badminton"],
                 "categories_football": ["football.u15"]},
    )
    map_response(resp)
    inst = Institution.objects.get(tournament=t, name="Don Bosco")

    team_form = generate_team_form_template(tournament=t, created_by=admin)
    team_form.status = "open"
    team_form.save(update_fields=["status"])

    answers = {
        "institution_id": str(inst.id),
        "sports": ["football", "badminton"],
        "categories_football": ["football.u15"],
        "teams_football_u15": [{
            "team_name_football_u15": "Don Bosco A",
            "players_football_u15": [{"player_name_football_u15": "P One"}],
        }],
        "teams_badminton": [{
            "team_name_badminton": "Don Bosco A",
            "players_badminton": [{"player_name_badminton": "P Two"}],
        }],
    }
    r = APIClient().post(
        f"/api/forms/{team_form.id}/public/",
        {"answers": answers, "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 201, r.json()
    assert Team.objects.filter(
        tournament=t, name="Don Bosco A", deleted_at__isnull=True
    ).count() == 2  # same name, two competitions

    # Duplicate names INSIDE one competition → 400 keyed by the group field.
    dup = {**answers, "teams_football_u15": [
        {"team_name_football_u15": "Twins",
         "players_football_u15": [{"player_name_football_u15": "A"}]},
        {"team_name_football_u15": "Twins",
         "players_football_u15": [{"player_name_football_u15": "B"}]},
    ]}
    r2 = APIClient().post(
        f"/api/forms/{team_form.id}/public/",
        {"answers": dup, "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r2.status_code == 400
    assert "teams_football_u15" in r2.json()["errors"]

    # A name already registered in that competition → 400 too.
    r3 = APIClient().post(
        f"/api/forms/{team_form.id}/public/",
        {"answers": answers, "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r3.status_code == 400
    assert Team.objects.filter(
        tournament=t, deleted_at__isnull=True
    ).count() == 2  # nothing extra slipped in


def _team_reg_fixture(email_suffix="access"):
    """Tournament + mapped institution (with contact email) + OPEN team form."""
    from apps.forms.services.generation import (
        generate_institution_form,
        generate_team_form_template,
    )
    from apps.forms.services.mapping import map_response
    from apps.teams.models import Institution
    from apps.tournaments.services.sports import normalize_sports

    admin = _verified(f"{email_suffix}@test.local")
    t = create_tournament(user=admin, name=f"{email_suffix} Cup")
    t.sports = normalize_sports([
        {"name": "Football", "nodes": [{"name": "U15"}]},
    ])
    t.save(update_fields=["sports"])
    org = generate_institution_form(tournament=t, created_by=admin)
    org.status = "open"
    org.save(update_fields=["status"])
    resp = FormResponse.objects.create(
        form=org, organization=t.organization, tournament=t, title="Don Bosco",
        answers={"school_name": "Don Bosco", "contact_name": "Fr. K",
                 "contact_email": "school@test.local",
                 "contact_phone": "9876543210",
                 "sports": ["football"],
                 "categories_football": ["football.u15"]},
    )
    map_response(resp)
    inst = Institution.objects.get(tournament=t, name="Don Bosco")
    team_form = generate_team_form_template(tournament=t, created_by=admin)
    team_form.status = "open"
    team_form.save(update_fields=["status"])
    return admin, t, inst, team_form


def _team_answers(inst, name="Don Bosco A", player="P One"):
    return {
        "institution_id": str(inst.id),
        "sports": ["football"],
        "categories_football": ["football.u15"],
        "teams_football_u15": [{
            "team_name_football_u15": name,
            "players_football_u15": [{"player_name_football_u15": player}],
        }],
    }


def test_team_access_codes_issue_hash_and_email(mailoutbox):
    """Issuing codes stores ONLY a password hash (never plaintext) and emails
    the contact the link + code; re-issue keeps existing codes."""
    from apps.teams.services.access import issue_team_access_codes

    _admin_user, t, inst, team_form = _team_reg_fixture("issue")
    out = issue_team_access_codes(tournament=t, form=team_form)
    assert out == {
        "sent": 1, "no_email": 0, "skipped": 0, "no_email_institutions": [],
    }
    inst.refresh_from_db()
    # Hashed with the configured Django hasher (Argon2id) — never plaintext.
    from django.contrib.auth.hashers import identify_hasher

    assert identify_hasher(inst.team_code_hash) is not None
    assert len(inst.team_code_hash) > 40
    assert inst.team_code_sent_at is not None
    assert len(mailoutbox) == 1
    body = mailoutbox[0].body
    assert f"/f/{team_form.id}" in body and "access code" in body
    # The emailed code is 8 chars from the unambiguous alphabet.
    code_line = [ln.strip() for ln in body.splitlines() if ln.strip().isalnum() and len(ln.strip()) == 8]
    assert code_line, body
    # Idempotent re-issue: the code in the inbox stays valid.
    out2 = issue_team_access_codes(tournament=t, form=team_form)
    assert out2["skipped"] == 1 and out2["sent"] == 0


def test_team_access_verify_lockout_and_token(mailoutbox):
    """Wrong codes 403 then lock out; the right code returns a signed token
    and the institution's previous submission for editing."""
    from apps.teams.services.access import issue_team_access_codes

    _a, t, inst, team_form = _team_reg_fixture("verify")
    issue_team_access_codes(tournament=t, form=team_form)
    code = next(
        ln.strip() for ln in mailoutbox[0].body.splitlines()
        if ln.strip().isalnum() and len(ln.strip()) == 8
    )

    url = f"/api/forms/{team_form.id}/team-access/"
    bad = APIClient().post(url, {"institution_id": str(inst.id), "code": "WRONGCOD"}, format="json")
    assert bad.status_code == 403 and bad.json()["detail"] == "invalid_code"
    for _ in range(4):
        APIClient().post(url, {"institution_id": str(inst.id), "code": "WRONGCOD"}, format="json")
    locked = APIClient().post(url, {"institution_id": str(inst.id), "code": code}, format="json")
    assert locked.status_code == 403 and locked.json()["detail"] == "locked"

    # Clear the lockout (cache-backed) and verify the real code.
    from django.core.cache import cache
    cache.clear()
    ok = APIClient().post(url, {"institution_id": str(inst.id), "code": code}, format="json")
    assert ok.status_code == 200
    assert ok.json()["access_token"]
    assert ok.json()["editing"] is False and ok.json()["prefill"] is None


def test_team_submit_requires_code_and_resubmit_supersedes(mailoutbox):
    """With a code issued: submitting without the token is rejected; with the
    token it succeeds; resubmitting REPLACES the previous teams (no
    duplicates) and the verify endpoint returns the prior answers."""
    from django.core.cache import cache

    from apps.teams.models import Team
    from apps.teams.services.access import issue_team_access_codes

    _a, t, inst, team_form = _team_reg_fixture("edit")
    issue_team_access_codes(tournament=t, form=team_form)
    code = next(
        ln.strip() for ln in mailoutbox[0].body.splitlines()
        if ln.strip().isalnum() and len(ln.strip()) == 8
    )
    submit_url = f"/api/forms/{team_form.id}/public/"

    # No token → rejected (anyone with the link can no longer impersonate).
    r = APIClient().post(
        submit_url,
        {"answers": _team_answers(inst), "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 400 and r.json()["detail"] == "team_access_required"

    cache.clear()  # earlier failed attempts in this test run
    token = APIClient().post(
        f"/api/forms/{team_form.id}/team-access/",
        {"institution_id": str(inst.id), "code": code}, format="json",
    ).json()["access_token"]
    r2 = APIClient().post(
        submit_url,
        {"answers": _team_answers(inst, name="Don Bosco A"),
         "event_id": str(uuid.uuid4()), "access_token": token},
        format="json",
    )
    assert r2.status_code == 201, r2.json()
    assert Team.objects.filter(tournament=t, deleted_at__isnull=True).count() == 1

    # Resubmit with a different roster → previous teams superseded, not stacked.
    r3 = APIClient().post(
        submit_url,
        {"answers": _team_answers(inst, name="Don Bosco Blue", player="P Two"),
         "event_id": str(uuid.uuid4()), "access_token": token},
        format="json",
    )
    assert r3.status_code == 201, r3.json()
    live = Team.objects.filter(tournament=t, deleted_at__isnull=True)
    assert [tm.name for tm in live] == ["Don Bosco Blue"]

    # Verify now offers the latest answers as prefill for editing.
    cache.clear()
    v = APIClient().post(
        f"/api/forms/{team_form.id}/team-access/",
        {"institution_id": str(inst.id), "code": code}, format="json",
    ).json()
    assert v["editing"] is True
    assert v["prefill"]["teams_football_u15"][0]["team_name_football_u15"] == "Don Bosco Blue"


def test_institution_edit_link_prefills_updates_in_place_and_is_single_use():
    """Admin mints a temporary edit link for a school: it opens the Stage-1
    form (even after it closed) prefilled with the school's previous answers;
    submitting UPDATES the same institution (rename included, no duplicate
    row); the link is spent after one submission."""
    from apps.teams.models import Institution

    admin, t, inst, _team_form = _team_reg_fixture("editlink")
    org = Form.objects.get(
        tournament=t, purpose="organization_registration", deleted_at__isnull=True
    )
    org.status = "closed"
    org.save(update_fields=["status"])

    c = APIClient()
    c.force_authenticate(user=admin)
    minted = c.post(
        f"/api/tournaments/{t.id}/institutions/{inst.id}/edit-link/", {}, format="json"
    )
    assert minted.status_code == 201, minted.json()
    token = minted.json()["path"].split("/r/")[1]

    # The bound link opens the CLOSED form, prefilled with prior answers.
    g = APIClient().get(f"/api/forms/r/{token}/").json()
    assert "closed" not in g or not g["closed"]
    assert g["prefill"]["school_name"] == "Don Bosco"

    answers = {
        **g["prefill"],
        "school_name": "Don Bosco HSS",
        "contact_email": "fixed@school.local",
    }
    r = APIClient().post(
        f"/api/forms/r/{token}/",
        {"answers": answers, "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 201, r.json()
    inst.refresh_from_db()
    assert inst.name == "Don Bosco HSS"
    assert inst.contact_email == "fixed@school.local"
    assert Institution.objects.filter(
        tournament=t, deleted_at__isnull=True
    ).count() == 1  # updated in place, never duplicated

    # Single-use: a second submission through the same link is refused.
    r2 = APIClient().post(
        f"/api/forms/r/{token}/",
        {"answers": answers, "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r2.status_code == 404


def test_directory_kpi_mode_setting_passthrough():
    """The admin's `settings.directory_kpis` choice reaches the public payload;
    unknown values fall back to the 'games' default."""
    t = create_tournament(user=_verified("kpi@test.local"), name="KPI Cup")
    form = Form.objects.create(
        organization=t.organization, tournament=t, slug="kpi", title="Reg",
        schema=SCHEMA, status="open", settings={"directory_kpis": "total"},
    )
    body = APIClient().get(f"/api/forms/{form.id}/directory/").json()
    assert body["kpi_mode"] == "total"
    # An open form advertises itself so the directory can link back to it.
    assert body["form_open"] is True

    form.settings = {"directory_kpis": "everything-bagel"}
    form.save(update_fields=["settings"])
    body = APIClient().get(f"/api/forms/{form.id}/directory/").json()
    assert body["kpi_mode"] == "games"

    # Closed form: the directory stays public but stops advertising the form.
    form.status = "closed"
    form.save(update_fields=["status"])
    body = APIClient().get(f"/api/forms/{form.id}/directory/").json()
    assert body["form_open"] is False
