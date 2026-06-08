# CP-SAT / OR-Tools modeling for sports timetabling + good heuristics

Research briefing for the Fixture flexible fixture-generation engine (Stage 4 of the
tournament flow). Status: research only — feeds the engine design, no code changes.
Date: 2026-06-08.

This document grounds **decision 3** of the spec
(`docs/superpowers/specs/2026-06-08-tournament-flow-and-constraint-engine.md` §4):
ship a **heuristic backend first** (constructive + repair/local-search, inline,
explainable, instant preview), then add a **committed CP-SAT (OR-Tools) backend**
as an async "Optimize" engine, both behind one solver interface. It builds directly
on the inert constraints catalog (`apps/fixtures/services/constraints.py::CONSTRAINT_TYPES`),
the structural generator (`apps/fixtures/services/generate.py`), the advancement
seam (`apps/fixtures/services/advance.py::advance_from_match`), and the data-driven
rules service (`apps/tournaments/services/rules.py`).

---

## 0. Executive summary (read this first)

1. **Two phases, one model.** Keep the existing **pairing/structure generation**
   (`generate.py`: round-robin circle method, single-elim winner_of pointers,
   groups→knockout) as **Phase A**. The new engine is **Phase B: assignment** —
   place each already-generated pairing onto a `(date, time-slot, venue)` subject
   to hard constraints, optimizing soft ones. This split is exactly the
   "schedule-then-break / two-phase decomposition" the sports-timetabling
   literature recommends, and it matches what `constraints.py` was always meant to
   feed (its docstring: "schedule-level enforcement … added in a later increment").

2. **The constraint model is the contract.** Define a solver-agnostic
   *declarative* model: `{resources, slots, assignments-to-make, constraints[]}`
   where each constraint is a typed record `{type, scope, params, severity, weight}`.
   Both backends consume the **same** model. This generalizes the current 5-entry
   catalog into a parameterized FET/RobinX-style catalog (§4).

3. **Heuristic backend = constructive (greedy, ordered) + repair (local search).**
   Build a feasible-leaning schedule by inserting pairings most-constrained-first
   into the cheapest legal slot; then run hill-climbing / simulated annealing over
   a small set of **move operators** (swap slots, swap venues, swap rounds) to drive
   down the weighted soft-penalty objective. Instant, explainable, deterministic
   with a seed. This is the proven recipe across school/exam/sports timetabling (§6).

4. **CP-SAT backend = optional intervals + AddNoOverlap per resource + weighted soft
   objective.** Model each match's slot as an integer/interval; model resource
   exclusivity (team busy, venue busy) with `add_no_overlap`; reify each soft
   constraint to a penalty literal and `minimize` the weighted sum. Run async with a
   wall-clock `max_time_in_seconds`, in a **subprocess** so it can be killed, with a
   solution callback streaming progress (§5, §8).

