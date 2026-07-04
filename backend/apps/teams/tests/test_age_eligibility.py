"""H5 — age-eligibility enforcement (finding N4: rules shown, never checked).

Covers the evaluator's semantics, the register_school backstop (coarse
dob_year is exact for the 31 Dec cutoff), the friendly form-boundary check
with dotted row paths, and the opt-out (presets, never prisons).
"""
from __future__ import annotations

from datetime import date
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError as DjangoValidationError
from django.utils import timezone

from apps.forms.services.validation import AnswerError, validate_age_eligibility
from apps.teams.services.eligibility import age_cutoff, age_on, violation
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import iter_leaves, normalize_sports

User = get_user_model()
pytestmark = pytest.mark.django_db

CUTOFF = date(2026, 12, 31)


def test_age_on_and_violation_semantics():
    # Born 2012 -> turns 14 during 2026 -> age 14 on 31 Dec 2026.
    assert age_on(date(2012, 6, 1), CUTOFF) == 14
    under15 = {"op": "under", "age": 15}
    assert violation(under15, cutoff=CUTOFF, dob=date(2012, 6, 1)) is None  # 14 < 15
    assert violation(under15, cutoff=CUTOFF, dob=date(2011, 1, 1)) == "age_over_limit_under_15"
    # dob_year alone matches the full-date verdict for a 31 Dec cutoff.
    assert violation(under15, cutoff=CUTOFF, dob_year=2012) is None
    assert violation(under15, cutoff=CUTOFF, dob_year=2011) == "age_over_limit_under_15"
    # over / between.
    assert violation({"op": "over", "age": 16}, cutoff=CUTOFF, dob_year=2012) == "age_under_limit_over_16"
    assert violation({"op": "between", "min": 12, "max": 14}, cutoff=CUTOFF, dob_year=2012) is None
    assert violation({"op": "between", "min": 12, "max": 14}, cutoff=CUTOFF, dob_year=2015) == "age_under_limit_between_12_14"
    # No rule / no DOB -> undecidable, passes.
    assert violation(None, cutoff=CUTOFF, dob_year=1990) is None
    assert violation(under15, cutoff=CUTOFF) is None


def _tournament(enforce=True):
    u = User.objects.create_user(
        email=f"age-{enforce}@test.local", password="FixtureDemo2026!", is_active=True
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    t = create_tournament(user=u, name="Age Cup")
    t.sports = normalize_sports(
        [{"name": "Football", "nodes": [{"name": "U-15"}]}]
    )
    if not enforce:
        t.rules = {**(t.rules or {}), "eligibility": {"enforce_age": False}}
    t.save(update_fields=["sports", "rules"])
    leaf = iter_leaves(t.sports)[0]["leaf_key"]
    return u, t, leaf


def test_register_school_blocks_overage_player():
    _u, t, leaf = _tournament()
    year = age_cutoff(t).year
    with pytest.raises(DjangoValidationError, match="player_age_ineligible"):
        register_school(
            tournament=t, school_name="S",
            teams=[{
                "name": "A", "leaf_key": leaf,
                "players": [{"full_name": "Too Old", "dob_year": year - 16}],
            }],
        )


def test_register_school_accepts_eligible_and_unknown_dob():
    _u, t, leaf = _tournament()
    year = age_cutoff(t).year
    teams = register_school(
        tournament=t, school_name="S",
        teams=[{
            "name": "A", "leaf_key": leaf,
            "players": [
                {"full_name": "Eligible", "dob_year": year - 13},
                {"full_name": "No DOB"},
            ],
        }],
    )
    assert len(teams) == 1


def test_enforcement_opt_out():
    _u, t, leaf = _tournament(enforce=False)
    year = age_cutoff(t).year
    teams = register_school(
        tournament=t, school_name="S",
        teams=[{
            "name": "A", "leaf_key": leaf,
            "players": [{"full_name": "Too Old", "dob_year": year - 20}],
        }],
    )
    assert len(teams) == 1


def test_form_boundary_check_emits_dotted_row_paths():
    _u, t, leaf = _tournament()
    year = age_cutoff(t).year
    form = SimpleNamespace(
        tournament=t,
        settings={
            "bindings": {
                "category_groups": [{
                    "group": "teams_u15",
                    "team_name": "team_name",
                    "players_group": "players",
                    "player_name": "player_name",
                    "player_dob": "player_dob",
                    "leaf_key": leaf,
                }]
            }
        },
    )
    answers = {
        "teams_u15": [{
            "team_name": "A",
            "players": [
                {"player_name": "OK", "player_dob": f"{year - 13}-05-01"},
                {"player_name": "Too Old", "player_dob": f"{year - 17}-05-01"},
            ],
        }]
    }
    with pytest.raises(AnswerError) as exc:
        validate_age_eligibility(form, answers)
    assert exc.value.errors == {
        "teams_u15.0.players.1.player_dob": "age_over_limit_under_15"
    }

    # Fixing the DOB clears it.
    answers["teams_u15"][0]["players"][1]["player_dob"] = f"{year - 14}-05-01"
    validate_age_eligibility(form, answers)
