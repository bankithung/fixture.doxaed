"""TDD — seeding methods (redesign spec §4.3): registration (default, zero
behavior change), random (seeded RNG, seed persisted for replayable draws),
snake (serpentine group distribution), seeded (strict Team.seed order)."""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.fixtures.services.generate import (
    generate_round_robin,
    generate_single_elimination,
)
from apps.matches.models import Match
from apps.teams.models import Team
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str = "org@test.local") -> User:
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _fresh(admin, n: int, *, distinct_schools: bool = True):
    t = create_tournament(user=admin, name=f"Cup {uuid.uuid4().hex[:6]}")
    teams = []
    if distinct_schools:
        for i in range(n):
            teams += register_school(
                tournament=t, school_name=f"School {i + 1}",
                teams=[{"name": f"Team {i + 1:02d}", "players": []}],
            )
    else:
        teams = register_school(
            tournament=t, school_name="S",
            teams=[{"name": f"Team {i + 1:02d}", "players": []} for i in range(n)],
        )
    return t, teams


def _pairing_names(t) -> list[tuple[str, str]]:
    return [
        (m.home_team.name, m.away_team.name)
        for m in Match.objects.filter(tournament=t, deleted_at__isnull=True)
        .select_related("home_team", "away_team").order_by("match_no")
    ]


def test_random_seeding_is_deterministic_per_seed():
    admin = _verified()
    t1, _ = _fresh(admin, 6)
    t2, _ = _fresh(admin, 6)
    generate_round_robin(tournament=t1, group_size=6, seeding="random", seed=42)
    generate_round_robin(tournament=t2, group_size=6, seeding="random", seed=42)
    assert _pairing_names(t1) == _pairing_names(t2)  # replayable draw

    t3, _ = _fresh(admin, 6)
    generate_round_robin(tournament=t3, group_size=6, seeding="random", seed=43)
    assert _pairing_names(t3) != _pairing_names(t1)  # a different draw


def test_random_seeding_persists_generated_seed():
    admin = _verified()
    t, _ = _fresh(admin, 4)
    generate_round_robin(tournament=t, group_size=4, seeding="random")
    t.refresh_from_db()
    seed = (t.draw_config or {}).get("*", {}).get("seed")
    assert isinstance(seed, int)  # persisted for replay/dispute (tenet 3)

    # replaying the persisted seed on a fresh tournament reproduces the draw
    t2, _ = _fresh(admin, 4)
    generate_round_robin(tournament=t2, group_size=4, seeding="random", seed=seed)
    assert _pairing_names(t2) == _pairing_names(t)


def test_random_seed_persists_under_leaf_scope():
    from apps.tournaments.services.sports import normalize_sports

    admin = _verified()
    t = create_tournament(user=admin, name="Leaf Cup")
    t.sports = normalize_sports([{"name": "Football", "nodes": [{"name": "U15"}]}])
    t.save(update_fields=["sports"])
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i}", "leaf_key": "football.u15", "sport": "football",
                "players": []} for i in range(4)],
    )
    generate_round_robin(
        tournament=t, group_size=4, leaf_key="football.u15", seeding="random",
    )
    t.refresh_from_db()
    assert isinstance(t.draw_config["football.u15"]["seed"], int)


def test_snake_seeding_distributes_serpentine():
    admin = _verified()
    t, teams = _fresh(admin, 6)
    for i, tm in enumerate(teams):
        tm.seed = i + 1
        tm.save(update_fields=["seed"])
    generate_round_robin(tournament=t, group_size=3, seeding="snake")
    groups: dict[str, set[str]] = {}
    for m in Match.objects.filter(tournament=t).select_related(
        "home_team", "away_team"
    ):
        groups.setdefault(m.group_label, set()).update(
            {m.home_team.name, m.away_team.name}
        )
    # A,B,B,A,A,B over seeds 1..6 → A={1,4,5}, B={2,3,6}
    assert groups["Group A"] == {"Team 01", "Team 04", "Team 05"}
    assert groups["Group B"] == {"Team 02", "Team 03", "Team 06"}


def test_seeded_requires_every_team_to_have_a_seed():
    admin = _verified()
    t, _teams = _fresh(admin, 4)
    with pytest.raises(ValueError):  # §9 A8 — no seeds set yet
        generate_round_robin(tournament=t, group_size=4, seeding="seeded")
    assert Match.objects.filter(tournament=t).count() == 0


