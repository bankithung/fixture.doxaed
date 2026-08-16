"""Houses as tournament participants (spec 2026-08-16 §D4/§D5)."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.utils import timezone
from rest_framework.test import APIClient

from apps.teams.models import (
    Season,
    Team,
    TeamGroup,
    TeamGroupMembership,
    TeamStatus,
    TournamentHouse,
)
from apps.teams.services import houses as svc
from apps.tournaments.models import TournamentScope
from apps.tournaments.models import TournamentStage as G
from apps.tournaments.services import state as st
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _user(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _meet(owner=None, name="Sports Day"):
    return create_tournament(
        user=owner or _user("owner@houses.test"), name=name,
        scope=TournamentScope.INTRA_SCHOOL,
    )


def _client(user):
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# ------------------------------------------------------------------- lifecycle
def test_a_house_is_whatever_the_host_calls_it():
    t = _meet()
    svc.create_house(tournament=t, name="Red Dragons", colour="#c0392b")
    svc.create_house(tournament=t, name="Kohima")

    names = list(svc.houses_for(t).values_list("name", flat=True))
    assert names == ["Red Dragons", "Kohima"]
    assert TournamentHouse.objects.filter(tournament=t).count() == 2
    # Houses live on the season, so next year's event reuses them.
    assert TeamGroup.objects.filter(season=t.season_ref).count() == 2


def test_a_blank_or_duplicate_name_is_refused():
    t = _meet()
    svc.create_house(tournament=t, name="Blue")
    with pytest.raises(ValidationError):
        svc.create_house(tournament=t, name="   ")
    # Same name is the SAME house re-entered, not a second one.
    svc.create_house(tournament=t, name="blue")
    assert svc.houses_for(t).count() == 1


def test_a_house_can_be_renamed_and_the_name_frees_up_when_retired():
    t = _meet()
    blue = svc.create_house(tournament=t, name="Blue")
    svc.update_house(tournament=t, group=blue, name="Sapphire")
    blue.refresh_from_db()
    assert blue.name == "Sapphire"

    green = svc.create_house(tournament=t, name="Green")
    with pytest.raises(ValidationError):
        svc.update_house(tournament=t, group=green, name="sapphire")

    svc.retire_house(tournament=t, group=blue)
    assert svc.houses_for(t).count() == 1
    # Retiring is not deleting — the season row survives for the ledger.
    assert TeamGroup.objects.filter(id=blue.id).exists()
    # And the name is usable again.
    svc.update_house(tournament=t, group=green, name="Sapphire")


def test_a_house_with_teams_cannot_be_withdrawn_mid_event():
    t = _meet()
    blue = svc.create_house(tournament=t, name="Blue")
    Team.objects.create(
        organization=t.organization, tournament=t, group=blue,
        slug="blue-u14", name="Blue", status=TeamStatus.REGISTERED,
    )
    with pytest.raises(ValidationError, match="house_has_teams"):
        svc.remove_house(tournament=t, group=blue)


def test_houses_are_refused_outright_in_a_school_tournament():
    t = create_tournament(user=_user("inter@houses.test"), name="Inter Cup")
    with pytest.raises(ValidationError, match="intra_school"):
        svc.create_house(tournament=t, name="Blue")


# ------------------------------------------------------------------- membership
def test_a_house_member_may_act_for_their_house_and_no_other():
    owner = _user("admin@houses.test")
    t = _meet(owner)
    blue = svc.create_house(tournament=t, name="Blue")
    green = svc.create_house(tournament=t, name="Green")
    captain = _user("captain@houses.test")
    svc.add_house_member(tournament=t, group=blue, user=captain, by=owner)

    assert svc.manageable_house_ids(t, captain) == {str(blue.id)}
    assert svc.may_register_for(t, captain, blue.id) is True
    assert svc.may_register_for(t, captain, green.id) is False
    # The organizer is unrestricted.
    assert svc.manageable_house_ids(t, owner) is None
    # And an inter-school tournament has no such scoping at all.
    inter = create_tournament(user=owner, name="Inter")
    assert svc.manageable_house_ids(inter, captain) is None


def test_revoking_a_member_takes_the_house_away():
    owner = _user("admin2@houses.test")
    t = _meet(owner)
    blue = svc.create_house(tournament=t, name="Blue")
    captain = _user("captain2@houses.test")
    m = svc.add_house_member(tournament=t, group=blue, user=captain, by=owner)
    svc.remove_house_member(tournament=t, membership=m, by=owner)
    assert svc.manageable_house_ids(t, captain) == set()


def test_adding_the_same_member_twice_is_idempotent():
    owner = _user("admin3@houses.test")
    t = _meet(owner)
    blue = svc.create_house(tournament=t, name="Blue")
    captain = _user("captain3@houses.test")
    a = svc.add_house_member(tournament=t, group=blue, user=captain, by=owner)
    b = svc.add_house_member(tournament=t, group=blue, user=captain, by=owner)
    assert a.id == b.id
    assert TeamGroupMembership.objects.filter(group=blue).count() == 1


# ------------------------------------------------------------------- stage gate
def test_team_registration_needs_at_least_two_houses():
    owner = _user("gate@houses.test")
    t = _meet(owner)
    st.transition_tournament(tournament=t, to_stage=G.HOUSE_SETUP, ack_warnings=True)

    preview = st.preview_advance(t, G.TEAM_REGISTRATION)
    assert "not_enough_houses" in preview["blockers"]

    svc.create_house(tournament=t, name="Blue")
    svc.create_house(tournament=t, name="Green")
    t.refresh_from_db()
    assert "not_enough_houses" not in st.preview_advance(t, G.TEAM_REGISTRATION)["blockers"]


def test_the_school_flow_is_never_asked_about_houses():
    t = create_tournament(user=_user("nogate@houses.test"), name="Inter Cup")
    st.transition_tournament(
        tournament=t, to_stage=G.ORG_REGISTRATION, ack_warnings=True,
    )
    preview = st.preview_advance(t, G.TEAM_REGISTRATION)
    assert "not_enough_houses" not in preview["blockers"]
    assert preview["summary_counts"]["houses"] == 0


# ------------------------------------------------------------------- API
def test_the_house_api_round_trips_and_is_org_isolated():
    owner = _user("api@houses.test")
    t = _meet(owner)
    c = _client(owner)

    r = c.post(f"/api/tournaments/{t.id}/houses/", {"name": "Blue", "colour": "#1e90ff"})
    assert r.status_code == 201, r.data
    house_id = r.data["id"]

    r = c.get(f"/api/tournaments/{t.id}/houses/")
    assert r.status_code == 200
    assert [h["name"] for h in r.data["houses"]] == ["Blue"]
    assert r.data["group_kind"] == "house"
    assert r.data["can_manage"] is True

    r = c.patch(f"/api/tournaments/{t.id}/houses/{house_id}/", {"name": "Azure"})
    assert r.status_code == 200 and r.data["name"] == "Azure"

    # A stranger cannot see the event at all (404, no existence leak).
    other = _user("stranger@houses.test")
    assert _client(other).get(f"/api/tournaments/{t.id}/houses/").status_code == 404

    r = c.delete(f"/api/tournaments/{t.id}/houses/{house_id}/")
    assert r.status_code == 204
    assert svc.houses_for(t).count() == 0


def test_the_house_api_refuses_a_school_tournament():
    owner = _user("apiinter@houses.test")
    t = create_tournament(user=owner, name="Inter Cup")
    r = _client(owner).get(f"/api/tournaments/{t.id}/houses/")
    assert r.status_code == 400
    assert r.data["detail"] == "houses_require_intra_school_scope"


def test_members_can_be_added_by_email_and_revoked():
    owner = _user("apimember@houses.test")
    t = _meet(owner)
    c = _client(owner)
    house_id = c.post(f"/api/tournaments/{t.id}/houses/", {"name": "Blue"}).data["id"]
    captain = _user("apicaptain@houses.test")

    r = c.post(
        f"/api/tournaments/{t.id}/houses/{house_id}/members/",
        {"email": "apicaptain@houses.test"},
    )
    assert r.status_code == 201
    assert [m["email"] for m in r.data["members"]] == ["apicaptain@houses.test"]

    r = c.delete(
        f"/api/tournaments/{t.id}/houses/{house_id}/members/?user={captain.id}"
    )
    assert r.status_code == 204
    assert svc.manageable_house_ids(t, captain) == set()


def test_a_house_manager_is_not_an_organizer():
    """Assignment gives a captain their house, not the console."""
    owner = _user("power@houses.test")
    t = _meet(owner)
    c = _client(owner)
    house_id = c.post(f"/api/tournaments/{t.id}/houses/", {"name": "Blue"}).data["id"]
    captain = _user("powercaptain@houses.test")
    c.post(
        f"/api/tournaments/{t.id}/houses/{house_id}/members/",
        {"email": captain.email},
    )

    cc = _client(captain)
    # They CAN see the event — being appointed has to grant that much, or they
    # could never reach the form they were appointed to fill.
    r = cc.get(f"/api/tournaments/{t.id}/houses/")
    assert r.status_code == 200
    assert r.data["can_manage"] is False
    assert r.data["my_houses"] == [house_id]
    # But they cannot run it.
    r = cc.post(f"/api/tournaments/{t.id}/houses/", {"name": "Sneaky"})
    assert r.status_code in (400, 403)
    assert svc.houses_for(t).count() == 1


def test_season_is_shared_across_a_schools_events():
    """Two events in one year share one season, so their houses are the same
    houses — which is what makes a season house table meaningful."""
    owner = _user("season@houses.test")
    a = _meet(owner, name="Sports Day")
    b = create_tournament(
        user=owner, name="Inter-house League",
        workspace_org=a.organization, scope=TournamentScope.INTRA_SCHOOL,
    )
    assert a.season_ref_id == b.season_ref_id
    assert Season.objects.filter(organization=a.organization).count() == 1

    blue = svc.create_house(tournament=a, name="Blue")
    reused = svc.create_house(tournament=b, name="Blue")
    assert reused.id == blue.id
    assert TournamentHouse.objects.filter(group=blue).count() == 2
