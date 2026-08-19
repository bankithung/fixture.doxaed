"""Copying one tournament's fixture setup onto another (owner 2026-08-19).

"I need a copy rule from different tournaments so that I can directly copy the
rules we have in Clone 2 into our main when it starts. Each and every rule and
timing, everything should be copied — only the rules, all inputs, everything
that comes under the fixture that is used to generate the fixture. The data
should remain untouched."
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.tournaments.models import Tournament
from apps.tournaments.services.copy_setup import (
    DEFAULT_PARTS,
    copy_fixture_setup,
)
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db

LEAF_TT = "table_tennis.u_14.boys.singles"
LEAF_SPK = "sepak_takraw.u_14.boys"

#: The real tree shape: a sport holds `nodes`, each node holds `children`.
SPORTS = [
    {
        "key": "table_tennis", "name": "Table Tennis",
        "nodes": [
            {"key": "u_14", "name": "U-14", "kind": "age_group", "children": [
                {"key": "boys", "name": "Boys", "kind": "gender", "children": [
                    {"key": "singles", "name": "Singles", "kind": "format",
                     "children": []},
                ]},
            ]},
        ],
    },
]


def _admin(email: str):
    u = User.objects.create_user(
        email=email, password="FixtureDemo2026!", is_active=True,
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _pair(admin):
    """A source with a full setup, and an empty target in the SAME workspace."""
    from apps.tournaments.services.sports import normalize_sports

    source = create_tournament(user=admin, name="Last year")
    # The realistic case: a host's tournaments live in ONE workspace, which is
    # also what lets their venues and court reservations be shared.
    target = create_tournament(
        user=admin, name="This year", workspace_org=source.organization,
    )
    for t in (source, target):
        t.sports = normalize_sports(SPORTS)
        t.save(update_fields=["sports"])
    source.constraints = [
        {"type": "min_rest_minutes", "scope": "all", "hard": True,
         "weight": 5, "params": {"minutes": 20}},
        {"type": "competition_priority", "scope": "all", "hard": False,
         "weight": 5, "params": {"order": [LEAF_TT], "mode": "within_round"}},
    ]
    source.draw_config = {
        "*": {"calendar": {"date_start": "2026-08-17", "daily_end": "15:30"}},
        LEAF_TT: {"format": "knockout", "match_duration_minutes": 10},
    }
    source.scheduling_config = {"slot_minutes": 30}
    source.rules = {"points": {"win": 3}}
    source.save(update_fields=[
        "constraints", "draw_config", "scheduling_config", "rules",
    ])
    return source, target


# ------------------------------------------------------------- what moves
def test_the_fixture_inputs_move_and_the_data_does_not():
    admin = _admin("a@test.local")
    source, target = _pair(admin)
    report = copy_fixture_setup(source=source, target=target, by=admin)
    target.refresh_from_db()

    assert report["copied"] is True
    assert target.constraints == source.constraints
    assert target.draw_config == source.draw_config
    assert target.scheduling_config == source.scheduling_config
    # Scoring rules govern MATCHES, not the draw, so they are opt-in.
    assert "rules" not in DEFAULT_PARTS
    assert target.rules != source.rules
    # And the target is still its own tournament.
    assert target.name == "This year"
    assert target.id != source.id


def test_scoring_rules_come_only_when_asked_for():
    admin = _admin("a@test.local")
    source, target = _pair(admin)
    copy_fixture_setup(
        source=source, target=target, by=admin,
        parts=["constraints", "rules"],
    )
    target.refresh_from_db()
    assert target.rules == source.rules
    assert target.constraints == source.constraints
    # draw_config was not asked for, so it stayed as it was.
    assert target.draw_config == {}


# --------------------------------------------------- looking before leaping
def test_a_dry_run_reports_without_writing():
    admin = _admin("a@test.local")
    source, target = _pair(admin)
    report = copy_fixture_setup(
        source=source, target=target, by=admin, dry_run=True,
    )
    target.refresh_from_db()
    assert report["dry_run"] is True and report["copied"] is False
    assert report["counts"]["constraints"] == 2
    assert target.constraints == []


def test_it_names_every_competition_the_target_does_not_have():
    """A rule the target cannot act on reads as set and does nothing. Say so."""
    admin = _admin("a@test.local")
    source, target = _pair(admin)
    source.constraints = [
        {"type": "min_rest_minutes", "scope": f"leaf:{LEAF_SPK}", "hard": True,
         "weight": 5, "params": {"minutes": 20}},
    ]
    source.draw_config = {LEAF_SPK: {"format": "groups_knockout"}}
    source.save(update_fields=["constraints", "draw_config"])
    report = copy_fixture_setup(
        source=source, target=target, by=admin, dry_run=True,
    )
    # The target runs table tennis only; the sepak references are dead.
    assert LEAF_SPK in report["unknown_competitions"]


def test_a_sport_wide_entry_is_not_reported_as_unknown():
    """A bare sport or a prefix matches whatever the target has — that is the
    point of writing it that way, so it is not a dead reference."""
    admin = _admin("a@test.local")
    source, target = _pair(admin)
    source.constraints = [
        {"type": "competition_priority", "scope": "sport:table_tennis",
         "hard": False, "weight": 5,
         "params": {"order": ["table_tennis"], "mode": "within_round"}},
    ]
    source.save(update_fields=["constraints"])
    report = copy_fixture_setup(
        source=source, target=target, by=admin, dry_run=True,
    )
    assert report["unknown_competitions"] == []


# ------------------------------------------------------------- the refusals
def test_it_refuses_another_workspace():
    a, b = _admin("a@test.local"), _admin("b@test.local")
    source = create_tournament(user=a, name="Mine")
    target = create_tournament(user=b, name="Theirs")
    with pytest.raises(PermissionError):
        copy_fixture_setup(source=source, target=target, by=a)


def test_it_refuses_copying_a_tournament_onto_itself():
    admin = _admin("a@test.local")
    source, _target = _pair(admin)
    with pytest.raises(ValueError):
        copy_fixture_setup(source=source, target=source, by=admin)


def test_it_refuses_an_empty_part_list():
    admin = _admin("a@test.local")
    source, target = _pair(admin)
    with pytest.raises(ValueError):
        copy_fixture_setup(source=source, target=target, by=admin, parts=["nope"])


# ------------------------------------------------------------- replay guard
def test_a_replayed_copy_does_not_run_twice():
    admin = _admin("a@test.local")
    source, target = _pair(admin)
    key = str(uuid.uuid4())
    first = copy_fixture_setup(
        source=source, target=target, by=admin, event_id=key,
    )
    assert first["copied"] is True
    # The host changes their mind and edits the target, then the same request
    # arrives again: it must NOT overwrite the edit.
    target.constraints = []
    target.save(update_fields=["constraints"])
    again = copy_fixture_setup(
        source=source, target=target, by=admin, event_id=key,
    )
    target.refresh_from_db()
    assert again.get("replayed") is True
    assert target.constraints == []


def test_the_copy_is_audited():
    from apps.audit.models import AuditEvent

    admin = _admin("a@test.local")
    source, target = _pair(admin)
    copy_fixture_setup(source=source, target=target, by=admin)
    row = AuditEvent.objects.filter(
        event_type="tournament_setup_copied", target_id=target.id,
    ).first()
    assert row is not None
    assert row.payload_after["source_tournament_id"] == str(source.id)


# -------------------------------------------------------- through the API
def test_the_endpoint_copies_for_a_manager(client):
    admin = _admin("a@test.local")
    source, target = _pair(admin)
    client.force_login(admin)
    res = client.post(
        f"/api/tournaments/{target.id}/copy-setup/",
        data={"source_tournament_id": str(source.id), "dry_run": True},
        content_type="application/json",
    )
    assert res.status_code == 200, res.content
    assert res.json()["counts"]["constraints"] == 2
    assert res.json()["copied"] is False


def test_the_endpoint_refuses_a_stranger(client):
    a, b = _admin("a@test.local"), _admin("b@test.local")
    source = create_tournament(user=a, name="Mine")
    target = create_tournament(
        user=a, name="Also mine", workspace_org=source.organization,
    )
    client.force_login(b)
    res = client.post(
        f"/api/tournaments/{target.id}/copy-setup/",
        data={"source_tournament_id": str(source.id)},
        content_type="application/json",
    )
    # No access to the tournament at all — 404, never a hint that it exists.
    assert res.status_code == 404


def test_copying_leaves_the_targets_own_teams_alone():
    """The whole promise: settings move, data does not."""
    from apps.teams.services.registration import register_school

    admin = _admin("a@test.local")
    source, target = _pair(admin)
    register_school(
        tournament=target, school_name="Grace Academy",
        teams=[{"name": "Grace A", "sport": "table_tennis",
                "leaf_key": LEAF_TT, "players": []}],
    )
    before = list(
        Tournament.objects.get(pk=target.pk).teams.values_list("name", flat=True)
    ) if hasattr(Tournament, "teams") else None
    copy_fixture_setup(source=source, target=target, by=admin)
    from apps.teams.models import Institution, Team

    assert Team.objects.filter(tournament=target, deleted_at__isnull=True).count() == 1
    assert Institution.objects.filter(
        tournament=target, deleted_at__isnull=True,
    ).count() == 1
    assert before is None or before
