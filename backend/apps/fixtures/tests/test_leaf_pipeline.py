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


def test_institution_form_branches_per_level_with_settings_tags():
    """W2-A: one question per BRANCH level (progressive disclosure), not one
    flat field stacking every leaf."""
    admin, t = _tournament_with_sports()
    form = generate_institution_form(tournament=t, created_by=admin)
    fields = {f["key"]: f for sec in form.schema["sections"] for f in sec["fields"]}

    top = fields["categories_football"]
    assert [o["value"] for o in top["options"]] == ["football.u15", LEAF_U17]
    assert [o["label"] for o in top["options"]] == ["U15", "U17"]
    assert top["visibility"] == {"field": "sports", "op": "includes",
                                 "value": "football"}

    mid = fields["categories_football_u15"]
    assert [o["value"] for o in mid["options"]] == ["football.u15.girls"]
    assert mid["visibility"] == {"field": "categories_football", "op": "includes",
                                 "value": "football.u15"}

    deep = fields["categories_football_u15_girls"]
    assert [o["value"] for o in deep["options"]] == [LEAF_5V5]
    assert deep["visibility"] == {"field": "categories_football_u15",
                                  "op": "includes", "value": "football.u15.girls"}

    # sport without categories gets no category field (the sport IS the leaf)
    assert "categories_table_tennis" not in fields
    # structural tags for downstream consumers (no field-position guessing)
    assert form.settings["sports_field"] == "sports"
    assert form.settings["category_fields"] == {"football": "categories_football"}
    assert form.settings["category_fields_all"] == {"football": [
        "categories_football", "categories_football_u15",
        "categories_football_u15_girls",
    ]}
    assert set(form.settings["leaf_values"]) == {LEAF_5V5, LEAF_U17, LEAF_TT}


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


def test_branching_validates_required_on_visible_and_maps_deep_leaves():
    """W2-A end-to-end: a respondent walks the chain (sport → U15 → Girls →
    5v5); validation forces every OPENED branch to be answered; mapping keeps
    only real leaves (branch picks are navigation, not entries)."""
    from apps.forms.services.validation import AnswerError, validate_answers

    admin, t = _tournament_with_sports()
    form = generate_institution_form(tournament=t, created_by=admin)

    full = {
        "school_name": "St. Mary", "contact_name": "Sr. A",
        "contact_phone": "9876543210",
        "sports": ["football"],
        "categories_football": ["football.u15", LEAF_U17],
        "categories_football_u15": ["football.u15.girls"],
        "categories_football_u15_girls": [LEAF_5V5],
    }
    clean = validate_answers(form.schema, full)
    assert clean["categories_football_u15_girls"] == [LEAF_5V5]

    # opened U15 but never picked within it → the visible chain field is
    # required, so the submission is rejected (no silent half-entries)
    partial = {**full}
    del partial["categories_football_u15"], partial["categories_football_u15_girls"]
    with pytest.raises(AnswerError):
        validate_answers(form.schema, partial)

    resp = FormResponse.objects.create(
        form=form, organization=t.organization, tournament=t,
        title="St. Mary", answers=clean,
    )
    map_response(resp)
    inst = Institution.objects.get(tournament=t, name="St. Mary")
    # football.u15 / football.u15.girls are branches — only leaves persist
    # (field-walk order: the top-level pick lands before deeper ones)
    assert inst.attributes["leaves"] == [LEAF_U17, LEAF_5V5]


