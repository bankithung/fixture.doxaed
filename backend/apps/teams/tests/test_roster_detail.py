"""Rich roster detail (logo, coaches, per-player DOB + documents) read back out
of a team's originating submission, the manager-gated endpoint that serves it,
and the signed file-serving endpoint (owner 2026-06-17)."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.forms.models import FormFileUpload, FormResponse
from apps.forms.services.generation import generate_team_form_template
from apps.forms.services.mapping import map_response
from apps.forms.services.roster import team_submission_detail
from apps.forms.services.uploads import sign_upload, verify_upload_token
from apps.teams.models import Team
from apps.teams.services.registration import get_or_create_institution
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()

# Age-eligible DOBs for the U-15 fixture leaf (H5 enforces at submit now):
# whole-year age on 31 Dec of the current year must be under 15.
_Y = timezone.now().year
DOB_A = f"{_Y - 13}-04-12"
DOB_B = f"{_Y - 12}-09-03"
pytestmark = pytest.mark.django_db


def _admin(email="rd@forms.test"):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _cup(admin):
    t = create_tournament(user=admin, name="RD Cup")
    t.sports = normalize_sports([{"name": "Football", "nodes": [{"name": "U15"}]}])
    t.save(update_fields=["sports"])
    return t


def _upload(form, name, content_type, content=b"x"):
    return FormFileUpload.objects.create(
        organization=form.organization,
        form=form,
        field_key="",
        file=SimpleUploadedFile(name, content, content_type=content_type),
        original_name=name,
        content_type=content_type,
        size=len(content),
    )


def _seed_submission(admin):
    """Tournament + institution + a team submission with a logo, a coach (with a
    doc) and two players (one with two docs). Returns (tournament, form, team)."""
    t = _cup(admin)
    inst = get_or_create_institution(tournament=t, name="Holy Cross")
    form = generate_team_form_template(tournament=t, created_by=admin)
    cg = form.settings["bindings"]["category_groups"][0]

    logo = _upload(form, "crest.png", "image/png")
    coach_doc = _upload(form, "coach.pdf", "application/pdf")
    # A respondent-given document name on one player doc — the admin should see it.
    pdoc1 = _upload(form, "id1.pdf", "application/pdf")
    pdoc1.label = "Aadhaar card"
    pdoc1.save(update_fields=["label"])
    pdoc2 = _upload(form, "cert.jpg", "image/jpeg")

    answers = {
        "institution_id": str(inst.id),
        cg["group"]: [
            {
                cg["team_name"]: "Eagles",
                cg["team_logo"]: str(logo.upload_ref),
                cg["coaches_group"]: [
                    {cg["coach_name"]: "Bankithung",
                     cg["coach_docs"]: [str(coach_doc.upload_ref)]},
                ],
                cg["players_group"]: [
                    {cg["player_name"]: "Ravi K", cg["player_dob"]: DOB_A,
                     cg["player_docs"]: [str(pdoc1.upload_ref), str(pdoc2.upload_ref)]},
                    {cg["player_name"]: "Merithung", cg["player_dob"]: DOB_B},
                ],
            }
        ],
    }
    resp = FormResponse.objects.create(
        form=form, organization=t.organization, tournament=t, answers=answers
    )
    # Claim the uploads onto the response (the submit path does this).
    FormFileUpload.objects.filter(form=form, response__isnull=True).update(response=resp)
    map_response(resp)
    team = Team.objects.get(tournament=t, name="Eagles")
    return t, form, team


@override_settings(MEDIA_ROOT="/tmp/fixture-test-media")
def test_team_submission_detail_surfaces_logo_coach_dob_docs():
    t, form, team = _seed_submission(_admin())
    detail = team_submission_detail(team)

    assert detail["logo"]["name"] == "crest.png"
    assert "/api/forms/uploads/" in detail["logo"]["url"]
    assert detail["logo"]["content_type"] == "image/png"

    assert detail["coaches"][0]["name"] == "Bankithung"
    assert detail["coaches"][0]["documents"][0]["name"] == "coach.pdf"

    players = {p["name"]: p for p in detail["players"]}
    assert players["Ravi K"]["dob"] == DOB_A
    assert {d["name"] for d in players["Ravi K"]["documents"]} == {"id1.pdf", "cert.jpg"}
    # The respondent's document name rides along for the admin.
    labels = {d["name"]: d["label"] for d in players["Ravi K"]["documents"]}
    assert labels["id1.pdf"] == "Aadhaar card"
    assert players["Merithung"]["dob"] == DOB_B
    assert players["Merithung"]["documents"] == []


@override_settings(MEDIA_ROOT="/tmp/fixture-test-media")
def test_registration_detail_endpoint_manager_only():
    admin = _admin("rd-mgr@forms.test")
    t, form, team = _seed_submission(admin)
    url = f"/api/tournaments/{t.id}/teams/{team.id}/registration/"

    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.get(url)
    assert r.status_code == 200
    assert r.json()["logo"]["name"] == "crest.png"

    # An unrelated, signed-in user can't reach another org's tournament (404,
    # no existence leak — invariant #2).
    outsider = _admin("rd-out@forms.test")
    c2 = APIClient()
    c2.force_authenticate(user=outsider)
    assert c2.get(url).status_code == 404


@override_settings(MEDIA_ROOT="/tmp/fixture-test-media")
def test_serve_upload_requires_signed_token_or_manager():
    admin = _admin("rd-srv@forms.test")
    t, form, team = _seed_submission(admin)
    up = FormFileUpload.objects.filter(form=form, original_name="crest.png").first()
    base = f"/api/forms/uploads/{up.upload_ref}/"

    pub = APIClient()  # unauthenticated, no token → 404
    assert pub.get(base).status_code == 404

    token = sign_upload(up.upload_ref)
    assert verify_upload_token(token) == str(up.upload_ref)
    ok = pub.get(base, {"t": token})
    assert ok.status_code == 200

    # A manager session is also allowed (no token).
    mgr = APIClient()
    mgr.force_authenticate(user=admin)
    assert mgr.get(base).status_code == 200

    # A signed-in outsider with no token is denied.
    outsider = _admin("rd-srv-out@forms.test")
    out = APIClient()
    out.force_authenticate(user=outsider)
    assert out.get(base).status_code == 404
