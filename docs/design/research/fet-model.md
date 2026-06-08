# FET (Free Timetabling Software) — Constraint Model & Solver, Translated to a Sports-Fixture Engine

> Research briefing for the Fixture Platform constraint-engine restructuring.
> Author: research subagent · Date: 2026-06-08
> Scope: how FET models the world, its full constraint taxonomy, its solver
> ("recursive swapping"), what makes it "fully flexible", and a concrete,
> implementable catalog + recommendation for **our** sports-fixture engine.
>
> Grounds against: the spec
> `docs/superpowers/specs/2026-06-08-tournament-flow-and-constraint-engine.md`
> (§3 "flexible fixture-generation engine"), the locked decisions (Institution→
> Team→Player hierarchy; multi-sport/multi-category; **layered solver** = heuristic
> first, CP-SAT later), and the actual code:
> `apps/fixtures/services/constraints.py` (inert catalog `CONSTRAINT_TYPES` +
> `validate_constraints`), `apps/fixtures/services/generate.py`
> (`_round_robin`/`generate_single_elimination`/`generate_knockout_from_groups`),
> `apps/tournaments/services/rules.py` (`DEFAULT_RULES`, `merge_rules`, freeze),
> and the seams named in `docs/RESTRUCTURING-NOTES.md` §5 (#9 Rules seam,
> #10 Constraint-engine seam, #5 Tournament state-machine seam).

---

## 0. TL;DR — the seven lessons we steal from FET

1. **Everything is a typed, weighted, declarative constraint record — nothing is
   hardcoded.** FET has *no* built-in notion of "a normal school week"; the entire
   timetable emerges from the constraint list. We already chose this (CLAUDE.md
   invariant: `rules`/`constraints` JSONB interpreted at runtime); FET validates
   the philosophy and gives us the catalog shape.
2. **A small, orthogonal RESOURCE model + a large, composable CONSTRAINT catalog.**
   FET models only Activities, Teachers, Students(sets), Subjects, Rooms,
   Buildings, Days×Hours, Activity-tags — then layers ~80 constraint *types* over
   them. Our analog: **Matches (activities), Participants/Teams, Institutions,
   Venues/Courts, Sports/Categories, Days×Slots, tags** + a constraint catalog.
3. **Hard vs soft is a *weight*, not a boolean.** FET uses a 0–100% weight where
   100% = "never violate (or the timetable is impossible)" and <100% literally
   maps to a *retry budget*. We keep `hard: bool` for the model boundary but add a
   numeric `weight` (already a field in `validate_constraints`, currently unused)
   with explicit penalty semantics.
4. **Constraints come in scoped families: per-one / per-set / per-all.** Almost
   every FET constraint exists as "for X", "for a set of X", and "for all X".
   That `scope` axis is the single biggest source of FET's flexibility and maps
   directly to our `scope` field (`apps/fixtures/services/constraints.py` already
   has `scope` defaulting to `"all"`).
5. **The solver is a constructive heuristic with bounded backtracking
   ("recursive swapping"), not local search or a GA.** Place most-constrained
   first; on conflict, find the slot with fewest conflicting placed activities,
   evict + recursively re-place them, bounded by recursion depth ~14 and ~2n
   calls. This is *exactly* the "constructive + repair" backend the spec mandates
   for phase 1 — FET is the reference implementation.
6. **Explainability is built into the weight model.** Because soft = bounded
   retries, FET can always report "I kept this conflict" and which activities are
   unplaceable. Our engine must emit a per-constraint satisfied/violated report
   (spec §3.C "Explainability"; invariant #10 regenerate/diff UX).
7. **Same interface, swappable engines.** FET shipped a GA, then replaced it with
   recursive swapping behind the same constraint model with zero data migration.
   That is our locked decision #3 (heuristic now, CP-SAT later behind one
   `Solver` interface).

---

## 1. FET's data / resource model

FET separates **resources** (the nouns) from **constraints** (the rules over
them). The resource model is deliberately tiny and orthogonal:

| FET entity | Meaning | Sports-fixture analog (this repo) |
|---|---|---|
| **Days × Hours** | The grid. Days/week configurable (Mon–Fri); each day has N numbered *periods/hours* of equal length. A **time slot = (day, hour)**. | **Calendar days × time-slots**. Slot length = sport match duration + buffer (spec §3.A.3). Days = date range minus excluded/rest days. |
| **Activity** | The atom that gets placed. Carries: teacher(s), student-set(s), subject, **duration** (integer periods), activity-tag(s). Can be split into **subactivities** (a 4h lesson → 4×1h). **Pseudo-activities** have no teacher/students (used to reserve time / support constraints). | **Match** (`apps/matches/models.Match`). Carries: the two (or N) participants, the sport+category, a duration → number of slots, optional tags ("final", "marquee"). A *bye* or a *placeholder* match (TBD pointer) ≈ pseudo-activity. |
| **Teacher** | A resource that can be in ≤1 activity per slot. Has optional target hours, qualified subjects. | **Team / Participant / Player**. The hard "can't be in two places at once" resource. For doubles/relays a Player belongs to multiple Teams → same constraint. |
| **Students set** (Year→Group→Subgroup hierarchy: Year/Form, Category, Division, Subgroup) | Hierarchical attendee. The hierarchy lets a constraint target a whole year OR one subgroup. | **Institution → Team → Player** (locked decision #1). The hierarchy is the *scope tree*: "same-Institution teams" constraints target the Institution node; player-clash targets the leaf. |
| **Subject** | Discipline taught; constraints can target "all activities of subject X". | **Sport + Category** (e.g. Sepak Takraw; Table Tennis singles/doubles; an age-group). Constraints target "all matches of category X". |
| **Activity tag** | A free label on activities (e.g. "lecture", "morning") used *only* to target constraints, never displayed. | **Match tags**: `final`, `semifinal`, `marquee`, `opening_round`, `derby`. The spec's "prime-time for marquee matches" and "same-institution teams kept apart until round R" are tag/round-scoped constraints. |
| **Room** | A space holding ≤1 activity per slot. | **Venue / Ground / Court** (spec §3.A.4). The "no venue double-booking" resource. A venue declares which sports/categories it supports + availability windows. |
| **Building** | Groups rooms geographically; used by building-change constraints. | **Venue cluster / site / city** — used by travel/min-gap-between-venue-changes constraints (maps to the Traveling-Tournament-Problem dimension, §5). |

**Key modeling move:** FET makes the *split* (subactivities) and the *grid*
(day×hour) first-class so durations, multi-period blocks, and "this must occupy 2
consecutive slots" all fall out naturally. Our matches are mostly single-slot, but
**best-of-N / multi-set / multi-leg ties and multi-court events** benefit from the
same "an activity has a duration in slots" abstraction rather than 1 row = 1 slot.

---

## 2. FET's constraint taxonomy (the full catalog)

FET splits constraints into **TIME** (when) and **SPACE** (where), each with a
*miscellaneous*, a *teacher*, a *students*, an *activity/subject* family. Nearly
every constraint has **for-one / for-a-set / for-all** variants — that scope axis
is reproduced once below rather than per-line.

### 2.1 TIME constraints

**Miscellaneous (time)**
- **Basic compulsory time constraints** — the implicit "no resource is in two
  activities at once" baseline. *Always 100%.* (Our `no_double_booking_team`.)
- **Break** — all teachers + all students unavailable in a slot (a global blackout).

**Teacher (time)** — (each has a "for all teachers" twin)
- A teacher is **not available** (per day/hour blackout).
- **Max / Min days per week** for a teacher.
- **Max gaps per week / per day** for a teacher.
- **Max / Min hours daily** for a teacher.
- **Max span per day** (first→last hour spread).
- **Max hours continuously** (optionally restricted **with activity tag**).
- **Working in hourly interval, max days per week**.
- **Min resting hours** between a teacher's last activity one day and first the next.

**Students set (time)** — (each has a "for all students" twin)
- A students set is **not available**.
- **Max / Min days per week**, **Max gaps per week / per day**,
  **Max / Min hours daily**, **Max span per day**.
- **Begins early** (e.g. must start by 2nd hour) — "max beginnings".
- **Max hours continuously** (optionally **with activity tag**).
- **Working in hourly interval, max days per week**.
- **Min resting hours**.

**Activity (time)** — the rich relational family (the heart of FET flexibility)
- An activity has a **preferred starting time** / a **set of preferred starting
  times** / a **set of preferred time slots**.
- A **set of activities** has preferred starting times / preferred time slots.
- A **set of subactivities** has preferred starting times / time slots.
- **Min days between** a set of activities *(auto-added for split lessons so the
  two halves land on different days — typically <100% weight)*.
- **Max days between** a set of activities.
- An activity / a set of activities **ends students' day** (must be last).
- **Two activities are consecutive** (B immediately after A).
- **Two activities are grouped** / **Three activities are grouped** (same block).
- **Two activities are ordered** (A before B).
- A set of activities has **same starting time** (day+hour) /
  **same starting day** (any hour) / **same starting hour** (any day).
- A set of activities **are not overlapping**.
- **Min gaps (hours) between** a set of activities.
- A set of activities **occupies max time slots from a selection**.
- **Max simultaneous activities** from a set in selected time slots.

### 2.2 SPACE constraints

**Miscellaneous (space)**
- **Basic compulsory space constraints** — implicit "a room holds ≤1 activity per
  slot". *Always 100%.* (Our `venue_single_use`.)

**Room**
- A room is **not available** (per day/hour) — venue availability windows.

**Teacher (space)** — (+ "for all teachers")
- A teacher has a **home room** / a **set of home rooms**.
- **Max building changes per day / per week**.
- **Min gaps between building changes**.

**Students (space)** — (+ "for all students")
- A set of students has a **home room** / **set of home rooms**.
- **Max building changes per day / per week**, **Min gaps between building changes**.

**Subject / Subject+tag (space)**
- A subject has a **preferred room** / **set of preferred rooms**.
- A subject **+ activity tag** has a preferred room / set of preferred rooms.

**Activity (space)**
- An activity has a **preferred room** / **set of preferred rooms**.
- A set of activities **are in the same room if consecutive**.
- A set of activities **occupies max different rooms** (keep them in few rooms).

### 2.3 The two orthogonal axes that generate the catalog

FET's ~80 constraints are really **a handful of constraint *shapes* × the scope
axis × the time/space axis**. The shapes:

- **Availability / blackout** (resource unavailable at slot set).
- **Counting bound** (max/min count of something per window: days, gaps, hours,
  building-changes, simultaneous activities).
- **Placement preference** (preferred slot/room set for an activity/subject).
- **Relational** (ordered / consecutive / grouped / same-X / not-overlapping /
  min-or-max-gap **between** activities).
- **Spread / span** (span per day, gaps per day/week, min rest between days).
- **Resource binding** (home room, preferred room).

This decomposition is the template for our catalog (§4): we implement a small set
of *shape handlers* parameterized by scope + resource, not 80 bespoke checks.

---

## 3. FET's solver — "recursive swapping"

Authoritative source: FET's own *generation-algorithm-description* page +
FAQ + the author's forum posts. FET dropped its original **genetic algorithm**
(pre-2007; "slow, only easy timetables") for a **constructive heuristic with
bounded backtracking** in summer 2007 — and that single change took it from
toy to industrial. The algorithm:

1. **Sort activities most-difficult-first.** ("Not critical, but speeds up the
   algorithm ~10×.") Difficulty ≈ how constrained the activity is (few legal
   slots, many shared resources). This is the classic **most-constrained-variable
   / fail-first** ordering from CSP.
2. **Place activities one at a time** into an allowed slot (respecting all
   constraints). If several legal slots exist, **pick one at random** (randomization
   → different runs explore different timetables; lets the user "re-roll").
3. **On conflict (no free legal slot), recursively swap:**
   - **2a.** For each candidate slot, compute the **list of already-placed
     activities that would conflict** if we forced our activity there.
   - **2b.** Choose the slot `T_j` with the **lowest number of conflicting
     activities**.
   - **2c.** Place the current activity at `T_j`; **evict** (mark unallocated)
     the conflicting activities.
   - **2d.** **Recursively** try to re-place each evicted activity by the same
     procedure.
   - **2e–2f.** If all evictions re-place → accept. Else, undo and try the
     next-best slot; continue until success or slots exhausted.
4. **Bounded recursion (so it terminates, not exhaustive search):**
   - recursion **depth ≤ ~14**, and
   - total recursive calls since work on activity `A_i` began **≤ ~2·n**.
   If the budget is exhausted, FET reports the activity as **unplaceable** and the
   user must relax constraints.

### 3.1 The weight model = a *retry budget* (this is the clever part)

FET's weights are not abstract penalties — they're **operationalized as retries**:

| Weight | Behavior (from the FAQ, verbatim semantics) |
|---|---|
| 50% | "In average FET retries **two** times to place an activity without a conflict. If it can't after ~2 tries, it **keeps the conflict** and moves on." |
| 75% | ~**4** retries |
| 95% | ~**20** retries |
| 99% | ~**100** retries |
| 99.99% | ~**10000** retries |
| **100%** | **Unlimited** — the constraint is *always* respected; **if it's impossible, FET cannot generate a timetable at all.** |

Consequences we must internalize:

- **"Mandatory" = 100% = a true hard constraint** that can make the problem
  infeasible. Some FET constraints are *forced* to 100% (the basic compulsory
  ones, and bounds whose violation is meaningless).
- **Anything <100% is "best effort, will be skipped if it gets too hard."** The
  weight is **subjective / relative** — it controls *effort*, and stacking many
  high-but-<100% constraints can still produce an infeasible-feeling result
  (e.g. five 95% constraints ≈ overall 99.75%, "very high, may be impossible").
- This is **why FET is explainable**: a soft violation is a deliberate "I kept
  this conflict after N tries" event, which can be surfaced to the user.

### 3.2 "Fully flexible" — what it actually means in FET

- **No hardcoded rules / no assumed structure.** FET makes "any school structure"
  expressible: the timetable is generated *only* from the constraint list. There
  is no privileged "normal" schedule the user deviates from.
- **Composable scope** (one/set/all) + **activity tags** let a constraint target
  exactly the right slice without new code.
- **Weight as a continuous knob** turns the whole catalog into preferences you can
  dial, with 100% as the hard end.
- **Iterative feasibility loop**: over-constrained → FET names the unplaceable
  activity → user lowers a weight or removes a constraint → regenerate. The
  *design accepts* that you'll relax constraints; it doesn't pretend every input
  is solvable.

---

## 4. Concrete constraint/pattern catalog for OUR engine

This is the implementable catalog. It **generalizes** the inert 5-entry
`CONSTRAINT_TYPES` in `apps/fixtures/services/constraints.py` and keeps the same
record shape that `validate_constraints` already normalizes:
`{type, scope, hard, weight, params}`. New fields proposed: `weight` gains
**numeric penalty** semantics (0–100 or 0–1); `scope` becomes a structured
selector `{kind, ids|attr|round|stage}` instead of the bare string `"all"`.

### 4.1 The record schema (proposed, backward-compatible)

```jsonc
{
  "type": "min_rest_minutes",            // a catalog key (the "shape")
  "scope": {                              // who/what this applies to
    "kind": "team" | "venue" | "institution" | "category" | "all"
          | "team_attr" | "match_tag" | "round" | "stage",
    "ids":   ["<uuid>"],                  // explicit targets, or
    "attr":  {"key": "age_group", "value": "U14"},  // attribute match, or
    "round": 1, "stage": "group"          // structural targets
  },
  "hard": true,                           // model boundary: true => weight pinned 100
  "weight": 100,                          // 0..100 penalty/effort (FET-style)
  "params": { "minutes": 60 }             // shape-specific
}
```

### 4.2 The catalog (shape → params → hard-default → maps-to-FET)

Grouped by FET shape so we implement ~7 **handlers**, not 30 checks. Each row is a
`type` key for `CONSTRAINT_TYPES`. Bold = already exists in the repo.

#### A. Resource exclusivity (FET "basic compulsory", always hard)
| type | params | hard | notes |
|---|---|---|---|
| **`no_double_booking_team`** | – | yes | exists. A participant in ≤1 match per slot. Extend to Player-level for doubles/relay (a player shared across teams). |
| **`venue_single_use`** | – | yes | exists. A venue/court hosts ≤1 match per slot. |
| `venue_capacity_per_slot` | `{max}` | yes | a multi-court venue hosts ≤`max` matches/slot → FET-style **reservoir**/cumulative, not pure single-use. |

#### B. Availability / blackout (FET "X not available")
| type | params | hard | maps to |
|---|---|---|---|
| `team_unavailable` | `{windows:[{day,from,to}]}` | yes | teacher/students not available. Team blackout dates/times (spec §3.B). |
| `venue_availability` | `{windows:[...]}` (or inverse blackout) | yes | room not available; "respect venue/day/slot availability" (spec). |
| `global_blackout` | `{slots:[...]}` | yes | FET **Break** — rest days, ceremony slots. |
| `category_venue_compat` | `{venue_ids}` scoped to category | yes | "category/age-group only in compatible venues" (spec); FET subject→preferred-room as a *hard* whitelist. |

#### C. Counting bounds (FET max/min per window)
| type | params | hard-default | maps to |
|---|---|---|---|
| **`min_rest_minutes`** | `{minutes}` | yes | exists. FET "min resting hours". |
| `max_matches_per_day` | `{n}` scope team/all | yes | "max matches per team per day" (spec); FET max hours/activities daily. |
| `min_days_between_matches` | `{days}` scope=set | soft | FET "min days between a set of activities" — even spacing of a team's fixtures. |
| `max_days_between_matches` | `{days}` | soft | FET "max days between". |
| `max_consecutive_away` / `max_consecutive_home` | `{n}` | soft | sports **max home/away streak** (TTP maxStreak, usually 3) — §5. |
| `max_simultaneous_in_window` | `{n, slots}` | soft | FET "max simultaneous activities from a set" — cap parallel matches of one category. |

#### D. Placement preference (FET preferred starting time/slot/room)
| type | params | hard-default | maps to |
|---|---|---|---|
| **`preferred_window`** | `{days, from, to}` | soft | exists. FET "preferred time slots". |
| `prefer_venue` | `{venue_ids}` | soft | FET activity→preferred room. "prefer certain venues for finals/seeds" (spec). |
| `prime_time_for_tag` | `{tag, slots}` | soft | marquee/final in prime-time (spec); tag-scoped preferred slots. |
| `fixed_slot` | `{day, slot, venue?}` | yes | pin a specific match (manual override; FET "preferred starting time" at 100%). Respects invariant #10 manual-edit. |

#### E. Relational between matches (FET ordered/consecutive/grouped/same/gap)
| type | params | hard-default | maps to |
|---|---|---|---|
| `match_order` | `{before, after}` | yes | FET "two activities ordered" — e.g. semifinals before final; group stage before knockout. |
| `min_gap_between` | `{minutes\|slots}` scope=set | soft | FET "min gaps between a set of activities". |
| `not_overlapping` | – scope=set | yes | FET "set not overlapping" — same-team matches, or a player's two events. |
| `same_day` / `same_slot` | – scope=set | soft | FET "same starting day/hour" — co-schedule a category's matches. |
| **`avoid_back_to_back`** | – | soft | exists. derived spacing; FET min-gap variant. |

#### F. Separation / keep-apart (sports-specific, generalizes FET tag targeting)
| type | params | hard-default | notes |
|---|---|---|---|
| `keep_apart_until_round` | `{attr:{key,value}\|institution, until_round}` | yes | **the spec's headline constraint**: "same-Institution teams cannot meet in the opening round/stage", generalized to "teams sharing attribute X kept apart until round R". A *draw/pairing-phase* constraint (phase 1), not a slotting constraint. |
| `seed_separation` | `{pots}` | soft | seeded teams in different groups/halves of the bracket. |
| `rematch_gap` | `{min_rounds}` | soft | TTP **no-repeat** — don't replay the same pairing in consecutive rounds. |

#### G. Spread / balance (FET span, gaps, building changes)
| type | params | hard-default | maps to |
|---|---|---|---|
| `even_spacing` | `{}` scope=team | soft | spread a team's matches across the date range (spec). FET "min days between". |
| `balance_venue_usage` | `{}` | soft | even matches per venue/slot (spec). FET "occupies max different rooms" inverse. |
| `balance_home_away` | `{}` | soft | even home/away count per team. |
| `minimize_span` | `{}` (objective) | soft | shrink total tournament length (spec). |
| `minimize_travel` | `{distance_matrix}` | soft | FET building-change / TTP travel — sum of venue-change distances (§5). |
| `max_venue_changes_per_day` | `{n}` | soft | FET "max building changes per day". |

### 4.3 Phase split — which phase enforces what

The spec (§3.C) already splits generation into **phase 1 = pairing/draw** and
**phase 2 = assignment to (date, slot, venue)**. FET only does phase-2-style
slotting (its "activities" are pre-defined). Sports adds phase 1. Map the catalog:

- **Pairing-phase constraints** (decide *who plays whom, in which round*):
  `keep_apart_until_round`, `seed_separation`, `rematch_gap`,
  `max_consecutive_home/away` (depends on H/A pattern), `balance_home_away`,
  `match_order` (structural). These shape the bracket/schedule skeleton produced
  by `generate.py` (`_round_robin`, `generate_single_elimination`,
  `generate_knockout_from_groups`).
- **Slotting-phase constraints** (decide *when/where* each pairing happens) — the
  FET-analogous part: everything in A–E + the spread/balance/objective rows.

This is the cleanest seam: **phase 1 reuses the existing format generators**
(they already emit `winner_of`/`group_position` pointers per invariant #9), and
**phase 2 is the new FET-style scheduler** the constraint engine drives.

---

## 5. Sports-scheduling literature (beyond FET)

FET has no concept of home/away, travel, or pairing — sports does. Authoritative
patterns to fold in alongside the FET catalog:

- **Round-robin construction**: the **circle method** (already in
  `generate.py::_round_robin`) is the canonical 1-factorization. A double
  round-robin mirrors it for the return leg.
- **Breaks**: a *break* is two consecutive games with the same home/away status.
  **Break minimization** (the BR1 family of constraints) is a primary objective in
  league scheduling → our `max_consecutive_home/away` + `balance_home_away`.
- **Carryover effect**: avoid a team repeatedly playing opponents who just played
  the same strong/weak team; balanced via specific 1-factorization patterns.
- **No-repeat / no-repeater**: don't replay the same pairing in consecutive rounds
  → `rematch_gap`.
- **Traveling Tournament Problem (TTP)**: double round-robin **minimizing total
  travel distance**, with `maxStreak` (≤3 consecutive home/away) and no-repeat.
  NP-hard. This is our `minimize_travel` + `max_consecutive_*` + building/venue
  cluster model. Real origin: MLB scheduling.
- **Multiple-venue sport scheduling** (CP literature): assign games to shared
  venues with capacity + availability — directly our `venue_capacity_per_slot` +
  `venue_availability`, and the canonical CP-SAT modeling target.
- **Solving approach in the literature**: side-constrained round-robin is a hard
  combinatorial problem; the standard tools are **tree search + branch-and-bound
  (CP)** for exact/optimal, and **constructive heuristics + local search** for
  fast/large — *exactly* the layered approach in locked decision #3.

---

## 6. Mapping the FET solver to our layered engine

### 6.1 Phase-1 heuristic backend (ship first) — FET recursive swapping, adapted

Implement behind a `Solver` interface (`solve(model) -> Schedule + Report`):

1. **Build the model**: resources (teams, venues, slots from the calendar/venue
   availability), the pairing list from phase 1, and the normalized constraint
   list.
2. **Sort matches most-constrained-first** (fail-first): fewest legal (slot,venue)
   pairs, most shared resources (e.g. marquee teams, scarce venues). Mirrors FET
   step 1.
3. **Greedily assign** each match to a legal (slot, venue), respecting all **hard**
   constraints; among legal options pick the one **minimizing soft penalty** (then
   randomize ties → re-rollable previews, per FET).
4. **On no legal slot → recursive swapping** (FET 2a–2f): for each candidate
   (slot,venue), list the placed matches it would conflict with; pick the cell with
   the **fewest conflicts**; evict them; recursively re-place; bound recursion
   depth (~14) and total calls (~2n). On budget exhaustion → mark the match
   **unplaceable** and record *which hard constraint blocked it*.
5. **Local-search repair pass** (the spec's "repair/local-search"): hill-climb on
   total soft penalty via pairwise slot/venue swaps for a time budget. (FET itself
   relies mostly on the swapping; we add a light repair pass for soft quality.)
6. **Emit the Report**: per-constraint satisfied/violated + per-match
   placed/unplaceable, with human-readable reasons — feeds the wizard preview and
   invariant #10's regenerate/keep/diff UX.

**Why this fits the spec exactly**: inline, instant preview, explainable, satisfies
hard + optimizes soft — and it's the *same* algorithm FET uses in production.

### 6.2 Weight semantics for OUR engine (FET-informed, but cleaner)

Don't copy FET's literal "weight = retry count" coupling — it conflates effort with
priority and surprises users. Instead:

- `hard: true` → a **true hard constraint**; the heuristic never violates it; if
  unsatisfiable, the match is reported unplaceable (FET 100% semantics).
- `hard: false` + `weight ∈ [0,100]` → a **soft penalty coefficient** added to the
  objective the greedy choice + repair pass minimize. (This is the CP-SAT-friendly
  reading and keeps the heuristic and CP-SAT backends behaving consistently — the
  same `weight` means the same thing in both.)
- Keep FET's *explainability* (report kept conflicts) and its *iterative
  feasibility loop* (name unplaceable matches → user relaxes → regenerate).

### 6.3 Phase-2 CP-SAT backend (add later) — same model, optimal/hard cases

Per locked decision #3 (OR-Tools cp314 wheel confirmed on Py 3.14), the **same
constraint model** compiles to CP-SAT behind the same `Solver` interface (async
job — spec §4.3 Celery/Channels). Concrete CP-SAT mappings (OR-Tools idioms):

- **Each match → optional `IntervalVar`** over the slot grid (start = slot index,
  size = match duration in slots). Per-resource **`AddNoOverlap`** on the set of a
  team's / a venue's intervals = `no_double_booking_team` / `venue_single_use`.
- **Multi-court venue capacity** → **`AddCumulative`** / **`AddReservoirConstraint`**
  (`venue_capacity_per_slot`).
- **Assignment vars** `x[match, slot, venue] ∈ {0,1}` with `AddExactlyOne` per
  match; venue compatibility = forbid incompatible (match,venue) literals.
- **Availability** → fix/forbid (match,slot) literals from windows.
- **min_rest / spacing / ordering** → linear constraints on interval starts
  (`start_b >= end_a + gap`).
- **keep_apart_until_round / seed_separation** → pairing-phase boolean constraints
  (these usually stay in phase 1, but CP-SAT can co-solve them with
  channeling vars if we want a unified solve).
- **Soft constraints** → reify each into a penalty bool/int and
  **`Minimize(sum(weight_i * violation_i))`**, with hard constraints posted
  directly. The `weight` field becomes the objective coefficient — identical
  meaning to the heuristic's penalty, so swapping backends doesn't change intent.

### 6.4 Implementation seam (RESTRUCTURING-NOTES §5 #10)

- `apps/fixtures/services/constraints.py`: grow `CONSTRAINT_TYPES` to §4.2;
  enrich `validate_constraints` to validate the structured `scope` + numeric
  `weight`; add `validate_schedule(model, schedule) -> violations[]` and
  `score_schedule(...) -> penalty` behind a **per-type handler registry keyed off
  `CONSTRAINT_TYPES`** (the notes' explicit recommendation).
- New `apps/fixtures/services/solver/` with `base.py` (the `Solver` interface +
  `Schedule`/`Report` dataclasses), `heuristic.py` (recursive-swapping backend),
  later `cpsat.py`. `generate.py` stays the **phase-1 pairing** producer; the
  solver consumes its matches + the model.
- Wire `resolve_rules(tournament)` (notes #9) so the engine reads stored
  `rules`/`constraints` (today the generator ignores them — notes §4 HIGH).
- Honor the **freeze invariant** (#7): constraints mutable in draft/published,
  frozen at `registration_open`, via the Tournament state-machine seam (#5).

---

## 7. Recommended for our engine (the build list)

**Adopt directly from FET:**
1. **The resource/constraint separation** + the **one/set/all `scope` axis** +
   **tags** as the targeting mechanism. This is what makes it "fully flexible";
   we already have `scope` — make it structured, not a string.
2. **The recursive-swapping heuristic** (most-constrained-first placement → fewest-
   conflict slot → evict + bounded recursive re-place) as the **phase-1 solver
   backend**. It's the literal spec requirement and a proven production algorithm.
3. **Hard = absolute, soft = penalty, with explainable "kept conflict" reporting**
   and the **iterative-feasibility loop** (name unplaceable items → relax →
   regenerate) wired into invariant #10's regenerate/diff UX.
4. **One `Solver` interface, swappable backends** (heuristic now, CP-SAT later),
   sharing one constraint model — FET's own GA→swapping swap is the precedent for
   our locked decision #3.

**Adapt / improve on FET (don't copy literally):**
5. **Decouple weight from retry count.** Use `weight` as a clean objective
   penalty so the heuristic and CP-SAT agree on what `weight` means. FET's
   weight=retries is an implementation leak that confuses users.
6. **Add the sports layer FET lacks**: home/away patterns, **break minimization**,
   **no-repeat**, **carryover**, **travel/TTP**, **seeding/pots**, **byes for
   non-power-of-2** — as first-class catalog entries (§4.2 F/G, §5).
7. **Two-phase split** (pairing/draw vs slotting). FET is slotting-only; the draw
   constraints (`keep_apart_until_round`, seeding) belong to phase 1 over the
   existing `generate.py` format generators.

**Defer (FET features not worth it for v1):**
- Multi-period **subactivity splitting** as a general feature — only needed for
  best-of-N / multi-set ties; model those as a small fixed duration-in-slots
  rather than FET's full split machinery initially.
- The full **building-change** family — collapse to `minimize_travel` +
  `max_venue_changes_per_day` until multi-site tournaments demand more.
- FET's literal **retry-budget weight tiers** — replaced by penalty weights (#5).

**Concrete first increment (smallest shippable slice):**
- Promote `CONSTRAINT_TYPES` to the §4.2 catalog (structured `scope`, numeric
  `weight`); add the handler registry + `validate_schedule`/`score_schedule`.
- Build `solver/heuristic.py` (recursive swapping) behind `solver/base.py`.
- Make the generator read `rules`/`constraints` via `resolve_rules`.
- Return a per-constraint Report to drive the wizard preview + the regenerate/diff
  UX. CP-SAT (`solver/cpsat.py` + async job) follows as the "Optimize" backend.

---

## 8. Sources

FET (primary):
- FET Manual (full constraint taxonomy): https://www.timetabling.de/manual/FET-manual.en.html
- FET generation-algorithm description (recursive swapping): https://lalescu.ro/liviu/fet/doc/en/generation-algorithm-description.html
- FET FAQ (weight=retries semantics, no-hardcoded-rules philosophy, impossible timetables): https://lalescu.ro/liviu/fet/doc/en/faq.html
- FET forum — recursive swapping origin (2007, replaced the GA): https://lalescu.ro/liviu/fet/forum/index.php?topic=444.0
- FET forum — time complexity of recursive swapping: https://lalescu.ro/liviu/fet/forum/index.php?topic=5102.0
- FET review (Cal Poly, model + weights overview): http://users.csc.calpoly.edu/~gfisher/classes/309/specs/scheduler_m-f10-afternoon/requirements/fet-review.html
- FET 6.2.2 release notes: https://sourceforge.net/p/fet-timetabling/news/2021/11/fet-622-released/

Sports scheduling + CP/OR-Tools:
- A Pragmatic Approach for Solving the Sports Scheduling Problem (PATAT 2022): https://www.patatconference.org/patat2022/proceedings/PATAT_2022_paper_21.pdf
- A constraint programming approach to the multiple-venue sport-scheduling problem: https://www.researchgate.net/publication/222677007_A_constraint_programming_approach_to_the_multiple-venue_sport-scheduling_problem
- Scheduling double round-robin tournaments with divisional play using CP (EJOR): https://www.sciencedirect.com/science/article/abs/pii/S0377221716309584
- Round robin scheduling — a survey (EJOR): https://www.sciencedirect.com/science/article/abs/pii/S0377221707005309
- The Traveling Tournament Problem: Improved Algorithms (arXiv 2024): https://arxiv.org/html/2404.10955
- The Traveling Tournament Problem — Description and Benchmarks: https://www.researchgate.net/publication/220270875_The_Traveling_Tournament_Problem_Description_and_Benchmarks
- OR-Tools CP-SAT scheduling docs (intervals / no-overlap / cumulative): https://github.com/google/or-tools/blob/stable/ortools/sat/docs/scheduling.md
- The CP-SAT Primer — advanced modeling (intervals, no-overlap, reservoir): https://d-krupke.github.io/cpsat-primer/04B_advanced_modelling.html
- jmarca/sports_scheduling — OR-Tools sports scheduling reference: https://github.com/jmarca/sports_scheduling