def test_team_form_sections_come_from_sports_config_not_field_order():
    admin, t = _tournament_with_sports()
    generate_institution_form(tournament=t, created_by=admin)
    team_form = generate_team_form_template(tournament=t, created_by=admin)
    fields = {f["key"]: f for sec in team_form.schema["sections"]
              for f in sec["fields"]}
    # W2-A: the selector is the progressive sport→category chain.
    assert [o["value"] for o in fields["sports"]["options"]] == [
        "football", "table_tennis",
    ]
    deep = fields["categories_football_u15_girls"]
    assert [o["value"] for o in deep["options"]] == [LEAF_5V5]
    # Each leaf's team section gates on the DEEPEST field carrying that leaf.
    by_vis = {
        (s.get("visibility") or {}).get("value"): s
        for s in team_form.schema["sections"]
        if s.get("visibility")
    }
    assert by_vis[LEAF_5V5]["visibility"]["field"] == "categories_football_u15_girls"
    assert by_vis[LEAF_U17]["visibility"]["field"] == "categories_football"
    # Sport-level leaf: ticking the sport reveals its team section.
    assert by_vis[LEAF_TT]["visibility"]["field"] == "sports"
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
    assert db_team.pool == "Football · U15 · Girls · 5v5"  # display label
    tt_team = Team.objects.get(tournament=t, name="DB TT")
    assert (tt_team.sport, tt_team.leaf_key) == ("table_tennis", LEAF_TT)

    matches = generate_round_robin_by_category(tournament=t)
    assert len(matches) == 2  # one pairing per leaf, never cross-leaf
    by_leaf = {m.leaf_key: m for m in matches}
    assert set(by_leaf) == {LEAF_5V5, LEAF_TT}
    # B1 regression: Match.sport resolves through the registry (was always '')
    assert by_leaf[LEAF_5V5].sport == "football"
    assert by_leaf[LEAF_TT].sport == "table_tennis"
    assert by_leaf[LEAF_5V5].group_label == "Football · U15 · Girls · 5v5"
    pair = {by_leaf[LEAF_5V5].home_team.name, by_leaf[LEAF_5V5].away_team.name}
    assert pair == {"DB Girls A", "MH Girls A"}


def test_leaves_generate_independently_via_api():
    """Per-leaf generation (spec P3): drawing one competition never blocks the
    others, repeats are idempotent, and formats can differ per leaf."""
    from rest_framework.test import APIClient

    admin, t = _tournament_with_sports()
    generate_institution_form(tournament=t, created_by=admin)
    team_form = generate_team_form_template(tournament=t, created_by=admin)
    groups = {g["leaf_key"]: g for g in
              team_form.settings["bindings"]["category_groups"]}
    g5, gtt = groups[LEAF_5V5], groups[LEAF_TT]
    for school, five, tts in (
        ("A School", ["A1", "A2", "A3"], ["A TT"]),
        ("B School", [], ["B TT"]),
    ):
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
                g5["group"]: [{g5["team_name"]: n} for n in five],
                gtt["group"]: [{gtt["team_name"]: n} for n in tts],
            },
        )
        map_response(resp)

    c = APIClient()
    c.force_authenticate(user=admin)
    # knockout (with a bye: 3 teams) for the football leaf only
    r1 = c.post(
        f"/api/tournaments/{t.id}/generate-fixtures/",
        {"format": "knockout", "leaf_key": LEAF_5V5},
        format="json",
    )
    assert r1.status_code == 201, r1.content
    assert r1.json()["generated"] == 2  # semi + final (one bye)
    assert Match.objects.filter(tournament=t, leaf_key=LEAF_5V5).count() == 2

    # the TT leaf still generates afterwards — round robin this time
    r2 = c.post(
        f"/api/tournaments/{t.id}/generate-fixtures/",
        {"format": "by_category", "leaf_key": LEAF_TT},
        format="json",
    )
    assert r2.status_code == 201, r2.content
    tt_matches = Match.objects.filter(tournament=t, leaf_key=LEAF_TT)
    assert tt_matches.count() == 1
    assert tt_matches.first().sport == "table_tennis"

    # repeating a leaf is idempotent — nothing duplicates
    r3 = c.post(
        f"/api/tournaments/{t.id}/generate-fixtures/",
        {"format": "by_category", "leaf_key": LEAF_TT},
        format="json",
    )
    assert r3.status_code == 201
    assert Match.objects.filter(tournament=t).count() == 3


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
