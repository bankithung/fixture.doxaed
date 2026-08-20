"""TDD — the previewed draw is PINNED (owner 2026-08-20).

"It should be generated once and saved and not change until I press try
another draw" — plus "fresh draw need to be automatic" when the inputs move.

The preview used to re-run from scratch on every visit. For a competition
seeded by registration order that happened to come back identical; for one
seeded at RANDOM it minted a new seed every time, so the organizer was shown
a different fixture on every visit, and a "Try another draw" they liked was
lost the moment they left the page. These tests pin all four behaviours:
replay, deliberate re-draw, automatic re-draw on drift, and the promise that
a pin is a SEED and never a fixture.
"""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.audit.models import AuditEvent
from apps.fixtures.services.generate import compute_inputs_hash
from apps.fixtures.services.preview import preview_all_fixtures, preview_fixtures
from apps.fixtures.services.preview_pin import ALL_SCOPE, PIN_KEY, leaf_scope
from apps.matches.models import Match
from apps.teams.models import Team, TeamStatus
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()
pytestmark = pytest.mark.django_db

LEAF = "football.u15"
SCHEDULE = {
    "date_start": "2026-08-01", "date_end": "2026-08-07",
    "daily_start": "09:00", "daily_end": "18:00", "slot_minutes": 60,
    "venues": ["G"], "rest_minutes": 0, "max_per_team_per_day": 4,
}


