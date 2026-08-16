"""The participants sheet: a school declares its people, once (spec 2026-08-17).

The generated form is ordinary schema data on the existing engine — two
repeatable groups and a competitor picker — so the admin can rewrite any of it
in the builder. What is NOT negotiable is where a submission lands: one
``RosterMember`` per row, keyed so a corrected re-submission updates instead of
doubling the school's list.
"""
from __future__ import annotations

import uuid as _uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.forms.constants import FormPurpose, FormStatus
from apps.forms.models import Form
from apps.forms.services.forms import publish_form
from apps.forms.services.generation import (
    build_participants_form_schema,
    generate_participants_form,
)
from apps.teams.models import (
    Institution,
    InstitutionStatus,
    RosterMember,
    RosterMemberKind,
)
from apps.teams.services import roster as roster_svc
from apps.tournaments.models import RosterMode, TournamentScope, TournamentStage
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.state import transition_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db

SPORTS = [{
    "key": "table_tennis", "name": "Table Tennis",
    "categories": [{"key": "u14", "name": "U14", "children": [
        {"key": "boys", "name": "Boys"}, {"key": "girls", "name": "Girls"},
    ]}],
}]


def _user(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _tournament(email, **kw):
    t = create_tournament(user=_user(email), name="Roster Cup", **kw)
    t.sports = SPORTS
    t.roster_mode = RosterMode.ROSTER_FIRST
    t.save(update_fields=["sports", "roster_mode"])
    return t


def _inst(t, name="Grace School", slug="grace"):
    return Institution.objects.create(
        organization=t.organization, tournament=t, slug=slug, name=name,
        status=InstitutionStatus.REGISTERED,
        contact_name="Fr. K", contact_email=f"{slug}@school.test",
        contact_phone="9876543210",
    )


def _fields(schema, group_key):
    for sec in schema["sections"]:
        for f in sec["fields"]:
            if f.get("key") == group_key:
                return f
    return None


# ----------------------------------------------------------------- the schema
def test_the_sheet_asks_for_students_and_teachers_and_nothing_about_events():
    t = _tournament("schema@test.local")
    schema, b = build_participants_form_schema(t)

    students = _fields(schema, "students")
    teachers = _fields(schema, "teachers")
    assert students["repeatable"] and teachers["repeatable"]
    keys = {f["key"] for f in students["fields"]}
    assert {"student_name", "student_class", "student_dob"} <= keys
    # Which competition a child enters is the TEAM form's question — asking it
    # here would make every school answer it twice.
    text = str(schema)
    assert "table_tennis" not in text
    assert b["participant_groups"][0]["kind"] == "student"
    assert b["participant_groups"][1]["kind"] == "teacher"


def test_a_within_school_sheet_picks_a_house_and_uses_its_noun():
    t = _tournament(
        "intra@test.local", scope=TournamentScope.INTRA_SCHOOL, group_kind="class",
    )
    schema, b = build_participants_form_schema(t)
    picker = schema["sections"][0]["fields"][0]
    assert picker["key"] == "house_id"
    assert picker["data_source"] == {"type": "house_list"}
    assert "class" in picker["label"]
    assert b["competitor_kind"] == "house"


def test_every_bound_question_names_the_column_it_fills():
    t = _tournament("bind@test.local")
    _schema, b = build_participants_form_schema(t)
    students = b["participant_groups"][0]
    assert students["name"] == "student_name"
    assert students["fields"]["class_section"] == "student_class"
    assert students["fields"]["date_of_birth"] == "student_dob"
    teachers = b["participant_groups"][1]
    assert teachers["fields"]["contact_phone"] == "teacher_phone"


# ---------------------------------------------------------------- the mapping
def _submit(client, form, answers, token=None, event_id=None):
    payload = {"answers": answers, "event_id": str(event_id or _uuid.uuid4())}
    if token:
        payload["access_token"] = token
    return client.post(
        f"/api/forms/{form.id}/public/", payload, format="json",
    )


def _open_form(t):
    form = generate_participants_form(tournament=t)
    publish_form(form)
    return form


def _access(client, form, inst, code):
    r = client.post(
        f"/api/forms/{form.id}/team-access/",
        {"institution_id": str(inst.id), "code": code}, format="json",
    )
    return r


def test_a_submission_declares_every_row(mailoutbox):
    from rest_framework.test import APIClient

    client = APIClient()
    t = _tournament("map@test.local")
    inst = _inst(t)
    form = _open_form(t)
    code = _issue(t, form, mailoutbox)

    r = _access(client, form, inst, code)
    assert r.status_code == 200, r.data
    token = r.data["access_token"]

    r = _submit(client, form, {
        "institution_id": str(inst.id),
        "students": [
            {"student_name": "Imli Jamir", "student_class": "9-B",
             "student_roll": "21", "student_dob": "2012-03-04"},
            {"student_name": "Toshi Ao", "student_class": "9-A",
             "student_dob": "2012-07-01"},
        ],
        "teachers": [
            {"teacher_name": "Mr Ao", "teacher_phone": "9876543210"},
        ],
    }, token=token)
    assert r.status_code == 201, r.data

    members = roster_svc.roster_for(t, inst)
    assert members.count() == 3
    imli = members.get(roll_no="21")
    assert imli.class_section == "9-B"
    assert imli.date_of_birth.isoformat() == "2012-03-04"
    assert imli.person.dob_year == 2012
    teacher = members.get(kind=RosterMemberKind.TEACHER)
    assert teacher.contact_phone == "9876543210"


def test_a_corrected_re_submission_updates_the_same_person(mailoutbox):
    from rest_framework.test import APIClient

    client = APIClient()
    t = _tournament("resub@test.local")
    inst = _inst(t)
    form = _open_form(t)
    token = _access(
        client, form, inst, _issue(t, form, mailoutbox)
    ).data["access_token"]

    base = {"institution_id": str(inst.id), "teachers": []}
    _submit(client, form, {**base, "students": [
        {"student_name": "Imli Jamir", "student_class": "9-A",
         "student_roll": "21", "student_dob": "2012-03-04"},
    ]}, token=token)
    _submit(client, form, {**base, "students": [
        {"student_name": "Imliyanger Jamir", "student_class": "9-B",
         "student_roll": "21", "student_dob": "2012-03-04"},
    ]}, token=token)

    assert RosterMember.objects.filter(tournament=t, deleted_at__isnull=True).count() == 1
    m = roster_svc.roster_for(t, inst).first()
    assert m.person.full_name == "Imliyanger Jamir"
    assert m.class_section == "9-B"


def test_an_extra_question_the_admin_added_is_kept(mailoutbox):
    """Fully editable (owner 2026-08-17): a question the generator never wrote
    still reaches the member, on ``attributes``, with no schema change."""
    from rest_framework.test import APIClient

    client = APIClient()
    t = _tournament("extra@test.local")
    inst = _inst(t)
    form = generate_participants_form(tournament=t)
    for sec in form.schema["sections"]:
        for f in sec["fields"]:
            if f.get("key") == "students":
                f["fields"].append({
                    "key": "blood_group", "type": "short_text",
                    "label": "Blood group", "required": False,
                })
    form.save(update_fields=["schema"])
    publish_form(form)
    token = _access(
        client, form, inst, _issue(t, form, mailoutbox)
    ).data["access_token"]

    r = _submit(client, form, {
        "institution_id": str(inst.id), "teachers": [],
        "students": [{"student_name": "Imli", "student_class": "9-B",
                      "student_dob": "2012-03-04", "blood_group": "O+"}],
    }, token=token)
    assert r.status_code == 201, r.data
    assert roster_svc.roster_for(t, inst).first().attributes["blood_group"] == "O+"


def test_a_school_cannot_write_another_schools_roll_without_its_code(mailoutbox):
    """A roll of children is at least as protected as a team list."""
    from rest_framework.test import APIClient

    client = APIClient()
    t = _tournament("gate@test.local")
    inst = _inst(t)
    form = _open_form(t)
    _issue(t, form, mailoutbox)

    r = _submit(client, form, {
        "institution_id": str(inst.id), "teachers": [],
        "students": [{"student_name": "Nobody", "student_class": "9-B",
                      "student_dob": "2012-03-04"}],
    })
    assert r.status_code == 400
    assert r.data["detail"] == "team_access_required"
    assert RosterMember.objects.filter(tournament=t).count() == 0


def test_the_pickers_arrive_only_after_the_code_verifies(mailoutbox):
    from rest_framework.test import APIClient

    client = APIClient()
    t = _tournament("pii@test.local")
    inst = _inst(t)
    other = _inst(t, "Pine Academy", "pine")
    roster_svc.declare_member(tournament=t, institution=inst, full_name="Ours")
    roster_svc.declare_member(tournament=t, institution=other, full_name="Theirs")
    roster_svc.declare_member(
        tournament=t, institution=inst, full_name="Our Teacher",
        kind=RosterMemberKind.TEACHER,
    )
    form = _open_form(t)
    code = _issue(t, form, mailoutbox, inst)

    # The public schema never carries a name.
    public = client.get(f"/api/forms/{form.id}/public/")
    assert "Ours" not in str(public.data)

    r = _access(client, form, inst, code)
    assert [o["label"] for o in r.data["roster"]["students"]] == ["Ours"]
    assert [o["label"] for o in r.data["roster"]["teachers"]] == ["Our Teacher"]


def _issue(t, form, mailoutbox, inst=None) -> str:
    """Mail the institutions their access codes; return ``inst``'s plaintext one
    (it exists only in the inbox — the DB keeps an Argon2id hash)."""
    from django.core.cache import cache

    from apps.teams.services.access import issue_team_access_codes

    cache.clear()  # lockout counters are cache-backed and leak across tests
    issue_team_access_codes(tournament=t, form=form)
    mail = next(
        (m for m in mailoutbox if inst is None or inst.contact_email in m.to),
        None,
    )
    assert mail is not None, [m.to for m in mailoutbox]
    return next(
        ln.strip() for ln in mail.body.splitlines()
        if ln.strip().isalnum() and len(ln.strip()) == 8
    )


# ------------------------------------------------------------------ the stage
def _advance(t, stage, capture):
    with capture(execute=True):
        return transition_tournament(
            tournament=t, to_stage=stage, ack_warnings=True,
        )


def test_entering_the_stage_leaves_a_ready_draft(django_capture_on_commit_callbacks):
    t = _tournament("stage@test.local")
    _inst(t)
    t = _advance(t, TournamentStage.ORG_REGISTRATION, django_capture_on_commit_callbacks)
    t = _advance(t, TournamentStage.ROSTER, django_capture_on_commit_callbacks)
    assert t.stage == TournamentStage.ROSTER
    form = Form.objects.get(
        tournament=t, purpose=FormPurpose.PARTICIPANT_REGISTRATION,
    )
    assert form.status == FormStatus.DRAFT
    assert form.stage == "roster"


def test_re_entering_the_stage_never_duplicates_the_sheet(
    django_capture_on_commit_callbacks,
):
    cap = django_capture_on_commit_callbacks
    t = _tournament("dupe@test.local")
    _inst(t)
    t = _advance(t, TournamentStage.ORG_REGISTRATION, cap)
    t = _advance(t, TournamentStage.ROSTER, cap)
    t = _advance(t, TournamentStage.ORG_REGISTRATION, cap)
    t = _advance(t, TournamentStage.ROSTER, cap)
    assert Form.objects.filter(
        tournament=t, purpose=FormPurpose.PARTICIPANT_REGISTRATION,
    ).count() == 1


def test_the_stepper_counts_the_people_declared():
    from apps.tournaments.services.state import build_stage_payload

    t = _tournament("count@test.local")
    inst = _inst(t)
    roster_svc.declare_member(tournament=t, institution=inst, full_name="Imli")
    payload = build_stage_payload(t, t.created_by)
    step = next(s for s in payload["stages"] if s["key"] == "roster")
    assert step["counts"] == {"participants": 1}
    assert payload["order"].index("roster") == 2