5. **Explainability is a first-class output**, not an afterthought. Both backends
   return the same `ScheduleResult`: the assignment + a per-constraint report
   (`satisfied | violated`, who, by how much, penalty contribution). Hard violations
   ⇒ infeasible-with-reasons; soft violations ⇒ ranked warnings. This is how FET and
   the ITC2021 winners present results, and it reuses our existing
   `inputs_hash` / `last_manual_edit_at` regeneration UX (invariant #10).

6. **When to use which.** Heuristic = the default, always-on, sub-second wizard
   preview. CP-SAT = a user-triggered "Optimize" / "Prove feasibility" job for
   hard instances (tight venues, many separation constraints, "must be optimal").
   The research is blunt: *pure* exact solvers struggle on the hardest sports
   instances, but **CP-SAT + a metaheuristic warm-start** is competitive and was a
   top ITC2021 design. Our layering (heuristic result → CP-SAT hint) gets the best
   of both.

---

## 1. Problem framing: what we are actually scheduling

Classic academic "sports timetabling" (ITC2021, RobinX, CSPLib prob026) schedules a
**compact (double) round-robin into rounds**, optimizing home/away patterns
(breaks), carry-over, and fairness. That literature is the gold-standard source for
*constraint vocabulary and algorithms*, but our product is broader and in some ways
simpler-per-match and harder-per-resource:

| Dimension | Academic sports TT | Fixture Platform (ours) |
|---|---|---|
| Structure | fixed double RR, n teams, n−1 rounds | **any** format (RR single/double, knockout, groups→KO, Swiss, multi-event) — produced by Phase A |
| Time | abstract "rounds" (slots within a round) | **real calendar**: date range, daily windows, slot = duration + buffer |
| Resource | venue mostly implicit | **explicit venues/courts/grounds** with per-day/per-slot availability, sport/category compatibility |
| Home/away & breaks | central objective | **secondary** (we care more about spacing, rest, venue balance, separation) |
| Multi-sport | single competition | **multi-sport + multi-category in one tournament** sharing a venue pool |
| Run cadence | once per season, days of compute OK | interactive wizard preview (ms) **and** a heavier "optimize" job |

**Takeaway:** borrow RobinX's *constraint taxonomy* and the ITC2021 winners'
*algorithms*, but re-cast the core decision as a **resource-constrained scheduling
/ assignment problem** (matches → time-slots × venues), which is squarely CP-SAT's
`AddNoOverlap`/`AddCumulative` wheelhouse and a clean fit for greedy+local-search.

### The decision, precisely
- **Given** a set of matches `M` (each match `m` has participants `P(m)` — teams or
  individuals — a sport, a category, a stage/round, a duration `d(m)`).
- **Given** resources: time-slots `S` (concrete `(date, start)` candidates derived
  from the calendar wizard) and venues `V` (each with availability and
  sport/category compatibility).
- **Decide** for each `m`: a start slot and a venue (and, where the format leaves it
  open, possibly the round).
- **Subject to** hard constraints; **minimizing** the weighted sum of soft penalties.

---

## 2. Two solver backends behind one interface

```
                 ┌────────────────────────────────────────────┐
   Wizard  ──►   │  ConstraintModel (declarative, JSONB-backed) │
   answers       │  resources + slots + matches + constraints[] │
                 └───────────────┬──────────────────┬──────────-┘
                                 │                   │
                     ┌───────────▼──────┐   ┌────────▼─────────────┐
                     │ HeuristicBackend  │   │   CpSatBackend       │
                     │ greedy + repair   │   │ OR-Tools, async job  │
                     │ inline, ms        │   │ subprocess + timeout │
                     └───────────┬──────┘   └────────┬─────────────┘
                                 │                   │
                       ┌─────────▼───────────────────▼────────┐
                       │           ScheduleResult              │
                       │  assignment + per-constraint report   │
                       │  (satisfied/violated, penalty, who)   │
                       └───────────────────────────────────────┘
```

Interface sketch (Python, illustrative — not to be committed here):

```python
class SchedulerBackend(Protocol):
    name: str
    def solve(self, model: ConstraintModel, *, time_budget_s: float,
              seed: int, hint: Assignment | None = None) -> ScheduleResult: ...

@dataclass
class ScheduleResult:
    status: Literal["optimal", "feasible", "infeasible", "timeout", "partial"]
    assignment: dict[MatchId, SlotVenue]      # may be partial on infeasible
    objective: int                             # total weighted soft penalty
    bound: int | None                          # CP-SAT proven lower bound (gap)
    report: list[ConstraintOutcome]            # per-constraint, explainable
    solver: str; seed: int; wall_ms: int
```

`ScheduleResult` is what the wizard renders and what the regeneration UX diffs.
The two backends MUST be interchangeable on the same `ConstraintModel`; CP-SAT is a
drop-in, never a rewrite (spec §4.3).

---

## 3. The declarative constraint model (data shape)

Generalize today's `apps/fixtures/services/constraints.py`. Each constraint becomes
a parameterized record interpreted at runtime — never hardcoded (spec §3.B/§3.C,
invariant: data-driven rules). Stored on `Tournament.constraints` (JSONB), validated
by an extended `validate_constraints`.

```jsonc
// resources model (derived from the wizard, not user-typed JSON)
{
  "slots":   [{"id":"s1","date":"2026-09-01","start":"09:00","len_min":40}, ...],
  "venues":  [{"id":"v1","name":"Court 1","sports":["table_tennis"],
               "availability":[{"date":"2026-09-01","from":"08:00","to":"18:00"}]}],
  "matches": [{"id":"m1","participants":["t7","t12"],"sport":"football",
               "category":"u17","stage":"group","round":1,"dur_min":90,
               "attrs":{"institution":["INST_A","INST_A"],"seed":[1,16]}}],
  // typed, parameterized, severity+weight — the FET/RobinX-style catalog
  "constraints": [
    {"type":"no_double_booking_team","scope":"all","severity":"hard"},
    {"type":"venue_single_use","scope":"all","severity":"hard"},
    {"type":"min_rest_minutes","scope":"all","severity":"hard","params":{"minutes":120}},
    {"type":"max_matches_per_day","scope":{"team":"*"},"severity":"hard","params":{"max":2}},
    {"type":"venue_availability","scope":"all","severity":"hard"},
    {"type":"category_venue_compat","scope":"all","severity":"hard"},
    {"type":"separate_until_round","severity":"hard",
     "params":{"attr":"institution","round":2}},
    {"type":"blackout","scope":{"team":"t7"},"severity":"hard",
     "params":{"windows":[{"date":"2026-09-03","from":"00:00","to":"23:59"}]}},
    {"type":"even_spacing","severity":"soft","weight":5},
    {"type":"avoid_back_to_back","severity":"soft","weight":8},
    {"type":"balance_venue_load","severity":"soft","weight":3},
    {"type":"preferred_window","scope":{"match":"final"},"severity":"soft","weight":10,
     "params":{"days":["Sat"],"from":"18:00","to":"20:00"}}
  ]
}
```

`severity ∈ {hard, soft}` replaces today's boolean `hard` (keep `hard:true/false`
as an alias for back-compat). `weight` is an integer soft penalty (FET uses a
0–100% scale; we use absolute integer weights because CP-SAT minimizes an integer
objective and integer weights are exact — convert a UI percentage to a weight).

