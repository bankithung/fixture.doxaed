"""The participants sheet lives INSIDE the team form (owner 2026-08-17).

Participants-first used to mean a SECOND form: a separate sheet an organizer
published, each school code-verified again, before the pickers on the team form
had anything in them. In practice that left every dropdown empty with no way to
fill it from where you were standing.

The school now declares its people in step one of the team form and picks them
in the steps that follow — one visit, one gate, one submission.
"""
from __future__ import annotations

import pytest

from apps.forms.services.generation import generate_team_form_template
from apps.forms.services.mapping import map_response
from apps.teams.models import (
    Institution,
    InstitutionStatus,
    Player,
    RosterMember,
    Team,
    TeamStaff,
)
from apps.tournaments.services.create import create_tournament

pytestmark = pytest.mark.django_db


def _verified(email="a@test.local"):
    from django.contrib.auth import get_user_model
    from django.utils import timezone

    U = get_user_model()
    return U.objects.create_user(
        email=email, password="pw12345!", email_verified_at=timezone.now(),
    )


def _tournament(**kw):
    t = create_tournament(user=_verified(), name="Meet", roster_mode="roster_first", **kw)
    t.sports = [{
        "key": "table_tennis", "name": "Table Tennis",
        "categories": [{
            "key": "u14", "name": "U14",
            "children": [
                {"key": "boys", "name": "Boys",
                 "children": [{"key": "singles", "name": "Singles",
                               "kind": "format",
                               "format": {"players_per_side": 1, "squad_max": 2}}]},
            ],
        }],
    }]
    t.save(update_fields=["sports"])
    return t


def _school(t, name="Grace Academy", slug="grace"):
    return Institution.objects.create(
        organization=t.organization, tournament=t, slug=slug, name=name,
        status=InstitutionStatus.REGISTERED,
    )


def _submit(form, answers, institution):
    from apps.forms.models import FormResponse

    resp = FormResponse.objects.create(
        organization=form.organization, form=form, tournament=form.tournament,
        answers=answers,
    )
    return map_response(resp)


# ------------------------------------------------------------------ schema
def test_the_team_form_carries_its_own_participants_sheet():
    t = _tournament()
    form = generate_team_form_template(tournament=t)
    keys = [s["key"] for s in form.schema["sections"]]
    # It comes BEFORE any competition: you declare, then you pick.
    assert keys.index("participants") < keys.index(
        next(k for k in keys if k.startswith("cat_"))
    )
    section = next(s for s in form.schema["sections"] if s["key"] == "participants")
    groups = {g["key"]: g for g in section["fields"]}
    # The logo is asked ONCE here rather than on every team (owner 2026-08-17).
    assert set(groups) == {
        "participant_students", "participant_staff", "team_logo",
    }
    assert groups["team_logo"]["type"] == "file_upload"
    # Each row mints its own identity, which is what a pick points at.
    assert groups["participant_students"]["row_key"] == "participant_id"
    assert groups["participant_staff"]["row_key"] == "staff_id"


def test_the_pickers_are_bound_to_that_sheet_not_to_a_published_roster():
    t = _tournament()
    form = generate_team_form_template(tournament=t)
    found = []

    def walk(fields):
        for f in fields:
            if (f.get("data_source") or {}).get("type") == "form_group":
                found.append(f["data_source"])
            walk(f.get("fields") or [])

    for s in form.schema["sections"]:
        walk(s["fields"])
    assert found, "no in-form pickers were generated"
    groups = {d["group"] for d in found}
    assert groups == {"participant_students", "participant_staff"}
    # Nothing still points at the separately-published sheet.
    assert all(d["type"] == "form_group" for d in found)


def test_an_inline_tournament_gets_no_participants_sheet():
    """Everything here is opt-in: a typed-name tournament is untouched."""
    t = create_tournament(user=_verified("b@test.local"), name="Plain")
    t.sports = [{"key": "table_tennis", "name": "Table Tennis",
                 "categories": [{"key": "u14", "name": "U14"}]}]
    t.save(update_fields=["sports"])
    form = generate_team_form_template(tournament=t)
    assert "participants" not in [s["key"] for s in form.schema["sections"]]
    assert "participants" not in (form.settings or {}).get("bindings", {})


