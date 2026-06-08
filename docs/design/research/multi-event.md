# Multi-Sport / Multi-Category Event Scheduling — Research Briefing

Status: research input for the constraint-engine restructuring (2026-06-08).
Scope: how real multi-event meets (athletics, table tennis singles/doubles,
badminton, sepak takraw) are scheduled, and what that implies for a **single
engine that spans team + individual sports**. Grounded in the spec
`docs/superpowers/specs/2026-06-08-tournament-flow-and-constraint-engine.md`,
`docs/ARCHITECTURE.md` / `CLAUDE.md`, and the actual code in
`apps/fixtures/services/*`, `apps/tournaments/services/rules.py`.

The end of this doc has the **Recommended-for-our-engine** synthesis. The middle
is a concrete, citeable catalog of patterns and constraints we can implement.

---

## 0. TL;DR for the engine designers

1. **A multi-event meet is N independent "draws" sharing a pool of resources and
   a pool of participants.** Each category (Boys U16 100m, Men's TT Singles,
   Women's Regu, Mixed Doubles) is its own bracket/round-robin/heats structure.
   The hard cross-category coupling is only two things:
   - a **resource is shared** (a court/ground/track-lane/table can host one
     activity at a time, across all categories), and
   - a **participant is shared** (an athlete entered in 100m + long jump, or a
     player entered in singles + doubles, cannot be in two places at once).
   This maps cleanly onto FET's model (activities + resources) and onto the
   CP-SAT model (optional intervals + `AddNoOverlap` per resource and per
   participant). It also maps onto our existing two-phase generator:
   `generate.py` (pairing/structure) then **assignment** (date/slot/venue).

2. **Two-phase decomposition is the dominant real-world pattern.** Sports-
   scheduling literature decomposes timetabling into (a) *who plays whom in which
   abstract round* and (b) *which concrete slot/venue/home-away*. Our codebase
   already does phase (a) in `apps/fixtures/services/generate.py`. Phase (b) — the
   declarative constraint **assignment** — is exactly what the spec §3.C calls for
   and is the part to build.

3. **Individual sports add three structural concepts** beyond our current
   team-vs-team `Match` model: **heats/rounds with advancement-by-rank** (top-N
   times across heats → next round), **field-event qualifying-then-final**, and
   **combined events** (decathlon/heptathlon — one athlete in many sub-events with
   prescribed gaps). These are *structures*, not new constraint types; the
   constraint catalog stays unified.

4. **The unifying abstraction** is: every category produces **competition units**
   (a match, a heat, a field-event flight, a regu tie) that each (i) consume a
   **resource** for a **duration**, (ii) involve a set of **participants**, and
   (iii) may depend on the result of earlier units (advancement pointers, already
   in our model as `home_source`/`away_source`). Schedule = assign each unit a
   (date, slot, venue). Every constraint in the spec is a predicate over that
   assignment plus unit metadata.

---

## 1. How real multi-event meets are actually scheduled

### 1.1 Athletics (track & field) — the canonical multi-event meet

A championship athletics meet is the richest multi-event case. Sources: World
Athletics "Competition Timetable — General Principles and Guidelines", and US
high-school/NCAA championship regulations.

**Structure per event:**
- **Track events** run in **rounds**: First Round (heats) → Semi-Finals →
  Final. The number of rounds is fixed *by event and by total entries*:
  - Three rounds: 100/200/400/800/1500m, 100/110/400m Hurdles.
  - Two rounds: 5000m, 3000m SC, relays.
  - Straight final: 10,000m.
- **Advancement is by rank across heats**, not by bracket: "Q" = top-N place per
  heat advance automatically; "q" = next fastest *times across all heats* fill
  the remaining lanes. This is fundamentally different from knockout (where a
  named winner advances) — the *whole field is re-ranked* and the top K go on.
- **Field events** (jumps/throws) use **Qualifying round → Final** (no semis).
  Within a round, athletes take multiple **trials/attempts** in **flights**; the
  best-8 after 3 attempts advance to 3 more attempts. (A "flight" = a sub-group of
  the field competing in a rotation; multiple flights share one apparatus.)
- **Combined events** (decathlon = 10 events over 2 days; heptathlon = 7): a
  single athlete competes in *many* sub-events in a prescribed order with
  prescribed minimum gaps ("not less than 30 minutes between the finish of one
  event and the start of the next for any athlete").

**Concrete numeric rest/recovery rules (World Athletics timetable principles):**
- "At least **two rest days** between the first round and the final" for 5000m,
  3000m SC.
- "Normally **at least one rest day** between the Semi-Finals / Qualification and
  the Finals" for 400m, 400mH, 800m, 1500m, HJ, PV, TJ, javelin, hammer.
- "100m Semi-Finals and Finals … in the same session, but with **at least a
  90-minute interval**."
- "200m Finals … the following day of the semi-finals."
- Session caps: evening session ≈ 2.5h (≤3h); "**only two Field Event Finals per
  evening session** (one jump + one throw)."

**Cross-event athlete coupling ("doubling"):** the timetable explicitly designs
for **traditional doubling possibilities** (an athlete realistically does
100/200/4x100, or 800/1500, or 5000/10000). The scheduler must keep those event
pairs from colliding for the *same athlete* AND give recovery between them. Where
a clash is unavoidable, real meets fall back on operational rules: an athlete
"may check out of the field event no sooner than **5 minutes before** the start of
their (track) race"; coaches pre-flag conflicts on the heat sheet and prioritise.

**Heat seeding/distribution:** to make heats fair, entries are distributed so
strong athletes (and athletes from the same club/unit) are spread across heats —
e.g. **serpentine ("snake") seeding** by performance, and a "diagonal line pass"
distribution that keeps same-unit / similar-ability athletes out of the same
heat. (Research: GA + diagonal-pass methods for automated heat arrangement.)

### 1.2 Racket sports — table tennis & badminton (singles/doubles/mixed)

These are the canonical "**one person, many categories, shared courts**" case.

- A meet runs **several events in parallel**: MS, WS, MD, WD, XD, plus age groups
  (U13/U15/U17/Open) and ability tiers. Each event is its **own draw** — usually
  **group stage (round-robin pools) → knockout**, or straight knockout.
- **Draw construction (BWF General Competition Regulations / ISF / USAB):**
  - Seeds: top-ranked entry = seed 1, etc.; **2 seeds if < 16 entries**, then 4,
    8, 16 as the draw grows; seeds placed at fixed positions (1 top, 2 bottom,
    3/4 split into quarters, …).
  - **Byes**: when the field is not a power of two, byes fill the first round and
    are placed adjacent to seeds (Tables/Diagrams 1–5 in BWF). Our
    `generate_single_elimination` currently *requires* a power-of-two — see Gap §6.
  - **Separation**: "Players/Pairs from the **same country** (read: same
    institution for us) … do not meet each other in early rounds." This is the
    spec's "same-organization teams cannot meet in the opening round" constraint,
    generalised — and it is a *draw-construction* constraint, not a scheduling
    one.
- **Scheduling across events** (commercial software — Brakto, STADIUM,
  Tournament Planner): players entered in multiple events get **smart scheduling
  that prevents conflicts** plus **minimum rest between a player's matches**, while
  **multiple events run simultaneously** sharing a court pool. The scheduler also
  honours "a match can't start until both feeder matches are done" (knockout
  dependency) and court availability windows.
- **Court allocation** is the shared-resource problem: one match per court per
  time, optimise court utilisation, keep a player's matches spaced. Commercial
  "smart court allocation" = exactly `AddNoOverlap` per court + per player.

### 1.3 Sepak takraw — team sport with nested sub-matches + categories

Useful because it shows **categories** and a **team event made of sub-units**:
- Categories: **Regu** (3 players), **Doubles** (2), **Quad** (4), **Team Regu**,
  with men's/women's and (for Quad) **mixed** divisions. So a single meet already
  has ≥5 category × gender combinations — a multi-category meet by itself.
- **Team Regu is a tie made of three sequential regu matches** ("three back-to-
  back matches, different players for each regu; best of three regus wins the
  tie"). This is structurally like a tennis Davis-Cup tie or a chess board-match:
  **one fixture = several sub-matches that must be scheduled together / in order**
  on the same court. Maps to FET's "activities grouped / consecutive / same room".
- Format: group stage (round-robin pools, ranked by match-wins → set-points →
  point-difference) → knockout. Court = 13.4×6.1m (badminton-sized) — i.e.
  a venue can be **re-used across racket + takraw** categories: cross-sport
  resource sharing is real.

### 1.4 Common shape across all four

| Concept | Athletics | TT / Badminton | Sepak Takraw | Team sports (football, current) |
|---|---|---|---|---|
| Category | event × gender × age | event(MS/WS/MD…) × age | Regu/Doubles/Quad × gender | the tournament |
| Structure | heats→semis→final / qual→final | pools→KO or KO | pools→KO | RR / KO / groups→KO |
| Advancement | by **rank across heats** (Q/q) | named winner (KO) / standings | standings / winner | winner_of / group_position |
| Competition unit | heat, flight, final | match | regu (sub of a tie) | match |
| Shared resource | track, lanes, runway, throw circle | court | court | ground |
| Shared participant | athlete (multi-event) | player (multi-event) | player (multi-category) | (team only) |
| Rest rule | min mins/days between rounds | min mins between matches | within-tie ordering | min rest, max/day |

The right-hand column is what we have today; the left three columns are the
generalisation we need. **Nothing here breaks the model — it extends it.**

---

## 2. The unifying data model (what a "single engine" needs)

This generalises the current `Match`-centric model into a small set of entities.
Names chosen to fit the spec's locked decisions (Institution → Team → Player) and
existing code.

### 2.1 Core scheduling objects

- **Category** (new): a sub-competition with its own structure. Fields:
  `sport`, `event` (e.g. "100m", "Singles", "Regu"), `gender`, `age_group`,
  `participant_kind` (individual | pair | team), `format`
  (rr | single_elim | double_elim | groups_knockout | swiss | heats_final |
  qualifying_final | combined_event), plus `Sport`-config (slot length,
  participants-per-unit, scoring model — already anticipated in spec Decision 2).
  A tournament has **many Categories**; today there is effectively one implicit
  category (the whole tournament).

- **Entry / Participant** (generalises Team): the competing unit *within a
  category* — a Team (football), a single Player, a Pair, or a takraw Regu lineup.
  An **athlete/player can have many Entries across categories** (this is the
  multi-event coupling). Keep the spec's `Institution → Team → Player`; an
  individual Entry is `(category, player[, partner])`; carry `institution_id` so
  the same-institution separation/clash constraints work uniformly.

- **CompetitionUnit** (generalises `Match`): one schedulable thing that consumes a
  resource for a duration and involves participants. Subtypes:
  - **match** (2 sides) — today's `Match`, unchanged.
  - **heat** (k lanes/competitors, advancement by rank).
  - **flight** (field-event sub-group sharing an apparatus).
  - **tie** with ordered **sub-units** (Team Regu, Davis-Cup style).
  Reuse the existing typed dependency pointers (`home_source`/`away_source`,
  invariant #9) and **add a rank-based pointer** for heats:
  `{"type": "rank_in", "round": "heat", "category_id": …, "rank": 1..N}` and
  `{"type": "fastest_losers", "round": "heat", "count": k}` — the heats analogue
  of `winner_of`. `advance.py` gets a sibling resolver for rank/time advancement.

- **Resource** (new, first-class): venue / court / ground / **track** / **lane** /
  **runway** / **throw-circle** / **table**, with availability windows and a
  `capacity` (a track hosts 1 race but ~8 lanes; model as `NoOverlap` on the track
  + a per-race lane assignment, or `Cumulative` capacity = lanes). Resources carry
  which `sports`/`categories` they support (spec §3.A.4).

- **TimeSlot / Session**: a session is a contiguous window on a day (morning/
  evening, ≈2.5–3h cap from World Athletics). Slots inside it have length =
  unit duration + buffer (spec §3.A.3).

### 2.2 The schedule = an assignment

`schedule(unit) -> (date, start_time, resource[, lane/flight])`. Phase 1
(structure) builds units + dependency pointers; **Phase 2 (assignment)** is the
constraint solve. This is exactly the spec §3.C two-phase design and matches the
literature's "schedule-then-assign" decomposition.

---

## 3. Constraint & pattern catalog (implementable)

Each entry below is written to drop into the declarative catalog in
`apps/fixtures/services/constraints.py` (today it has 5 types:
`no_double_booking_team`, `min_rest_minutes`, `venue_single_use`,
`preferred_window`, `avoid_back_to_back`). Format mirrors the existing
`{type, scope, hard, weight, params}` record. **R** = resource constraint,
**P** = participant constraint, **S** = structural/draw constraint,
**T** = temporal/fairness. FET / CP-SAT analog cited so the CP-SAT backend
(Decision 3) is a mechanical translation.

### 3.1 Hard constraints (must hold)

| type | category | params | meaning | FET analog | CP-SAT analog |
|---|---|---|---|---|---|
| `resource_single_use` | R | `{resource_kinds:[…]}` | one unit per resource (court/track/table) per overlapping time | "Activities not overlapping" (room) | `AddNoOverlap` over each resource's intervals (optional intervals if resource is a choice) |
| `resource_capacity` | R | `{resource, capacity}` | ≤ C concurrent units on a shared resource (lanes on a track; courts on a campus) | room capacity | `AddCumulative(intervals, demands=1, capacity=C)` |
| `resource_availability` | R | `{resource, windows:[{day,from,to}]}` | unit only in resource's open windows | "Room not available" | bound interval start to allowed windows / forbidden assumption |
| `resource_supports_category` | R | `{resource, categories:[…]}` | category only on compatible resource (e.g. throws need a circle) | "Subject preferred room(s)" | restrict the optional-interval set to allowed resources |
| `participant_no_clash` | P | `{participant_kinds:[athlete,player,team]}` | a participant can't be in two units at once — **the multi-event core** | "Activities not overlapping" (students set) | `AddNoOverlap` over every participant's intervals **across all categories** |
| `min_rest_minutes` | P/T | `{minutes}` *(have it)* | ≥ N minutes between a participant's consecutive units | "Min resting hours" / "Min gaps between activities" | gap: `end[a] + N ≤ start[b]` (disjunctive over order) |
| `min_rest_days_between_rounds` | T | `{event/category, days}` | ≥ D rest **days** between named rounds (athletics: 1–2 days qual→final) | "Min days between a set of activities" | `day[final] - day[qual] ≥ D` |
| `max_units_per_day` | P/T | `{n, per:[participant\|team\|all]}` | rest cap; athletics "≤2 field finals/evening" is the resource form | "Max hours/activities daily" | per-day count ≤ n via reified booleans |
| `same_attribute_separation` | S | `{attribute:institution, until_round}` | same-institution / same-club entries kept apart **until round R** (spec's headline rule; BWF "same-country separation") | n/a (draw rule) | draw-time placement OR pairwise: forbid the pairing before round R |
| `blackout` | P/T | `{participant\|resource, windows}` | hard unavailability (a team's blackout, a venue closed) | "…not available" | remove those slots from the domain |
| `unit_ordering` | S/T | `{before, after, min_gap}` | one unit precedes another (sub-units of a tie; qual before final) | "Two activities ordered" | `end[before] + gap ≤ start[after]` |
| `units_grouped_same_resource` | S | `{unit_set}` | sub-units of a tie scheduled together on the same court (Team Regu) | "Activities grouped" + "same room if consecutive" | shared resource + tight start windows |
| `dependency_ready` | S | derived from `*_source` | a unit can't start until its feeder units are decided (KO / heats Q-q) | n/a | precedence on resolved-result event |
| `session_cap` | R/T | `{session, max_minutes, max_finals}` | session length ≤ cap; ≤K finals per session | "Max span per day" | sum of durations in session ≤ cap |

### 3.2 Soft constraints (optimize / warn)

| type | category | params | objective | CP-SAT analog |
|---|---|---|---|---|
| `even_spacing` | T | `{per:[participant\|team]}` | spread each participant's units across the date range | minimise variance / penalise tight gaps |
| `avoid_back_to_back` | T | `{}` *(have it)* | discourage consecutive-slot units for one participant | penalty var when `gap < threshold` |
| `prefer_window` | T | `{days,from,to}` *(have `preferred_window`)* | prime-time for finals/marquee; morning heats | penalty for out-of-window start |
| `balance_resource_use` | R | `{}` | even matches across courts/grounds (PSL fairness: avoid one venue hosting most games) | minimise max-min load (carry-over-effect literature) |
| `minimize_breaks` | T | `{}` | minimise idle gaps in a participant's day (sports-sched "minimize breaks") | count + penalise breaks |
| `balance_rest_days` | T | `{}` | fairness: equalise rest-day distribution across entries (burnout paper's core metric) | minimise pairwise rest-day difference |
| `minimize_span` | T | `{}` | shortest overall tournament / day | minimise makespan |
| `minimize_travel` | R | `{}` | reduce venue→venue movement between a team's units | sum of inter-unit travel costs |
| `seed_protection` | S | `{}` | seeds/byes placed per regs; strong entries spread across heats (serpentine) | draw-time placement |
| `home_away_balance` | T | `{max_consecutive}` | for league play: cap consecutive home/away, minimise breaks | classic break-minimisation constraints |

### 3.3 Draw / structure patterns (Phase 1, not the scheduler)

These shape **who-plays-whom**; they belong with `generate.py`, fed by the wizard.

- **Round-robin / pools**: circle method (already in `generate.py::_round_robin`),
  grouped into pools of size G. Temporally-constrained RR needs `r·(n−1)` slots.
- **Single/double elimination**: power-of-two with `winner_of`/`loser_of` pointers
  (have it) — **needs bye support for non-power-of-2** (Gap §6).
- **Groups → knockout**: top-N per group cross-seeded (have it,
  `generate_knockout_from_groups`).
- **Heats → semis → final** (NEW for individual): build K heats by serpentine
  seeding; advancement = `rank_in`/`fastest_losers` pointers re-ranking the field.
- **Qualifying → final** (NEW, field events): one qual round, top-N by mark/best
  advance; flights share apparatus.
- **Combined events** (NEW): one Entry, an ordered list of sub-event units with
  `unit_ordering` + `min_rest_minutes` between them, scored by points table.
- **Swiss / ladder** (future): pairing depends on running standings — generate one
  round at a time (different from the all-at-once generators).
- **Seeding/byes**: seeds at fixed positions; byes adjacent to seeds when field is
  not 2^k; same-institution separation applied at draw time.

---

## 4. Solver mapping (heuristic now, CP-SAT later — spec Decision 3)

The catalog above is **backend-agnostic** (spec invariant: solver-swappable).

### 4.1 Heuristic backend (ship first — inline, explainable, instant preview)
- **Construct**: order units by criticality (finals last, byes first, most-
  constrained-first), greedily assign earliest feasible (date, slot, resource)
  honouring all **hard** constraints; resolve dependency order first.
- **Repair / local search**: hill-climb / simulated-annealing swaps to reduce soft
  penalty; report unsatisfiable hard constraints with the offending units.
- Good fit for the wizard's "instant preview"; matches GA/heuristic approaches in
  athletics-meet literature and commercial racket-sport schedulers.

### 4.2 CP-SAT backend (OR-Tools, async job — the "Optimize" engine)
Direct translation table (OR-Tools `cp_model`):
- One **interval var** per (unit, candidate resource) — `new_optional_interval_var`
  with a presence Bool selecting the resource (alternative-resource pattern).
- **`AddExactlyOne`** over a unit's resource-presence Bools (it lands on exactly
  one resource).
- **`AddNoOverlap`** over each **resource's** interval set ⇒ `resource_single_use`.
- **`AddNoOverlap`** over each **participant's** interval set (all categories) ⇒
  `participant_no_clash` — the multi-event guarantee.
- **`AddCumulative(intervals, demands, capacity)`** ⇒ `resource_capacity`,
  `session_cap`, "≤2 field finals per session", "max courts at a campus".
- **Gap/precedence**: `end[a] + minutes ≤ start[b]` (with a disjunctive order Bool
  for unordered pairs) ⇒ `min_rest_minutes`, `unit_ordering`, `dependency_ready`,
  `min_rest_days_between_rounds` (on the day variable).
- **Domain restriction** ⇒ `resource_availability`, `blackout`,
  `resource_supports_category`.
- **Objective** = weighted sum of soft-constraint penalty vars ⇒ §3.2.
- Runs as an **async job** (Decision 3: Celery vs Channels/Redis worker) with
  progress; OR-Tools `cp314` wheel is confirmed installable.

CP-SAT note from OR-Tools docs: an optional interval must be **distinct per
resource** (don't reuse one interval across two resources, or it counts as present
in both) — important for the per-resource `NoOverlap` pattern.

---

## 5. The fixture-generation wizard (multi-event additions)

Extends the spec §3.A interview. Per **Category** (the wizard loops over chosen
sport+events), collect:
1. **Category definition**: sport, event(s), gender, age group(s),
   participant-kind, expected entries → drives format suggestion + #rounds (cf.
   World Athletics "#rounds by entries").
2. **Structure**: format (RR/KO/groups-KO/heats-final/qual-final/combined),
   heat size / lanes, advancement rule (top-N place + fastest-losers count),
   seeds count, bye handling.
3. **Calendar**: shared with other categories — date range, rest days,
   per-event min rest-days between rounds (athletics defaults: 1 day qual→final;
   90 min for 100m semi→final).
4. **Timing**: session windows (≈2.5–3h cap), slot length per category (TT match
   vs a 100m heat vs a long-jump flight differ widely), buffers.
5. **Resources**: which courts/tracks/circles support which categories;
   availability; capacity (lanes); cross-sport sharing.
6. **Cross-category coupling**: enable `participant_no_clash` + `min_rest_minutes`
   globally; declare "doubling" event pairs to actively spread (athletics).
7. **Separation / fairness**: same-institution separation until round R; seed
   spreading across heats (serpentine); soft balancing (venues, rest days, span).

The wizard writes a **single declarative model** (categories + units + resources +
constraint records) that the chosen backend solves — no format is hardcoded
(spec §3 principle; consistent with FET's "catalog + solver, not a fixed
algorithm").

---

## 6. Gaps vs current code (what to build, citing real symbols)

- `apps/fixtures/services/constraints.py::CONSTRAINT_TYPES` has **5 types**; the
  catalog needs the ~13 hard + ~10 soft above, generalised from `team` to a
  **participant/resource** abstraction so individual sports work. `scope` field
  already exists — extend it to carry `category_id`, attribute selectors.
- `validate_constraints` validates *shape* only; the spec's `validate_schedule` /
  `score_schedule` (the actual enforcement/solve) is the new work — build it
  behind a **solver interface** (heuristic first, CP-SAT later).
- `generate.py::generate_single_elimination` **requires power-of-2** (`raise
  ValueError`); real draws need **byes** (BWF tables) — add bye placement.
- `generate.py` is **team-only** (`Team.objects.filter(...REGISTERED)`); add
  **Category** + **Entry** (individual/pair/regu) and the **heats/qual-final/
  combined** structure generators.
- `advance.py::advance_from_match` resolves only `winner_of`/`loser_of`; add a
  **rank/time resolver** for `rank_in` / `fastest_losers` (heats → next round).
- `tournaments/services/rules.py::DEFAULT_RULES` is football-shaped (halves,
  goals); make rules **per-Category / per-Sport** (slot length, scoring model,
  participants-per-unit) — spec Decision 2.
- No **Resource** model with availability/capacity yet — needed for the assignment
  phase (courts/tracks/lanes). Venue is currently implicit.
- The two-phase split (structure vs assignment) is implicit; make **assignment**
  an explicit service consuming the declarative model.

These build *on* the existing seams (typed dependency pointers, `inputs_hash` /
`last_manual_edit_at` regen UX, the rule-freeze gate, the JSONB constraints list)
— none of the architectural invariants in `CLAUDE.md` are violated.

---

## 7. Recommended for our engine

1. **Adopt the two-layer model now**: (Phase 1) **structure generators** per
   Category → competition units + dependency pointers; (Phase 2) a single
   **declarative assignment solver** behind an interface. This is the dominant
   real-world decomposition and matches the spec and our existing `generate.py`.

2. **Generalise the constraint record from `team` to `participant` + `resource`.**
   The *only* things coupling categories are shared resources and shared
   participants — both expressible as **`NoOverlap` per resource** and
   **`NoOverlap` per participant**. Implement these two as the load-bearing hard
   constraints; everything else (rest, caps, windows, separation, balance) layers
   on. This single change makes the engine span team + individual sports.

3. **Model resources as first-class with availability + capacity** (court/track/
   table/lane/circle), each tagged with supported categories. Capacity (`Cumulative`)
   handles lanes-per-track and courts-per-campus uniformly.

4. **Add the three individual-sport structures**: heats→semis→final (rank-based
   advancement via new `rank_in`/`fastest_losers` pointers + a resolver beside
   `advance.py`), qualifying→final with flights, and combined events (ordered
   sub-units with gaps). Keep them as *structures*; the constraint catalog stays
   unified.

5. **Bake in the athletics numeric defaults** as wizard presets (90-min semi→
   final, ≥1 rest day qual→final, ≥2 days for distance, ≤2 field finals/session,
   2.5–3h session cap, ≥30-min between combined-event sub-events). They are the
   most concrete, authoritative rest rules we found and double as sensible
   cross-sport defaults.

6. **Same-institution separation is a *draw-time* constraint** (place entries),
   not (only) a scheduling one — apply it in Phase 1 seeding/bye placement, with a
   scheduling-time fallback that forbids the pairing before round R. This is the
   spec's headline example, and it is exactly BWF same-country separation.

7. **Ship the heuristic backend first** (most-constrained-first construct +
   local-search repair; inline, explainable, instant wizard preview), with the
   **CP-SAT backend as a drop-in async "Optimize"** using the translation table in
   §4.2. The catalog is authored once and consumed by both.

8. **Explainability is a requirement, not a nice-to-have** (spec §3.C): both
   backends must report satisfied/violated soft constraints and the offending
   units, reusing the `inputs_hash` / `last_manual_edit_at` regen UX for manual
   edits.

---

## Sources

- World Athletics — Competition Timetable: General Principles and Guidelines (PDF;
  numeric rest/round rules, session caps, doubling): https://worldathletics.org/about-iaaf/documents/technical-information
- World Athletics Book of Rules (Technical Rules C2.1 — field-event flights,
  combined events, clerk procedures): https://worldathletics.org/about-iaaf/documents/book-of-rules
- "Towards Prevention of Sportsmen Burnout: Formal Analysis of Sub-Optimal
  Tournament Scheduling" (formal RR/break/rest-day/carry-over constraints):
  https://arxiv.org/pdf/2106.09627
- OR-Tools CP-SAT scheduling docs (interval vars, NoOverlap, NoOverlap2D,
  Cumulative, optional/alternative resources): https://github.com/google/or-tools/blob/stable/ortools/sat/docs/scheduling.md
- OR-Tools CP-SAT primer — advanced modelling (reservoir, optional intervals,
  resource assignment): https://d-krupke.github.io/cpsat-primer/04B_advanced_modelling.html
- FET — Free Timetabling Software, constraint reference (time + space constraints,
  not-overlapping, min/max days/gaps, preferred rooms/times, grouped/ordered):
  https://www.timetabling.de/manual/FET-manual.en.html and https://lalescu.ro/liviu/fet/
- BWF General Competition Regulations (seeding, byes, same-country separation):
  https://system.bwfbadminton.com/documents/folder_1_81/Statutes/CHAPTER-5---TECHNICAL-REGULATIONS/Section%205.1%20-%20General%20Competitions%20Regulations.pdf
- BWF Technical Diagrams and Tables — Seeding and Byes:
  https://www.badmintonpanam.org/wp-content/uploads/2018/04/3.3.8-Technical-Diagrams-and-Tables-Seeding-and-Byes.compressed.pdf
- ISF Badminton Technical Rules (school multi-event singles/doubles/mixed):
  https://www.isfsports.org/sites/default/files/documents/2024-05/BADMINTON%202024%20-%20ISF%20Technical%20Rules%20and%20Regulations.pdf
- Sepak takraw — categories (Regu/Doubles/Quad/Team), team-tie structure, scoring,
  court dims: https://en.wikipedia.org/wiki/Sepak_takraw and
  https://www.activesgcircle.gov.sg/learn/sepak-takraw/rules-and-regulations-of-sepak-takraw
- Athletics heats/semis/finals advancement (Q/q, serpentine seeding, multi-event
  conflicts): https://www.coachxpro.com/blog/heats-vs-semis-vs-finals-track and
  https://www.ghsa.net/track-field-advancement-and-seeding and
  OHSAA Track & Field Tournament Regulations: https://ohsaaweb.blob.core.windows.net/files/Sports/Track-Field/TFTournamentRegulations.pdf
- Sports-scheduling literature (two-phase decompose, breaks, carry-over, fairness):
  "A Schedule-Then-Break Approach to Sports Timetabling" https://link.springer.com/content/pdf/10.1007/3-540-44629-X_15.pdf ;
  "Fairness trade-offs in sports timetabling" https://www.researchgate.net/publication/345808233_Fairness_trade-offs_in_sports_timetabling
- AI/GA for athletics-meet scheduling (heat arrangement, diagonal-pass fairness):
  https://valeofyork.org/2026/03/21/using-artificial-intelligence-to-schedule-athletics-meets/ and
  "Sport Tournament Automated Scheduling System" https://www.researchgate.net/publication/323362146_Sport_Tournament_Automated_Scheduling_System
- Commercial multi-event racket schedulers (per-player conflict avoidance, court
  allocation, simultaneous events): https://www.brakto.com/badminton-tournament-software ,
  https://stadiumcompete.com/for/badminton-tournaments ,
  https://mobisoftinfotech.com/resources/blog/smart-court-allocation-systems-tournament-scheduling
