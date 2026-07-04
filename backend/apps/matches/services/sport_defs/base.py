"""The SportDefinition contract (P1 — sport as a first-class axis).

One frozen dataclass per sport carries everything sport-specific the chassis
needs: the period model, the score reducer, set-scoring defaults, state
machine traits, terminology, leaderboard specs and the console blueprint the
client renders from. BEHAVIOR lives here in code (versioned); every NUMBER
stays per-tournament/per-leaf JSONB (rules.by_leaf), resolved with the
existing per-game -> per-sport -> definition-default precedence — presets,
never prisons.

Adding a sport = one module in this package + a registry entry. If it fits
the TIMED or TARGET family, no frontend code is required (the blueprint
drives a generic console/view).
"""
from __future__ import annotations

from dataclasses import dataclass, field

# Period models — the REAL sport split (replaces the setBased boolean).
TIMED = "timed"    # clock periods + goal-sum scoring (football, hockey, ...)
TARGET = "target"  # race to a points target per set/game (TT, sepak, ...)


@dataclass(frozen=True)
class LeaderboardSpec:
    """One board on the Leaders surface (catalog:
    docs/superpowers/specs/2026-07-04-sport-leaders-catalog.md)."""

    key: str
    label: str                      # i18n key rendered through t()
    subject: str                    # "player" | "team" | "regu" | "pair"
    metric: str                     # named reducer key (registry-resolved)
    sort: str = "desc"              # "desc" | "asc" (asc = fewest wins, e.g. GA)
    fmt: str = "int"                # "int" | "pct" | "ratio" | "decimal"
    tier: tuple[str, ...] = ("federation", "school")
    default_on: tuple[str, ...] = ("federation", "school")


@dataclass(frozen=True)
class SportDefinition:
    code: str                       # canonical underscored key; "" maps here too
    version: int                    # stamped into frozen rules with its consumer
    display_name: str
    period_model: str               # TIMED | TARGET
    score_reducer: str              # "goal_sum" | "sets"
    scoring: dict | None            # set-scoring defaults; None = goal-based
    duration_minutes: int           # scheduler slot estimate
    venue_type: str
    # --- state machine traits ---
    has_half_time: bool             # TARGET sports pause between sets instead
    opening_period: str             # current_period stamped on first kickoff
    # --- presentation ---
    terms: dict = field(default_factory=dict)
    leaderboards: tuple[LeaderboardSpec, ...] = ()
    console_blueprint: dict = field(default_factory=dict)