Catalog plumbing already exists: `CONSTRAINT_TYPES` + `validate_constraints` in
`constraints.py`. The work is (a) add the new types + param schemas, (b) add a
`severity` field, (c) add the two enforcement entry points the docstring promises:
`build_cp_model(model)` (CP-SAT) and `evaluate(assignment, model)` (heuristic +
final report). Both read the **same** records.

---

## 4. Constraint catalog (implementable, mapped to RobinX + FET)

The **RobinX** unified format (ITC2021) classifies round-robin constraints into five
families; **FET** classifies into time vs space, compulsory vs preferred. Our catalog
fuses both and adds the calendar/venue realism we need. For each: hard/soft default,
params, how the **heuristic** evaluates it, how **CP-SAT** encodes it.

### 4.1 Resource-exclusivity (hard) — the backbone

| Type | Meaning | Heuristic check | CP-SAT encoding |
|---|---|---|---|
| `no_double_booking_team` *(have)* | a team/player is in ≤1 match per overlapping time | reject slot if any participant already busy in an overlapping interval | per **participant**: `add_no_overlap` over the optional intervals of all matches that include it |
| `venue_single_use` *(have)* | ≤1 match per venue per overlapping time | reject if venue interval overlaps | per **venue**: `add_no_overlap` over optional intervals assigned to that venue |
| `venue_capacity` (parallel courts at one ground) | ≤K concurrent at a venue | running count ≤K | `add_cumulative(intervals, demands=1, capacity=K)` |

These map cleanly to CP-SAT interval/no-overlap (§5.2). They are the *only*
constraints that strictly need intervals; everything else can be linear on the slot
index, which the Primer explicitly recommends ("Do not directly jump to intervals…
consider whether simple Boolean/integer variables are more efficient" — discrete
slots favor booleans).

### 4.2 Temporal / rest (hard, sometimes soft)

| Type | Meaning | Params | Notes |
|---|---|---|---|
| `min_rest_minutes` *(have)* | gap ≥ N min between a team's consecutive matches | `minutes` | RobinX **SE1** analogue (separation). CP-SAT: for each pair of matches sharing a participant, `start_j ≥ end_i + N OR start_i ≥ end_j + N` via reified disjunction; or rely on per-team `add_no_overlap` with inflated interval = `dur + N` |
| `max_matches_per_day` (overall & per team) | cap matches in a calendar day | `max`, `scope` | RobinX **CA**-style capacity. CP-SAT: sum of day-indicator booleans ≤ max |
| `min_days_between` | ≥ D days between a team's matches | `days` | spacing as hard floor |
| `blackout` | team/venue unavailable in windows | `windows` | model as **fixed intervals** the resource's no_overlap must avoid (Primer "weekend" pattern), or prune slot domain |
| `venue_availability` | venue open only in listed windows | derived | restrict each match-on-venue interval's start domain to open windows |
| `daily_window` / `earliest_latest_start` | matches inside daily time window | from/to | slot generation already enforces; keep as guard |

### 4.3 Structural / draw (hard) — our differentiators

| Type | Meaning | Params | Encoding |
|---|---|---|---|
| `separate_until_round` | teams sharing attribute X (e.g. same `institution`) cannot meet before round R | `attr`, `round` | **affects Phase A pairing**, not just assignment. In knockout draws, this is a *draw constraint*: place same-attr teams in different bracket quarters. Heuristic: constrained seeding/draw; CP-SAT (if pairings are decision vars): forbid the pairing literal for `round < R`. For our RR/groups it constrains *which round* a fixed pairing lands in |
| `category_venue_compat` | a category/age-group only on compatible venues | derived from `venue.sports` | prune venue domain per match; CP-SAT: only create optional intervals for compatible (match,venue) pairs |
| `same_venue_for_group` | a group/pool plays all its matches at one venue | `group` | channel all that group's venue vars to one value |
| `home_away` / `break_*` (RobinX BR1/BR2, CA3) | limit consecutive home/away, total breaks | — | **lower priority for us** (most school/college events are at neutral venues). Keep types defined but default-off; encode breaks as booleans `b_{t,r} = (HA_{t,r}==HA_{t,r-1})`, minimize `sum b` (classic break-minimization) |

