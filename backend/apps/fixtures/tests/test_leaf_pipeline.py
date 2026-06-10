"""End-to-end leaf pipeline (spec 2026-06-10): sports config → auto-generated
institution form → response mapping (institution leaves) → auto-generated team
form → team mapping (Team.sport/leaf_key) → per-leaf fixture generation
(Match.sport/leaf_key). This is the regression suite for breaks B1/B2/B4:
before the registry, teams were bucketed by the SPORT selector and Match.sport
always resolved to ''."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.fixtures.services.generate import generate_round_robin_by_category
from apps.forms.models import FormResponse
from apps.forms.services.generation import (
    generate_institution_form,
    generate_team_form_template,
)
from apps.forms.services.mapping import map_response
from apps.matches.models import Match
from apps.teams.models import Institution, Team
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()
pytestmark = pytest.mark.django_db

LEAF_5V5 = "football.u15.girls.5v5"
LEAF_U17 = "football.u17"
LEAF_TT = "table_tennis"


def _verified(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _tournament_with_sports():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Games")
    t.sports = normalize_sports([
        {"name": "Football", "nodes": [
            {"name": "U15", "children": [
                {"name": "Girls", "children": [{"name": "5v5"}]},
            ]},
            {"name": "U17"},
        ]},
        {"name": "Table Tennis"},
    ])
    t.save(update_fields=["sports"])
    return admin, t


def test_institution_form_carries_leaf_keys_and_settings_tags():
    admin, t = _tournament_with_sports()
    form = generate_institution_form(tournament=t, created_by=admin)
    fields = {f["key"]: f for sec in form.schema["sections"] for f in sec["fields"]}
    fb = fields["categories_football"]
    assert [o["value"] for o in fb["options"]] == [LEAF_5V5, LEAF_U17]
    assert [o["label"] for o in fb["options"]] == ["U15 — Girls — 5v5", "U17"]
    # sport without categories gets no category field (the sport IS the leaf)
    assert "categories_table_tennis" not in fields
    # structural tags for downstream consumers (no field-position guessing)
    assert form.settings["sports_field"] == "sports"
    assert form.settings["category_fields"] == {"football": "categories_football"}


def test_org_response_mapping_persists_institution_leaves():
    admin, t = _tournament_with_sports()
    form = generate_institution_form(tournament=t, created_by=admin)
    resp = FormResponse.objects.create(
        form=form, organization=t.organization, tournament=t,
        title="Don Bosco",
        answers={
            "school_name": "Don Bosco", "contact_name": "Fr. K",
            "contact_phone": "9999", "sports": ["football", "table_tennis"],
            "categories_football": [LEAF_5V5, LEAF_U17],
        },
    )
    map_response(resp)
    inst = Institution.objects.get(tournament=t, name="Don Bosco")
    # selected leaves stored structurally; bare sport selection = sport leaf
    assert inst.attributes["leaves"] == [LEAF_5V5, LEAF_U17, LEAF_TT]


def test_team_form_sections_come_from_sports_config_not_field_order():
    admin, t = _tournament_with_sports()
    generate_institution_form(tournament=t, created_by=admin)
    team_form = generate_team_form_template(tournament=t, created_by=admin)
    fields = {f["key"]: f for sec in team_form.schema["sections"]
              for f in sec["fields"]}
    cats = fields["categories"]
    # B2 regression: options are category LEAVES, never sport keys
    assert [o["value"] for o in cats["options"]] == [LEAF_5V5, LEAF_U17, LEAF_TT]
    assert [o["label"] for o in cats["options"]] == [
        "Football — U15 — Girls — 5v5", "Football — U17", "Table Tennis",
    ]
    groups = team_form.settings["bindings"]["category_groups"]
    assert [(g["sport_key"], g["leaf_key"]) for g in groups] == [
        ("football", LEAF_5V5), ("football", LEAF_U17),
        ("table_tennis", LEAF_TT),
    ]


def test_team_mapping_stamps_sport_and_leaf_then_fixtures_scope_per_leaf():
    admin, t = _tournament_with_sports()
    generate_institution_form(tournament=t, created_by=admin)
    team_form = generate_team_form_template(tournament=t, created_by=admin)
    groups = {g["leaf_key"]: g for g in
              team_form.settings["bindings"]["category_groups"]}
    g5, gtt = groups[LEAF_5V5], groups[LEAF_TT]

    def submit(school, teams_5v5, teams_tt):
        inst = Institution.objects.create(
            organization=t.organization, tournament=t,
            slug=school.lower().replace(" ", "-"), name=school,
        )
        resp = FormResponse.objects.create(
            form=team_form, organization=t.organization, tournament=t,
            title=school,
            answers={
                "institution_id": str(inst.id),
                "categories": [LEAF_5V5, LEAF_TT],
                g5["group"]: [{g5["team_name"]: n} for n in teams_5v5],
                gtt["group"]: [{gtt["team_name"]: n} for n in teams_tt],
            },
        )
        map_response(resp)

    submit("Don Bosco", ["DB Girls A"], ["DB TT"])
    submit("Mount Hermon", ["MH Girls A"], ["MH TT"])

    db_team = Team.objects.get(tournament=t, name="DB Girls A")
    assert db_team.sport == "football"
    assert db_team.leaf_key == LEAF_5V5
    assert db_team.pool == "Football — U15 — Girls — 5v5"  # display label
    tt_team = Team.objects.get(tournament=t, name="DB TT")
    assert (tt_team.sport, tt_team.leaf_key) == ("table_tennis", LEAF_TT)

    matches = generate_round_robin_by_category(tournament=t)
    assert len(matches) == 2  # one pairing per leaf, never cross-leaf
    by_leaf = {m.leaf_key: m for m in matches}
    assert set(by_leaf) == {LEAF_5V5, LEAF_TT}
    # B1 regression: Match.sport resolves through the registry (was always '')
    assert by_leaf[LEAF_5V5].sport == "football"
    assert by_leaf[LEAF_TT].sport == "table_tennis"
    assert by_leaf[LEAF_5V5].group_label == "Football — U15 — Girls — 5v5"
    pair = {by_leaf[LEAF_5V5].home_team.name, by_leaf[LEAF_5V5].away_team.name}
    assert pair == {"DB Girls A", "MH Girls A"}


def test_round_robin_no_longer_overwrites_team_pool():
    from apps.fixtures.services.generate import generate_round_robin
    from apps.teams.services.registration import register_school

    _admin, t = _tournament_with_sports()
    register_school(
        tournament=t, school_name="Don Bosco",
        teams=[{"name": "A", "pool": "U15 Girls", "players": []},
               {"name": "B", "pool": "U15 Girls", "players": []}],
    )
    generate_round_robin(tournament=t, group_size=5)
    assert set(Team.objects.filter(tournament=t)
               .values_list("pool", flat=True)) == {"U15 Girls"}
    assert Match.objects.filter(tournament=t).count() == 1
