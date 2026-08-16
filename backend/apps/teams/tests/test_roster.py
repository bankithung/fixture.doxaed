"""The participants layer, and the scheduling rules it makes possible
(spec 2026-08-17).

Two halves. First: a school declares its people once, so identity is CHOSEN
rather than matched from a typed string. Second: the link graph the scheduler
already uses for shared players gains a shared-teacher and a same-school edge
source — each behind its own constraint record, so none of it is implicit.
"""
from __future__ import annotations

from datetime import date, time

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.utils import timezone

from apps.fixtures.services.scheduler import (
    ScheduleConfig,
    build_schedule_inputs,
    merge_stored_constraints,
)
from apps.teams.models import (
    Institution,
    InstitutionStatus,
    Person,
    RosterMember,
    RosterMemberKind,
    Team,
    TeamStaff,
    TeamStatus,
)
from apps.teams.services import roster as svc
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _user(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _setup(email="roster@test.local"):
    t = create_tournament(user=_user(email), name="Roster Cup")
    inst = Institution.objects.create(
        organization=t.organization, tournament=t, slug="grace",
        name="Grace School", status=InstitutionStatus.REGISTERED,
    )
    return t, inst


def _team(t, inst, name, leaf=""):
    return Team.objects.create(
        organization=t.organization, tournament=t, institution=inst,
        slug=name.lower().replace(" ", "-"), name=name, leaf_key=leaf,
        status=TeamStatus.REGISTERED,
    )


# ------------------------------------------------------------------ declaring
def test_a_school_declares_students_and_teachers():
    t, inst = _setup()
    svc.declare_member(
        tournament=t, institution=inst, full_name="Imli Jamir",
        class_section="9-B", roll_no="21",
    )
    svc.declare_member(
        tournament=t, institution=inst, full_name="Mr Ao",
        kind=RosterMemberKind.TEACHER, contact_phone="9876543210",
    )

    assert svc.roster_for(t, inst).count() == 2
    students = svc.roster_for(t, inst, kind=RosterMemberKind.STUDENT)
    assert [m.person.full_name for m in students] == ["Imli Jamir"]
    assert students.first().class_section == "9-B"


def test_re_submitting_updates_rather_than_duplicating():
    """A school that fixes a typo and re-submits must not double its roster."""
    t, inst = _setup("resub@test.local")
    svc.declare_member(
        tournament=t, institution=inst, full_name="Imli Jamir",
        roll_no="21", class_section="9-A",
    )
    svc.declare_member(
        tournament=t, institution=inst, full_name="Imliyanger Jamir",
        roll_no="21", class_section="9-B",
    )

    assert svc.roster_for(t, inst).count() == 1
    m = svc.roster_for(t, inst).first()
    # The roll number is the school's own key, so the name is corrected in place.
    assert m.person.full_name == "Imliyanger Jamir"
    assert m.class_section == "9-B"


def test_two_schools_may_both_declare_the_same_name():
    t, inst = _setup("two@test.local")
    other = Institution.objects.create(
        organization=t.organization, tournament=t, slug="pine",
        name="Pine Academy", status=InstitutionStatus.REGISTERED,
    )
    svc.declare_member(tournament=t, institution=inst, full_name="Imli Jamir")
    svc.declare_member(tournament=t, institution=other, full_name="Imli Jamir")

    assert Person.objects.filter(full_name="Imli Jamir").count() == 2
    assert svc.roster_for(t, inst).count() == 1
    assert svc.roster_for(t, other).count() == 1


def test_a_blank_name_is_refused():
    t, inst = _setup("blank@test.local")
    with pytest.raises(ValidationError, match="participant_name_required"):
        svc.declare_member(tournament=t, institution=inst, full_name="   ")


def test_a_participant_on_a_team_cannot_be_quietly_withdrawn():
    t, inst = _setup("withdraw@test.local")
    m = svc.declare_member(tournament=t, institution=inst, full_name="Imli Jamir")
    team = _team(t, inst, "Grace A")
    from apps.teams.models import Player

    Player.objects.create(
        organization=t.organization, tournament=t, team=team, person=m.person,
    )
    with pytest.raises(ValidationError, match="participant_in_use"):
        svc.withdraw_member(member=m)


def test_withdrawing_frees_the_row_but_keeps_the_person():
    t, inst = _setup("free@test.local")
    m = svc.declare_member(tournament=t, institution=inst, full_name="Toshi")
    svc.withdraw_member(member=m)
    assert svc.roster_for(t, inst).count() == 0
    assert Person.objects.filter(id=m.person_id).exists()


def test_the_picker_payload_is_scoped_to_one_school():
    """A roster is student PII: the team form's dropdown must never be able to
    read another school's children."""
    t, inst = _setup("pii@test.local")
    other = Institution.objects.create(
        organization=t.organization, tournament=t, slug="pine2",
        name="Pine", status=InstitutionStatus.REGISTERED,
    )
    svc.declare_member(tournament=t, institution=inst, full_name="Ours")
    svc.declare_member(tournament=t, institution=other, full_name="Theirs")
    svc.declare_member(
        tournament=t, institution=inst, full_name="Our Teacher",
        kind=RosterMemberKind.TEACHER,
    )

    opts = svc.member_options(t, inst)
    assert [o["label"] for o in opts] == ["Ours"]  # students only, ours only
    teachers = svc.member_options(t, inst, kind=RosterMemberKind.TEACHER)
    assert [o["label"] for o in teachers] == ["Our Teacher"]


# ------------------------------------------------------------------ the rules
def _cfg(records):
    cfg = ScheduleConfig(
        date_start=date(2026, 8, 1), date_end=date(2026, 8, 1),
        daily_start=time(9, 0), daily_end=time(18, 0), slot_minutes=30,
        venues=["A"],
    )
    merge_stored_constraints(cfg, records)
    return cfg


def test_nothing_links_teams_unless_a_record_asks_for_it():
    """No hard-coded rules (owner 2026-08-17): each edge source is opt-in, and
    the shared-player one stays on by default so today's protection is kept."""
    assert _cfg([]).link_sources == set()

    cfg = _cfg([{"type": "no_person_overlap", "scope": "all", "params": {}}])
    assert cfg.link_sources == {"player"}

    cfg = _cfg([{"type": "no_staff_overlap", "scope": "all", "params": {}}])
    assert cfg.link_sources == {"staff"}

    cfg = _cfg([{"type": "no_institution_overlap", "scope": "all", "params": {}}])
    assert cfg.link_sources == {"institution"}


def test_the_teacher_rule_carries_its_own_gaps():
    cfg = _cfg([{
        "type": "no_staff_overlap", "scope": "all",
        "params": {"min_gap_minutes": 10, "cross_venue_gap_minutes": 45},
    }])
    assert cfg.person_min_gap == 10
    assert cfg.person_cross_venue_gap == 45


def test_two_teams_under_one_teacher_are_linked():
    """The owner's rule: "the teacher in-charges of the school cannot be in two
    courts". Keyed on the teacher, so this is exact rather than blanket."""
    t, inst = _setup("staff@test.local")
    teacher = svc.declare_member(
        tournament=t, institution=inst, full_name="Mr Ao",
        kind=RosterMemberKind.TEACHER,
    )
    boys = _team(t, inst, "Grace Boys", "tt.u14.boys")
    girls = _team(t, inst, "Grace Girls", "tt.u14.girls")
    for team in (boys, girls):
        TeamStaff.objects.create(
            organization=t.organization, team=team, member=teacher,
        )

    cfg = _cfg([{"type": "no_staff_overlap", "scope": "all", "params": {}}])
    _reqs, _pre, linked = build_schedule_inputs(t, cfg)
    assert linked.get(str(boys.id)) == {str(girls.id)}
    assert linked.get(str(girls.id)) == {str(boys.id)}


def test_a_school_that_sends_two_teachers_keeps_both_courts():
    """Precisely why the rule is keyed on the teacher and not the school."""
    t, inst = _setup("twoteachers@test.local")
    a = svc.declare_member(
        tournament=t, institution=inst, full_name="Mr Ao",
        kind=RosterMemberKind.TEACHER,
    )
    b = svc.declare_member(
        tournament=t, institution=inst, full_name="Ms Kikon",
        kind=RosterMemberKind.TEACHER,
    )
    boys = _team(t, inst, "Grace Boys", "tt.u14.boys")
    girls = _team(t, inst, "Grace Girls", "tt.u14.girls")
    TeamStaff.objects.create(organization=t.organization, team=boys, member=a)
    TeamStaff.objects.create(organization=t.organization, team=girls, member=b)

    cfg = _cfg([{"type": "no_staff_overlap", "scope": "all", "params": {}}])
    _reqs, _pre, linked = build_schedule_inputs(t, cfg)
    assert linked == {}

    # The blunt same-school rule WOULD have forbidden it — which is why it is
    # a separate, off-by-default record.
    blunt = _cfg([{"type": "no_institution_overlap", "scope": "all", "params": {}}])
    _r, _p, linked_blunt = build_schedule_inputs(t, blunt)
    assert linked_blunt.get(str(boys.id)) == {str(girls.id)}


def test_the_shared_player_rule_is_exactly_what_it_was():
    """The regression that matters: with no new record authored, the graph is
    built from shared players and nothing else."""

    from apps.teams.models import Player

    t, inst = _setup("player@test.local")
    m = svc.declare_member(tournament=t, institution=inst, full_name="Imli")
    tt = _team(t, inst, "Grace TT", "tt.u14.boys")
    sepak = _team(t, inst, "Grace Sepak", "sepak.u14.boys")
    for team in (tt, sepak):
        Player.objects.create(
            organization=t.organization, tournament=t, team=team, person=m.person,
        )

    cfg = _cfg([])  # no records at all
    _reqs, _pre, linked = build_schedule_inputs(t, cfg)
    assert linked.get(str(tt.id)) == {str(sepak.id)}


def test_different_players_leave_two_competitions_free_to_run_together():
    """The owner's TT-vs-Sepak question, answered exactly instead of by a
    blanket "these two sports never overlap"."""

    from apps.teams.models import Player

    t, inst = _setup("differ@test.local")
    one = svc.declare_member(tournament=t, institution=inst, full_name="Imli")
    two = svc.declare_member(tournament=t, institution=inst, full_name="Toshi")
    tt = _team(t, inst, "Grace TT", "tt.u14.boys")
    sepak = _team(t, inst, "Grace Sepak", "sepak.u14.boys")
    Player.objects.create(
        organization=t.organization, tournament=t, team=tt, person=one.person,
    )
    Player.objects.create(
        organization=t.organization, tournament=t, team=sepak, person=two.person,
    )

    _reqs, _pre, linked = build_schedule_inputs(t, _cfg([]))
    assert linked == {}


def test_declared_identity_survives_a_typo_where_name_matching_would_not():
    """The whole point of the layer. Two teams pick the SAME declared person,
    so the link holds even though nothing matched on a string."""

    from apps.teams.models import Player

    t, inst = _setup("typo@test.local")
    m = svc.declare_member(
        tournament=t, institution=inst, full_name="Imliyanger Jamir", roll_no="21",
    )
    # The same child, entered a second time the way a hurried teacher types it.
    again = svc.declare_member(
        tournament=t, institution=inst, full_name="I. Jamir", roll_no="21",
    )
    assert again.id == m.id
    assert RosterMember.objects.filter(tournament=t).count() == 1

    tt = _team(t, inst, "TT", "tt.u14.boys")
    sepak = _team(t, inst, "Sepak", "sepak.u14.boys")
    for team in (tt, sepak):
        Player.objects.create(
            organization=t.organization, tournament=t, team=team, person=m.person,
        )

    _reqs, _pre, linked = build_schedule_inputs(t, _cfg([]))
    assert linked.get(str(tt.id)) == {str(sepak.id)}
