"""TDD — purpose-driven entity mapping (Increment 5, Task 5.1).

``map_response`` dispatches by ``Form.purpose``: ``team_registration`` reuses
``apps/teams`` ``register_school`` (no rewrite); ``organization_registration``
and ``generic`` are no-ops (the response itself IS the participant record).
Mapping is idempotent — already-mapped responses are skipped so a replay never
duplicates teams.
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.forms.models import Form, FormResponse
from apps.forms.services.mapping import map_response
from apps.teams.models import Player, Team
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _team_reg_form(t):
    return Form.objects.create(
        organization=t.organization, tournament=t, slug="roster", title="Roster",
        purpose="team_registration",
        settings={"bindings": {"school_name": "school", "team_name": "team",
                               "players_group": "players", "player_name": "pname"}},
        schema={"version": 1, "sections": [{"key": "s", "title": "S", "fields": [
            {"key": "school", "type": "short_text", "label": "School", "role": "title"},
            {"key": "team", "type": "short_text", "label": "Team"}]}]},
    )


def test_team_registration_maps_to_register_school():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = _team_reg_form(t)
    resp = FormResponse.objects.create(
        form=f, organization=t.organization, tournament=t,
        answers={"school": "Mount Hermon", "team": "MH A"}, title="Mount Hermon")
    map_response(resp)
    resp.refresh_from_db()
    assert Team.objects.filter(tournament=t, school="Mount Hermon").exists()
    assert resp.mapped_entities.get("team_ids")


def test_team_registration_builds_players_from_group():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = _team_reg_form(t)
    resp = FormResponse.objects.create(
        form=f, organization=t.organization, tournament=t,
        answers={
            "school": "Mount Hermon", "team": "MH A",
            "players": [
                {"pname": "Asha", "jersey_no": 7, "position": "FW", "dob_year": 2010},
                {"pname": "Beni"},  # only name
                {"jersey_no": 9},  # no name -> skipped
                "not-a-dict",  # skipped
            ],
        },
        title="Mount Hermon")
    map_response(resp)
    team = Team.objects.get(tournament=t, school="Mount Hermon")
    players = list(Player.objects.filter(team=team).select_related("person"))
    assert len(players) == 2
    asha = next(p for p in players if p.person.full_name == "Asha")
    assert asha.jersey_no == 7
    assert asha.position == "FW"
    assert asha.person.dob_year == 2010


def test_mapping_is_idempotent_skips_already_mapped():
    """A second map_response on an already-mapped row must NOT create more teams."""
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = _team_reg_form(t)
    resp = FormResponse.objects.create(
        form=f, organization=t.organization, tournament=t, event_id=uuid.uuid4(),
        answers={"school": "Mount Hermon", "team": "MH A"}, title="Mount Hermon")
    map_response(resp)
    first_count = Team.objects.filter(tournament=t, school="Mount Hermon").count()
    assert first_count == 1
    map_response(resp)  # replay
    resp.refresh_from_db()
    assert Team.objects.filter(tournament=t, school="Mount Hermon").count() == first_count


def test_org_registration_is_noop_mapping():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = Form.objects.create(organization=t.organization, tournament=t, slug="org", title="Org",
                            purpose="organization_registration",
                            schema={"version": 1, "sections": []})
    resp = FormResponse.objects.create(form=f, organization=t.organization, tournament=t,
                                       title="A School")
    map_response(resp)  # no exception; response itself is the participant record
    resp.refresh_from_db()
    assert Team.objects.filter(tournament=t).count() == 0


def test_generic_is_noop_mapping():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = Form.objects.create(organization=t.organization, tournament=t, slug="g", title="G",
                            purpose="generic", schema={"version": 1, "sections": []})
    resp = FormResponse.objects.create(form=f, organization=t.organization, tournament=t,
                                       title="Something")
    map_response(resp)
    assert Team.objects.filter(tournament=t).count() == 0


def test_team_registration_multi_category_creates_teams_with_players():
    """Auto-generated team form: one institution enters MULTIPLE teams per
    category, each with its own nested player roster."""
    from apps.teams.services.registration import get_or_create_institution

    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    inst = get_or_create_institution(tournament=t, name="Mount Hermon")
    f = Form.objects.create(
        organization=t.organization, tournament=t, slug="multi", title="Teams",
        purpose="team_registration",
        settings={"bindings": {
            "institution_id": "institution_id",
            "category_groups": [
                {"category": "u14", "group": "teams_u14", "team_name": "tn_u14",
                 "players_group": "players_u14", "player_name": "pn_u14"},
            ],
        }},
        schema={"version": 1, "sections": [{"key": "s", "title": "S", "fields": [
            {"key": "teams_u14", "type": "group", "label": "Team", "repeatable": True,
             "fields": [
                 {"key": "tn_u14", "type": "short_text", "label": "Team name"},
                 {"key": "players_u14", "type": "group", "label": "Player",
                  "repeatable": True, "fields": [
                      {"key": "pn_u14", "type": "short_text", "label": "Player name"}]},
             ]}]}]},
    )
    resp = FormResponse.objects.create(
        form=f, organization=t.organization, tournament=t, title="Mount Hermon",
        answers={
            "institution_id": str(inst.id),
            "teams_u14": [
                {"tn_u14": "MH A",
                 "players_u14": [{"pn_u14": "Asha"}, {"pn_u14": "Beni"}]},
                {"tn_u14": "MH B", "players_u14": [{"pn_u14": "Cara"}]},
            ],
        },
    )
    map_response(resp)

    teams = Team.objects.filter(tournament=t).order_by("name")
    assert [tm.name for tm in teams] == ["MH A", "MH B"]
    assert all(tm.pool == "u14" for tm in teams)
    mh_a = teams.get(name="MH A")
    assert sorted(
        p.person.full_name
        for p in Player.objects.filter(team=mh_a).select_related("person")
    ) == ["Asha", "Beni"]
    assert Player.objects.filter(team=teams.get(name="MH B")).count() == 1
