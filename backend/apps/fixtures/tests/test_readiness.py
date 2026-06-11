"""TDD — fixture-readiness checklist (redesign spec §5.1, amendments §9
A8/A10): server-computed per-leaf checks with fix deep-link keys, plus the
inputs_hash v2 staleness signal (§2.5) behind ``already_generated``."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.fixtures.models import Venue
from apps.fixtures.services.draw_config import update_draw_config
from apps.fixtures.services.generate import compute_inputs_hash
from apps.fixtures.services.readiness import fixture_readiness
from apps.teams.models import Team
from apps.teams.services.registration import register_school
from apps.tournaments.models import (
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
)
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.rules import update_settings
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


def _tournament(admin):
    t = create_tournament(user=admin, name="Cup")
    t.sports = normalize_sports([
        {"name": "Football", "nodes": [{"name": "U15"}, {"name": "U17"}]},
    ])
    t.save(update_fields=["sports"])
    return t


def _register(t, n, leaf=LEAF_U15, school="S"):
    return register_school(
        tournament=t, school_name=school,
        teams=[{"name": f"{school} T{i}", "leaf_key": leaf, "sport": "football",
                "players": []} for i in range(n)],
    )


def _checks(block) -> dict:
    return {c["id"]: c for c in block["checks"]}


def _leaf(body, leaf_key):
    return next(c for c in body["competitions"] if c["leaf_key"] == leaf_key)


# ------------------------------------------------------------------ global
def test_global_checks_fail_on_empty_tournament():
    admin = _verified("a@test.local")
    t = _tournament(admin)
    out = fixture_readiness(t)
    g = _checks(out["global"])
    assert g["calendar_set"]["status"] == "fail"
    assert g["calendar_set"]["fix"] == "settings"
    assert g["venues_defined"]["status"] == "fail"
    assert g["venues_defined"]["fix"] == "venues"
    assert g["constraints_reviewed"]["status"] == "warn"  # warn, never gates
    assert g["constraints_reviewed"]["fix"] == "constraints"


def test_global_checks_pass_when_configured():
    admin = _verified("a@test.local")
    t = _tournament(admin)
    t.scheduling_config = {"date_start": "2026-08-01", "date_end": "2026-08-05"}
    t.save(update_fields=["scheduling_config"])
    Venue.objects.create(organization=t.organization, name="Main Ground")
    update_draw_config(
        tournament=t, leaf_key="*",
        partial={"constraints_reviewed_at": timezone.now().isoformat()}, by=admin,
    )
    g = _checks(fixture_readiness(t)["global"])
    assert {c["status"] for c in g.values()} == {"ok"}


def test_constraints_reviewed_goes_stale_after_settings_change():
    """§9 A10: a constraint change AFTER the review flips the check back."""
    admin = _verified("a@test.local")
    t = _tournament(admin)
    update_draw_config(
        tournament=t, leaf_key="*",
        partial={"constraints_reviewed_at": timezone.now().isoformat()}, by=admin,
    )
    assert _checks(fixture_readiness(t)["global"])[
        "constraints_reviewed"]["status"] == "ok"
    update_settings(
        tournament=t, constraints=[{"type": "blackout_dates",
                                    "params": {"dates": ["2026-08-02"]}}],
        by=admin,
    )
    chk = _checks(fixture_readiness(t)["global"])["constraints_reviewed"]
    assert chk["status"] == "warn"
    assert chk["fix"] == "constraints"


def test_calendar_set_accepts_wizard_saved_dates():
    """§5.1: calendar_set passes on scheduling_config OR the global-setup
    wizard's draw_config["*"].calendar dates."""
    admin = _verified("a@test.local")
    t = _tournament(admin)
    update_draw_config(
        tournament=t, leaf_key="*",
        partial={"calendar": {"date_start": "2026-08-01",
                              "date_end": "2026-08-05"}},
        by=admin,
    )
    t.refresh_from_db()
    assert _checks(fixture_readiness(t)["global"])[
        "calendar_set"]["status"] == "ok"


# ------------------------------------------------------------ per-competition
def test_enough_teams_gates_and_summary_counts():
    admin = _verified("a@test.local")
    t = _tournament(admin)
    _register(t, 1, leaf=LEAF_U15)
    _register(t, 2, leaf=LEAF_U17, school="X")
    body = fixture_readiness(t)
    u15 = _leaf(body, LEAF_U15)
    assert u15["label"]  # human label, not the raw key
    c = _checks(u15)
    assert c["enough_teams"]["status"] == "fail"
    assert c["enough_teams"]["fix"] == "teams"
    assert u15["ready"] is False
    u17 = _leaf(body, LEAF_U17)
    assert _checks(u17)["enough_teams"]["status"] == "ok"
    # summary counts ok checks over the 5 gating ones (already_generated is
    # informational)
    assert u15["summary"].endswith("/5")


def test_format_chosen_warns_until_stored():
    admin = _verified("a@test.local")
    t = _tournament(admin)
    _register(t, 2)
    assert _checks(_leaf(fixture_readiness(t), LEAF_U15))[
        "format_chosen"]["status"] == "warn"
    update_draw_config(
        tournament=t, leaf_key=LEAF_U15, partial={"format": "knockout"}, by=admin,
    )
    t.refresh_from_db()
    assert _checks(_leaf(fixture_readiness(t), LEAF_U15))[
        "format_chosen"]["status"] == "ok"