`separate_until_round` is explicitly in the spec ("same-organization teams cannot
meet in the opening round … generalizable: teams sharing attribute X kept apart
until round R"). It is the one constraint that reaches *back into Phase A* — design
Phase A's draw to accept a "keep-apart" set so the heuristic can honor it during
seeding rather than failing in assignment.

### 4.4 Soft / fairness (optimize + warn)

| Type | Meaning | Penalty model |
|---|---|---|
| `even_spacing` | spread a team's matches evenly across the date range | penalty = sum of squared deviations from ideal gap, or sum of `|gap − ideal|` (use abs to keep CP-SAT linear) |
| `avoid_back_to_back` | no two matches for a team in adjacent slots/same day | +weight per adjacent pair (a "near-break") |
| `balance_venue_load` / `balance_slot_load` | even matches per venue / per day | penalize `max_load − min_load`, or deviation from mean |
| `preferred_window` *(have)* | finals/marquee in prime time; seeded teams' preferred times | +weight if outside window (RobinX **GA1** soft form) |
| `compactness` / `minimize_span` | finish the tournament sooner | penalize last used day index (RobinX makespan) |
| `minimize_travel` | minimize venue→venue movement for a team across its matches | +weight·distance per consecutive different-venue pair (needs a venue distance matrix) |
| `fairness_rest` | minimize variance of rest across teams (soft floor above the hard `min_rest`) | penalize teams below a target rest |

**FET parallel:** FET attaches a *weight percentage 0–100%* to every constraint and
minimizes the weighted deviation; 100%-weight constraints are effectively hard.
We adopt the same mental model (severity=hard ≈ FET 100%-compulsory; soft+weight ≈
FET preferred), which is exactly what the wizard's "hard | soft + weight" toggle
(spec §3.B) needs.

---

## 5. CP-SAT (OR-Tools) modeling — concrete

OR-Tools `cp314` wheel is confirmed installable on the venv's Python 3.14
(spec §4.3). All API names below are the modern snake_case Python API
(`ortools.sat.python.cp_model`).

### 5.1 Decision variables

Discrete time is natural for us (slot list from the wizard). Two viable encodings:

**(A) Slot-index + venue-index (recommended default).** Compact, linear constraints,
fast presolve.
```python
S = list_of_slots            # each has a global integer index (sorted by datetime)
V = list_of_venues
# per match: which slot, which venue
slot[m]  = model.new_int_var(0, len(S)-1, f"slot_{m}")
venue[m] = model.new_int_var(0, len(V)-1, f"venue_{m}")
# OR, the channeling form used for no-overlap below:
x[m][s][v] = model.new_bool_var(...)   # 1 iff match m at slot s on venue v
model.add_exactly_one(x[m][s][v] for s in S for v in compatible_venues(m))
```
Prune the domain at build time: only create `x[m][s][v]` for **compatible** `(m,v)`
(category/venue compat, §4.3) and **available** `(s,v)` (venue availability,
blackouts, §4.2). Domain pruning is the single biggest CP-SAT speed-up here.

**(B) Optional intervals (use for the resource no-overlap layer).** This is the
canonical OR-Tools "task on alternative machines" pattern from the scheduling docs:
one optional interval per `(match, venue)`, exactly-one selection, no-overlap per
venue.
```python
# duration in slot-units (or minutes if slots are minute-grained)
for m in M:
    presence = {}
    ivs = {}
    for v in compatible_venues(m):
        presence[m,v] = model.new_bool_var(f"on_{m}_{v}")
        ivs[m,v] = model.new_optional_fixed_size_interval_var(
            start=start[m], size=dur[m], is_present=presence[m,v],
            name=f"iv_{m}_{v}")
    model.add_exactly_one(presence[m,v] for v in compatible_venues(m))

# venue exclusivity: per venue, the optional intervals can't overlap
for v in V:
    model.add_no_overlap([ivs[m,v] for m in M if (m,v) in ivs])

# team/participant exclusivity: per participant, a single interval per match,
# no-overlap across all its matches (venue-agnostic team-busy interval)
team_iv = {m: model.new_fixed_size_interval_var(start[m], dur[m], f"tiv_{m}") for m in M}
for p in participants:
    model.add_no_overlap([team_iv[m] for m in matches_of(p)])
```
This is verbatim the OR-Tools multi-resource recipe (per scheduling.md and the
CP-SAT Primer "Multi-Room Scheduling" example): optional interval per (task,
resource) + `add_exactly_one` selection + `add_no_overlap` per resource.

> Primer caution: for purely **discrete-slot** problems, plain booleans/integers
> often beat intervals. Recommendation: use **(A) booleans for everything except**
> the venue/team **exclusivity**, where intervals + `add_no_overlap` (B) are clean
> and let CP-SAT's specialized no-overlap propagators do the work — especially once
> matches have **variable durations** (multi-sport: TT 40min vs football 90min) and
> rest buffers, where time isn't a clean 1-match-per-slot grid.

### 5.2 Hard constraints → CP-SAT

| Constraint | CP-SAT |
|---|---|
| team no-double-book | `add_no_overlap(team_iv for that participant)` |
| venue single use | `add_no_overlap(optional ivs on that venue)` |
| venue capacity K | `add_cumulative(ivs_on_venue, demands=[1…], capacity=K)` |
| min_rest_minutes | inflate `team_iv` size to `dur+rest`, OR reified disjunction `start_j ≥ end_i+R ∨ start_i ≥ end_j+R` per shared-participant pair |
| max per day | `add(sum(day_indicator[m,d] for m in team's matches) ≤ max)`; `day_indicator` channeled from `slot[m]`'s date |
| blackout / availability | restrict `start[m]` domain via `new_int_var_from_domain(Domain.from_intervals(open_windows))`; or add a fixed busy interval to the resource no-overlap |
| category/venue compat | omit incompatible `(m,v)` intervals entirely (domain pruning) |
| separate_until_round | if rounds are fixed by Phase A → no-op; if round is a decision → forbid the pairing/round literal (or solve at the draw level) |

### 5.3 Soft constraints → weighted objective

Reify each soft violation to a penalty term and minimize the weighted sum (the
standard hard/soft sports-TT objective: *satisfy all hard, minimize weighted soft
deviation*).

```python
penalties = []
# avoid_back_to_back: for each team, each adjacent-slot pair both used → penalty
for p in participants:
    for (mi, mj) in adjacent_pairs(matches_of(p)):
        b2b = model.new_bool_var(f"b2b_{p}_{mi}_{mj}")
        # b2b == 1 iff |slot[mi]-slot[mj]| == 1 (channel via reified linear)
        ...
        penalties.append((W_back_to_back, b2b))

# preferred_window (final at prime time): out_of_window bool
ow = model.new_bool_var("final_out_of_window")
model.add(slot[final] not in prime_slots).only_enforce_if(ow)   # via domain channel
model.add(slot[final] in prime_slots).only_enforce_if(ow.Not())
penalties.append((W_final_window, ow))

# even_spacing: penalize abs deviation of each gap from ideal (linear via aux var)
# balance_venue_load: minimize (max_load - min_load) with two aux vars + add_max/min

model.minimize(sum(w * var for (w, var) in penalties))
```
Use **integer** weights (CP-SAT objective is integer). Convert a UI percentage to a
weight at model-build time. Keep all penalties **linear** (use abs-value via
auxiliary `model.add_abs_equality`, or squared-via-piecewise only if needed) so the
LP relaxation stays strong.

### 5.4 Solving: parameters, status, hints, callbacks

```python
solver = cp_model.CpSolver()
solver.parameters.max_time_in_seconds = time_budget_s   # WALL-CLOCK cap (required)
solver.parameters.num_workers = 8                        # parallel portfolio
solver.parameters.relative_gap_limit = 0.02              # stop within 2% of optimum
solver.parameters.random_seed = seed                     # reproducibility
solver.parameters.log_search_progress = True             # pipe to job log

# WARM-START from the heuristic solution → huge speedup / immediate feasibility
for m, (s, v) in heuristic_assignment.items():
    model.add_hint(slot[m], s)
    model.add_hint(venue[m], v)

status = solver.solve(model, progress_callback)
# OPTIMAL(4) | FEASIBLE(2) | INFEASIBLE(3) | UNKNOWN(0) | MODEL_INVALID(1)
if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
    obj   = solver.objective_value
    bound = solver.best_objective_bound          # gap = obj - bound (proof quality)
```

Progress streaming (for the async job's progress bar + early stop):
```python
class Progress(cp_model.CpSolverSolutionCallback):
    def on_solution_callback(self):
        publish(obj=self.objective_value, bound=self.best_objective_bound,
                wall=self.wall_time)
        if self.objective_value - self.best_objective_bound <= ACCEPTABLE:
            self.stop_search()
```

**Hint-as-warm-start is the most important production lever for us:** the heuristic
backend already produced a feasible (or near-feasible) assignment in milliseconds;
feeding it as hints lets CP-SAT either *prove* it optimal/near-optimal or *improve*
it, and means CP-SAT almost never returns empty-handed within the budget. The Primer
notes good hints "significantly improve performance"; bad hints slow things down, so
only hint a *feasible* heuristic result. (`repair_hint=True` + `hint_conflict_limit`
let CP-SAT mend a slightly-infeasible hint.)

**Infeasibility explainability:** if `INFEASIBLE`, re-solve a relaxed model where
each *hard* constraint gets an "allow-violation" boolean with a large penalty
(turn hard→soft-with-huge-weight), then report which were violated — this surfaces
*why* it's impossible ("Court 1 is over-subscribed on Sep 3; relax rest to 90min or
add a venue"). This mirrors the ITC2021 winners' approach (start with hard-as-soft,
let annealing/CP find the infeasibility, then harden).

---

## 6. Heuristic backend — constructive + repair (ship first)

The proven, explainable, instant recipe (consistently the practical winner in
school/exam/sports timetabling, and the structure of the ITC2021 SA winners).

### 6.1 Phase A — pairing/structure (already built)
Reuse `generate.py`: `generate_round_robin` (circle method, grouped),
`generate_single_elimination` (winner_of pointers), `generate_knockout_from_groups`.
Extend the **draw** step to honor `separate_until_round` (keep-apart sets during
seeding). Output: the set of matches `M` with participants, sport, category, round,
duration. Advancement of TBD matches stays on the existing
`advance.py::advance_from_match` on-commit seam (invariant #9).

### 6.2 Phase B1 — greedy constructive (initial feasible-leaning schedule)
"Most-constrained-first insertion into cheapest legal slot":
1. **Order matches** by a difficulty score (descending): few compatible
   `(slot,venue)` options first; earlier rounds first; marquee/seeded first. (Graph-
   coloring "saturation degree" intuition — schedule the hardest things while the
   calendar is empty.)
2. For each match, enumerate **legal** `(slot, venue)` candidates (passes all hard
   checks given the partial schedule: team free, venue free + available + compatible,
   rest satisfied, within daily window, not blacked-out, max-per-day not exceeded).
3. Pick the candidate with the **lowest marginal soft cost** (Δ of the weighted
   objective). Tie-break by earliest slot / least-loaded venue.
4. If no legal candidate, **backtrack** a bounded number of steps (un-place the most
   recent conflicting match and try its next-best slot) — bounded so it stays fast.
   If still stuck, leave it **unplaced** and record a hard-violation reason
   (feeds explainability + "relax X" suggestions).

### 6.3 Phase B2 — repair / local search (drive down soft penalty)
Start from B1's schedule; iterate **move operators** (the sports-TT canon):
- **MoveMatch** — reassign one match to a different legal slot/venue.
- **SwapSlots** — exchange the time-slots of two matches.
- **SwapVenues** — exchange the venues of two matches.
- **SwapRounds** — exchange two whole rounds (cheap macro-move; preserves RR validity).
- **PartialSwap** — swap a subset of a team's matches (the ITC2021 "PartialSwapTeams/
  Rounds" family that the winning Udine SA used; powerful for breaking local minima).

Acceptance:
- **Hill climbing** for the instant wizard preview (accept any non-worsening move;
  stop after a small move budget or a wall-clock of ~100–300ms). Deterministic with
  a seed.
- **Simulated annealing** for a "better preview" / mid effort: accept worsening moves
  with prob `exp(−Δ/T)`, cool `T` over iterations. SA is the single most effective
  approach in the ITC2021 results; a multi-neighborhood SA over the operators above
  is the recommended heuristic core if we invest beyond hill-climbing.
- **Tabu search** is the main alternative (forbid recently-reversed moves to escape
  cycles); comparable quality, slightly more bookkeeping. SA is simpler and the
  literature's top performer here, so prefer SA.

Always keep hard constraints **inviolable during repair** (only generate legal
moves), so the schedule is feasible at every step and can be returned at any time —
this is what makes the heuristic safe for an inline, interruptible preview.

### 6.4 Why this first
- **Instant + inline**: no async infra needed for the wizard's live preview.
- **Explainable**: every placement decision and every residual soft violation has a
  human reason; unplaced matches carry an actionable "why" + "relax which constraint".
- **Deterministic**: seed → reproducible (important for the `inputs_hash`
  regenerate/keep/diff UX, invariant #10).
- **Feeds CP-SAT**: its output is the warm-start hint (§5.4) — zero wasted work.

---

## 7. Explainable hard/soft scoring model (shared output)

Both backends emit the same scoring report so the UI is backend-agnostic.

```python
@dataclass
class ConstraintOutcome:
    constraint_id: str
    type: str                 # e.g. "min_rest_minutes"
    severity: Literal["hard","soft"]
    status: Literal["satisfied","violated"]
    weight: int               # soft only
    penalty: int              # weight * magnitude (0 if satisfied)
    magnitude: float          # e.g. minutes short of rest, # of back-to-backs
    offenders: list[str]      # match/team/venue ids involved
    message: str              # localized, e.g. "Team A had only 75 min rest (need 120)"
```

- **Score** = `sum(penalty for soft outcomes)` (= CP-SAT `objective_value`; = the
  heuristic's evaluated objective — they MUST agree on the same assignment, which is
  the cross-check that the two backends share one model).
- **Feasibility** = `all(o.status=="satisfied" for o in hard outcomes)`.
- **Report rendering**: group by severity, sort soft by penalty desc; show the
  CP-SAT **gap** (`objective − bound`) as "this is within X of provably optimal" when
  available. FET and the ITC2021 tooling present results exactly this way (satisfied
  vs violated soft, ranked by weighted deviation).
- **Regeneration UX**: store the objective + report alongside `inputs_hash`; on input
  change, offer regenerate/keep/diff (reuse the existing pattern from
  `rules.py`/the generator) and diff the per-constraint outcomes.

---

## 8. Async / time-limit patterns for the CP-SAT job

CP-SAT solves can't block a request (spec §4.3). Recommended pattern, grounded in the
CP-SAT Primer's "coding patterns" + Celery web patterns:

1. **Job kickoff**: `POST /tournaments/{id}/fixtures/optimize` enqueues a background
   job, returns a `job_id` immediately (202). Idempotent on a client `event_id`
   (invariant #3).
2. **Worker**: a background worker (Celery — educonnect already runs it, spec §4.3 —
   or a Channels/Redis task) builds the `ConstraintModel`, warm-starts from the
   heuristic result, runs the solve.
3. **Run the solver in a subprocess** (`multiprocessing.Process` + `Pipe`, the Primer
   pattern) so the worker stays responsive to **stop/timeout** signals and can hard-
   kill a runaway solve. `max_time_in_seconds` is the soft cap; the subprocess
   timeout is the hard cap.
4. **Progress**: a `CpSolverSolutionCallback` publishes `{objective, bound, wall}` on
   each improving solution. Surface via the existing live transport — **SSE** for the
   one-way progress feed (invariant #11; SSE is for one-way viewer/notification
   streams), or poll `GET /jobs/{job_id}`.
5. **Result**: persist the `ScheduleResult`; on success, apply the assignment to
   `Match` rows (set `scheduled_at`, `venue`) inside a transaction, set `inputs_hash`,
   publish on `transaction.on_commit` (invariant #4). The user can **keep** the
   heuristic result or **adopt** the optimized one (diff view).
6. **Budgets**: small default (e.g. 10–30s) for "improve my schedule", larger
   opt-in (minutes) for "prove feasibility / find optimal", always with a hard
   subprocess kill. Return the **best feasible found** on timeout (status=`timeout`,
   include the gap) — never fail the user empty-handed because the heuristic result
   is always available as the floor.

Concurrency guards: only one optimize job per tournament at a time; respect the
freeze invariant (constraints frozen at `registration_open`, spec §3.C / invariant
#7) so the model can't shift mid-solve. Migrations are blocked while a tournament is
`live` (existing pre-flight) — unrelated to solving but a reminder the worker must
use the same DB safely.

---

## 9. Recommended for our engine (decisions)

1. **Keep the two-phase split.** Phase A = existing `generate.py` structure/draw
   (extended for `separate_until_round` keep-apart). Phase B = the new assignment
   engine. Don't model pairing *and* placement as one giant CP-SAT problem — it's
   slower and throws away working code.

2. **One declarative `ConstraintModel`**, generalize `constraints.py`: add the §4
   types + `severity` + integer `weight`; add `build_cp_model()` and
   `evaluate(assignment)` entry points the docstring already promised. This is the
   contract both backends share and the wizard authors.

3. **Ship the heuristic backend first** (§6): greedy most-constrained-first
   construction + bounded backtracking, then hill-climbing for the instant preview,
   with **simulated annealing over multi-neighborhood moves** (Move/SwapSlots/
   SwapVenues/SwapRounds/PartialSwap) as the quality tier. Inline, deterministic
   (seeded), explainable. This satisfies the spec's "instant wizard preview" and is
   the literature's practical winner.

4. **Add CP-SAT as the async "Optimize" backend** (§5, §8): encoding **(A) booleans
   for placement + (B) optional intervals + `add_no_overlap` for team/venue
   exclusivity** (and `add_cumulative` for multi-court venues); weighted soft
   objective with integer weights; **warm-start from the heuristic result** via
   `add_hint`; `max_time_in_seconds` + subprocess kill; solution-callback progress.
   Return best-feasible on timeout with the optimality gap.

5. **Explainability is a shared `ScheduleResult`** (§7): per-constraint
   satisfied/violated + penalty + offenders + localized message, plus CP-SAT's gap.
   Wire it to the existing `inputs_hash`/`last_manual_edit_at` regenerate/keep/diff
   UX (invariant #10).

6. **Domain-prune aggressively** before either solve: only legal `(match, slot,
   venue)` combos exist (category/venue compat, availability, blackout). This is the
   biggest, cheapest performance win for both backends.

7. **Infeasibility = actionable** (§5.4): re-solve hard-as-soft to report *which*
   constraints make it impossible and suggest relaxations ("add a venue", "reduce
   rest to 90min", "extend the date range").

8. **De-prioritize home/away break minimization** for v1 (most school/college events
   are neutral-venue), but keep the RobinX BR/CA break types defined and default-off
   so leagues can switch them on later — the catalog is extensible by design.

9. **Don't over-reach with exact methods.** The research is explicit: pure IP/CP
   struggles on the hardest sports instances; **SA and CP-SAT+metaheuristic hybrids
   win**. Our layering (heuristic always-on, CP-SAT warm-started for the hard/optimal
   cases) is exactly that hybrid — and is a drop-in behind the interface, not a
   rewrite (spec §4.3).

---

## 10. Risks / open questions for the build plan

- **Time granularity.** Minute-grained intervals (clean for variable durations +
  rest buffers, multi-sport) vs slot-grained (faster, but a "slot" must absorb the
  longest match). Recommendation: **minute-grained start domains restricted to the
  wizard's candidate start times** — best of both (small domain, exact durations).
- **Multi-event coupling.** Different sports share the venue pool but rarely share
  participants; model them as **one** assignment problem over the shared venue
  resources (so courts aren't double-booked across sports) — a single `ConstraintModel`
  spanning sports, with per-match `sport`/`category`/`dur` (spec decision 2).
- **`separate_until_round` reaching into Phase A.** Needs the draw to accept keep-
  apart sets; confirm Phase A's draw refactor scope.
- **Worker infra choice** (Celery vs Channels/Redis task) — spec §4.3 leaves
  `[OPEN]`; either supports the §8 pattern, Celery is already in the ecosystem.
- **Determinism vs parallelism.** CP-SAT with `num_workers>1` is not bit-for-bit
  deterministic; fix `random_seed` and accept that the *heuristic* (not CP-SAT) is
  the deterministic source for the `inputs_hash` regenerate/diff UX.

---

## Sources

- [OR-Tools CP-SAT scheduling docs (google/or-tools, scheduling.md)](https://github.com/google/or-tools/blob/stable/ortools/sat/docs/scheduling.md) — interval vars, optional intervals, AddNoOverlap, AddCumulative, ranking, transitions, alternative resources.
- [CP-SAT Primer — Advanced Modeling (Krupke, TU Braunschweig)](https://d-krupke.github.io/cpsat-primer/04B_advanced_modelling.html) — intervals, optional intervals + presence literals, multi-room/alternative-resource pattern, reification.
- [CP-SAT Primer — Parameters](https://d-krupke.github.io/cpsat-primer/05_parameters.html) — max_time_in_seconds, num_workers, gap limits, hints, solution callbacks, status codes, warm-start.
- [CP-SAT Primer — Coding Patterns](https://d-krupke.github.io/cpsat-primer/06_coding_patterns.html) — solver-class structure, warm-start/repair_hint, multiprocessing for responsiveness/timeouts, serialization for web apps.
- [CP-SAT Primer — Basic Modeling](https://d-krupke.github.io/cpsat-primer/04_modelling.html) — variables, linear/reified constraints, objective.
- [ortools.sat.python.cp_model API](https://or-tools.github.io/docs/pdoc/ortools/sat/python/cp_model.html) — exact Python method names.
- [The international timetabling competition on sports timetabling (ITC2021), EJOR 2023](https://www.sciencedirect.com/science/article/abs/pii/S0377221722009201) — compact double RR, hard/soft objective, competition structure.
- [Which algorithm to select in sports timetabling? (arXiv 2309.03229v2)](https://arxiv.org/html/2309.03229v2) — RobinX CA/BR/GA/FA/SE constraint families; SA/CP-SAT-hybrid winners; move operators (SwapHomes/Teams/Rounds, PartialSwap); exact-vs-heuristic guidance.
- [Multi-neighborhood simulated annealing for ITC2021 (Journal of Scheduling)](https://link.springer.com/article/10.1007/s10951-022-00740-y) — the winning multi-neighborhood SA approach.
- [CSPLib prob026 — Sports Tournament Scheduling](https://www.csplib.org/Problems/prob026/) — formal RR problem (teams/weeks/periods/slots) + core constraints.
- [Round robin scheduling: a survey (Rasmussen & Trick, CMU)](https://mat.tepper.cmu.edu/trick/survey.pdf) — schedule-then-break, decomposition, break/carry-over.
- [Integrated break and carryover effect minimization (Journal of Scheduling)](https://link.springer.com/article/10.1007/s10951-022-00744-8) — fairness objectives (breaks, carry-over).
- [A Pragmatic Approach for Solving the Sports Scheduling Problem (PATAT 2022)](https://www.patatconference.org/patat2022/proceedings/PATAT_2022_paper_21.pdf) — CP-SAT + SA: hard-as-soft warm start, then harden.
- [FET Manual (timetabling.de)](https://www.timetabling.de/manual/FET-manual.en.html) — time/space, compulsory/preferred constraints, 0–100% weight model.
- [Greedy constructive heuristic + local search for rostering/timetabling (ResearchGate)](https://www.researchgate.net/publication/252027282_Greedy_constructive_heuristic_and_local_search_algorithm_for_solving_Nurse_Rostering_Problems) — construct-then-improve pattern.
- [Celery background tasks + progress (update_state PROGRESS) patterns](https://khairi-brahmi.medium.com/mastering-celery-a-guide-to-background-tasks-workers-and-parallel-processing-in-python-eea575928c52) — async job + polling/progress.
</content>
</invoke>