# ------------------------------------------------------------------ mapping
def _answers(form, inst, *, students, staff, picks, staff_picks=(), team="Grace A"):
    """One submission: a participants sheet, then a team picking from it.

    Field keys are read from the form's OWN bindings rather than spelled out,
    so the test exercises whatever the generator actually emitted.
    """
    b = (form.settings or {})["bindings"]
    cg = b["category_groups"][0]
    return {
        "institution_id": str(inst.id),
        "participant_students": students,
        "participant_staff": staff,
        cg["group"]: [{
            cg["team_name"]: team,
            cg["players_group"]: [
                {cg["player_member"]: p} for p in picks
            ],
            cg["staff_group"]: [
                {cg["staff_member"]: s} for s in staff_picks
            ],
        }],
    }


def test_one_submission_declares_the_people_then_fields_them():
    t = _tournament()
    inst = _school(t)
    form = generate_team_form_template(tournament=t)
    form.status = "open"
    form.save(update_fields=["status"])

    _submit(form, _answers(
        form, inst,
        students=[
            {"participant_id": "r1", "participant_name": "Imli Jamir",
             "participant_class": "8-A", "participant_roll": "12",
             "participant_gender": "male", "participant_dob": "2012-03-04"},
            {"participant_id": "r2", "participant_name": "Toshi Ao",
             "participant_class": "9-B", "participant_roll": "3"},
        ],
        staff=[{"staff_id": "s1", "staff_full_name": "Mr Ao",
                "staff_phone": "9876500000"}],
        picks=["r1"],
        staff_picks=["s1"],
    ), inst)

    # Everyone on the sheet is declared, including the one not yet fielded.
    declared = RosterMember.objects.filter(tournament=t, deleted_at__isnull=True)
    assert {m.person.full_name for m in declared} == {
        "Imli Jamir", "Toshi Ao", "Mr Ao",
    }
    # Stored against the SCHOOL that entered them, with every detail typed —
    # this list is what the organizer reads and what the draw reasons over, so
    # a dropped column is a person the schedule cannot see properly.
    assert all(m.institution_id == inst.id for m in declared)
    imli = declared.get(person__full_name="Imli Jamir")
    assert imli.institution.name == "Grace Academy"
    assert imli.roll_no == "12"
    assert imli.class_section == "8-A"
    assert imli.gender == "male"
    assert str(imli.date_of_birth) == "2012-03-04"
    assert imli.kind == "student"
    assert declared.get(person__full_name="Mr Ao").kind == "teacher"
    assert declared.get(person__full_name="Mr Ao").contact_phone == "9876500000"

    # …and the team fields the person that sheet introduced, by identity.
    team = Team.objects.get(tournament=t, deleted_at__isnull=True)
    player = Player.objects.get(team=team)
    assert player.person.full_name == "Imli Jamir"
    assert player.person_id == declared.get(person__full_name="Imli Jamir").person_id
    assert TeamStaff.objects.get(team=team).member.person.full_name == "Mr Ao"


def test_two_same_named_students_stay_two_people():
    """The whole reason a pick carries a row id and not a name."""
    t = _tournament()
    inst = _school(t)
    form = generate_team_form_template(tournament=t)
    form.status = "open"
    form.save(update_fields=["status"])

    _submit(form, _answers(
        form, inst,
        students=[
            {"participant_id": "r1", "participant_name": "Imli Jamir",
             "participant_roll": "12"},
            {"participant_id": "r2", "participant_name": "Imli Jamir",
             "participant_roll": "48"},
        ],
        staff=[],
        picks=["r2"],
    ), inst)

    declared = RosterMember.objects.filter(tournament=t, deleted_at__isnull=True)
    assert declared.count() == 2
    assert {m.roll_no for m in declared} == {"12", "48"}
    # The team got the one it actually picked, not "the first Imli".
    player = Player.objects.get(team=Team.objects.get(tournament=t))
    assert player.person_id == declared.get(roll_no="48").person_id


def test_a_pick_that_names_nobody_is_refused_not_guessed():
    t = _tournament()
    inst = _school(t)
    form = generate_team_form_template(tournament=t)
    form.status = "open"
    form.save(update_fields=["status"])

    from django.core.exceptions import ValidationError

    with pytest.raises(ValidationError, match="participant_not_in_roster"):
        _submit(form, _answers(
            form, inst,
            students=[{"participant_id": "r1", "participant_name": "Imli Jamir"}],
            staff=[],
            picks=["r-does-not-exist"],
        ), inst)
    # Nothing was written: the sheet and the teams share one transaction.
    assert not Team.objects.filter(tournament=t, deleted_at__isnull=True).exists()