def test_seeds_set_fails_when_seeded_without_seeds():
    """§9 A8: seeding='seeded' readiness-FAILS while any team lacks a seed."""
    admin = _verified("a@test.local")
    t = _tournament(admin)
    teams = _register(t, 3)
    update_draw_config(
        tournament=t, leaf_key=LEAF_U15, partial={"seeding": "seeded"}, by=admin,
    )
    t.refresh_from_db()
    chk = _checks(_leaf(fixture_readiness(t), LEAF_U15))["seeds_set"]
    assert chk["status"] == "fail"
    assert chk["fix"] == "seeds"
    for i, tm in enumerate(teams):
        Team.objects.filter(id=tm.id).update(seed=i + 1)
    assert _checks(_leaf(fixture_readiness(t), LEAF_U15))[
        "seeds_set"]["status"] == "ok"
    # other leaf (seeding=registration) never requires seeds
    _register(t, 2, leaf=LEAF_U17, school="X")
    assert _checks(_leaf(fixture_readiness(t), LEAF_U17))[
        "seeds_set"]["status"] == "ok"


def test_seeds_set_fails_for_keep_apart_seed_pot():
    """§9 A8: keep_apart key='seed_pot' also requires every team seeded."""
    admin = _verified("a@test.local")
    t = _tournament(admin)
    _register(t, 4)
    update_settings(
        tournament=t,
        constraints=[{"type": "keep_apart_until_round", "scope": f"leaf:{LEAF_U15}",
                      "params": {"key": "seed_pot", "until_round": 2}}],
        by=admin,
    )
    assert _checks(_leaf(fixture_readiness(t), LEAF_U15))[
        "seeds_set"]["status"] == "fail"
    Team.objects.filter(tournament=t).update(seed=1)
    assert _checks(_leaf(fixture_readiness(t), LEAF_U15))[
        "seeds_set"]["status"] == "ok"


def test_already_generated_tracks_inputs_hash_v2():
    """§2.5/§5.1: no draw → ok; fresh draw → ok (v2 hash stamped); a new
    registration after the draw → warn (inputs changed, invariant 10)."""
    admin = _verified("a@test.local")
    t = _tournament(admin)
    _register(t, 3)
    assert _checks(_leaf(fixture_readiness(t), LEAF_U15))[
        "already_generated"]["status"] == "ok"

    c = _client(admin)
    r = c.post(
        f"/api/tournaments/{t.id}/generate-fixtures/",
        {"format": "by_category", "leaf_key": LEAF_U15}, format="json",
    )
    assert r.status_code == 201, r.content
    t.refresh_from_db()
    assert _checks(_leaf(fixture_readiness(t), LEAF_U15))[
        "already_generated"]["status"] == "ok"

    _register(t, 1, school="Late")  # inputs changed under the draw
    chk = _checks(_leaf(fixture_readiness(t), LEAF_U15))["already_generated"]
    assert chk["status"] == "warn"
    assert chk["fix"] == "diff"


def test_inputs_hash_v2_ignores_seed_and_review_bookkeeping():
    """The hash covers teams + draw config + pairing constraints (§2.5) but
    not the replay seed or the reviewed-at timestamp — accepting a previewed
    random draw must not immediately read as 'inputs changed'."""
    admin = _verified("a@test.local")
    t = _tournament(admin)
    _register(t, 3)
    h0 = compute_inputs_hash(t, LEAF_U15)
    update_draw_config(
        tournament=t, leaf_key=LEAF_U15,
        partial={"seed": 42,
                 "constraints_reviewed_at": timezone.now().isoformat()},
        by=admin,
    )
    t.refresh_from_db()
    assert compute_inputs_hash(t, LEAF_U15) == h0
    update_draw_config(
        tournament=t, leaf_key=LEAF_U15, partial={"legs": 2}, by=admin,
    )
    t.refresh_from_db()
    assert compute_inputs_hash(t, LEAF_U15) != h0  # real input → new hash


# --------------------------------------------------------------------- API
def test_endpoint_membership_gate_and_shape():
    admin = _verified("a@test.local")
    outsider = _verified("b@test.local")
    t = _tournament(admin)
    _register(t, 2)
    url = f"/api/tournaments/{t.id}/fixture-readiness/"
    assert _client(outsider).get(url).status_code == 404  # no existence leak
    # any member may read (scorer has no bracket_editor module)
    scorer = _verified("c@test.local")
    TournamentMembership.objects.create(
        user=scorer, tournament=t, role=TournamentMembershipRole.MATCH_SCORER,
        status=TournamentMembershipStatus.ACTIVE,
    )
    r = _client(scorer).get(url)
    assert r.status_code == 200
    body = r.json()
    assert {c["id"] for c in body["global"]["checks"]} == {
        "calendar_set", "venues_defined", "constraints_reviewed",
    }
    leaf = _leaf(body, LEAF_U15)
    assert {c["id"] for c in leaf["checks"]} == {
        "enough_teams", "format_chosen", "seeds_set", "calendar_set",
        "constraints_reviewed", "already_generated",
    }
    assert isinstance(leaf["ready"], bool)
    assert _client(admin).get(url).status_code == 200
    # read-only: GET twice, same body
    assert _client(admin).get(url).json() == body