def test_seeded_knockout_uses_strict_seed_order():
    admin = _verified()
    t, teams = _fresh(admin, 4)
    # reverse of name order: Team 04 is the top seed
    for i, tm in enumerate(teams):
        tm.seed = len(teams) - i
        tm.save(update_fields=["seed"])
    matches = generate_single_elimination(
        tournament=t, teams=teams, seeding="seeded",
    )
    semis = sorted([m for m in matches if m.round_no == 1], key=lambda m: m.match_no)
    # standard bracket: seed 1 (Team 04) meets seed 4 (Team 01) in semi 1
    assert {semis[0].home_team.name, semis[0].away_team.name} == {"Team 04", "Team 01"}
    assert {semis[1].home_team.name, semis[1].away_team.name} == {"Team 03", "Team 02"}


def test_registration_default_changes_nothing():
    admin = _verified()
    t1, _ = _fresh(admin, 5)
    t2, _ = _fresh(admin, 5)
    generate_round_robin(tournament=t1, group_size=5)
    generate_round_robin(tournament=t2, group_size=5, seeding="registration")
    assert _pairing_names(t1) == _pairing_names(t2)


def test_generate_api_reads_seeding_from_stored_config():
    from apps.fixtures.services.draw_config import update_draw_config

    admin = _verified()
    t, _ = _fresh(admin, 4)
    update_draw_config(
        tournament=t, leaf_key="*",
        partial={"seeding": "random", "seed": 7}, by=admin,
    )
    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.post(f"/api/tournaments/{t.id}/generate-fixtures/", {}, format="json")
    assert r.status_code == 201, r.content
    assert r.json()["seed"] == 7

    t2, _ = _fresh(admin, 4)
    generate_round_robin(tournament=t2, group_size=5, seeding="random", seed=7)
    assert _pairing_names(t) == _pairing_names(t2)


# ----------------------------------------------------------- bulk seeds API
def test_seeds_api_bulk_sets_team_seeds():
    admin = _verified()
    t, teams = _fresh(admin, 3)
    c = APIClient()
    c.force_authenticate(user=admin)
    eid = str(uuid.uuid4())
    r = c.put(
        f"/api/tournaments/{t.id}/teams/seeds/",
        {"seeds": [{"team_id": str(tm.id), "seed": i + 1}
                   for i, tm in enumerate(teams)],
         "event_id": eid},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert r.json()["updated"] == 3
    assert [Team.objects.get(id=tm.id).seed for tm in teams] == [1, 2, 3]

    # replay: same event_id with different values -> ignored (invariant 3)
    r2 = c.put(
        f"/api/tournaments/{t.id}/teams/seeds/",
        {"seeds": [{"team_id": str(teams[0].id), "seed": 9}], "event_id": eid},
        format="json",
    )
    assert r2.status_code == 200
    assert Team.objects.get(id=teams[0].id).seed == 1

    from apps.audit.models import AuditEvent
    assert AuditEvent.objects.filter(
        event_type="team_seeds_updated", idempotency_key=eid
    ).count() == 1


def test_seeds_api_validates_and_scopes():
    admin = _verified()
    outsider = _verified("out@test.local")
    t, teams = _fresh(admin, 2)
    _other_t, other_teams = _fresh(admin, 2)
    c = APIClient()
    c.force_authenticate(user=admin)
    # a team from another tournament is rejected (no cross-scope writes)
    r = c.put(
        f"/api/tournaments/{t.id}/teams/seeds/",
        {"seeds": [{"team_id": str(other_teams[0].id), "seed": 1}],
         "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 400
    # bad seed value
    r = c.put(
        f"/api/tournaments/{t.id}/teams/seeds/",
        {"seeds": [{"team_id": str(teams[0].id), "seed": -1}],
         "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 400
    # outsider: 404, no existence leak
    co = APIClient()
    co.force_authenticate(user=outsider)
    assert co.put(
        f"/api/tournaments/{t.id}/teams/seeds/",
        {"seeds": [{"team_id": str(teams[0].id), "seed": 1}],
         "event_id": str(uuid.uuid4())},
        format="json",
    ).status_code == 404


def test_team_list_exposes_seed_for_the_seed_editor():
    # The CompetitionFormatWizard's SeedListEditor prefills from stored seeds
    # (redesign §6 screen 3) — the team list must surface them.
    admin = _verified()
    t, teams = _fresh(admin, 2)
    teams[0].seed = 1
    teams[0].save(update_fields=["seed"])
    c = APIClient()
    c.force_authenticate(user=admin)
    rows = c.get(f"/api/tournaments/{t.id}/teams/").json()
    by_name = {r["name"]: r for r in rows}
    assert by_name["Team 01"]["seed"] == 1
    assert by_name["Team 02"]["seed"] is None


def test_seeds_api_allows_clearing_with_null():
    admin = _verified()
    t, teams = _fresh(admin, 2)
    teams[0].seed = 5
    teams[0].save(update_fields=["seed"])
    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.put(
        f"/api/tournaments/{t.id}/teams/seeds/",
        {"seeds": [{"team_id": str(teams[0].id), "seed": None}],
         "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert Team.objects.get(id=teams[0].id).seed is None
