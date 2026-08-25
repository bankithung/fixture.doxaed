"""`GET`/`PATCH /api/tournaments/{id}/awards/` — the medal tally setup.

Spec: docs/superpowers/specs/2026-08-25-results-medal-tally-design.md.

The load-bearing choice is that awards config sits OUTSIDE `rules`: the ladder
decides a trophy rather than a result, and a host must be able to change it on
the morning of the meet — which the invariant-7 freeze would forbid.
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.tournaments.models import TournamentStatus
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()
pytestmark = pytest.mark.django_db

SPORTS = [
    {"name": "Table Tennis", "nodes": [{
        "name": "U-14",
        "children": [{"name": "Boys", "children": [{"name": "Singles"}]},
                     {"name": "Girls", "children": [{"name": "Singles"}]}],
    }]},
    {"name": "Sepak Takraw", "nodes": [{
        "name": "U-14", "children": [{"name": "Boys"}, {"name": "Girls"}],
    }]},
]


def _user(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _client(user):
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _tournament(admin, sports=True):
    t = create_tournament(user=admin, name="Awards Cup")
    if sports:
        t.sports = normalize_sports(SPORTS)
        t.save(update_fields=["sports"])
    return t


def test_defaults_are_the_owners_ladder_and_the_feature_is_off_until_asked():
    admin = _user(f"aw-{uuid.uuid4().hex[:6]}@test.local")
    t = _tournament(admin)
    body = _client(admin).get(f"/api/tournaments/{t.id}/awards/").json()

    assert body["awards"]["enabled"] is False
    assert [(r["place"], r["points"]) for r in body["awards"]["ladder"]] == [
        (1, 5), (2, 3), (3, 2),
    ]
    assert body["can_manage"] is True


def test_it_suggests_groups_read_off_the_hosts_own_category_tree():
    """One group per age band and gender, spanning SPORTS — exactly how the
    reference medal sheet bands its columns."""
    admin = _user(f"aw-{uuid.uuid4().hex[:6]}@test.local")
    t = _tournament(admin)
    body = _client(admin).get(f"/api/tournaments/{t.id}/awards/").json()

    groups = {g["label"]: g for g in body["suggested_groups"]}
    assert "U-14 Boys" in groups
    assert set(groups["U-14 Boys"]["include"]) == {
        "table_tennis.u_14.boys", "sepak_takraw.u_14.boys",
    }
    assert groups["Overall Champion"]["include"] == []


def test_a_manager_can_change_the_ladder_after_the_rules_have_frozen():
    admin = _user(f"aw-{uuid.uuid4().hex[:6]}@test.local")
    t = _tournament(admin)
    t.status = TournamentStatus.LIVE
    t.rules_frozen_at = timezone.now()
    t.save(update_fields=["status", "rules_frozen_at"])

    r = _client(admin).patch(
        f"/api/tournaments/{t.id}/awards/",
        {"awards": {"enabled": True,
                    "ladder": [{"place": 1, "points": 10, "label": "Gold"}]}},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert r.json()["awards"]["ladder"] == [
        {"place": 1, "points": 10, "label": "Gold"}
    ]


def test_a_patch_merges_rather_than_replacing_the_whole_config():
    admin = _user(f"aw-{uuid.uuid4().hex[:6]}@test.local")
    t = _tournament(admin)
    c = _client(admin)
    c.patch(f"/api/tournaments/{t.id}/awards/",
            {"awards": {"enabled": True, "groups": [
                {"key": "overall", "label": "Overall", "include": []}]}},
            format="json")
    body = c.patch(f"/api/tournaments/{t.id}/awards/",
                   {"awards": {"bronze": "none"}}, format="json").json()

    assert body["awards"]["bronze"] == "none"
    assert body["awards"]["enabled"] is True
    assert [g["key"] for g in body["awards"]["groups"]] == ["overall"]


@pytest.mark.parametrize("bad,detail", [
    ({"ladder": [{"place": 1, "points": -5}]}, "must_not_be_negative"),
    ({"ladder": [{"place": 1, "points": 5}, {"place": 1, "points": 3}]},
     "duplicate_place"),
    ({"bronze": "silver"}, "bronze_mode_unknown"),
    ({"groups": [{"label": ""}]}, "group_label_required"),
    ({"overrides": [{"leaf_key": "x", "place": 1}]},
     "override_needs_a_team_or_a_name"),
    ({"nonsense": 1}, "unknown_awards_keys"),
])
def test_invalid_config_is_refused_with_a_reason(bad, detail):
    admin = _user(f"aw-{uuid.uuid4().hex[:6]}@test.local")
    t = _tournament(admin)
    r = _client(admin).patch(
        f"/api/tournaments/{t.id}/awards/", {"awards": bad}, format="json",
    )
    assert r.status_code == 400
    assert detail in str(r.json())


def test_two_groups_that_slug_the_same_stay_two_groups():
    """The host types labels, not keys — a collision must not make the second
    group unreachable."""
    admin = _user(f"aw-{uuid.uuid4().hex[:6]}@test.local")
    t = _tournament(admin)
    body = _client(admin).patch(
        f"/api/tournaments/{t.id}/awards/",
        {"awards": {"groups": [{"label": "U 14 Boys", "include": ["a"]},
                               {"label": "U-14 Boys", "include": ["b"]}]}},
        format="json",
    ).json()

    keys = [g["key"] for g in body["awards"]["groups"]]
    assert keys == ["u_14_boys", "u_14_boys_2"]


def test_patch_is_idempotent_on_event_id():
    admin = _user(f"aw-{uuid.uuid4().hex[:6]}@test.local")
    t = _tournament(admin)
    c = _client(admin)
    eid = str(uuid.uuid4())
    c.patch(f"/api/tournaments/{t.id}/awards/",
            {"awards": {"bronze": "none"}, "event_id": eid}, format="json")
    body = c.patch(f"/api/tournaments/{t.id}/awards/",
                   {"awards": {"bronze": "shared"}, "event_id": eid},
                   format="json").json()

    assert body["awards"]["bronze"] == "none"  # the replay changed nothing


def test_a_non_manager_may_read_but_not_write():
    admin = _user(f"aw-{uuid.uuid4().hex[:6]}@test.local")
    t = _tournament(admin)
    viewer = _user(f"vw-{uuid.uuid4().hex[:6]}@test.local")
    from apps.tournaments.models import TournamentMembership

    TournamentMembership.objects.create(
        user=viewer, tournament=t, role="viewer", status="active",
    )
    c = _client(viewer)
    assert c.get(f"/api/tournaments/{t.id}/awards/").status_code == 200
    r = c.patch(f"/api/tournaments/{t.id}/awards/",
                {"awards": {"bronze": "none"}}, format="json")
    assert r.status_code == 403


def test_another_workspace_cannot_see_or_set_the_ladder():
    """Invariant 2: no existence leak across organizations."""
    admin = _user(f"aw-{uuid.uuid4().hex[:6]}@test.local")
    t = _tournament(admin)
    stranger = _user(f"st-{uuid.uuid4().hex[:6]}@test.local")

    c = _client(stranger)
    assert c.get(f"/api/tournaments/{t.id}/awards/").status_code == 404
    assert c.patch(f"/api/tournaments/{t.id}/awards/",
                   {"awards": {"bronze": "none"}}, format="json").status_code == 404
