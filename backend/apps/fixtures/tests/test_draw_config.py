"""TDD — per-competition draw config (fixture-engine redesign §2.1):
storage, whitelist merge + validation (§9 A8), effective-config layering
(defaults < legacy rules keys < draw_config["*"] < draw_config[leaf] <
explicit request params), the PATCH endpoint, and the generator reading
stored config (spec §4.5 "generator-default")."""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.audit.models import AuditEvent
from apps.fixtures.services.draw_config import (
    DEFAULT_DRAW_CONFIG,
    effective_draw_config,
    merge_draw_config,
    update_draw_config,
)
from apps.matches.models import Match
from apps.teams.services.registration import register_school
from apps.tournaments.models import (
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
)
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()
pytestmark = pytest.mark.django_db

LEAF_U15 = "football.u15"
LEAF_U17 = "football.u17"


def _verified(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _client(user):
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _tournament(admin, *, with_sports=True):
    t = create_tournament(user=admin, name="Cup")
    if with_sports:
        t.sports = normalize_sports([
            {"name": "Football", "nodes": [{"name": "U15"}, {"name": "U17"}]},
        ])
        t.save(update_fields=["sports"])
    return t


# ------------------------------------------------------------------- merge
def test_merge_rejects_unknown_keys():
    with pytest.raises(ValueError):
        merge_draw_config({"bogus": 1})


def test_merge_keeps_layers_sparse():
    out = merge_draw_config({"legs": 2}, base={"format": "knockout"})
    assert out == {"format": "knockout", "legs": 2}  # defaults NOT baked in


@pytest.mark.parametrize(
    "partial",
    [
        {"group_size": 1},                          # A8: group_size < 2
        {"group_size": 3, "advance_per_group": 3},  # A8: apg >= group_size
        {"advance_per_group": 0},
        {"format": "ladder"},  # still deferred (swiss landed in increment P)
        {"legs": 3},
        {"seeding": "lottery"},
        {"third_place": "yes"},
        {"min_entries_action": "auto_champion"},    # A6: deferred
        {"bye_policy": "preliminary_round"},        # deferred
        {"seed": "abc"},
    ],
)
def test_merge_rejects_invalid_values(partial):
    with pytest.raises(ValueError):
        merge_draw_config(partial)


def test_merge_cross_validates_against_base():
    # apg valid alone but >= the group_size already stored on the layer
    with pytest.raises(ValueError):
        merge_draw_config({"advance_per_group": 4}, base={"group_size": 4})


# --------------------------------------------------------------- layering
def test_effective_layering_defaults_then_rules_then_star_then_leaf():
    admin = _verified("a@test.local")
    t = _tournament(admin)
    assert effective_draw_config(t, LEAF_U15) == DEFAULT_DRAW_CONFIG

    t.rules = {"format": "knockout", "group_size": 4}
    cfg = effective_draw_config(t, LEAF_U15)
    assert (cfg["format"], cfg["group_size"]) == ("knockout", 4)  # legacy rules

    t.draw_config = {"*": {"format": "round_robin", "legs": 2}}
    cfg = effective_draw_config(t, LEAF_U15)
    assert cfg["format"] == "round_robin"   # "*" beats rules
    assert cfg["group_size"] == 4           # rules still fills the gap
    assert cfg["legs"] == 2

    t.draw_config[LEAF_U15] = {"format": "knockout", "third_place": True}
    cfg = effective_draw_config(t, LEAF_U15)
    assert (cfg["format"], cfg["third_place"]) == ("knockout", True)  # leaf wins
    assert effective_draw_config(t, LEAF_U17)["format"] == "round_robin"

    cfg = effective_draw_config(t, LEAF_U15, overrides={"format": "by_category"})
    assert cfg["format"] == "by_category"   # explicit request params always win


def test_effective_without_leaf_uses_star_only():
    admin = _verified("a@test.local")
    t = _tournament(admin)
    t.draw_config = {"*": {"group_size": 3}, LEAF_U15: {"group_size": 9}}
    assert effective_draw_config(t, None)["group_size"] == 3


# ---------------------------------------------------------------- service
def test_update_draw_config_persists_audits_and_replays():
    admin = _verified("a@test.local")
    t = _tournament(admin)
    eid = uuid.uuid4()
    update_draw_config(
        tournament=t, leaf_key=LEAF_U15, partial={"format": "knockout"},
        by=admin, event_id=eid,
    )
    t.refresh_from_db()
    assert t.draw_config[LEAF_U15] == {"format": "knockout"}
    assert AuditEvent.objects.filter(
        event_type="draw_config_updated", idempotency_key=eid
    ).count() == 1

    # replay: same event_id with a different value -> ignored
    update_draw_config(
        tournament=t, leaf_key=LEAF_U15, partial={"format": "round_robin"},
        by=admin, event_id=eid,
    )
    t.refresh_from_db()
    assert t.draw_config[LEAF_U15] == {"format": "knockout"}


def test_update_draw_config_rejects_unknown_leaf():
    admin = _verified("a@test.local")
    t = _tournament(admin)
    with pytest.raises(ValueError):
        update_draw_config(
            tournament=t, leaf_key="cricket.u19", partial={"legs": 2}, by=admin,
        )


# -------------------------------------------------------------------- API
def test_patch_endpoint_roundtrip_and_get():
    admin = _verified("a@test.local")
    t = _tournament(admin)
    c = _client(admin)
    r = c.patch(
        f"/api/tournaments/{t.id}/draw-config/",
        {"leaf_key": LEAF_U15, "config": {"format": "knockout", "third_place": True},
         "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 200, r.content
    body = r.json()
    assert body["draw_config"][LEAF_U15] == {"format": "knockout", "third_place": True}
    assert body["effective"]["third_place"] is True
    assert body["has_matches"] is False

    g = c.get(f"/api/tournaments/{t.id}/draw-config/")
    assert g.status_code == 200
    assert g.json()["draw_config"][LEAF_U15]["format"] == "knockout"
    assert g.json()["defaults"]["seeding"] == "registration"


def test_patch_endpoint_defaults_to_star_layer():
    admin = _verified("a@test.local")
    t = _tournament(admin)
    r = _client(admin).patch(
        f"/api/tournaments/{t.id}/draw-config/",
        {"config": {"legs": 2}, "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert r.json()["draw_config"]["*"] == {"legs": 2}


def test_patch_endpoint_validation_errors_are_400():
    admin = _verified("a@test.local")
    t = _tournament(admin)
    r = _client(admin).patch(
        f"/api/tournaments/{t.id}/draw-config/",
        {"leaf_key": LEAF_U15, "config": {"group_size": 1},
         "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 400


def test_patch_endpoint_permissions():
    admin = _verified("a@test.local")
    outsider = _verified("b@test.local")
    t = _tournament(admin)
    body = {"leaf_key": LEAF_U15, "config": {"legs": 2},
            "event_id": str(uuid.uuid4())}
    # outsider: 404 (no existence leak)
    assert _client(outsider).patch(
        f"/api/tournaments/{t.id}/draw-config/", body, format="json"
    ).status_code == 404
    assert _client(outsider).get(
        f"/api/tournaments/{t.id}/draw-config/"
    ).status_code == 404
    # member without the bracket_editor module: can read, cannot write
    scorer = _verified("c@test.local")
    TournamentMembership.objects.create(
        user=scorer, tournament=t, role=TournamentMembershipRole.MATCH_SCORER,
        status=TournamentMembershipStatus.ACTIVE,
    )
    assert _client(scorer).get(
        f"/api/tournaments/{t.id}/draw-config/"
    ).status_code == 200
    assert _client(scorer).patch(
        f"/api/tournaments/{t.id}/draw-config/", body, format="json"
    ).status_code == 403


def test_patch_flags_existing_draw_instead_of_blocking():
    """Freeze semantics (§2.1): once a leaf has matches, edits are still
    allowed — the response flags it so the UI can show the invariant-10
    banner."""
    admin = _verified("a@test.local")
    t = _tournament(admin)
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i}", "leaf_key": LEAF_U15, "sport": "football",
                "players": []} for i in range(2)],
    )
    c = _client(admin)
    r0 = c.post(
        f"/api/tournaments/{t.id}/generate-fixtures/",
        {"format": "by_category", "leaf_key": LEAF_U15}, format="json",
    )
    assert r0.status_code == 201, r0.content
    r = c.patch(
        f"/api/tournaments/{t.id}/draw-config/",
        {"leaf_key": LEAF_U15, "config": {"legs": 2},
         "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert r.json()["has_matches"] is True


# ------------------------------------------------- generator reads config
def test_generate_with_bare_body_reads_stored_format():
    """Spec §4.5: a request body of just {leaf_key} works — the wizard saves
    format via the draw-config PATCH, then generation needs no params."""
    admin = _verified("a@test.local")
    t = _tournament(admin)
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i}", "leaf_key": LEAF_U15, "sport": "football",
                "players": []} for i in range(4)],
    )
    update_draw_config(
        tournament=t, leaf_key=LEAF_U15, partial={"format": "knockout"}, by=admin,
    )
    r = _client(admin).post(
        f"/api/tournaments/{t.id}/generate-fixtures/",
        {"leaf_key": LEAF_U15}, format="json",
    )
    assert r.status_code == 201, r.content
    assert r.json()["format"] == "knockout"
    ms = Match.objects.filter(tournament=t, leaf_key=LEAF_U15)
    assert ms.count() == 3  # 4 teams -> 2 semis + final
    assert set(ms.values_list("stage", flat=True)) == {"knockout"}


def test_generate_explicit_params_beat_stored_config():
    admin = _verified("a@test.local")
    t = _tournament(admin)
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i}", "leaf_key": LEAF_U15, "sport": "football",
                "players": []} for i in range(4)],
    )
    update_draw_config(
        tournament=t, leaf_key=LEAF_U15, partial={"format": "knockout"}, by=admin,
    )
    r = _client(admin).post(
        f"/api/tournaments/{t.id}/generate-fixtures/",
        {"leaf_key": LEAF_U15, "format": "by_category"}, format="json",
    )
    assert r.status_code == 201, r.content
    assert Match.objects.filter(tournament=t).count() == 6  # round robin C(4,2)


