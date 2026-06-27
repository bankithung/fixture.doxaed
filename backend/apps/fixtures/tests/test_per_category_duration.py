"""TDD — per-category match durations (owner ask 2026-06-27).

A competition can carry its own match length via the layered scalar
``draw_config[leaf]["match_duration_minutes"]`` ("*" = tournament default,
"<leaf>" = per-category override). The scheduler's ``duration_for`` resolves it
(leaf override → per-sport scheduling override → SPORT_PROFILES → slot_minutes),
so each match BLOCKS its own length. Duration is scheduling-only — it must NOT
enter ``inputs_hash`` (it never changes WHO plays WHOM).
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.fixtures.services.generate import compute_inputs_hash
from apps.fixtures.services.scheduler import build_schedule_inputs, config_from_dict
from apps.matches.models import Match, MatchStatus
from apps.teams.models import Team
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _setup():
    admin = _verified(f"dur-{uuid.uuid4().hex[:8]}@test.local")
    t = create_tournament(user=admin, name="Duration Cup")
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i}", "players": []} for i in range(4)],
    )
    return admin, t, list(Team.objects.filter(tournament=t).order_by("name"))


def _match(t, home, away, *, leaf, n, sport="table_tennis"):
    return Match.objects.create(
        organization=t.organization, tournament=t,
        home_team=home, away_team=away, sport=sport, leaf_key=leaf,
        status=MatchStatus.SCHEDULED, round_no=1, match_no=n,
    )


CFG = {"date_start": "2026-08-01", "date_end": "2026-08-31", "slot_minutes": 90}


def test_per_leaf_override_resolves():
    _admin, t, teams = _setup()
    # 37 is intentionally not any sport-profile default → proves the override won.
    t.draw_config = {"tt.u14": {"match_duration_minutes": 37}}
    t.save(update_fields=["draw_config"])
    m_over = _match(t, teams[0], teams[1], leaf="tt.u14", n=1)
    m_other = _match(t, teams[2], teams[3], leaf="tt.u19", n=2)

    reqs, _pre, _linked = build_schedule_inputs(t, config_from_dict(CFG))
    by_id = {r.id: r for r in reqs}
    assert by_id[str(m_over.id)].duration_minutes == 37          # per-leaf override
    assert by_id[str(m_other.id)].duration_minutes != 37          # falls back


def test_star_default_applies_without_leaf_override():
    _admin, t, teams = _setup()
    t.draw_config = {"*": {"match_duration_minutes": 41}, "tt.u14": {"match_duration_minutes": 37}}
    t.save(update_fields=["draw_config"])
    m_leaf = _match(t, teams[0], teams[1], leaf="tt.u14", n=1)
    m_star = _match(t, teams[2], teams[3], leaf="tt.u19", n=2)

    reqs, _pre, _linked = build_schedule_inputs(t, config_from_dict(CFG))
    by_id = {r.id: r for r in reqs}
    assert by_id[str(m_leaf.id)].duration_minutes == 37   # leaf beats "*"
    assert by_id[str(m_star.id)].duration_minutes == 41   # "*" tournament default


def test_match_duration_excluded_from_inputs_hash():
    _admin, t, _teams = _setup()
    before = compute_inputs_hash(t)
    t.draw_config = {"*": {"match_duration_minutes": 55}}
    t.save(update_fields=["draw_config"])
    after = compute_inputs_hash(t)
    assert before == after  # duration changes scheduling, not pairings
