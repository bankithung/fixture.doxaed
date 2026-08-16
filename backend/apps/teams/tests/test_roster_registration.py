"""Teams built by PICKING declared people (spec 2026-08-17, increment 2).

``register_school`` used to derive a player's identity from the typed string.
When a tournament runs participants-first the school has already declared its
people, so the submission carries a ``member_id`` and identity is *chosen*.
Teachers in charge arrive the same way and become ``TeamStaff`` rows — the edge
the scheduler reads to keep one teacher off two courts at once.
"""
from __future__ import annotations

import uuid as _uuid

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.utils import timezone

from apps.teams.models import (
    Institution,
    InstitutionStatus,
    Player,
    RosterMemberKind,
    TeamStaff,
)
from apps.teams.services import roster as roster_svc
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _user(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _setup(email):
    t = create_tournament(user=_user(email), name="Pick Cup")
    inst = Institution.objects.create(
        organization=t.organization, tournament=t, slug="grace",
        name="Grace School", status=InstitutionStatus.REGISTERED,
    )
    return t, inst


def _declare(t, inst, name, **kw):
    return roster_svc.declare_member(
        tournament=t, institution=inst, full_name=name, **kw
    )


def test_a_picked_member_is_the_player_identity():
    t, inst = _setup("pick@test.local")
    m = _declare(t, inst, "Imliyanger Jamir", roll_no="21")

    teams = register_school(
        tournament=t, school_name=inst.name, institution=inst,
        teams=[{
            "name": "Grace TT", "leaf_key": "tt.u14.boys",
            # The name typed here is deliberately WRONG — the pick wins.
            "players": [{"full_name": "I. Jamir", "member_id": str(m.id)}],
        }],
        event_id=_uuid.uuid4(),
    )
    player = Player.objects.get(team=teams[0])
    assert player.person_id == m.person_id
    assert player.person.full_name == "Imliyanger Jamir"


def test_one_student_in_two_sports_is_one_person():
    """The whole point: an exact answer to "is this child in two competitions?",
    with no string matching involved."""
    t, inst = _setup("two@test.local")
    m = _declare(t, inst, "Imli Jamir")

    teams = register_school(
        tournament=t, school_name=inst.name, institution=inst,
        teams=[
            {"name": "Grace TT", "leaf_key": "tt.u14.boys",
             "players": [{"full_name": "Imli Jamir", "member_id": str(m.id)}]},
            {"name": "Grace Sepak", "leaf_key": "sepak.u14.boys",
             "players": [{"full_name": "IMLI  JAMIR", "member_id": str(m.id)}]},
        ],
        event_id=_uuid.uuid4(),
    )
    persons = {p.person_id for p in Player.objects.filter(team__in=teams)}
    assert persons == {m.person_id}


def test_another_schools_participant_cannot_be_fielded():
    t, inst = _setup("steal@test.local")
    other = Institution.objects.create(
        organization=t.organization, tournament=t, slug="pine",
        name="Pine Academy", status=InstitutionStatus.REGISTERED,
    )
    theirs = _declare(t, other, "Their Child")

    with pytest.raises(ValidationError, match="participant_not_in_roster"):
        register_school(
            tournament=t, school_name=inst.name, institution=inst,
            teams=[{"name": "Grace TT", "leaf_key": "tt.u14.boys",
                    "players": [{"full_name": "Their Child",
                                 "member_id": str(theirs.id)}]}],
            event_id=_uuid.uuid4(),
        )


def test_an_unknown_member_id_is_refused_rather_than_guessed():
    t, inst = _setup("unknown@test.local")
    with pytest.raises(ValidationError, match="participant_not_in_roster"):
        register_school(
            tournament=t, school_name=inst.name, institution=inst,
            teams=[{"name": "Grace TT", "leaf_key": "tt.u14.boys",
                    "players": [{"full_name": "Ghost",
                                 "member_id": str(_uuid.uuid4())}]}],
            event_id=_uuid.uuid4(),
        )


def test_the_same_member_listed_twice_on_one_squad_lands_once():
    """A duplicate row would trip ``unique_person_per_team`` and roll the whole
    submission back — a school re-picking a name must not lose its entry."""
    t, inst = _setup("dupe@test.local")
    m = _declare(t, inst, "Imli Jamir")

    teams = register_school(
        tournament=t, school_name=inst.name, institution=inst,
        teams=[{"name": "Grace TT", "leaf_key": "tt.u14.boys", "players": [
            {"full_name": "Imli Jamir", "member_id": str(m.id)},
            {"full_name": "Imli Jamir", "member_id": str(m.id)},
        ]}],
        event_id=_uuid.uuid4(),
    )
    assert Player.objects.filter(team=teams[0]).count() == 1


def test_typed_names_still_work_when_nothing_was_declared():
    """No hard-coded rules (owner 2026-08-17): the participants layer is opt-in,
    so a tournament that never declared anyone registers exactly as before."""
    t, inst = _setup("typed@test.local")
    teams = register_school(
        tournament=t, school_name=inst.name, institution=inst,
        teams=[{"name": "Grace TT", "leaf_key": "tt.u14.boys",
                "players": [{"full_name": "Imli Jamir"}]}],
        event_id=_uuid.uuid4(),
    )
    assert Player.objects.filter(team=teams[0]).count() == 1


# ------------------------------------------------------------------ teachers
def test_a_teacher_in_charge_is_recorded_against_the_team():
    t, inst = _setup("staff@test.local")
    teacher = _declare(t, inst, "Mr Ao", kind=RosterMemberKind.TEACHER)

    teams = register_school(
        tournament=t, school_name=inst.name, institution=inst,
        teams=[{"name": "Grace TT", "leaf_key": "tt.u14.boys", "players": [],
                "staff": [str(teacher.id)]}],
        event_id=_uuid.uuid4(),
    )
    rows = TeamStaff.objects.filter(team=teams[0])
    assert [r.member_id for r in rows] == [teacher.id]
    assert rows.first().role == "in_charge"


def test_a_staff_row_may_name_its_own_role():
    t, inst = _setup("role@test.local")
    teacher = _declare(t, inst, "Mr Ao", kind=RosterMemberKind.TEACHER)
    teams = register_school(
        tournament=t, school_name=inst.name, institution=inst,
        teams=[{"name": "Grace TT", "players": [],
                "staff": [{"member_id": str(teacher.id), "role": "coach"}]}],
        event_id=_uuid.uuid4(),
    )
    assert TeamStaff.objects.get(team=teams[0]).role == "coach"


def test_one_teacher_may_take_two_teams():
    """Two TeamStaff rows, which is exactly what the scheduler links."""
    t, inst = _setup("twoteams@test.local")
    teacher = _declare(t, inst, "Mr Ao", kind=RosterMemberKind.TEACHER)
    teams = register_school(
        tournament=t, school_name=inst.name, institution=inst,
        teams=[
            {"name": "Grace Boys", "leaf_key": "tt.u14.boys", "players": [],
             "staff": [str(teacher.id)]},
            {"name": "Grace Girls", "leaf_key": "tt.u14.girls", "players": [],
             "staff": [str(teacher.id)]},
        ],
        event_id=_uuid.uuid4(),
    )
    assert TeamStaff.objects.filter(team__in=teams).count() == 2


def test_a_staff_pick_from_another_school_is_refused():
    t, inst = _setup("staffsteal@test.local")
    other = Institution.objects.create(
        organization=t.organization, tournament=t, slug="pine2",
        name="Pine", status=InstitutionStatus.REGISTERED,
    )
    theirs = _declare(t, other, "Their Teacher", kind=RosterMemberKind.TEACHER)
    with pytest.raises(ValidationError, match="participant_not_in_roster"):
        register_school(
            tournament=t, school_name=inst.name, institution=inst,
            teams=[{"name": "Grace TT", "players": [], "staff": [str(theirs.id)]}],
            event_id=_uuid.uuid4(),
        )


def test_a_teacher_in_charge_blocks_a_quiet_withdrawal():
    t, inst = _setup("withdraw2@test.local")
    teacher = _declare(t, inst, "Mr Ao", kind=RosterMemberKind.TEACHER)
    register_school(
        tournament=t, school_name=inst.name, institution=inst,
        teams=[{"name": "Grace TT", "players": [], "staff": [str(teacher.id)]}],
        event_id=_uuid.uuid4(),
    )
    with pytest.raises(ValidationError, match="participant_in_use"):
        roster_svc.withdraw_member(member=teacher)