def test_generate_groups_knockout_config_generates_group_stage():
    admin = _verified("a@test.local")
    t = _tournament(admin)
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i}", "players": []} for i in range(8)],
    )
    update_draw_config(
        tournament=t, leaf_key="*",
        partial={"format": "groups_knockout", "group_size": 4}, by=admin,
    )
    r = _client(admin).post(
        f"/api/tournaments/{t.id}/generate-fixtures/", {}, format="json",
    )
    assert r.status_code == 201, r.content
    labels = set(
        Match.objects.filter(tournament=t).values_list("group_label", flat=True)
    )
    assert labels == {"Group A", "Group B"}  # stored group_size=4 honored


def test_venue_count_field_defaults_to_one():
    from apps.fixtures.models import Venue

    admin = _verified("a@test.local")
    t = _tournament(admin)
    v = Venue.objects.create(organization=t.organization, name="MP Hall")
    assert v.count == 1


# ----------------------------------------------------------------- calendar
def test_calendar_layer_round_trips():
    """The global-setup wizard's calendar (spec §5.1 "wizard-saved dates")
    persists into draw_config["*"].calendar — whitelist-validated."""
    admin = _verified("a@test.local")
    t = _tournament(admin)
    update_draw_config(
        tournament=t, leaf_key="*",
        partial={"calendar": {
            "date_start": "2026-08-01", "date_end": "2026-08-05",
            "daily_start": "09:00", "daily_end": "17:00", "slot_minutes": 90,
        }},
        by=admin,
    )
    t.refresh_from_db()
    assert t.draw_config["*"]["calendar"]["date_start"] == "2026-08-01"
    assert effective_draw_config(t, LEAF_U15)["calendar"]["slot_minutes"] == 90


@pytest.mark.parametrize(
    "calendar",
    [
        "2026-08-01",                  # not an object
        {"bogus": 1},                  # unknown subkey
        {"date_start": "not-a-date"},
        {"date_end": 20260801},
        {"daily_start": "9am"},
        {"slot_minutes": "ninety"},
        {"slot_minutes": 0},
    ],
)
def test_calendar_rejects_invalid_shapes(calendar):
    with pytest.raises(ValueError):
        merge_draw_config({"calendar": calendar})


def test_calendar_excluded_from_inputs_hash():
    """Calendar is slot-time data (§2.5): saving it must not flip the
    already_generated staleness signal."""
    from apps.fixtures.services.generate import compute_inputs_hash

    admin = _verified("a@test.local")
    t = _tournament(admin)
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i}", "leaf_key": LEAF_U15, "sport": "football",
                "players": []} for i in range(3)],
    )
    h0 = compute_inputs_hash(t, LEAF_U15)
    update_draw_config(
        tournament=t, leaf_key="*",
        partial={"calendar": {"date_start": "2026-08-01"}}, by=admin,
    )
    t.refresh_from_db()
    assert compute_inputs_hash(t, LEAF_U15) == h0