def test_a_half_typed_row_is_not_a_person():
    t = _tournament()
    inst = _school(t)
    form = generate_team_form_template(tournament=t)
    form.status = "open"
    form.save(update_fields=["status"])

    _submit(form, _answers(
        form, inst,
        students=[
            {"participant_id": "r1", "participant_name": "Imli Jamir"},
            {"participant_id": "r2", "participant_name": "   "},
            {"participant_id": "r3"},
        ],
        staff=[],
        picks=["r1"],
    ), inst)
    assert RosterMember.objects.filter(
        tournament=t, deleted_at__isnull=True,
    ).count() == 1


def test_resubmitting_the_sheet_updates_people_instead_of_doubling_them():
    t = _tournament()
    inst = _school(t)
    form = generate_team_form_template(tournament=t)
    form.status = "open"
    form.save(update_fields=["status"])

    _submit(form, _answers(
        form, inst,
        students=[{"participant_id": "r1", "participant_name": "Imli Jamir",
                   "participant_roll": "12", "participant_class": "8-A"}],
        staff=[],
        picks=["r1"],
    ), inst)
    # Same school, same roll, corrected class — and a brand new set of row ids,
    # because the browser mints them fresh on every visit.
    _submit(form, _answers(
        form, inst,
        students=[{"participant_id": "zz9", "participant_name": "Imli Jamir",
                   "participant_roll": "12", "participant_class": "8-B"}],
        staff=[],
        picks=["zz9"],
        # A different team, because superseding a prior set is the
        # access-code path's job — this test is about the PEOPLE.
        team="Grace B",
    ), inst)

    members = RosterMember.objects.filter(tournament=t, deleted_at__isnull=True)
    assert members.count() == 1
    assert members.first().class_section == "8-B"


# ------------------------------------- sports only, and papers per student
def test_a_student_is_asked_for_sports_only_never_categories():
    """Owner 2026-08-18: "select sports not the categories, just the sports".

    Listing every competition turned a two-line question into a twelve-item
    list and made the school decide the category before opening the category's
    own step.
    """
    t = _tournament()
    form = generate_team_form_template(tournament=t)
    section = next(s for s in form.schema["sections"] if s["key"] == "participants")
    students = next(
        g for g in section["fields"] if g["key"] == "participant_students"
    )
    events = next(
        f for f in students["fields"] if f["key"] == "participant_events"
    )
    values = {o["value"] for o in events["options"]}
    # Exactly the tournament's sport keys — nothing with a category segment.
    assert values == {sp["key"] for sp in t.sports}
    assert not any("." in v for v in values)
    assert events["type"] == "multi_choice"


def test_each_student_may_attach_up_to_three_documents():
    t = _tournament()
    form = generate_team_form_template(tournament=t)
    section = next(s for s in form.schema["sections"] if s["key"] == "participants")
    students = next(
        g for g in section["fields"] if g["key"] == "participant_students"
    )
    docs = next(f for f in students["fields"] if f["key"] == "participant_docs")
    assert docs["type"] == "file_upload"
    assert docs["multiple"] is True
    assert docs["max_items"] == 3
    assert "application/pdf" in docs["accept"]
    # Papers are optional: a school missing one certificate must still submit.
    assert docs["required"] is False


def _errors_for(form, docs, institution):
    """Validation errors for one student carrying `docs` files."""
    from apps.forms.services.validation import AnswerError, validate_answers

    answers = {
        "institution_id": str(institution.id),
        "sports": [form.tournament.sports[0]["key"]],
        "participant_students": [
            {"participant_name": "Aben Kikon", "participant_docs": docs},
        ],
    }
    try:
        validate_answers(form.schema, answers)
        return {}
    except AnswerError as e:
        return e.errors


def test_a_fourth_document_on_one_student_is_refused_by_the_server():
    """The cap has to bind on the SERVER: a limit only the picker knows is a
    suggestion, and anything the client simply does not send sails past it."""
    t = _tournament()
    form = generate_team_form_template(tournament=t)
    inst = _school(t)
    errors = _errors_for(form, ["f1", "f2", "f3", "f4"], inst)
    doc_errs = {k: v for k, v in errors.items() if "participant_docs" in k}
    assert doc_errs, errors
    assert "too_many_files" in doc_errs.values()


def test_three_documents_are_accepted():
    t = _tournament()
    form = generate_team_form_template(tournament=t)
    inst = _school(t)
    errors = _errors_for(form, ["f1", "f2", "f3"], inst)
    assert not any("participant_docs" in k for k in errors), errors
