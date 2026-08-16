"""The within-school registration form (spec 2026-08-16 §D6).

No Stage 1 exists in an intra-school event, so ONE generated form is the whole
registration: which house, the competition chain, then the students. Same
generator, same bindings contract, same mapper — only the competitor question
and the person fields differ.
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.forms.constants import FormStatus
from apps.forms.services.forms import publish_form
from apps.forms.services.generation import generate_team_form_template
from apps.teams.models import Person, Team
from apps.teams.services import houses as house_svc
from apps.tournaments.models import TournamentScope
from apps.tournaments.models import TournamentStage as G
from apps.tournaments.services import state as st
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()
pytestmark = pytest.mark.django_db

SPORTS = [{
    "name": "Table Tennis",
    "nodes": [{"name": "U14", "children": [{"name": "Boys"}, {"name": "Girls"}]}],
}]


def _user(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _meet(owner, name="Sports Day"):
    t = create_tournament(
        user=owner, name=name, scope=TournamentScope.INTRA_SCHOOL,
    )
    t.sports = normalize_sports(SPORTS)
    t.save(update_fields=["sports"])
    return t


def _open_registration(t):
    st.transition_tournament(tournament=t, to_stage=G.HOUSE_SETUP, ack_warnings=True)
    blue = house_svc.create_house(tournament=t, name="Blue")
    green = house_svc.create_house(tournament=t, name="Green")
    st.transition_tournament(
        tournament=t, to_stage=G.TEAM_REGISTRATION, ack_warnings=True,
    )
    return blue, green


def _form(t):
    form = generate_team_form_template(tournament=t)
    publish_form(form=form)
    form.refresh_from_db()
    assert form.status == FormStatus.OPEN
    return form


def _leaf(t, gender):
    from apps.tournaments.services.sports import iter_leaves

    return next(
        leaf["leaf_key"] for leaf in iter_leaves(t.sports)
        if leaf["leaf_key"].endswith(gender)
    )


def _group_keys(form, leaf):
    for cg in (form.settings or {})["bindings"]["category_groups"]:
        if cg.get("leaf_key") == leaf:
            return cg
    raise AssertionError(f"no category group for {leaf}")


# ------------------------------------------------------------------ generation
def test_the_form_asks_for_a_house_not_a_school():
    owner = _user("gen@house.form")
    t = _meet(owner)
    _open_registration(t)
    form = _form(t)

    first = form.schema["sections"][0]
    keys = [f["key"] for f in first["fields"]]
    assert "house_id" in keys
    assert "institution_id" not in keys
    house_field = next(f for f in first["fields"] if f["key"] == "house_id")
    assert house_field["data_source"] == {"type": "house_list"}
    assert house_field["required"] is True
    assert "house" in house_field["label"].lower()

    b = form.settings["bindings"]
    assert b["competitor_kind"] == "house"
    assert b["competitor_id"] == "house_id"


def test_the_noun_follows_what_the_host_chose():
    owner = _user("noun@house.form")
    t = create_tournament(
        user=owner, name="Inter-class", scope=TournamentScope.INTRA_SCHOOL,
        group_kind="class",
    )
    t.sports = normalize_sports(SPORTS)
    t.save(update_fields=["sports"])
    form = generate_team_form_template(tournament=t)
    label = form.schema["sections"][0]["fields"][0]["label"]
    assert "class" in label.lower()


def _find_field(schema, key):
    """Depth-first: the players group is nested inside the team group."""
    def walk(fields):
        for f in fields:
            if f.get("key") == key:
                return f
            if f.get("type") == "group":
                hit = walk(f.get("fields", []))
                if hit is not None:
                    return hit
        return None

    for sec in schema["sections"]:
        hit = walk(sec["fields"])
        if hit is not None:
            return hit
    raise AssertionError(f"no field {key}")


def _chain_answers(form, leaf):
    """The progressive sport -> category answers that reveal a leaf's section:
    every option whose value is the leaf or an ancestor of it."""
    out = {}
    for f in form.schema["sections"][0]["fields"]:
        picks = [
            o["value"] for o in f.get("options", []) or []
            if leaf == o["value"] or leaf.startswith(str(o["value"]) + ".")
        ]
        if picks:
            out[f["key"]] = picks
    return out


def test_the_student_fields_are_school_internal():
    owner = _user("fields@house.form")
    t = _meet(owner)
    _open_registration(t)
    form = _form(t)

    boys = _leaf(t, "boys")
    cg = _group_keys(form, boys)
    group = _find_field(form.schema, cg["players_group"])
    keys = [f["key"] for f in group["fields"]]
    assert any(k.startswith("player_class_") for k in keys)
    assert any(k.startswith("player_roll_") for k in keys)
    assert any("Student name" == f["label"] for f in group["fields"])


def test_the_school_form_is_completely_unchanged():
    """The negative test that matters: an inter-school event still generates
    exactly the institution-bound form it always did."""
    owner = _user("inter@house.form")
    t = create_tournament(user=owner, name="Inter Cup")
    t.sports = normalize_sports(SPORTS)
    t.save(update_fields=["sports"])
    form = generate_team_form_template(tournament=t)

    keys = [f["key"] for f in form.schema["sections"][0]["fields"]]
    assert "institution_id" in keys
    assert "house_id" not in keys
    field = form.schema["sections"][0]["fields"][0]
    assert field["data_source"] == {"type": "institution_list"}
    b = form.settings["bindings"]
    assert b["competitor_kind"] == "institution"
    assert b["institution_id"] == "institution_id"
    # And no school-internal student fields leaked in.
    dumped = str(form.schema)
    assert "player_class_" not in dumped
    assert "player_roll_" not in dumped


# ------------------------------------------------------------------ data source
def test_the_public_form_lists_the_houses_that_are_actually_playing():
    owner = _user("src@house.form")
    t = _meet(owner)
    blue, green = _open_registration(t)
    form = _form(t)

    r = APIClient().get(f"/api/forms/{form.id}/public/")
    assert r.status_code == 200, r.data
    field = next(
        f for s in r.data["form"]["schema"]["sections"] for f in s["fields"]
        if f["key"] == "house_id"
    )
    assert sorted(o["label"] for o in field["options"]) == ["Blue", "Green"]
    assert {o["value"] for o in field["options"]} == {str(blue.id), str(green.id)}
    # No access code in this flow — a house captain is a member, not a secret.
    assert all(o["requires_code"] is False for o in field["options"])


# ------------------------------------------------------------------ submission
def _payload(form, t, house_id, leaf, team_name, students):
    cg = _group_keys(form, leaf)
    slug = cg["players_group"].removeprefix("players_")
    rows = []
    for i, s in enumerate(students):
        rows.append({
            cg["player_name"]: s,
            # The within-school form asks a school's own questions.
            f"player_class_{slug}": f"9-{'AB'[i % 2]}",
            cg["player_dob"]: "2013-05-0%d" % (i + 1),
        })
    return {
        "house_id": str(house_id),
        **_chain_answers(form, leaf),
        cg["group"]: [{
            cg["team_name"]: team_name,
            cg["players_group"]: rows,
        }],
    }


def test_a_house_captain_registers_their_own_house_and_only_theirs():
    owner = _user("submit@house.form")
    t = _meet(owner)
    blue, green = _open_registration(t)
    form = _form(t)
    boys = _leaf(t, "boys")

    captain = _user("captain@house.form")
    house_svc.add_house_member(tournament=t, group=blue, user=captain, by=owner)

    c = APIClient()
    c.force_authenticate(user=captain)
    r = c.post(
        f"/api/forms/{form.id}/public/",
        {
            "answers": _payload(form, t, blue.id, boys, "", ["Imli", "Along"]),
            "event_id": str(uuid.uuid4()),
        },
        format="json",
    )
    assert r.status_code == 201, r.data

    team = Team.objects.get(tournament=t, leaf_key=boys)
    assert team.group_id == blue.id
    # A blank team name adopts the HOUSE, never the one shared school.
    assert team.name == "Blue"
    assert team.institution is not None
    assert team.players.count() == 2

    # The same captain cannot register Green.
    r = c.post(
        f"/api/forms/{form.id}/public/",
        {
            "answers": _payload(form, t, green.id, boys, "", ["Toshi"]),
            "event_id": str(uuid.uuid4()),
        },
        format="json",
    )
    assert r.status_code == 400
    assert r.data["detail"] == "house_access_required"


def test_two_students_of_the_same_name_in_different_houses_stay_two_people():
    """With one shared institution, name-matching inside it would merge them."""
    owner = _user("dedupe@house.form")
    t = _meet(owner)
    blue, green = _open_registration(t)
    form = _form(t)
    boys = _leaf(t, "boys")

    c = APIClient()
    c.force_authenticate(user=owner)
    for house in (blue, green):
        r = c.post(
            f"/api/forms/{form.id}/public/",
            {
                "answers": _payload(form, t, house.id, boys, house.name, ["Imliyanger Jamir"]),
                "event_id": str(uuid.uuid4()),
            },
            format="json",
        )
        assert r.status_code == 201, r.data

    people = Person.objects.filter(
        players__tournament=t, full_name="Imliyanger Jamir"
    ).distinct()
    assert people.count() == 2, "the two houses' students collapsed into one Person"


def test_every_house_gets_its_own_team_name_rather_than_fighting_over_the_school():
    owner = _user("names@house.form")
    t = _meet(owner)
    blue, green = _open_registration(t)
    form = _form(t)
    boys = _leaf(t, "boys")

    c = APIClient()
    c.force_authenticate(user=owner)
    for house in (blue, green):
        r = c.post(
            f"/api/forms/{form.id}/public/",
            {
                "answers": _payload(form, t, house.id, boys, "", ["A", "B"]),
                "event_id": str(uuid.uuid4()),
            },
            format="json",
        )
        assert r.status_code == 201, r.data

    names = sorted(
        Team.objects.filter(tournament=t, leaf_key=boys).values_list("name", flat=True)
    )
    assert names == ["Blue", "Green"]
    # Not "St Mary's" / "St Mary's 2" — which is what defaulting to the one
    # shared institution used to produce.
    assert not any(n.endswith(" 2") for n in names)


def test_an_unknown_house_is_refused():
    owner = _user("bad@house.form")
    t = _meet(owner)
    _open_registration(t)
    form = _form(t)
    boys = _leaf(t, "boys")

    c = APIClient()
    c.force_authenticate(user=owner)
    r = c.post(
        f"/api/forms/{form.id}/public/",
        {
            "answers": _payload(form, t, uuid.uuid4(), boys, "X", ["A"]),
            "event_id": str(uuid.uuid4()),
        },
        format="json",
    )
    assert r.status_code == 400
