"""The team form as a PICKER, once a tournament declares its people first
(spec 2026-08-17).

The same generator, the same traversal engine, the same mapper — what changes
is that a player row names a declared person instead of spelling one out, and
the teacher in charge becomes a real ``TeamStaff`` row the scheduler can read.
A tournament that never turned the layer on keeps the typed form exactly.
"""
from __future__ import annotations

import uuid as _uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.forms.services.forms import publish_form
from apps.forms.services.generation import generate_team_form_template
from apps.teams.models import (
    Institution,
    InstitutionStatus,
    Player,
    RosterMemberKind,
    Team,
    TeamStaff,
)
from apps.teams.services import roster as roster_svc
from apps.tournaments.models import RosterMode
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db

SPORTS = [{
    "key": "table_tennis", "name": "Table Tennis",
    "categories": [{"key": "u14", "name": "U14", "children": [
        {"key": "boys", "name": "Boys"},
    ]}],
}]
LEAF = "table_tennis.u14.boys"


def _user(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _fixture(slug, *, roster_first=True):
    t = create_tournament(user=_user(f"{slug}@test.local"), name=f"Cup {slug}")
    t.sports = SPORTS
    if roster_first:
        t.roster_mode = RosterMode.ROSTER_FIRST
    t.save(update_fields=["sports", "roster_mode"])
    inst = Institution.objects.create(
        organization=t.organization, tournament=t, slug=f"grace-{slug}",
        name="Grace School", status=InstitutionStatus.REGISTERED,
        contact_name="Fr. K", contact_email=f"{slug}@school.test",
        contact_phone="9876543210",
    )
    form = generate_team_form_template(tournament=t)
    publish_form(form)
    return t, inst, form


def _cg(form):
    return (form.settings or {})["bindings"]["category_groups"][0]


def _token(client, form, inst, mailoutbox):
    from django.core.cache import cache

    from apps.teams.services.access import issue_team_access_codes

    cache.clear()
    issue_team_access_codes(tournament=form.tournament, form=form)
    code = next(
        ln.strip() for ln in mailoutbox[-1].body.splitlines()
        if ln.strip().isalnum() and len(ln.strip()) == 8
    )
    r = client.post(
        f"/api/forms/{form.id}/team-access/",
        {"institution_id": str(inst.id), "code": code}, format="json",
    )
    assert r.status_code == 200, r.data
    return r


def _all_fields(schema):
    out = []

    def walk(fields):
        for f in fields:
            out.append(f)
            if f.get("type") == "group":
                walk(f.get("fields", []))

    for sec in schema.get("sections", []):
        walk(sec.get("fields", []))
    return out


# ------------------------------------------------------------------- schema
def test_the_player_row_picks_instead_of_asking_again():
    _t, _inst, form = _fixture("pick")
    keys = {f["key"]: f for f in _all_fields(form.schema)}
    cg = _cg(form)

    picker = keys[cg["player_member"]]
    assert picker["type"] == "dropdown"
    # Bound to the participants sheet at the top of THIS form (owner
    # 2026-08-17), so the list is what the school just typed — no second form
    # to publish and no roster to wait for.
    assert picker["data_source"] == {
        "type": "form_group",
        "group": "participant_students",
        "value_field": "participant_id",
        "label_field": "participant_name",
    }
    # The questions the participants sheet already answered are gone.
    assert cg["player_name"] not in keys
    assert cg["player_dob"] not in keys


def test_the_teacher_in_charge_is_picked_too():
    _t, _inst, form = _fixture("staff")
    keys = {f["key"]: f for f in _all_fields(form.schema)}
    cg = _cg(form)
    assert keys[cg["staff_member"]]["data_source"] == {
        "type": "form_group",
        "group": "participant_staff",
        "value_field": "staff_id",
        "label_field": "staff_full_name",
    }
    # It REPLACES the free-text coach group — asking for both would collect the
    # same teacher twice, under two identities.
    assert cg["coach_name"] not in keys


def test_a_tournament_that_types_names_is_untouched():
    _t, _inst, form = _fixture("typed", roster_first=False)
    keys = {f["key"] for f in _all_fields(form.schema)}
    cg = _cg(form)
    assert cg["player_name"] in keys and cg["coach_name"] in keys
    assert "player_member" not in cg and "staff_group" not in cg


def test_the_public_schema_never_carries_a_child_s_name():
    t, inst, form = _fixture("pii")
    roster_svc.declare_member(tournament=t, institution=inst, full_name="Imli Jamir")
    r = APIClient().get(f"/api/forms/{form.id}/public/")
    assert r.status_code == 200
    assert "Imli Jamir" not in str(r.data)
    cg = _cg(form)
    picker = next(
        f for f in _all_fields(r.data["form"]["schema"])
        if f["key"] == cg["player_member"]
    )
    assert picker["options"] == []


# ------------------------------------------------------------------ mapping
def test_a_picked_squad_becomes_players_and_staff(mailoutbox):
    client = APIClient()
    t, inst, form = _fixture("map")
    one = roster_svc.declare_member(
        tournament=t, institution=inst, full_name="Imli Jamir", roll_no="21",
    )
    two = roster_svc.declare_member(
        tournament=t, institution=inst, full_name="Toshi Ao", roll_no="22",
    )
    teacher = roster_svc.declare_member(
        tournament=t, institution=inst, full_name="Mr Ao",
        kind=RosterMemberKind.TEACHER,
    )
    access = _token(client, form, inst, mailoutbox)
    # The pickers arrived with the authorization, not with the public schema.
    assert {o["value"] for o in access.data["roster"]["students"]} == {
        str(one.id), str(two.id)
    }
    assert [o["value"] for o in access.data["roster"]["teachers"]] == [str(teacher.id)]

    cg = _cg(form)
    r = client.post(f"/api/forms/{form.id}/public/", {
        "event_id": str(_uuid.uuid4()),
        "access_token": access.data["access_token"],
        "answers": {
            "institution_id": str(inst.id),
            "sports": ["table_tennis"],
            "categories_table_tennis": [LEAF],
            cg["group"]: [{
                cg["team_name"]: "Grace A",
                cg["staff_group"]: [{cg["staff_member"]: str(teacher.id)}],
                cg["players_group"]: [
                    {cg["player_member"]: str(one.id), cg["player_jersey"]: 7},
                    {cg["player_member"]: str(two.id)},
                ],
            }],
        },
    }, format="json")
    assert r.status_code == 201, r.data

    team = Team.objects.get(tournament=t, name="Grace A")
    assert team.leaf_key == LEAF
    players = Player.objects.filter(team=team).select_related("person")
    assert {p.person.full_name for p in players} == {"Imli Jamir", "Toshi Ao"}
    assert players.get(person=one.person).jersey_no == 7
    assert [s.member_id for s in TeamStaff.objects.filter(team=team)] == [teacher.id]


def test_two_teams_under_one_teacher_reach_the_scheduler(mailoutbox):
    """End to end: the owner's rule — "the teacher in-charges of the school
    cannot be in two courts" — arriving from a public submission."""
    from apps.fixtures.services.scheduler import (
        ScheduleConfig,
        build_schedule_inputs,
        merge_stored_constraints,
    )

    client = APIClient()
    t, inst, form = _fixture("link")
    t.sports = [{
        "key": "table_tennis", "name": "Table Tennis",
        "categories": [{"key": "u14", "name": "U14", "children": [
            {"key": "boys", "name": "Boys"}, {"key": "girls", "name": "Girls"},
        ]}],
    }]
    t.save(update_fields=["sports"])
    form.delete()
    form = generate_team_form_template(tournament=t)
    publish_form(form)

    teacher = roster_svc.declare_member(
        tournament=t, institution=inst, full_name="Mr Ao",
        kind=RosterMemberKind.TEACHER,
    )
    access = _token(client, form, inst, mailoutbox)
    groups = (form.settings or {})["bindings"]["category_groups"]
    answers = {
        "institution_id": str(inst.id),
        "sports": ["table_tennis"],
        "categories_table_tennis": [
            "table_tennis.u14.boys", "table_tennis.u14.girls",
        ],
    }
    for i, cg in enumerate(groups):
        answers[cg["group"]] = [{
            cg["team_name"]: f"Grace {i}",
            cg["staff_group"]: [{cg["staff_member"]: str(teacher.id)}],
            cg["players_group"]: [],
        }]
    r = client.post(f"/api/forms/{form.id}/public/", {
        "event_id": str(_uuid.uuid4()),
        "access_token": access.data["access_token"],
        "answers": answers,
    }, format="json")
    assert r.status_code == 201, r.data

    import datetime as _dt

    cfg = ScheduleConfig(
        date_start=_dt.date(2026, 8, 1), date_end=_dt.date(2026, 8, 1),
        daily_start=_dt.time(9, 0), daily_end=_dt.time(18, 0),
        slot_minutes=30, venues=["A"],
    )
    merge_stored_constraints(
        cfg, [{"type": "no_staff_overlap", "scope": "all", "params": {}}]
    )
    _reqs, _pre, linked = build_schedule_inputs(t, cfg)
    ids = {str(x.id) for x in Team.objects.filter(tournament=t)}
    assert len(ids) == 2
    a, b = sorted(ids)
    assert linked.get(a) == {b} and linked.get(b) == {a}


def test_a_stale_pick_is_refused_rather_than_silently_dropped(mailoutbox):
    """A participant withdrawn between opening the form and submitting it must
    fail loudly — a squad quietly one player short is worse than an error."""
    client = APIClient()
    t, inst, form = _fixture("stale")
    m = roster_svc.declare_member(
        tournament=t, institution=inst, full_name="Imli Jamir",
    )
    access = _token(client, form, inst, mailoutbox)
    roster_svc.withdraw_member(member=m)

    cg = _cg(form)
    r = client.post(f"/api/forms/{form.id}/public/", {
        "event_id": str(_uuid.uuid4()),
        "access_token": access.data["access_token"],
        "answers": {
            "institution_id": str(inst.id),
            "sports": ["table_tennis"],
            "categories_table_tennis": [LEAF],
            cg["group"]: [{
                cg["team_name"]: "Grace A",
                cg["players_group"]: [{cg["player_member"]: str(m.id)}],
            }],
        },
    }, format="json")
    assert r.status_code == 400, r.data
    assert "participant_not_in_roster" in str(r.data)
    assert Team.objects.filter(tournament=t).count() == 0