def _admin():
    u = User.objects.create_user(
        email="pin@test.local", password="FixtureDemo2026!", is_active=True,
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _tournament(*, random_seeding: bool):
    t = create_tournament(user=_admin(), name="Cup")
    t.sports = normalize_sports([{"name": "Football", "nodes": [{"name": "U15"}]}])
    # A RANDOM draw is the case the pin exists for: without it every preview
    # mints a fresh seed and shows a different fixture.
    t.draw_config = {LEAF: {"seeding": "random"}} if random_seeding else {}
    t.save(update_fields=["sports", "draw_config"])
    return t


def _register(t, n, school="S"):
    register_school(
        tournament=t, school_name=school,
        teams=[{"name": f"{school} T{i}", "leaf_key": LEAF, "sport": "football",
                "players": []} for i in range(n)],
    )


def _pairs(out):
    """The draw itself: who plays whom, in order. Times are not the draw."""
    return [
        (m["leaf_key"], m["round_no"],
         (m["home"] or {}).get("team_id"), (m["away"] or {}).get("team_id"))
        for m in out["matches"]
    ]


# --------------------------------------------------------------- replay
def test_a_random_draw_is_the_same_on_every_visit():
    t = _tournament(random_seeding=True)
    _register(t, 6)
    first = preview_fixtures(
        tournament=t, leaf_key=LEAF, schedule=SCHEDULE, include_schedule=True,
    )
    assert first["pin"] == {
        "pinned": True, "created_at": first["pin"]["created_at"],
        "redrawn": True, "reason": "first_preview",
    }
    t.refresh_from_db()
    for _ in range(3):
        again = preview_fixtures(
            tournament=t, leaf_key=LEAF, schedule=SCHEDULE, include_schedule=True,
        )
        assert again["pin"]["redrawn"] is False
        assert again["pin"]["reason"] is None
        assert _pairs(again) == _pairs(first)
        assert again["seed"] == first["seed"]


def test_all_competitions_preview_is_the_same_on_every_visit():
    t = _tournament(random_seeding=True)
    _register(t, 6)
    first = preview_all_fixtures(
        tournament=t, schedule=SCHEDULE, include_schedule=True,
    )
    t.refresh_from_db()
    again = preview_all_fixtures(
        tournament=t, schedule=SCHEDULE, include_schedule=True,
    )
    assert again["pin"]["redrawn"] is False
    assert _pairs(again) == _pairs(first)
    assert again["per_leaf_seed"] == first["per_leaf_seed"]


# ------------------------------------------------------------- re-drawing
def test_try_another_draw_re_rolls_and_the_new_draw_survives_the_revisit():
    """The bug this catches: pinning only the SEED replayed the tournament's
    configured draw, because a registration-order competition ignores any seed
    it is handed. The shuffle the organizer chose has to be pinned WITH the
    override that made it a shuffle."""
    t = _tournament(random_seeding=False)  # configured for registration order
    _register(t, 6)
    original = preview_all_fixtures(
        tournament=t, schedule=SCHEDULE, include_schedule=True,
    )
    t.refresh_from_db()

    # "Try another draw" — the button overrides every competition to random.
    for _ in range(20):
        redrawn = preview_all_fixtures(
            tournament=t, schedule=SCHEDULE, include_schedule=True,
            draw={"seeding": "random"},
        )
        t.refresh_from_db()
        if _pairs(redrawn) != _pairs(original):
            break
    else:  # pragma: no cover — 20 shuffles of 6 teams landing identically
        pytest.skip("every shuffle happened to reproduce the configured draw")
    assert redrawn["pin"]["reason"] == "redraw_requested"

    revisit = preview_all_fixtures(
        tournament=t, schedule=SCHEDULE, include_schedule=True,
    )
    assert revisit["pin"]["redrawn"] is False
    assert _pairs(revisit) == _pairs(redrawn)
    assert _pairs(revisit) != _pairs(original)


# ------------------------------------------------------- automatic re-draw
def test_a_withdrawal_redraws_automatically_and_says_why():
    t = _tournament(random_seeding=True)
    _register(t, 6)
    before = preview_all_fixtures(
        tournament=t, schedule=SCHEDULE, include_schedule=True,
    )
    t.refresh_from_db()

    gone = Team.objects.filter(tournament=t, leaf_key=LEAF).first()
    gone.status = TeamStatus.WITHDRAWN
    gone.save(update_fields=["status"])

    after = preview_all_fixtures(
        tournament=t, schedule=SCHEDULE, include_schedule=True,
    )
    assert after["pin"]["redrawn"] is True
    assert after["pin"]["reason"] == "inputs_changed"
    assert _pairs(after) != _pairs(before)
    # And the fresh draw is itself pinned, so the NEXT visit is stable again.
    t.refresh_from_db()
    settled = preview_all_fixtures(
        tournament=t, schedule=SCHEDULE, include_schedule=True,
    )
    assert settled["pin"]["redrawn"] is False
    assert _pairs(settled) == _pairs(after)


def test_moving_the_calendar_re_times_but_does_not_re_pair():
    """Lengthening the day must not rearrange who plays whom — the calendar is
    deliberately outside the pin's fingerprint."""
    t = _tournament(random_seeding=True)
    _register(t, 6)
    before = preview_all_fixtures(
        tournament=t, schedule=SCHEDULE, include_schedule=True,
    )
    t.refresh_from_db()
    after = preview_all_fixtures(
        tournament=t, include_schedule=True,
        schedule={**SCHEDULE, "daily_end": "20:00"},
    )
    assert after["pin"]["redrawn"] is False
    assert _pairs(after) == _pairs(before)


# ------------------------------------------------- a pin is a seed, not a fixture
def test_the_pin_is_seeds_only_and_never_a_fixture():
    t = _tournament(random_seeding=True)
    _register(t, 6)
    audits_before = AuditEvent.objects.count()
    out = preview_fixtures(
        tournament=t, leaf_key=LEAF, schedule=SCHEDULE, include_schedule=True,
    )
    t.refresh_from_db()
    pin = (t.draw_config or {})[PIN_KEY][leaf_scope(LEAF)]
    assert set(pin) == {"seeds", "overrides", "fingerprint", "created_at"}
    assert pin["seeds"] == {LEAF: out["seed"]}
    # Nothing else moved: no match rows, no scheduling config, no audit event,
    # and no config LAYER written where a draw setting lives.
    assert Match.objects.count() == 0
    assert t.scheduling_config == {}
    assert AuditEvent.objects.count() == audits_before
    assert t.last_manual_edit_at is None


def test_the_pin_cannot_perturb_the_hash_that_invalidates_it():
    """``preview_pin`` sits in ``draw_config`` beside the config layers. If it
    reached ``inputs_hash`` the first preview would invalidate its own pin and
    every visit would redraw forever."""
    t = _tournament(random_seeding=True)
    _register(t, 6)
    before = compute_inputs_hash(t, LEAF)
    preview_fixtures(
        tournament=t, leaf_key=LEAF, schedule=SCHEDULE, include_schedule=True,
    )
    t.refresh_from_db()
    assert PIN_KEY in (t.draw_config or {})
    assert compute_inputs_hash(t, LEAF) == before


def test_one_competition_and_all_competitions_keep_separate_pins():
    t = _tournament(random_seeding=True)
    _register(t, 6)
    preview_fixtures(
        tournament=t, leaf_key=LEAF, schedule=SCHEDULE, include_schedule=True,
    )
    t.refresh_from_db()
    preview_all_fixtures(tournament=t, schedule=SCHEDULE, include_schedule=True)
    t.refresh_from_db()
    pins = (t.draw_config or {})[PIN_KEY]
    assert set(pins) == {leaf_scope(LEAF), ALL_SCOPE}
