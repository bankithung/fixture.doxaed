# Real-World Sports Tournament Scheduling — Constraints & Formats (Research Briefing)

Status: research catalog (2026-06-08). Input for the Fixture flexible constraint engine
(spec `docs/superpowers/specs/2026-06-08-tournament-flow-and-constraint-engine.md`,
Stage 4 fixture-generation wizard). This file is a **catalog**, not a design — it enumerates the
formats and constraints we must be able to express, grounded in academic taxonomies (RobinX,
Ribeiro's survey), FET's constraint model, and operational sports-scheduling practice, then maps
each to what our engine should support and how it builds on existing code.

Existing code this builds on:
- `apps/fixtures/services/constraints.py` — `CONSTRAINT_TYPES` catalog (5 types today) + `validate_constraints` shape validator. This is the seam to generalize.
- `apps/fixtures/services/generate.py` — `_round_robin` (circle method), `generate_round_robin` (grouped), `generate_single_elimination` (power-of-2, `winner_of` pointers), `generate_knockout_from_groups` (top-N, cross-seed).
- `apps/fixtures/services/advance.py` — `advance_from_match` resolves typed `home_source`/`away_source` pointers (`winner_of`/`loser_of`).
- `apps/tournaments/services/rules.py` — `DEFAULT_RULES`, `merge_rules`, `tiebreakers`, freeze gate.

---

## 0. Two layers of the problem (the mental model)

Real tournament scheduling decomposes into two distinct sub-problems. Our engine should keep them
separate (the spec §3.C already calls this out: "phase 1 = pairing generation, phase 2 = assignment").

1. **The pairing / format problem ("who plays whom, in what round/leg")** — determined almost
   entirely by the *format* (round-robin, knockout, Swiss, groups). Output: an ordered set of
   pairings each tagged with a round/leg and a home/away orientation, plus dependency pointers for
   later rounds. This is combinatorial structure, mostly deterministic given the format + seeding +
   draw. `generate.py` already does this for 3 formats.

2. **The timetabling / assignment problem ("when and where each pairing happens")** — assign each
   pairing a (date, time-slot, venue). This is the genuinely hard, constraint-heavy part: resources
   (teams, venues, officials) cannot collide, rest/spacing/availability must hold, soft preferences
   are optimized. This is what FET solves for schools and is currently **not implemented** — it is
   the new work. The constraint catalog in §3 is mostly about *this* layer.

Some constraints span both layers (e.g. "same-school teams apart until round R" constrains pairing;
"no team plays twice on the same day" constrains assignment). The engine model in §4 keeps every
constraint a declarative record so it does not matter which phase consumes it.

---

## 1. Tournament FORMATS catalog

Each format is a *pairing generator*. For each: definition, math (match count, rounds), seeding/draw
mechanics, byes, variants, and the real-world edge cases an engine must handle.

### 1.1 Round-robin (all-play-all)

- **Single round-robin (SRR):** every pair meets once. With `n` teams: `n*(n-1)/2` matches over
  `n-1` rounds (`n` even) or `n` rounds (`n` odd, one bye per round). Each round has `floor(n/2)`
  matches. This is `_round_robin` today via the **circle method**.
- **Double round-robin (DRR):** every pair meets twice, once home + once away (`n*(n-1)` matches,
  `2(n-1)` rounds). The standard league format (most football leagues). The second half ("return
  leg" / "second leg") usually mirrors the first with home/away flipped.
- **Triple / quadruple round-robin:** small leagues (e.g. some hockey/ice leagues) where teams meet
  3–4 times; orientation pattern (HAH / HHA) becomes a design choice.
- **Circle (polygon) method:** fix one team, rotate the rest; produces a valid SRR. Caveat from the
  literature: **the circle method produces the MAXIMUM carry-over effect** — it is structurally
  unfair if carry-over fairness matters (see §3.5). Fine as a default; flag it as a known limitation.
- **Berger tables:** the canonical published SRR tables (chess/FIDE) — an alternative deterministic
  ordering to the naive circle method, with better-known break/orientation properties.
- **Edge cases & options:**
  - Odd `n` → exactly one **bye** per round (the rotated-out team). Our `_round_robin` already
    inserts a `None` placeholder. Bye distribution should be roughly even per team.
  - **First-/last-round constraints:** marquee opener, fixed final-round derbies.
  - **Mirrored vs non-mirrored DRR:** mirrored = second half repeats first-half ordering; French/
    English variants reorder to spread repeats.
  - **Partial round-robin / incomplete RR:** too many teams to play everyone — each team plays a
    fixed `k < n-1` opponents (balanced incomplete block design). Used in large leagues (NFL: 17
    games among 32 teams). Needs an opponent-selection sub-problem.

### 1.2 Knockout / single-elimination

- **Definition:** lose once → eliminated. With `n = 2^k` teams: `n-1` matches, `k` rounds
  (R32→R16→QF→SF→F). `generate_single_elimination` handles power-of-2 with `winner_of` pointers.
- **Byes for non-power-of-2:** number of byes = `next_pow2(n) - n`. Byes go to the **highest seeds**
  (reward for ranking) and must be **distributed across the bracket**, never clustered. Example:
  13 teams → 16-slot bracket → 3 byes to seeds 1–3; 23 teams → 32 slots → 9 byes.
  - This is a **gap in current code** — `generate_single_elimination` *requires* power-of-2 and
    raises otherwise. Real tournaments rarely have power-of-2 counts. Needs a "preliminary round"
    (a.k.a. "play-in" / "wild-card round") for the non-byed teams, then a clean bracket.
- **Seeding patterns:** the standard "bracket seeding" places seed 1 vs seed `n`, seed 2 vs `n-1`,
  with 1 and 2 in opposite halves, 1/2/3/4 in separate quadrants (meet only in SF), etc. This is the
  recursive `1 vs 2^k - 1+...` slotting (the "standard seeding" or "snake" placement). Variants:
  - **Random draw** (no seeding) — pure luck.
  - **Pot/seeded draw** — top seeds protected, rest drawn (tennis Grand Slams, FA Cup later rounds).
  - **Regional/geographic protection** — keep same-region competitors apart early (NCAA "S-curve").
- **Consolation / classification rounds:**
  - **Third-place playoff (bronze final):** the two SF losers play for 3rd. Common in football/
    Olympics. A single extra match with `loser_of(SF1)` vs `loser_of(SF2)` pointers — the
    `loser_of` pointer already exists in `advance.py`.
  - **Full consolation bracket / "back-draw":** every first-round loser enters a parallel losers'
    bracket so everyone gets ≥2 games (common in junior/club events, wrestling). Determines full
    placement 1..n.
  - **Plate / Bowl / Shield:** secondary trophy brackets for early losers (rugby sevens, school
    fests). Generalizes the consolation idea into named sub-tournaments.
- **Single-leg vs two-leg ties:** knockout "ties" can be one match or **home-and-away two legs**
  with aggregate score (UEFA), needing away-goals or aggregate tiebreak rules. Engine must support a
  knockout "tie" being 1 or 2 matches.

### 1.3 Double-elimination

- **Definition:** eliminated after **two** losses. A **winners' bracket (WB)** + a **losers'
  bracket (LB)**; the WB final winner meets the LB winner in a **grand final**, which may need a
  **bracket reset** (if the LB team wins the first grand-final match, a decider is played, because
  the WB team then has only one loss). Common in esports, fighting games, wrestling, some softball.
- **Byes:** only in the WB (same rule as single-elim); the LB structure flexes dynamically.
- **Advantage:** determines 1st–4th (and beyond) without needing a separate consolation match —
  losers drop down rather than out.
- **Pointers needed:** richer than today — LB slots are `loser_of(WB match)` *and* `winner_of(LB
  match)`. The `loser_of` type exists; the wiring (which WB loser feeds which LB slot, "drop
  patterns" to avoid quick rematches) is the new structural logic.

### 1.4 Groups → knockout (the FIFA / multi-stage model)

- **Definition:** divide teams into `g` groups, play a round-robin (single or double) inside each,
  then the top `m` per group advance to a knockout bracket. `generate_knockout_from_groups` does
  top-N + cross-seed today.
- **Qualification rules:** top-2 standard; sometimes "best third-placed teams across groups" also
  advance (2026 World Cup: 12 groups, top 2 + best 8 thirds → Round of 32). This needs a
  **cross-group ranking** of same-position finishers — more than current top-N-per-group.
- **Cross-seeding / bracket mapping:** winners drawn against runners-up of *other* groups; specific
  group-to-bracket-slot maps are usually fixed in advance to keep same-group teams apart until late.
  Current code cross-seeds winner(i) vs runner-up(i+1) — a reasonable default but real events use
  published bracket maps (1A vs 2B, 1C vs 2D, …) with anti-rematch / anti-same-confederation rules.
- **Carry-over:** some formats **carry group points/results forward** into the next group stage
  (old Champions League second group stage; many handball/curling formats carry the head-to-head
  result among co-advancing teams). Engine should optionally seed the next stage's standings with
  carried points.
- **Draw constraints (pot system):** teams seeded into **pots** by ranking; one drawn from each pot
  per group, with **separation rules** ("no two teams from the same confederation/region/club in a
  group", host-nation placement). This is a *draw* sub-problem (constraint-satisfaction over group
  assignment) distinct from scheduling — but shares the engine's separation-constraint vocabulary.

### 1.5 Swiss system

- **Definition:** fixed number of rounds `R` (≈`ceil(log2(n))` to crown a clear winner, often more);
  **no eliminations**; each round pairs players on **equal/near-equal scores**, and **no pair meets
  twice**. Used in chess, many esports, Magic/board games, large open events where a full RR is
  infeasible.
- **Pairing rules (FIDE Dutch is the reference):**
  - Group players by score; within a score group, split top half vs bottom half and pair across.
  - **No rematches** (backtrack to avoid).
  - **Color/home-away balance:** alternate White/Black (home/away); keep the running color
    difference within ±1; never give the same color three times in a row; honor "absolute" color
    preferences before "strong"/"mild" ones. (Directly maps to home/away in our world.)
  - **Byes:** with odd `n`, one player gets a bye (usually full points), normally given to a
    low-scorer who has not had one yet; "pairing-allocated bye" vs "requested/half-point bye".
  - **Floats:** a player paired up/down out of their score group is "floated"; minimize repeated
    floats / float direction across rounds (downfloat/upfloat tracking).
- **Accelerated pairings:** add virtual points to top seeds in early rounds so strong players meet
  sooner (used in large opens to reduce the number of perfect scores).
- **FIDE variants:** Dutch (classical), Burstein, Lim, Dubov — differ in pairing heuristics.
- **Tiebreaks** (because Swiss frequently produces ties on points) — see §3.5.
- **Status in our code:** **not implemented.** Swiss is inherently round-by-round and adaptive
  (round R+1 depends on round R results), so it cannot be fully pre-generated — it needs a
  "generate next round" operation that reads current standings + pairing history. This is a natural
  fit for the heuristic backend (constructive pairing + backtracking on the no-rematch/color rules).

### 1.6 League + playoffs (regular season → post-season)

- **Definition:** a (single/double/partial) round-robin "regular season" to rank teams, then a
  single- or double-elimination (or best-of-N series) playoff among the top finishers. The
  dominant North-American pro-sports shape (NBA/NFL/MLB/NHL).
- **Series ("best-of-N"):** a playoff "match" is actually a best-of-3/5/7 **series** with home/away
  patterns (2-2-1-1-1, 2-3-2). The series winner advances. Engine needs a "series" abstraction (a
  match that is itself N sub-matches with an aggregate/first-to-k rule). Generalizes the two-leg tie.
- **Reseeding:** higher seeds re-matched against lowest remaining seed each round (vs a fixed
  bracket). A scheduling/pairing option.
- **Divisions/conferences:** teams play more games inside their division/conference; cross-division
  games limited — a *partial* RR with structured opponent counts (see §1.1 partial RR).

### 1.7 Pools / pool play

- **Definition:** synonym for the group stage — teams split into "pools", round-robin within pool,
  top finishers advance to playoffs/bracket. Ubiquitous in volleyball, ultimate, cricket, bowling,
  bag-toss. Often run on **multiple courts/fields in parallel within a single day** (the
  venue-allocation problem dominates). "Pool play → single-elim playoff" is the most common amateur
  one-day-tournament shape.
- **Crossover playoffs:** pool A's seed-1 plays pool B's seed-2 etc.

### 1.8 Ladder / pyramid

- **Definition:** an ongoing ranking; lower-ranked players **challenge** those one or two rungs
  above; winner takes the higher rung. Continuous, not bounded by rounds. Common in club ladders
  (squash, tennis, table tennis). Scheduling is on-demand (challenge → match within a window) rather
  than batch-generated. Lower priority for v1 but worth modeling as "challenge match" events.

### 1.9 Multi-event / multi-category (locked decision #2 — multi-sport from day one)

Not a format per se but a *cross-cutting requirement*: a single tournament hosts many independent
draws — e.g. **Sepak Takraw + Table Tennis (singles + doubles) + age groups**. Each
sport/category/age-group runs its *own* format (one might be RR, another knockout). The hard part is
that **resources (courts, days, officials) and people are shared across categories**:

- A player entered in **multiple categories** (e.g. men's singles + mixed doubles) cannot be on two
  courts at once and needs rest between their matches (badminton practice: ≥30 min gap for
  multi-entry players). This couples otherwise-independent draws through the *person*.
- **Block scheduling by category** (all singles in the morning, doubles in the afternoon) reduces
  cross-category conflicts — a soft preference the engine should support.
- A category maps to a **Sport** config (participants-per-match: 1v1 singles, 2v2 doubles, team
  sizes; slot length; scoring). The engine schedules across the *union* of categories onto the
  shared resource calendar.

---

## 2. Format → math/parameters quick-reference

| Format | Matches (n teams) | Rounds | Byes | Pre-generatable? | In code today |
|---|---|---|---|---|---|
| Single RR | n(n-1)/2 | n-1 (even) / n (odd) | 1/round if odd | Yes | Yes (`generate_round_robin`) |
| Double RR | n(n-1) | 2(n-1) | — | Yes | No (extend RR) |
| Single-elim | n-1 | ⌈log2 n⌉ | next_pow2(n)-n | Yes | Yes, power-of-2 only |
| Double-elim | ~2n-1 (+reset) | ~2⌈log2 n⌉-1 | WB only | Yes | No |
| Groups→KO | per group RR + KO | sum | per stage | Yes | Yes (top-N cross-seed) |
| Swiss | R·⌊n/2⌋ | R (chosen) | 1/round if odd | **No** (round-by-round) | No |
| League+playoffs | RR + series | RR + series | — | Partly (season yes, playoffs after) | No |
| Pools→playoff | pools RR + KO | sum | per stage | Yes | Reuse groups→KO |
| Ladder | on demand | — | — | No (challenge-driven) | No |

---

## 3. CONSTRAINT catalog (the heart of it — "all real-life scenarios")

Organized by the **RobinX three-field academic taxonomy** (the standard reference for round-robin
sports timetabling: ~20 canonical constraints in 5 groups — Capacity, Game, Break, Fairness,
Separation), cross-referenced with **FET's constraint families** (the model the spec explicitly
draws from) and **operational/real-world** constraints from practitioner sources. Each constraint
notes: hard/soft default, the *resource* it concerns, parameters, and a proposed `type` string for
our catalog.

Legend: **H** = typically hard, **S** = typically soft, **H/S** = either (user choosable).
"Scope" = what the constraint binds to (team/venue/category/global/match-set).

### 3.0 Resource / availability constraints (FET "not available" family) — H

The foundational layer: every resource has a calendar of when it can/can't be used.

| `type` | Description | Scope | Params | Maps to |
|---|---|---|---|---|
| `venue_not_available` | A venue/court/ground is unavailable in given date+slot windows | venue | windows[] | FET "room not available"; blackout per venue |
| `team_not_available` | A team unavailable on dates/slots (exam week, travel, religious obs.) | team | windows[] | FET "students set not available" |
| `participant_not_available` | A person/player unavailable (multi-category, injury, work) | person | windows[] | FET "teacher not available" |
| `official_not_available` | Referee/umpire/scorer unavailable | official | windows[] | FET "teacher not available" |
| `tournament_blackout` | Global no-play dates (holidays, ceremonies, maintenance) | global | dates[] | "finalize blackout dates" |
| `slot_calendar` | The master grid: date range, match-days vs rest-days, daily start/end, slot length | global | from,to,days[],day_start,day_end,slot_minutes | FET time-slots; spec §3.A "Calendar/Timing" |
| `category_venue_compatibility` | A category/sport may only use venues that support it | category | venue_ids[] | spec "compatible venues"; FET subject→preferred room |

### 3.1 Resource non-collision (RobinX implicit / FET "not overlapping") — H

The clash-free core. These are the "no two X at once" invariants.

| `type` | Description | Scope | Maps to |
|---|---|---|---|
| `no_double_booking_team` | A team plays ≤1 match per slot | team | **exists today**; RobinX implicit; FET no-overlap |
| `venue_single_use` | A venue hosts ≤1 match per slot | venue | **exists today**; FET room no-overlap |
| `no_double_booking_participant` | A person (cross-category) plays ≤1 match per slot | person | the multi-entry badminton case |
| `no_double_booking_official` | An official works ≤1 match per slot | official | FET teacher no-overlap |
| `shared_venue_no_simultaneous_home` | Teams sharing a home venue can't both be "home" in the same slot | team-group | literature "teams sharing a venue cannot play home in same slot" |

### 3.2 Rest / spacing / frequency (FET "max hours daily", "min gaps", "min days between") — H/S

How often and how close-together a team/person may play. The spec calls these out (rest rules, max
matches/day per team).

| `type` | Description | H/S | Params |
|---|---|---|---|
| `min_rest_minutes` | ≥ N minutes between a team's consecutive matches | H | minutes | **exists today** |
| `min_rest_minutes_participant` | ≥ N minutes between a person's matches (multi-category, e.g. 30) | H/S | minutes |
| `max_matches_per_day_team` | A team plays ≤ K matches/day | H | k |
| `max_matches_per_day_participant` | A person plays ≤ K matches/day | H | k |
| `max_matches_per_day_global` | ≤ K matches/day across the whole event (capacity) | H | k |
| `min_days_between_legs` | The two legs of a tie ≥ D days apart (no back-to-back legs) | H | days | TTP "cannot be consecutive days" |
| `min_days_between_matches_team` | ≥ D days between a team's matches | S | days | FET "min days between activities" |
| `max_days_between_matches_team` | ≤ D days (don't leave a team idle too long) | S | days | FET "max days between" |
| `even_spacing` | Spread a team's fixtures evenly across the date range | S | weight | spec soft list; FET "spread activities" |
| `avoid_back_to_back` | Avoid a team's matches in adjacent slots | S | — | **exists today** |
| `max_consecutive_play_days` | ≤ C consecutive play-days for a team (rest day required) | S | c | burnout-prevention literature |

### 3.3 Capacity / home-away balance (RobinX **CA** + **BR** classes) — H/S

Regulate when/how often a team plays home vs away. Central to leagues.

| `type` | Description | H/S | Maps to |
|---|---|---|---|
| `home_away_balance` | Each team plays ~equal home and away over the tournament | S | RobinX CA1 |
| `max_home_in_window` / `max_away_in_window` | ≤ k home (or away) games in any window of w slots | H/S | RobinX CA3/CA4 |
| `max_consecutive_home` / `max_consecutive_away` | Cap home (away) **streaks** = limit "breaks" | H/S | RobinX BR1; TTP "consecutive home/away" |
| `min_breaks` / `no_break` | (DRR) minimize or forbid breaks (a "break" = same home/away as prev round) | S | break-minimization literature |
| `fixed_home_away` | Force a specific game's orientation (derby at X's ground) | H | RobinX GA "fixed assignment" |
| `complementary_schedule` | Two teams have complementary home/away patterns (shared stadium) | H | literature "complementary pairs" |
| `first_last_home_away` | Constrain opening/closing fixtures' orientation | S | common league request |

### 3.4 Game assignment / fixed & forbidden (RobinX **GA** class) — H

Pin or ban specific games to/from specific slots/rounds/venues.

| `type` | Description | H/S |
|---|---|---|
| `fixed_match_slot` | This pairing must be in this date/slot/venue (TV, ceremony, opener, final) | H |
| `forbidden_match_slot` | This pairing must NOT be in these slots (RobinX GA1 forbid) | H |
| `match_in_round` | A pairing must occur in round R (e.g. derby in final round) | H |
| `phase_window` | A whole stage (group/QF/SF/F) must fall in a date window | H |
| `final_at_venue_time` | Final (or marquee match) at a specific prime venue + prime-time slot | S |

### 3.5 Fairness / attractiveness (RobinX **FA** class — always soft) — S

Equity and entertainment. Always soft by definition in the literature.

| `type` | Description |
|---|---|
| `carry_over_balance` | Minimize carry-over effect (X beats A, then A faces Y next round → A "carries" fatigue/scout intel to Y). Circle method MAXimizes this — warn. |
| `strength_balance` | Don't cluster a team's hardest opponents together / all on the road |
| `rest_fairness` | Equalize total/short rest across teams (no team systematically under-rested) |
| `bye_fairness` | Distribute byes evenly; no team gets two byes before another gets one |
| `prime_time_fairness` | Distribute marquee/prime-time slots fairly across teams |
| `venue_usage_balance` | Spread matches evenly across venues / slots (don't overload one court) |
| `tiebreak_policy` | The ordered standings tiebreak chain (not a scheduling constraint but a ranking rule — see below) |

**Standings tiebreakers** (used by `compute_standings` / `rules.tiebreakers`; extend the existing
chain). League/group: points → goal/point difference → goals/points for → head-to-head → fair-play
(cards) → drawing of lots. Swiss-specific (because Swiss ties are frequent): **Buchholz** (sum of
opponents' scores), **Median/Solkoff** (Buchholz dropping highest+lowest / keeping all),
**Sonneborn-Berger** (defeated opponents' full score + drawn opponents' half), **Cumulative**
(running-score sum, rewards early wins), **Most wins (Baumbach)**, **opponents' performance rating**,
then speed playoff / coin flip. The engine should treat the tiebreak chain as an ordered, named,
data-driven list (today's `rules.tiebreakers` is exactly this shape — extend the vocabulary).

### 3.6 Separation / "kept apart" (RobinX **SE** class) — H/S

Control how soon/often specific pairings can recur or meet. **This is the spec's headline example**
("same-organization teams cannot meet in the opening round/stage", generalized to "teams sharing
attribute X are kept apart until round R").

| `type` | Description | H/S |
|---|---|---|
| `min_rounds_between_rematch` | (DRR/Swiss) ≥ R rounds between the two meetings of a pair | H/S (RobinX SE1) |
| `no_rematch` | A pair never meets twice (Swiss core rule) | H |
| `keep_apart_until_round` | Entities sharing attribute X (same institution/region/pot) cannot meet before round R | H |
| `keep_apart_in_group` | Entities sharing attribute X cannot be drawn into the same group/pool | H (draw constraint) |
| `same_institution_protection` | Specialization of the above for `Institution` (the locked hierarchy) — e.g. two teams of one school avoid each other in the opening round | H |
| `confederation_separation` | Region/confederation separation in group draw (World Cup pots) | H |
| `host_placement` | Host(s) pinned to specific group/slot | H |

### 3.7 Seeding / draw constraints — H/S

Inputs to the *pairing* phase (knockout bracket, group draw).

| `type` | Description |
|---|---|
| `seeding_source` | seeded \| random \| pots — how the draw is built |
| `pots` | Define pots (by rank/rating); one team per pot per group |
| `bracket_seed_map` | Standard 1-vs-n bracket placement / explicit slot map |
| `bye_to_top_seeds` | Award byes to highest seeds (non-pow2 knockout) |
| `protect_seeds` | Top seeds can't meet before round R (knockout separation) |
| `geographic_seeding` | Regional balancing in bracket placement (NCAA S-curve) |
| `accelerated_pairing` | Swiss acceleration (virtual points to top seeds early) |

### 3.8 Operational / external (broadcast, daylight, weather, travel) — H/S

Real-world non-sporting constraints from practitioner sources. Mostly soft, some hard.

| `type` | Description | H/S |
|---|---|---|
| `broadcast_window` | Assign marquee matches to TV windows / prime-time; respect broadcaster slot requests | H/S |
| `daypart_rules` | Slot policies by daypart (after-school, prime-time, late) | S |
| `curfew` | Hard latest finish (neighborhood/lighting/noise curfew) | H |
| `daylight_only` | Matches needing daylight must finish before sunset (no floodlights) | H |
| `weather_reserve` | Reserve buffer/rain-date slots; field-type-aware rescheduling | S |
| `minimize_travel` | Minimize total/again team travel distance (TTP objective) | S |
| `travel_swing_limit` | Cap consecutive away-trip distance / road-trip length | H/S |
| `geographic_clustering` | Cluster a team's away games geographically (one trip) | S |
| `venue_changeover_buffer` | Min turnaround when a venue switches category/sport (net change, surface) | H |
| `attendance_optimization` | Prefer slots maximizing attendance (weekends/evenings) | S |
| `field_capacity_concurrency` | Max concurrent matches a site can run (parking/staff) | H |

### 3.9 Match-content constraints (from `rules.py`, not scheduling but adjacent)

Already modeled in `DEFAULT_RULES` and worth keeping distinct from *scheduling* constraints: points
(win/draw/loss), match structure (halves/minutes, extra time, penalties), squad min/max/subs,
discipline (card suspensions), two-leg aggregate / away-goals, golden-goal. These feed standings and
match flow, not the (date, slot, venue) assignment — keep them in `rules`, not `constraints`.

---

## 4. The unified constraint model (recommended record shape)

Generalize today's `validate_constraints` record. Every constraint is a declarative JSONB record so
the solver backend is swappable (locked decision #3). Proposed canonical shape:

```jsonc
{
  "type": "keep_apart_until_round",   // from the catalog above
  "scope": {                           // WHAT it binds to (replaces today's flat "scope":"all")
    "selector": "attribute",           // all | team | venue | category | participant | attribute | match_set
    "attribute": "institution_id",     // for attribute/separation selectors
    "ids": []                          // explicit entity ids when selector is team/venue/...
  },
  "params": { "round": 1 },            // type-specific (validated against params_schema)
  "severity": "hard",                  // hard | soft
  "weight": 100,                       // for soft: relative importance (FET-style weight%)
  "category": "SE",                    // RobinX class: CA|BR|GA|FA|SE|RES|REST|OPS (for grouping/UI)
  "applies_to": ["pairing", "assignment"] // which phase consumes it
}
```

This is a strict superset of the current record (`{type, scope, hard, weight, params}`): map
`hard:true` → `severity:"hard"`, keep `weight`, expand `scope` from a string to an object, add
`category`/`applies_to`. `CONSTRAINT_TYPES` grows from 5 entries to the catalog in §3, each with a
`params_schema` (already the established pattern) used by the wizard UI builder.

**FET parallel for the wizard (spec §3.A "deep requirements interview"):** FET's UI is literally a
typed list of "add constraint" dialogs grouped into Time/Space families. Our Stage-4 wizard mirrors
this: pick sport + format (→ §1 generator + sensible constraint defaults), then walk the families in
§3.0–§3.8 as wizard steps (Calendar → Venues → Timing/Rest → Seeding/Draw → Separation →
Fairness/Soft → Operational), each step appending typed records. Defaults are pre-filled from the
chosen sport/format; the user toggles hard/soft + weight, exactly like FET's hard/soft model.

---

## 5. Solver mapping (heuristic first, CP-SAT later — locked decision #3)

Keeping it concrete for the layered solver behind one interface:

**Phase 1 (pairing)** — deterministic per format (extend `generate.py`): RR (have it), DRR (mirror +
orientation pattern), single-elim with byes/play-in (extend), double-elim (new WB+LB pointers),
groups→KO (have it; add best-third + bracket maps + carry-over), Swiss (new, round-by-round). Honors
SE/GA pairing constraints (separation, fixed/forbidden, seeding/pots/byes) during generation.

**Phase 2 (assignment)** — the new timetabling layer; assign each pairing a (date, slot, venue).
- **Heuristic backend (ship first):** constructive greedy (order pairings by constrainedness — most
  constrained first; place each in the earliest feasible (slot,venue) honoring all hard constraints)
  + **repair/local-search** (swap/move to fix violations, then optimize soft via weighted score).
  Inline, instant, explainable — returns per-constraint satisfied/violated report (spec §3.C
  explainability; reuse `inputs_hash`/`last_manual_edit_at`).
- **CP-SAT backend (add later, async):** the §3 catalog maps cleanly to OR-Tools CP-SAT primitives:
  - each pairing → an **optional/interval variable** over the slot grid; venue/team/person/official
    no-overlap → `AddNoOverlap` per resource (the documented CP-SAT scheduling pattern).
  - availability/blackout → forbid intervals (domain restriction) on the resource.
  - rest/spacing/min-days → linear/`Add` constraints on start-time differences.
  - home/away balance, breaks (CA/BR) → boolean home vars + sum/window constraints.
  - separation (SE), fixed/forbidden (GA) → equality/`AddForbiddenAssignments`.
  - soft (FA + soft of others) → penalty terms summed into `Minimize(weighted_violations)`.
  Same declarative model in, same schedule + report out — a drop-in, not a rewrite.

---

## 6. RECOMMENDED FOR OUR ENGINE

Prioritized for the Fixture build (Nagaland schools focus, multi-sport from day one, heuristic-first).

**Tier 1 — must ship (covers >90% of real school/college tournaments):**
- Formats: single RR (have), double RR, single-elim **with byes + play-in** (fix the power-of-2
  gap — real entries are rarely 2^k), groups→KO (have; add best-third advancement), pools→playoff
  (reuse groups→KO).
- Constraints (§3.0–§3.2 + the headline §3.6): full availability/blackout (`venue_not_available`,
  `team_not_available`, `tournament_blackout`, `slot_calendar`, `category_venue_compatibility`);
  non-collision (`no_double_booking_team` ✔, `venue_single_use` ✔, `no_double_booking_participant`,
  `no_double_booking_official`); rest/frequency (`min_rest_minutes` ✔, `max_matches_per_day_team`,
  `min_rest_minutes_participant`, `even_spacing` (S), `avoid_back_to_back` ✔ (S));
  **separation: `keep_apart_until_round` + `same_institution_protection`** (the spec's flagship
  scenario); seeding/byes (`bye_to_top_seeds`, `bracket_seed_map`, `protect_seeds`).
- Multi-category coupling via the *person* (no_double_booking_participant + rest) — required by the
  Sepak Takraw + Table Tennis use case.
- Standings tiebreak chain already in `rules.tiebreakers` — extend vocabulary for group head-to-head.

**Tier 2 — high value, add next:**
- Double-elim (esports/wrestling/club), Swiss (round-by-round generate-next-round; needs no-rematch
  + color/home-away balance + byes + accelerated pairing). League+playoffs with **best-of-N series**
  abstraction (generalizes two-leg ties). Two-leg knockout ties + aggregate/away-goals rules.
- Home/away balance + break limits (CA/BR) for double-RR leagues. Operational soft constraints
  (`broadcast_window`/prime-time for finals, `curfew`, `daylight_only`, `venue_changeover_buffer`).
- Fairness soft set: `bye_fairness`, `venue_usage_balance`, `rest_fairness`.

**Tier 3 — advanced / when CP-SAT lands:**
- Carry-over minimization (and warn that the circle method maximizes it → consider Berger tables as
  the RR default). Travel/geographic (`minimize_travel`, road-trip clustering) — TTP-grade, the
  classic CP-SAT win. Pot-based group draw with confederation/region separation + host placement.
  Full consolation/plate/shield secondary brackets. Ladder/challenge format. Weather reserve slots.

**Design guidance distilled from the research:**
1. Keep the **two layers separate** (pairing vs assignment) — every constraint tags `applies_to` so
   the right phase consumes it; this is what makes the solver swappable.
2. Adopt the **RobinX 5-class taxonomy (CA/BR/GA/FA/SE)** + a resource/availability class + an
   operational class as the catalog's top-level grouping — it is the field-standard vocabulary and
   gives the wizard a clean step structure mirroring FET's Time/Space families.
3. **Fairness constraints are always soft** (FA) — never let the user mark carry-over/strength/prime-
   time fairness "hard", or feasibility collapses.
4. Replace the power-of-2 knockout restriction with **byes + a preliminary/play-in round** — the most
   common real-world gap in current code.
5. Swiss and league-playoffs are **not fully pre-generatable** — model them as "generate next
   round/stage" operations that read live standings + history, consistent with the existing
   `advance_from_match` post-commit advancement pattern.
6. Generalize `scope` from a string to a `{selector, attribute, ids}` object so "teams sharing
   attribute X" (institution, region, pot, shared-venue) is first-class — this single change unlocks
   the entire SE/separation class including the spec's headline same-institution rule.

---

## Sources

- RobinX three-field classification (CA/BR/GA/FA/SE constraint groups), Van Bulck et al. — https://robinxval.ugent.be/RobinX/ and https://www.sciencedirect.com/science/article/abs/pii/S0377221719305879
- "Which algorithm to select in sports timetabling?" (RobinX constraint groups detail) — https://arxiv.org/html/2309.03229v2
- Ribeiro, "Sports scheduling: problems and applications" (survey; GA/complementary/special constraints) — http://www.dcc.ic.uff.br/~celso/artigos/sports-scheduling.pdf
- FET full constraint list (time + space families) — https://www.timetabling.de/manual/FET-manual.en.html and https://lalescu.ro/liviu/fet/
- Carry-over effect / circle method maximizes carry-over — https://www.researchgate.net/publication/303515072_Round-Robin_Tournaments_Generated_by_the_Circle_Method_Have_Maximum_Carry-Over and https://www.semanticscholar.org/paper/Minimizing-the-Carry-Over-Eects-Value-in-a-Miyashiro-Matsui/cd5c7babe820a1ca5d3cc7a03f6ef6a60457da28
- Traveling Tournament Problem (home/away streaks, no-consecutive-legs, travel) — https://www.khoury.northeastern.edu/home/rhoshino/papers/sc11.pdf and https://arxiv.org/pdf/2505.06828
- Swiss-system pairing rules (no rematch, color balance, byes, floats, acceleration) — https://en.wikipedia.org/wiki/Swiss-system_tournament and https://chesspairings.org/en/guide/swiss-system-explained/
- Swiss tiebreak systems (Buchholz/Median/Sonneborn-Berger/Cumulative/etc.) — https://en.wikipedia.org/wiki/Tie-breaking_in_Swiss-system_tournaments
- Single/double-elimination, byes for non-power-of-2, seeding, consolation/3rd-place — https://www.bracketsninja.com/types/single-elimination-bracket, https://en.wikipedia.org/wiki/Double-elimination_tournament, https://www.printyourbrackets.com/how-byes-work-in-a-tournament.html
- Groups→knockout, FIFA 2026 format (best-third advancement, pots, draw separation) — https://www.foxsports.com/stories/soccer/fifa-world-cup-group-stage-third-place-tiebreakers and https://arxiv.org/pdf/2502.08565
- Pool play / league / playoffs / ladder formats — https://en.wikipedia.org/wiki/Playoff_format and https://docs.scoreholio.com/tournament/tournament-formats/pool-play
- Badminton/tennis multi-category court allocation + rest (multi-entry 30-min gap, block scheduling) — https://kb.score7.io/blog/guides/how-to-organize-a-badminton-tournament/ and https://mobisoftinfotech.com/resources/blog/smart-court-allocation-systems-tournament-scheduling
- Operational constraints (broadcast windows, blackout dates, curfew, daylight, weather, dayparts) — https://www.fastbreak.ai/blog/the-art-and-science-of-sports-scheduling, https://www.ezfacility.com/blog/sports-league-scheduling-problem/, https://www.jerseywatch.com/blog/create-a-sports-schedule
- OR-Tools CP-SAT scheduling primitives (intervals, AddNoOverlap, forbidden assignments) — https://github.com/google/or-tools/blob/stable/ortools/sat/docs/scheduling.md and https://d-krupke.github.io/cpsat-primer/04B_advanced_modelling.html
