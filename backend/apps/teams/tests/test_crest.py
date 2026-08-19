"""Team crests: where the badge is stored, and who may load it.

Owner 2026-08-19: "when fixture is generated we should also show logos … not
just generated but all other fixtures, be it in matches pages or anywhere a
fixture is shown". That only works if the crest lives on the domain row rather
than inside the submission — a fixture list renders dozens of teams and the
public match centre has no session to read a form with.
"""
from __future__ import annotations

import uuid as _uuid

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.forms.models import FormFileUpload, FormResponse
from apps.forms.services.generation import generate_team_form_template
from apps.forms.services.mapping import map_response
from apps.teams.models import Institution, Team
from apps.teams.services.crest import (
    crest_map,
    crest_map_for_ids,
    crest_url,
    team_crest,
)
from apps.teams.services.registration import get_or_create_institution
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()
pytestmark = pytest.mark.django_db


def _admin(email="crest@test.local"):
    u = User.objects.create_user(
        email=email, password="FixtureDemo2026!", is_active=True,
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _cup(admin):
    t = create_tournament(user=admin, name="Crest Cup")
    t.sports = normalize_sports([{"name": "Football", "nodes": [{"name": "U15"}]}])
    t.save(update_fields=["sports"])
    return t


def _upload(form, name="crest.png"):
    return FormFileUpload.objects.create(
        organization=form.organization, form=form, field_key="",
        file=SimpleUploadedFile(name, b"x", content_type="image/png"),
        original_name=name, content_type="image/png", size=1,
    )


@override_settings(MEDIA_ROOT="/tmp/fixture-test-media")
def test_a_submitted_logo_lands_on_the_school_not_only_in_the_form():
    admin = _admin()
    t = _cup(admin)
    inst = get_or_create_institution(tournament=t, name="Holy Cross")
    form = generate_team_form_template(tournament=t, created_by=admin)
    cg = form.settings["bindings"]["category_groups"][0]
    logo = _upload(form)

    resp = FormResponse.objects.create(
        form=form, organization=t.organization, tournament=t,
        answers={
            "institution_id": str(inst.id),
            # The crest is asked once per submission, at the top level.
            cg["team_logo"]: str(logo.upload_ref),
            cg["group"]: [{cg["team_name"]: "Eagles"}],
        },
    )
    FormFileUpload.objects.filter(form=form, response__isnull=True).update(response=resp)
    map_response(resp)

    inst.refresh_from_db()
    assert inst.logo_ref == logo.upload_ref
    # Every team of the school wears it — the badge is the school's.
    team = Team.objects.get(tournament=t, name="Eagles")
    assert team.logo_ref is None
    assert team_crest(team) == crest_url(logo.upload_ref)


@override_settings(MEDIA_ROOT="/tmp/fixture-test-media")
def test_a_per_row_logo_wins_for_its_own_team():
    """Forms generated before the crest moved to the participants sheet asked
    for one per team row; that row must still dress its own team."""
    admin = _admin("crest-row@test.local")
    t = _cup(admin)
    inst = get_or_create_institution(tournament=t, name="Holy Cross")
    form = generate_team_form_template(tournament=t, created_by=admin)
    cg = form.settings["bindings"]["category_groups"][0]
    school_logo = _upload(form, "school.png")
    row_logo = _upload(form, "row.png")

    resp = FormResponse.objects.create(
        form=form, organization=t.organization, tournament=t,
        answers={
            "institution_id": str(inst.id),
            cg["team_logo"]: str(school_logo.upload_ref),
            cg["group"]: [
                {cg["team_name"]: "Eagles", cg["team_logo"]: str(row_logo.upload_ref)},
                {cg["team_name"]: "Hawks"},
            ],
        },
    )
    FormFileUpload.objects.filter(form=form, response__isnull=True).update(response=resp)
    map_response(resp)

    eagles = Team.objects.get(tournament=t, name="Eagles")
    hawks = Team.objects.get(tournament=t, name="Hawks")
    assert eagles.logo_ref == row_logo.upload_ref
    assert team_crest(eagles) == crest_url(row_logo.upload_ref)
    # The one without its own falls back to the school's.
    assert hawks.logo_ref is None
    assert team_crest(hawks) == crest_url(school_logo.upload_ref)


@override_settings(MEDIA_ROOT="/tmp/fixture-test-media")
def test_the_bulk_maps_never_query_per_team():
    admin = _admin("crest-bulk@test.local")
    t = _cup(admin)
    inst = Institution.objects.create(
        organization=t.organization, tournament=t, slug="hc", name="Holy Cross",
        logo_ref=_uuid.uuid4(),
    )
    plain = Institution.objects.create(
        organization=t.organization, tournament=t, slug="np", name="No Crest",
    )
    a = Team.objects.create(
        organization=t.organization, tournament=t, institution=inst,
        slug="a", name="A", leaf_key="football.u15",
    )
    b = Team.objects.create(
        organization=t.organization, tournament=t, institution=plain,
        slug="b", name="B", leaf_key="football.u15",
    )
    got = crest_map_for_ids([a.id, b.id])
    # A team without a crest is ABSENT, so a caller can `.get(id, "")` and
    # never branch on None.
    assert set(got) == {str(a.id)}
    assert got[str(a.id)] == crest_url(inst.logo_ref)
    assert crest_map([a, b]) == got


def test_a_missing_or_junk_ref_is_no_crest_rather_than_a_broken_badge():
    assert crest_url(None) == ""
    assert crest_url("") == ""
    assert team_crest(None) == ""


@override_settings(MEDIA_ROOT="/tmp/fixture-test-media")
def test_the_crest_url_loads_without_a_session():
    """A crest shows on the public match centre and inside a printed sheet, so
    the URL has to be a capability rather than a login."""
    admin = _admin("crest-pub@test.local")
    t = _cup(admin)
    form = generate_team_form_template(tournament=t, created_by=admin)
    logo = _upload(form)

    url = crest_url(logo.upload_ref)
    assert url.startswith(f"/api/forms/uploads/{logo.upload_ref}/?t=")
    assert APIClient().get(url).status_code == 200
    # The token is what authorizes it — without one, nothing leaks.
    assert APIClient().get(f"/api/forms/uploads/{logo.upload_ref}/").status_code == 404
