"""Age-eligibility evaluation (H5).

Age categories were captured on the sports tree and SHOWN to registrants
("Age limit: under 15.") but never enforced anywhere — over-age players
registered without an error (verified finding N4). This module evaluates a
leaf's structured age rule ({op: under|over|between, age | min+max},
auto-seeded by the sports registry) against a player's date of birth.

Age is reckoned as of a CUTOFF DATE — the SGFI/CBSE convention is 31 December
of the event year — configurable per tournament via
``rules.eligibility.age_cutoff`` ("MM-DD"). With the 31 Dec default,
``dob_year`` alone is exact (everyone born in year Y is the same whole-year
age on 31 Dec), which is why the register_school backstop can enforce from
the coarse year the mapper already stores.
"""
from __future__ import annotations

from datetime import date

from apps.tournaments.services.sports import leaf_age_rule


def _eligibility_cfg(tournament) -> dict:
    from apps.tournaments.services.rules import merge_rules

    try:
        return merge_rules(getattr(tournament, "rules", None)).get("eligibility") or {}
    except Exception:
        return {}


def enforce_age_enabled(tournament) -> bool:
    """Enforcement is ON by default; organizers may opt out per tournament
    (rules.eligibility.enforce_age = false) — presets, never prisons."""
    return bool(_eligibility_cfg(tournament).get("enforce_age", True))


def age_cutoff(tournament) -> date:
    """The date age is reckoned on, in the EVENT year (starts_at, else the
    tournament's creation year). Malformed config falls back to 31 Dec."""
    raw = str(_eligibility_cfg(tournament).get("age_cutoff") or "12-31")
    starts = getattr(tournament, "starts_at", None)
    year = (starts or tournament.created_at.date()).year
    try:
        month, day = (int(x) for x in raw.split("-", 1))
        return date(year, month, day)
    except (TypeError, ValueError):
        return date(year, 12, 31)


def age_on(dob: date, cutoff: date) -> int:
    """Whole-year age on the cutoff date."""
    return cutoff.year - dob.year - (
        (cutoff.month, cutoff.day) < (dob.month, dob.day)
    )


def team_age_rule(tournament, leaf_key: str) -> dict | None:
    """The structured age rule governing one competition leaf, or None."""
    if not leaf_key:
        return None
    return leaf_age_rule(getattr(tournament, "sports", None) or [], leaf_key)


def violation(
    rule: dict | None,
    *,
    cutoff: date,
    dob: date | None = None,
    dob_year: int | None = None,
) -> str | None:
    """None when eligible or undecidable (no rule / no DOB — required-ness is
    the form's job, not this evaluator's). Otherwise a stable error code the
    UI can translate, e.g. ``age_over_limit_under_15``."""
    if not rule:
        return None
    if dob is not None:
        years = age_on(dob, cutoff)
    elif dob_year:
        years = cutoff.year - int(dob_year)
    else:
        return None

    op = rule.get("op")
    if op == "under" and rule.get("age") and years >= int(rule["age"]):
        return f"age_over_limit_under_{rule['age']}"
    if op == "over" and rule.get("age") and years < int(rule["age"]):
        return f"age_under_limit_over_{rule['age']}"
    if op == "between":
        mn, mx = rule.get("min"), rule.get("max")
        if mn and years < int(mn):
            return f"age_under_limit_between_{mn}_{mx}"
        if mx and years > int(mx):
            return f"age_over_limit_between_{mn}_{mx}"
    return None
