"""The organizer's participants console (spec 2026-08-17).

Most rows arrive through the public sheet; this is the surface that reads them
back, corrects them, and — the question the owner actually asked — shows which
people ended up in more than one competition.
"""
from __future__ import annotations

import uuid as _uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.teams.models import (
    Institution,
    InstitutionStatus,
    Player,
    RosterMember,
    RosterMemberKind,
    Team,
    TeamStatus,
)
from apps.teams.services import houses as houses_svc
from apps.teams.services import roster as svc
from apps.tournaments.models import TournamentScope
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _user(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _client(user):
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _fixture(slug, **kw):
    owner = _user(f"{slug}@test.local")
    t = create_tournament(user=owner, name=f"Cup {slug}", **kw)
    inst = Institution.objects.filter(tournament=t).first() or Institution.objects.create(
        organization=t.organization, tournament=t, slug=f"grace-{slug}",
        name="Grace School", status=InstitutionStatus.REGISTERED,
    )
    return owner, t, inst


def _url(t, member=None):
    base = f"/api/tournaments/{t.id}/roster/"
    return base if member is None else f"{base}{member.id}/"


def _team(t, inst, name, leaf, group=None):
    return Team.objects.create(
        organization=t.organization, tournament=t, institution=inst, group=group,
        slug=name.lower().replace(" ", "-"), name=name, leaf_key=leaf,
        status=TeamStatus.REGISTERED,
    )


# ------------------------------------------------------------------- reading
def test_the_console_lists_who_was_declared():
    owner, t, inst = _fixture("list")
    svc.declare_member(
        tournament=t, institution=inst, full_name="Imli Jamir",
        class_section="9-B", roll_no="21",
    )
    svc.declare_member(
        tournament=t, institution=inst, full_name="Mr Ao",
        kind=RosterMemberKind.TEACHER,
    )

    r = _client(owner).get(_url(t))
    assert r.status_code == 200, r.data
    assert r.data["counts"] == {"students": 1, "teachers": 1, "multi_entry": 0}
    names = {m["full_name"] for m in r.data["members"]}
    assert names == {"Imli Jamir", "Mr Ao"}
    student = next(m for m in r.data["members"] if m["kind"] == "student")
    assert student["class_section"] == "9-B"
    assert student["institution"]["name"] == inst.name


def test_it_shows_every_competition_a_person_ended_up_in():
    """The owner's question — "we can see if one student is in multiple sports"
    — answered as data, not by eyeballing two team lists."""
    owner, t, inst = _fixture("multi")
    m = svc.declare_member(tournament=t, institution=inst, full_name="Imli Jamir")
    tt = _team(t, inst, "Grace TT", "tt.u14.boys")
    sepak = _team(t, inst, "Grace Sepak", "sepak.u14.boys")
    for team in (tt, sepak):
        Player.objects.create(
            organization=t.organization, tournament=t, team=team, person=m.person,
        )

    r = _client(owner).get(_url(t))
    row = r.data["members"][0]
    assert {e["leaf_key"] for e in row["entries"]} == {"tt.u14.boys", "sepak.u14.boys"}
    assert all(e["role"] == "player" for e in row["entries"])
    assert r.data["counts"]["multi_entry"] == 1


def test_a_teacher_in_charge_of_two_teams_shows_both():
    from apps.teams.models import TeamStaff

    owner, t, inst = _fixture("staffrows")
    teacher = svc.declare_member(
        tournament=t, institution=inst, full_name="Mr Ao",
        kind=RosterMemberKind.TEACHER,
    )
    for leaf in ("tt.u14.boys", "tt.u14.girls"):
        TeamStaff.objects.create(
            organization=t.organization,
            team=_team(t, inst, f"Grace {leaf}", leaf),
            member=teacher,
        )
    r = _client(owner).get(_url(t))
    row = r.data["members"][0]
    assert len(row["entries"]) == 2
    assert {e["role"] for e in row["entries"]} == {"in_charge"}
    assert r.data["counts"]["multi_entry"] == 1


def test_filters_narrow_by_school_kind_and_name():
    owner, t, inst = _fixture("filter")
    other = Institution.objects.create(
        organization=t.organization, tournament=t, slug="pine",
        name="Pine", status=InstitutionStatus.REGISTERED,
    )
    svc.declare_member(tournament=t, institution=inst, full_name="Imli Jamir")
    svc.declare_member(tournament=t, institution=other, full_name="Toshi Ao")
    svc.declare_member(
        tournament=t, institution=inst, full_name="Mr Ao",
        kind=RosterMemberKind.TEACHER,
    )
    c = _client(owner)

    only_ours = c.get(_url(t), {"institution": str(inst.id)})
    assert {m["full_name"] for m in only_ours.data["members"]} == {"Imli Jamir", "Mr Ao"}
    teachers = c.get(_url(t), {"kind": "teacher"})
    assert [m["full_name"] for m in teachers.data["members"]] == ["Mr Ao"]
    search = c.get(_url(t), {"q": "toshi"})
    assert [m["full_name"] for m in search.data["members"]] == ["Toshi Ao"]


def test_an_outsider_cannot_read_a_tournaments_participants():
    _owner, t, inst = _fixture("outsider")
    svc.declare_member(tournament=t, institution=inst, full_name="Imli Jamir")
    r = _client(_user("stranger@test.local")).get(_url(t))
    assert r.status_code == 404  # no existence leak (invariant 2)


# ------------------------------------------------------------------- writing
def test_an_organizer_can_declare_someone_by_hand():
    owner, t, inst = _fixture("declare")
    r = _client(owner).post(_url(t), {
        "full_name": "Imli Jamir", "class_section": "9-B", "roll_no": "21",
        "institution_id": str(inst.id), "date_of_birth": "2012-03-04",
    }, format="json")
    assert r.status_code == 201, r.data
    m = RosterMember.objects.get(tournament=t)
    assert m.person.full_name == "Imli Jamir"
    assert m.date_of_birth.isoformat() == "2012-03-04"


def test_a_blank_name_is_refused_with_a_readable_code():
    owner, t, inst = _fixture("blank")
    r = _client(owner).post(
        _url(t), {"full_name": "  ", "institution_id": str(inst.id)}, format="json",
    )
    assert r.status_code == 400
    assert r.data["detail"] == "participant_name_required"


def test_a_correction_keeps_the_same_person_and_their_teams():
    """Editing must not re-mint an identity: the participant is already on a
    team, and a new Person would silently unlink them from the draw."""
    owner, t, inst = _fixture("correct")
    m = svc.declare_member(
        tournament=t, institution=inst, full_name="Imli Jamir", class_section="9-A",
    )
    team = _team(t, inst, "Grace TT", "tt.u14.boys")
    Player.objects.create(
        organization=t.organization, tournament=t, team=team, person=m.person,
    )

    r = _client(owner).patch(_url(t, m), {
        "full_name": "Imliyanger Jamir", "class_section": "9-B",
    }, format="json")
    assert r.status_code == 200, r.data
    m.refresh_from_db()
    assert r.data["id"] == str(m.id)
    assert m.person.full_name == "Imliyanger Jamir"
    assert m.class_section == "9-B"
    assert Player.objects.get(team=team).person_id == m.person_id
    assert len(r.data["entries"]) == 1


def test_withdrawing_is_refused_while_the_participant_is_fielded():
    owner, t, inst = _fixture("withdraw")
    m = svc.declare_member(tournament=t, institution=inst, full_name="Imli Jamir")
    team = _team(t, inst, "Grace TT", "tt.u14.boys")
    Player.objects.create(
        organization=t.organization, tournament=t, team=team, person=m.person,
    )
    r = _client(owner).delete(_url(t, m))
    assert r.status_code == 400
    assert r.data["detail"] == "participant_in_use"


def test_withdrawing_frees_an_unfielded_participant():
    owner, t, inst = _fixture("free")
    m = svc.declare_member(tournament=t, institution=inst, full_name="Toshi")
    r = _client(owner).delete(_url(t, m))
    assert r.status_code == 204
    assert svc.roster_for(t).count() == 0


def test_an_unknown_member_is_not_found_rather_than_crashing():
    owner, t, _inst = _fixture("missing")
    r = _client(owner).delete(f"/api/tournaments/{t.id}/roster/{_uuid.uuid4()}/")
    assert r.status_code == 400
    assert r.data["detail"] == "participant_not_found"


# ------------------------------------------------- within-school house scoping
def _intra(slug):
    owner, t, inst = _fixture(slug, scope=TournamentScope.INTRA_SCHOOL)
    blue = houses_svc.create_house(tournament=t, name="Blue", by=owner)
    green = houses_svc.create_house(tournament=t, name="Green", by=owner)
    return owner, t, inst, blue, green


def test_a_house_captain_sees_only_their_own_house():
    owner, t, inst, blue, green = _intra("scope")
    captain = _user("captain@test.local")
    houses_svc.add_house_member(tournament=t, group=blue, user=captain, by=owner)
    svc.declare_member(
        tournament=t, institution=inst, group=blue, full_name="Blue Child",
    )
    svc.declare_member(
        tournament=t, institution=inst, group=green, full_name="Green Child",
    )

    r = _client(captain).get(_url(t))
    assert r.status_code == 200, r.data
    assert [m["full_name"] for m in r.data["members"]] == ["Blue Child"]
    # The organizer still sees the whole event.
    assert len(_client(owner).get(_url(t)).data["members"]) == 2


def test_a_house_captain_may_declare_into_their_own_house_only():
    owner, t, inst, blue, green = _intra("write")
    captain = _user("captain2@test.local")
    houses_svc.add_house_member(tournament=t, group=blue, user=captain, by=owner)
    c = _client(captain)

    ok = c.post(_url(t), {
        "full_name": "Blue Child", "group_id": str(blue.id),
        "institution_id": str(inst.id),
    }, format="json")
    assert ok.status_code == 201, ok.data
    assert RosterMember.objects.get(tournament=t).group_id == blue.id

    nope = c.post(_url(t), {
        "full_name": "Green Child", "group_id": str(green.id),
        "institution_id": str(inst.id),
    }, format="json")
    assert nope.status_code == 400
    assert nope.data["detail"] == "house_access_required"


def test_a_house_captain_cannot_edit_another_houses_child():
    owner, t, inst, blue, green = _intra("edit")
    captain = _user("captain3@test.local")
    houses_svc.add_house_member(tournament=t, group=blue, user=captain, by=owner)
    theirs = svc.declare_member(
        tournament=t, institution=inst, group=green, full_name="Green Child",
    )
    r = _client(captain).patch(
        _url(t, theirs), {"full_name": "Hacked"}, format="json",
    )
    assert r.status_code == 400
    assert r.data["detail"] == "house_access_required"
    theirs.refresh_from_db()
    assert theirs.person.full_name == "Green Child"
