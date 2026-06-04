# v1 — Flexible Fixture Generation Engine

> **Status:** Draft v1 (design) — 2026-06-04
> **Owner:** graceschooledu@gmail.com
> **Companion to:** PRD §5 (football state machines), v1Users.md (RBAC), v1Sport.md (per-sport plugins, to be written)
> **Inspiration:** FET (Free Timetabling Software) — declarative hard/soft constraint solving.

This document defines the architecture for **fixture generation** so it is **as flexible as possible** across sports: a declarative, constraint-based engine (hard + soft constraints, weighted, scoped, toggleable) analogous to school-timetabling software, but specialized for sports tournaments.

---

## 1. Core principle: fixture generation is TWO problems

Conflating these is why most tournament tools are rigid. We separate them cleanly; the seam between them is the **typed match-dependency invariant (#9)**.

1. **Phase A — Structure / Draw**: *who plays whom*. Pure combinatorics. Produces `Match` rows whose opponents may be concrete teams or **typed pointers** (`winner_of` / `loser_of` / `group_position` / `team` / `tbd`). Advancement resolves via a `transaction.on_commit` domain-event hook.
2. **Phase B — Schedule**: *when & where*. A constraint-satisfaction/optimization problem — assign each match a `(datetime, venue, officials)` tuple. This is the FET-analogous engine.
3. **Phase 0 (optional) — Group/seed draw**: seed teams into pots/groups under draw constraints (e.g., "no two teams from the same district in one group").

Each phase is independently runnable: re-draw without re-scheduling; re-schedule a fixed draw when a pitch falls through.

---

## 2. Phase A — Structure formats (pluggable)

Each format is a generator that, given entrants + params, emits `Match` rows + advancement edges. Deterministic (seeded) for reproducibility.

| Format | Key params |
|---|---|
| Single elimination | seeding method, byes (auto for non-2^n), 3rd-place playoff, consolation/plate bracket |
| Double elimination | winners/losers bracket, grand-final reset toggle |
| Round robin (single/double/N legs) | circle method, home/away assignment |
| Groups → knockout | group count, teams/group, qualifiers/group, best-Nth-place ranking, draw constraints |
| Swiss system | rounds, pairing by score, avoid rematch, home/colour balance (paired per round after results) |
| League | full double round-robin, home/away |
| Multi-stage | composition of sub-formats (e.g. groups → super-league → playoffs) |
| Custom | manual bracket builder |

Output contract: `Match.home_source` / `away_source` are JSONB typed pointers (#9), never inferred from bracket position. Advancement is an explicit hook, not a query over bracket shape.

---

## 3. Phase B — The constraint model (the flexibility engine)

**Design rule (locked): NO rule is ever hardcoded in Python.** There is no per-rule `if` branch and no per-type handler to write. A constraint is a **declarative expression (an AST stored as JSON)** over a fixed, small vocabulary of domain primitives. ONE generic compiler interprets *any* expression into solver constraints. Adding a brand-new kind of rule = inserting a data row — **no code change, no deploy.** Sports and admins contribute rules as data, never as code.

### 3.1 Constraint row shape

```python
class SchedulingConstraint(models.Model):
    id = UUIDField(default=uuid7)            # invariant #1
    tournament = FK(Tournament)             # org-scoped via tournament (#2)
    expr = JSONField()                       # the rule itself, as an AST (see 3.2) — DATA, not code
    kind = CharField(choices=["hard", "soft"])
    weight = PositiveIntegerField(default=1) # only meaningful for soft
    scope = CharField(choices=["tournament","group","team","venue","round","match"])
    scope_ref = UUIDField(null=True)         # the group/team/venue/etc this applies to
    sport = CharField(blank=True)            # optional: rule belongs to a sport's constraint library
    template = CharField(blank=True)         # optional: saved-template id this came from
    is_active = BooleanField(default=True)
    source = CharField(choices=["auto","manual"], default="manual")
    description = TextField(blank=True)      # human-readable, shown in UI
    created_by = FK(User, null=True)
    created_at / updated_at
```

**Any constraint can be flipped `hard` ↔ `soft`, re-weighted, re-scoped, or toggled** — this is the "as flexible as possible" requirement.

### 3.2 The constraint expression grammar (the DSL — this is what makes rules data)

Every rule is composed from a fixed set of primitives. The grammar is tiny and total; the rule space it spans is unbounded. The stored artifact is always JSON.

**Entity attributes (read-only vocabulary):** `match.{round,stage,group,home_team,away_team,teams,venue,datetime,duration,officials,leg,is_home}`, plus `team`, `venue`, `official`, `slot`, `round`, `group`, and any sport-declared attribute.

**Selectors:** `matches[<filter>]`, `teams[...]`, `venues[...]`, `pairs(<set>)`, `consecutive(<ordered set>, n, <pred>)`.

**Functions / relations:** `count`, `sum`, `min`, `max`, `span`, `gap(a,b)`, `overlaps(a,b)`, `distance(v1,v2)`, `same(x,y)`, `before/after`, `abs`.

**Operators:** `<= >= == != < > + - *`, `and or not`, `if`.

**Quantifiers / objective:** `forall <var> in <set>: <bool>` (hard), `minimize|maximize <number>` (soft, scaled by `weight`).

A **hard** rule's `expr` is a boolean (must hold); a **soft** rule's `expr` is a numeric penalty added to the objective.

**Examples — each is pure JSON data, no code:**

```jsonc
// a team is never double-booked (HARD)
{ "forall": "t in teams",
  "assert": { "forall": "s in slots",
    "assert": { "<=": [ { "count": "matches[ t in m.teams and m.slot == s ]" }, 1 ] } } }

// minimum rest, value supplied as data (HARD)
{ "forall": "(m1,m2) in pairs(matches)",
  "where": { "overlaps_team": ["m1","m2"] },
  "assert": { ">=": [ { "gap": ["m1","m2"] }, "PT48H" ] } }

// compress the schedule (SOFT)
{ "minimize": { "span": ["matches", "m.datetime"] } }

// no 3 consecutive home games (SOFT)
{ "minimize": { "count": "consecutive(team.matches, 3, same(m.is_home))" } }
```

A **rule-builder UI** lets organizers compose these visually (subject → relation → value) so nobody hand-writes JSON — but the saved artifact is always data. Per-sport libraries (§6), imports, and power users can supply raw expressions directly. The constraints in §3.3–3.4 are simply the **starter template library** — pre-composed expressions shipped as data, not code; sports add many more the same way.

### 3.3 Starter template library — HARD (shipped as data, not code)

| code | meaning | params |
|---|---|---|
| `team_no_double_book` | a team plays ≤1 match per overlapping slot | — |
| `venue_no_double_book` | a venue hosts ≤1 match per overlapping slot | `turnaround_min` |
| `official_no_double_book` | a referee/scorer officiates ≤1 match per slot | — |
| `within_window` | match within tournament dates | `start`,`end` |
| `min_rest` | min gap between a team's matches | `hours` or `matchdays` |
| `venue_availability` | venue open only in given windows | `windows[]` |
| `team_blackout` | team unavailable on dates | `dates[]` |
| `round_ordering` | round N after N-1 (from structure deps) | — |
| `phase_ordering` | group stage before knockout | — |
| `max_matches_per_day` | per venue/day cap | `n`, scope |

### 3.4 Starter template library — SOFT (shipped as data, not code)

| code | optimizes | direction |
|---|---|---|
| `compact_span` | total tournament length | min (or `spread` toggle) |
| `home_away_balance` | no 3 consecutive home/away (leagues) | min violations |
| `rest_fairness` | equalize rest across teams | min variance |
| `even_spacing` | a team's matches evenly spread | min clustering |
| `preferred_kickoff` | preferred / avoided time-of-day | min penalty |
| `minimize_travel` | team travel between venues | min |
| `referee_load_balance` | even official workload | min variance |
| `simultaneous_last_round` | final group-round kickoffs together (anti-collusion) | toggle/reward |
| `avoid_early_rematch` | Swiss/group rematches | min |

---

## 4. The solver

- **Primary: Google OR-Tools CP-SAT.** Decision vars: `match→timeslot`, `match→venue`, `match→official`. Hard constraints → model constraints (`AddNoOverlap`, `AddAllDifferent`, reified booleans). Soft → penalty terms summed into `Minimize(Σ weightᵢ·penaltyᵢ)`. Time-budgeted; returns optimal or best-feasible.
- **One generic compiler, no per-rule code:** a single AST walker translates every constraint `expr` into an internal IR; the CP-SAT backend is one implementation. New rule *types* need zero solver code. A **metaheuristic backend** (simulated annealing / tabu / FET-style recursive swapping) can be added for very large instances without touching any constraint definition.
- **Async execution:** generation runs as a background job (Channels worker / task), progress streamed over **SSE** (#11), result persisted DB-first (#4) and idempotent per run via `event_id` (#3).

### 4.1 Explainability (FET's real value)

- **Infeasibility diagnosis:** on hard-constraint conflict, return the **minimal infeasible subset** (via CP-SAT assumptions) — "these 3 constraints can't all hold" — plus suggested relaxations. Never a silent failure (#error-handling).
- **Soft-penalty report:** objective breakdown per constraint ("late-kickoff 40, travel 25"), so admins see trade-offs and tune weights.

---

## 5. Reproducibility, manual edit, regenerate (#10)

- `ScheduleRun`: `inputs_hash` over (matches, active constraints, availability, seed), `solver`, `status`, `objective`, `infeasible_core`, timestamps. Re-running with the same inputs is deterministic.
- **Lock + partial regenerate:** `Match.locked=True` (manual edits) become solver **assumptions**; the rest re-solves around them. `last_manual_edit_at` tracked.
- If inputs change after a manual edit → the **regenerate / keep-manual / view-diff** banner (#10).
- Presets/templates per tournament type + per-sport defaults: a casual organizer gets a good schedule with zero config; a power user tunes everything.

---

## 6. Sport pluggability — deep, per-sport constraint libraries (all data)

Each sport plugin (per the locked per-sport plugin-app architecture) ships a **constraint library**: an arbitrarily large bundle of constraint expressions (§3.2) + defaults, stored as data (JSON), never code. A sport can declare as many in-depth, sport-specific rules as it needs; they load into a tournament as editable defaults. Depth per sport is unbounded.

A sport plugin contributes (all as data):
- Supported structure formats + defaults.
- **Its constraint library** — sport-specific hard/soft rules. Examples of the depth possible:
  - **Football:** ≥2–3 days rest between matches; no team plays twice in a day; final group-round matches kick off simultaneously (anti-collusion); ≤N matches per pitch/day incl. turnaround; floodlight-only fixtures after sunset; avoid the same referee for a team twice; derbies in prime slots; max consecutive away games.
  - **Cricket:** a full/multi-day match occupies a whole ground for the day; reserve-day / DLS handling; ≥1 rest day after a multi-day match; pitch-reuse limits; toss-time windows; no two innings-heavy matches back-to-back on one pitch.
  - **Athletics / swimming:** heats→semis→finals ordering with mandatory per-athlete recovery gaps; lane/track capacity per slot; an athlete entered in multiple events can't have overlapping heats; interleave field and track events; call-room lead time.
  - **Basketball / volleyball / badminton (indoor):** court capacity per slot; back-to-back game limits per team; shared-court turnaround; multiple matches per court/day; warm-up buffer.
  - **Tennis / individual:** a player's singles & doubles matches can't overlap; min rest between rounds; order-of-play seeding on show courts.
- Match shape: periods/halves/innings/sets, durations, default turnaround buffer.
- Scoring model (feeds live-scoring + advancement).

The engine stays **sport-agnostic**: every sport-specific rule above is just an `expr` in that sport's library — the one generic compiler runs them all identically. A new sport, or a new rule for an existing sport, is **new data, never new code**. Football v1 priorities: **league (double round-robin, home/away)**, **groups→knockout**, **single-elimination cups**, plus the football library above.

---

## 7. Data model summary (new in `apps.fixtures`)

- `TournamentFormat` / format config on `Tournament` (type + params).
- `Match` (in `apps.matches`) with typed `home_source`/`away_source`, `scheduled_at`, `venue`, `officials`, `locked`, `last_manual_edit_at`.
- `Venue`, `VenueAvailability`.
- `Official` availability (reuse `TournamentMembership` referee/scorer rows + availability windows).
- `TeamBlackout`.
- `SchedulingConstraint` (§3.1).
- `ScheduleRun` (§5).
- All UUID v7 (#1), org-scoped via tournament (#2), audited transitions (#6).

---

## 8. Build phasing (MVP → full)

1. **MVP:** round-robin + single-elim structure; hard constraints (`team_no_double_book`, `venue_no_double_book`, `official_no_double_book`, `within_window`, `min_rest`, `venue_availability`); 2 soft (`compact_span`, `home_away_balance`); CP-SAT solver (greedy warm-start); manual lock + regenerate + diff banner. Football league + cup runnable end-to-end.
2. **+ Formats:** groups→knockout, double-elim, Swiss, multi-stage.
3. **+ Constraints:** travel, fairness, kickoff prefs, simultaneous-last-round, referee balancing; constraint UI with `params_schema` auto-forms; infeasibility explainer + penalty report.
4. **+ Scale:** metaheuristic backend for large instances; what-if scenarios; saved presets.

---

## 9. Open questions (deferred)

- Travel/distance: store venue lat/long for `minimize_travel`, or coarse zones?
- Multi-sport tournament (one event, several sports) — defer to v2 (re-narrow scope to (Tournament, Sport)).
- Live re-scheduling when a match is postponed mid-tournament (delta re-solve with maximal lock).
