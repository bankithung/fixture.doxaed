"""Generated team form: per-player DOB + documents, per-team logo + coaches,
and team name defaulting to the institution (owner 2026-06-16)."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.forms.models import FormResponse
from apps.forms.services.generation import (
    build_team_form_schema,
    generate_team_form_template,
)
from apps.forms.services.mapping import map_response
from apps.teams.models import Player, Team
from apps.teams.services.registration import get_or_create_institution
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()
pytestmark = pytest.mark.django_db


def _admin(email="tf@forms.test"):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _by_key(schema: dict) -> dict:
    out: dict = {}

    def walk(fields):
        for f in fields:
            out[f["key"]] = f
            if f.get("fields"):
                walk(f["fields"])

    for s in schema["sections"]:
        walk(s["fields"])
    return out


def _cup(admin):
    t = create_tournament(user=admin, name="TF Cup")
    t.sports = normalize_sports([{"name": "Football", "nodes": [{"name": "U15"}]}])
    t.save(update_fields=["sports"])
    return t


def test_team_form_includes_dob_docs_logo_and_coaches():
    t = _cup(_admin())
    schema, bindings = build_team_form_schema(None, tournament=t)
    fields = _by_key(schema)
    cg = bindings["category_groups"][0]

    assert fields[cg["player_dob"]]["type"] == "date"
    assert fields[cg["player_dob"]]["required"] is True
    assert fields[cg["player_docs"]]["type"] == "file_upload"
    assert fields[cg["player_docs"]]["multiple"] is True
    assert fields[cg["team_logo"]]["type"] == "file_upload"
    assert fields[cg["coach_name"]]["type"] == "short_text"
    assert fields[cg["coach_docs"]]["multiple"] is True
    # The team name is now optional — it defaults to the institution.
    assert fields[cg["team_name"]]["required"] is False


def test_blank_team_name_defaults_to_institution_and_maps_dob():
    admin = _admin("map@forms.test")
    t = _cup(admin)
    inst = get_or_create_institution(tournament=t, name="Holy Cross")
    form = generate_team_form_template(tournament=t, created_by=admin)
    cg = form.settings["bindings"]["category_groups"][0]

    answers = {
        "institution_id": str(inst.id),
        cg["group"]: [
            {
                cg["team_name"]: "",  # blank → should adopt the institution name
                cg["players_group"]: [
                    {cg["player_name"]: "Ravi K", cg["player_dob"]: "2009-03-01"},
                ],
            }
        ],
    }
    resp = FormResponse.objects.create(
        form=form, organization=t.organization, tournament=t, answers=answers
    )
    map_response(resp)

    team = Team.objects.get(tournament=t)
    assert team.name == "Holy Cross"
    player = Player.objects.get(team=team)
    assert player.person.dob_year == 2009


def test_two_blank_teams_in_a_leaf_get_distinct_default_names():
    admin = _admin("dup@forms.test")
    t = _cup(admin)
    inst = get_or_create_institution(tournament=t, name="Don Bosco")
    form = generate_team_form_template(tournament=t, created_by=admin)
    cg = form.settings["bindings"]["category_groups"][0]

    answers = {
        "institution_id": str(inst.id),
        cg["group"]: [
            {cg["team_name"]: "", cg["players_group"]: [{cg["player_name"]: "A"}]},
            {cg["team_name"]: "", cg["players_group"]: [{cg["player_name"]: "B"}]},
        ],
    }
    resp = FormResponse.objects.create(
        form=form, organization=t.organization, tournament=t, answers=answers
    )
    map_response(resp)

    names = sorted(Team.objects.filter(tournament=t).values_list("name", flat=True))
    assert names == ["Don Bosco", "Don Bosco 2"]
