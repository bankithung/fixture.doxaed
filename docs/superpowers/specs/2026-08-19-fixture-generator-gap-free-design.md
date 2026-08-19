# Gap-free fixture generation — plan of record

**Date:** 2026-08-19
**Status:** plan, ready to execute
**Owner ask:** "generate the best most possible fixture that uses all the applied rules and then find proper matches in all without missing out anything — make it smart enough to generate and not leave any gaps."

## 1. The goal, in the owner's terms

A generated fixture must be, in this priority order:

1. **Complete.** Every match in the draw gets a time and a court. Unplaced is a failure, never a trade.
2. **Legal.** Every rule the host authored is obeyed, by the draw AND by every hand-move afterwards. One rule, one answer: the placer, the optimizer and the conflict checker must never disagree about whether a slot is legal.
3. **Tight.** As little court time standing idle as the authored rules allow, and the day finishing as early as they allow.
4. **Deterministic.** The same tournament, the same rules and the same draw produce the same fixture, in preview and again at publish. Preview equals commit is not negotiable.

Item 2 comes first in the work order even though it is second in the ask, because today it is broken in a way that makes item 3 unreachable: the packing pass is gated on an oracle that answers wrong, so it adopts nothing.

## 2. Baseline, measured on the live clone (2026-08-19)

Tournament: `ANPSA … (Clone 2)`, id `01a005b5-0e4b-7cf0-b3a2-138b77edd0bd`. 113 matches, 2 days, 5 courts (`Audi · T1/T2/T3`, `Mph · T1/T2`), 08:00 to 15:30, `grid_step_minutes` 5, `slot_minutes` 30. Measured through the real preview path (`preview_all_fixtures`), read-only, nothing written.

| Reading | Value |
| --- | --- |
| Placed | 113 / 113, unplaced 0 |
| Played court-minutes | 1760 |
| Playable court-minutes on the grid | 3600 |
| Free court-minutes (grid minus played) | 1840 |
| Idle inside each court's own working stretch (`court_packing`) | 175 |
| Last whistle | 2026-08-18 15:15 (last start 15:05) |
| `soft_score` | 0.93 |
| Preview wall time, plain | 5.1 s |
| Preview wall time, "Fill the gaps" on | 25.5 s, **byte-identical output** |

**The 1840 free minutes split cleanly, and the split is the honest ceiling:**

| Court group | Playable | Played | Free |
| --- | --- | --- | --- |
| Audi T1/T2/T3 (reserved to table tennis competitions) | 2160 | 710 | **1450** |
| Mph T1/T2 (reserved to sepak takraw competitions) | 1440 | 1050 | 390 |

1450 of the 1840 free minutes are table-tennis courts that no sepak match may legally take, because the host reserved them per competition. That is the host's authored choice, not a scheduler failure. **No placement work can recover it; the product answer is to report it** (step D2). The reclaimable numbers are the 175 minutes of holes inside working stretches and the length of the day.

**The headline defect, reproduced live:**

```
SEED validate_schedule: 42  Counter({'shared_player_conflict': 42})
SEED _capacity_ok: True
SEED _legal: False
cfg.rest_minutes: 5      link gaps by sport: {'table_tennis': (0, 0), 'sepak_takraw': (0, 0)}
```

The greedy's own output fails the greedy's own validator, 42 times, so `optimizer._legal` is False on the seed and every proposal it generates. "Fill the gaps" burns 20 seconds and changes nothing. Cause: `validate_schedule` judges linked teams with the global `cfg.rest_minutes` (5) while `feasible` resolves the scoped `effective_link_gaps` (here 0/0, because the host authored 0). Today the validator is the *stricter* side; with the TT 20 / sepak 40 values the same tournament carried this morning it is the *more permissive* side and the optimizer walks straight through the gap the host set. Same bug, both directions.

**And the fix pays immediately.** Wrapping `validate_schedule` with the corrected per-pair gap resolution and re-running the identical optimizer:

```
SEED violations (corrected): Counter()          # was 42
adopted: True   moved: 15
[seed]      idle=175   [optimized] idle=135     # placer-rule link breaches: 0 in both
```

**Reproduce it** (read-only, no DB writes): probe scripts at `/tmp/claude-1000/-home-ubuntu-Fixture/7373abf5-ff66-4cd2-a628-830757c2ab28/scratchpad/{p2,p3,p4,p5}.py`, run with `backend/.venv/bin/python backend/manage.py shell < <file>`. The executor should copy these into their own scratchpad as the bench for every step below; the durable guards are the tests each step adds.

**Suite baseline:** `backend/apps/fixtures` collects **613 tests**. Every step below must leave 613+ green.

## 3. Rules this plan holds itself to

* **Data-driven or it does not ship.** No step names a sport, a category, a gender, a round or a policy in code. Every number a step introduces is either read from a catalog record or is an engine constant with a stated reason (and none of them encode a tournament's preference).
* **Deterministic or it does not ship.** No step introduces wall-clock-dependent output. This is why the plan **rejects** the clock-driven search budget the optimizer audit recommended: preview and publish are separate requests, so an effort level set by the clock means the published fixture is not the previewed one.
* **Preview equals commit.** Everything lands in `schedule_matches` / `optimize_schedule`, which both `preview._schedule_and_payload` and `scheduler.apply_schedule` call. The one step that touches the preview's own control flow (C3) restructures both sides together.
* **Measurable or it does not ship.** Each step names the number it must move and the number it must not move.

## 4. The work, in order

### Phase A — one oracle (correctness)

Every finding in phase A is an instance of one structural fault: the hard gate exists in three partial copies (`scheduler.feasible`, `optimizer._single_match_ok`, `scheduler.validate_schedule`) with no shared resolver. The file already solves this correctly three times (`closing_round_ok`, `resolve_finish_phases`, `effective_rest_gap`, each with a docstring saying it exists so the three callers cannot drift). Phase A extends that pattern to the rest, cheapest and highest-exposure first.

---

#### A1. The validator judges a linked pair by the scoped link gaps

**Files.** `backend/apps/fixtures/services/scheduler.py`: `validate_schedule` (the linked-pair loop at ~:2870-2890, `rest` at :2601, `team_items` construction at :2612/:2655).

**Change.** Carry the venue on each team interval (`team_items` entries become `(start, end, mid, venue)`; preoccupied bookings carry `booking[0]`). In the linked loop, resolve the gap per pair exactly as `feasible` does at :1810-1822:

```python
same_g, cross_g = effective_link_gaps(cfg, by_id.get(subject))
if same_g is None:
    g = effective_rest_gap(cfg, by_id.get(subject), team)      # legacy path, still scoped
else:
    same = base_of.get(v_i, v_i) == base_of.get(v_j, v_j)
    g = timedelta(minutes=(same_g if same else cross_g or same_g))
```

Extract it as a module-level `linked_pair_gap(cfg, match, team, venue_a, venue_b)` sitting beside `effective_rest_gap` / `effective_day_cap`, and have `feasible` call it too, so there is exactly one implementation.

**Why.** This is the single defect that makes "Fill the gaps" inert (measured: 42 phantom violations, `_legal` False, 20 s of nothing) and, under the other sign, lets the optimizer and every repair verb break the same-school gap the host authored. It is also the foundation every later step stands on: no packing work is safe while "is this slot legal?" answers wrong.

**Success criterion.** On the live clone: `validate_schedule(greedy seed)` returns **0** violations (was 42); `optimize_schedule` adopts (was inert) and **within-window idle falls from 175 to <= 140**; unplaced stays 0; an independent audit of the optimized assignment under the placer's own link rule reports **0 breaches**. 613+ tests green.

**Tests** (`backend/apps/fixtures/tests/test_same_school_overlap.py`):
* Scoped gap **wider** than `cfg.rest_minutes`: two linked teams placed `rest_minutes` apart in the same hall must now produce `shared_player_conflict` (the permissive direction, closed).
* Scoped gap **narrower** than `cfg.rest_minutes` (this tournament: 0 vs 5): the same placement must now validate **clean** (the strict direction, closed).
* Cross-venue: same pair on two different bases judged by `cross_venue_gap_minutes`, same base by `min_gap_minutes`.
* Two records of different scope (one per sport) in one config: each sport judged by its own record.
* Parity: for a greedy result on a config carrying scoped link records, `validate_schedule(result.assignments) == []`.

**Risk.** Tightening surfaces violations on already-published fixtures built under the loose check, and `repair.validate_slot_changes` starts refusing moves it used to allow. **Mitigation:** the repair verbs already carry `force`; the violation code is unchanged so no new UI string is needed; on the live clone the immediate effect is *fewer* violations, not more.

---

#### A2. The validator applies the precedence rest margin

**Files.** `scheduler.py`: `validate_schedule` bracket-precedence block (:2928-2943).

**Change.** Add the same gap the placer uses at :1702:

```python
if fslot is not None and slot[0] < fslot[0] + dur_of(fid) + effective_rest_gap(cfg, m, ""):
...
if m.not_before is not None and slot[0] < m.not_before + effective_rest_gap(cfg, m, ""):
```

**Why.** The winning team plays both matches, so this is the rest gap that protects a child. Today a final may start the instant its semi-final ends and the validator calls it clean, which is exactly what the optimizer and every drag-and-drop will do once A1 unblocks them.

**Success criterion.** A dependent placed at `feeder_end + 0/1/(gap-1)` minutes reports `predecessor_order`; at `feeder_end + gap` it does not. On the live clone, unplaced stays 0 and idle does not regress. 613+ green.

**Tests** (`test_scheduler_precedence.py`): the four boundary placements above, plus one with a scoped `min_rest_minutes` record on the dependent's leaf proving the scoped value governs, not `cfg.rest_minutes`.

**Risk.** Fixtures published with a zero gap between a semi and its final now report `predecessor_order`. **Mitigation:** the code already exists and is already localized; it appears only where a real back-to-back exists.

---

#### A3. The greedy and the validator agree on the per-day cap

**Files.** `scheduler.py`: `_schedule_once.feasible` (:1800), `effective_day_cap` (:2561-2575).

**Change.** Two edits.
1. The greedy keeps `day_cap_seen[(team, date)]` alongside `team_day`, set to the min of the resolved caps of the matches already placed for that team that day, and refuses when `team_day[(t, d)] >= min(_day_cap(m, t), day_cap_seen.get((t, d), inf))`. Update it on placement.
2. `effective_day_cap`'s tie-break: `if best is None or cand > best` (was `cand[0] > best[0]`), so among two equally specific caps the **smaller count** wins rather than whichever was read first. Note the direction differs from `effective_rest_gap`, where the larger minutes win: both mean "the stricter rule wins", so state that in the comment.

**Why.** Today, with a scoped cap of 1 on one leaf and the global 5 on another, emitting strict-first lets the greedy place both and then its own validator calls the result `exceeds_max_per_day`. That single pre-existing violation makes `_legal(seed)` False and turns the whole packing pass into a silent no-op, which is the same class of failure as A1. Whether the schedule is legal must not depend on draw emission order.

**Success criterion.** On a config with a scoped cap of 1 on one leaf and the global cap on a sibling, `validate_schedule(schedule_matches(...).assignments) == []` under **both** emission orders. Live clone unchanged (it authors no scoped day cap): 113/113, idle unchanged. 613+ green.

**Tests** (`test_scheduler_scopes.py`): the both-orders parity case above; a case with two equally specific caps (1 and 3) asserting 1 governs.

**Risk.** Tightening the greedy can leave a match unplaced on a tournament that relied on the loose order. **Mitigation:** it bites only where a scoped cap record exists; `schedule_matches`'s retry and step B2's variants cover it; the alternative (validator relaxes) would defeat the rule the host wrote.

---

#### A4. `official_capacity` counts concurrency, not overlaps

**Files.** `scheduler.py`: `feasible` capacity block (:1763-1779). Reuse `optimizer._max_concurrency` by moving it to `scheduler.py` (optimizer already imports from scheduler, so this is the correct direction) and re-exporting.

**Change.** Replace the overlap **count** with a sweep-line **peak**: collect the scoped intervals that overlap the candidate window, append the candidate's own `(dt, end)`, and refuse only when the peak exceeds `cap`. Preserve the existing scope semantics exactly, including that legacy meta-less bookings count only for scope `all`.

**Why.** Two matches that run back to back on other courts both overlap a long candidate's window without ever being simultaneous, so `n` reaches `cap` while true concurrency does not. Both other implementations (`validate_schedule` :3008-3030 and `optimizer._capacity_ok`) already sweep correctly, so the greedy is stricter than the two oracles that judge it: it refuses arrangements its own validator blesses. Correcting it is a strict relaxation toward the documented rule.

**Success criterion.** A unit case where cap = 2, two placed back-to-back matches straddle a candidate window, and the candidate is now accepted (was refused). On the live clone: placed stays 113/113, **last whistle no later than 15:15**, idle does not regress. 613+ green.

**Tests** (`test_scheduler_v2.py` or the capacity tests): the back-to-back case above; a genuine 3-concurrent case at cap 2 still refused; a per-leaf run where a sibling leaf's committed booking still counts; parity — for a config with a capacity record, `validate_schedule` on the greedy result is empty and `_capacity_ok` is True.

**Risk.** A relaxation could let a capacity rule be broken if the sweep is wrong. **Mitigation:** the candidate is included in the sweep, and the parity test asserts the two independent implementations agree on the greedy's own output.

Also in this step, one line of documentation, no behaviour change: `merge_stored_constraints` builds every `official_capacity` rule with a literal `hard=True` while the greedy filters without `r.hard` and the validator filters with it. Add a comment at :513-521 saying capacity is hard by construction, so neither consumer is tempted to branch on it. Do **not** start honouring `hard: false`: existing records carrying it would silently lose their limit.

---

#### A5. One per-match gate, shared by all three callers

**Files.** Move `optimizer._single_match_ok` (optimizer.py:153-215) into `scheduler.py` as `single_match_ok(...)` plus a `single_match_reasons(...)` generator that yields coded violations. Callers: `feasible` (replacing :1675-1732), `optimizer._candidates`, and a new per-assignment loop in `validate_schedule`. Add the pin window to the validator (`resolve_pinned_rounds` over **all** `round_pinned_to_window` rules, not only those with `venues`, reusing `_pin_ok`).

**Change.** The validator gains five checks it does not have today, each mapped to a code:

| Check | Code | Enforced by placer at |
| --- | --- | --- |
| venue type | `venue_type_mismatch` | :1675-1678 |
| hard session windows | `outside_session_window` | :1730-1732 |
| scoped blackout dates | `blackout_date` | :1711-1713 |
| scoped reserve days | `reserve_day` | :1724-1726 |
| pinned round date/time | `pinned_round_window` | :2127 via `_pin_ok` |

**Why.** Verified by probe: a match hand-moved onto a wrong-type venue, outside a category's session window, or onto a day its sport is blacked out of, all return **zero** violations today. Every repair verb (`reschedule_match`, `swap_slots`, bulk moves) routes through `validate_schedule` and so tells the admin there is no conflict. The logic already exists in `_single_match_ok`; it simply lives in the wrong module. The pin half additionally costs packing quality: `optimize_schedule` freezes **every** pinned match at its seed slot precisely because the validator does not re-check pin times.

**Success criterion.** Each of the five probes above now reports its code; the greedy's own output still validates empty on the live clone and on every existing test fixture. Unplaced 0, idle unchanged. 613+ green.

**Tests** (new `test_hard_gate_parity.py`): one case per code, each authored through `merge_stored_constraints` so it goes through the real interpretation path; plus a test that `single_match_ok` and `single_match_reasons` agree (bool == empty reasons) over a grid of matches and slots.

**Risk.** `feasible` is the hottest loop in the engine (113 x 720 on the clone), so the shared function must take the pre-resolved rule lists as arguments, not rebuild them per call, and must stay allocation-free on the bool path (the reasons generator is a separate entry point used only by the validator). **Mitigation:** measure preview wall time before and after; it must stay within 10% of the 5.1 s baseline.

---

#### A6. Calendar membership, and the parity guard

**Files.** `scheduler.py`: `validate_schedule` (one new pass), plus new test file.

**Change.** Build `{(start, venue): window_end}` once from `build_slots(cfg)` and, per assignment, emit `off_grid` when the `(start, venue)` pair is absent and `runs_past_window` when `dt + dur > window_end`. This one check subsumes the daily window, `excluded_dates`, all-scope blackout and reserve days, per-venue windows and breaks, venue off-days, and stale or non-existent court strings. While there, make the `venue_unavailable` check at :2624 resolve its base the way the capacity pass does (`base_of.get(venue) or court_base_of(venue, cfg.venues)`), so a stale `Audi · T9` resolves instead of falling through.

Then add the structural guard the whole phase exists for: a property test that, for a set of randomly generated assignments over a config exercising every catalog rule type, asserts **`feasible`-acceptance and `validate_schedule`-emptiness agree on every match**. Seeded RNG, fixed corpus, deterministic.

**Why.** Probed today: a match at 22:00, on a date a month past `date_end`, or on a court that does not exist all validate clean. Every repair verb trusts that answer. And the parity test is what stops phase A from being re-broken by the next catalog entry, which is the actual root cause of all eight parity findings.

**Success criterion.** The seven off-grid probes (16:00, 22:00, past `date_end`, a month out, a match running past `daily_end`, `Audi · T9`, bare `Audi`) each report a code; the live clone's greedy output still validates empty; the parity test passes. `validate_slot_changes` latency stays acceptable (cache the grid per call). 613+ green.

**Risk.** A start that is inside the window but off the coarse grid (an admin typing 09:07) is now flagged. **Mitigation:** this is the parity-true answer, since the placer only ever offers grid starts; the decision is explicit here rather than accidental. `build_slots` is 720 rows on the clone, built once per validate call.

---

### Phase B — construction quality (deterministic ordering)

Phase B is worth 5 to 14 percent on its own, an order of magnitude less than phase A. It is here because it is cheap, deterministic and risk-free, and because a better seed makes phase C's descent shorter.

#### B1. `_spread_conflicts` may interleave two competitions

**Files.** `scheduler.py`: the bucket key at :2069.

**Change.** `key = (_phase_sort(m), m.stage_no, m.round_no)`. The `by_order` sort key at :2059 keeps `*_pace(...)`, so the authored `competition_priority` still decides who asks for a slot first. Only what counts as a **tie** widens, which is what the function's own docstring says it is for.

**Why.** Measured: 48 buckets over 113 matches, every one holding exactly one competition, 21 of them singletons, so `_spread_conflicts` is a no-op on more than half the draw. Meanwhile `no_institution_overlap` is authored `within: sport`, so one school's teams across four categories are all mutually linked — exactly the group the spread cannot currently see.

**Success criterion.** On the live clone: bucket count falls and at least one bucket holds more than one competition; idle **does not rise**; unplaced stays 0. 613+ green.

**Tests** (`test_competition_priority.py`): a two-competition bucket that the spread now interleaves; an assertion that the authored priority order is still respected as the incoming order inside the bucket; determinism (two runs identical).

**Risk.** It changes the emitted fixture for any tournament with a `competition_priority` record, so existing ordering tests need refreshed expectations. **Mitigation:** the round term stays in the key (dropping it was measured catastrophic: 90/113 placed), and precedence is a hard gate in `feasible`, not an ordering assumption, so no bracket can invert.

#### B2. Best-of-K deterministic ordering variants

**Files.** `scheduler.py`: `schedule_matches` (:2203-2253) and the ordering block it drives.

**Change.** Generalize the existing keep-the-best wrapper. Today it runs a second pass only when the first leaves matches unplaced, and the varied knob is `reserve_phases`. Make the knob a short **ordered, fixed** list of deterministic tie-break variants — `[authored order, wide-spread bucket, court-balanced]` — and keep the best by the existing key (fewest unplaced, then better soft score) with strict `>` so the authored order wins ties. Run the extra variants when the first pass is already complete only if `cfg.optimize` is set, so the default preview keeps its latency.

**Why.** Measured across two rule snapshots of the same draw: best-of-3 saves 20 to 50 idle minutes and never loses a match. It also gives `schedule_matches` a lever for the "everything placed but gappy" case, which it has none for today.

**Success criterion.** Live clone with `optimize` on: idle at the seed falls below the current 175 (target <= 150) and unplaced stays 0; two runs in separate processes produce byte-identical assignments. One greedy pass measures ~3 s, so K passes must be counted against `MAX_DRAW_SECONDS` (see C3) — preview wall time must stay under 30 s. 613+ green.

**Tests** (`test_scheduler.py`): determinism across two calls; a config where a variant beats the authored order (assert the better one is kept); a config where nothing beats it (assert byte-identical to a single pass).

**Risk.** K passes multiply the draw budget. **Mitigation:** gated on `cfg.optimize`, and C3 restructures the preview budget in the same phase; if the measured preview exceeds 30 s, drop K to 2.

#### B3. The court reservation's prefer-versus-lock toggle must do something

**Files.** `scheduler.py`: `preference` (:1850-1851).

**Change.** Replace the bare `score -= 100.0` overflow penalty with a named module constant scaled to the other soft terms (earliness is capped at 1.0, a preferred window is 2.0), e.g. `_COURT_OVERFLOW_PENALTY`, and document the number. The `exclusive: true` case is unaffected: it is refused outright by `court_open_to` inside `feasible`, which is where a lock belongs.

**Why.** Measured: scheduling the clone's venues with `exclusive: false` and again with `exclusive: true` produces **byte-identical** assignments (same digest, same soft score). The host's choice between "prefer" and "lock" has no effect whatsoever, because a 100-point penalty against a 1-point earliness term means a preferred court a whole day later always beats a free non-preferred court now. `court_open_to`'s own docstring states the intent: a preference court "would rather host a waiting match than stand empty".

**Success criterion.** A test config with a busy preferred court and a free non-preferred one produces **different** schedules under `exclusive: true` and `exclusive: false` (today they are identical). On the live clone, unplaced stays 0 and idle does not rise. If the measured idle does not improve, keep the change anyway (the toggle must work) but do not tune the constant further in this plan.

**Tests** (`test_court_competitions.py`): the prefer-versus-lock case above; `exclusive: true` still refuses outright; determinism.

**Risk.** It changes where matches land for every tournament with reservations. **Mitigation:** the constant is named and documented so the settings UI can explain it later; existing court-reservation tests are extended rather than replaced.

---

### Phase C — the packing pass

#### C1. An objective that can see the gap

**Files.** `optimizer.py`: `assignment_quality` callers and the comparison keys in `_local_search` (:353, :369-372) and `optimize_schedule` (:601-607). New helper beside `court_packing` in `scheduler.py`.

**Change.** The optimizer stops comparing a single rounded float and compares an explicit lexicographic tuple of exact integers:

```
(matches placed, -makespan_minutes, -within_window_idle_minutes, soft_score)
```

`makespan_minutes` = last end minus the calendar's first start. `within_window_idle` = the existing `court_packing` idle. `soft_score` stays the **unrounded** `_score_soft` blend, used only as the final tie-break. `_score_soft` itself is **not** changed: it is the displayed quality and moving it would shift readiness and dozens of tests for no scheduling gain.

**Why.** Two measured defects, one fix. First, a move must currently remove roughly 11 minutes of idle before `round(..., 3)` can even see it, while the slot grid steps 5 minutes and a table-tennis match is 10, so the natural unit of compaction is a plateau move. Second, `court_packing` measures idle only between a court-day's own first and last match, so `Audi · T2` on day 2 plays 20 minutes out of 390 and scores a **perfect** packing ratio; there is no makespan or earliness term anywhere in the objective, so nothing rewards pulling a match into an empty morning or finishing the day earlier.

Note deliberately: minimizing total free grid minutes would be useless, because when every match is placed the played total is a constant. Makespan and within-window idle are the two quantities an arrangement can actually change.

**Success criterion.** On the live clone after A1: idle falls further than A1's measured 135 and **last whistle moves earlier than 15:15**; unplaced stays 0; the run is byte-identical across two processes. 613+ green.

**Tests** (`test_optimizer.py`): a hand-built pair of assignments differing by a 5-minute compaction, asserting the objective now distinguishes them (it does not today); an assertion that a proposal with one more match placed beats a tidier one with fewer.

**Risk.** Makespan pulls against the day-spread soft term (the players' day). **Mitigation:** spread stays in the tie-break, and every rest, cap and barrier rule is hard and untouched. If an organizer objects, the weighting becomes a catalog record, not a constant.

#### C2. A deterministic descent aimed at the holes

**Files.** `optimizer.py`: `_local_search` (:328-380), `optimize_schedule` (:570-596).

**Change.** Replace the uniform random sampler with a **deterministic gap-targeted first-improvement descent**:

1. Enumerate the current schedule's idle spans from the venue ledger, ordered largest-first with `(venue, start)` breaking ties.
2. For each span, walk the matches whose candidate list contains a start inside it, in the draw's own deterministic order.
3. Accept the first strictly-improving move under C1's key; repeat from step 1 until a pass finds no improving move, or a fixed move cap is reached.
4. Legality per candidate move uses an **incremental delta check** over pre-built venue / team / link / precedence indexes (measured at ~10 microseconds against ~3.3 milliseconds for a full re-validation, 335x), and every **accepted** move is then confirmed by the full `validate_schedule` + `_capacity_ok` gate before it is kept.

`rng` disappears from the accept path. `cfg.optimize_seconds` becomes a pure **safety abort** that returns the seed unchanged, sized so it never fires in practice.

**Why.** Measured: 3904 iterations in 20 s, 0 accepted; under a clean seed, 52 improving moves out of 37,248 samples in 180 s, because 89% of random slots are already occupied and the sampler has no idea where the holes are. A deterministic descent over the *same* single-relocation move set reached a near-packed schedule in 28 moves and 19 s while honouring every placer rule.

**This step explicitly rejects** the clock-driven budget the optimizer audit recommended (`loop until the deadline`). It would make the amount of search a function of machine load, so publish could produce a different fixture than preview. Determinism and preview-equals-commit outrank the extra minutes.

**Success criterion.** On the live clone: **within-window idle <= 60** (must-pass bar: <= 100, from 175), last whistle earlier than 15:15, unplaced 0, `validate_schedule` on the result empty, an independent placer-rule audit reporting 0 link breaches, and byte-identical output across two separate processes. The pass completes in under 10 s (down from 20 s of nothing). 613+ green.

**Tests** (`test_optimizer.py`): determinism across two calls and two processes; a hand-built schedule with one obvious hole and one match that can legally fill it, asserting the descent fills it; an assertion that the delta check and `validate_schedule` agree on a corpus of candidate moves (the guard against reintroducing phase A's divergence); an assertion that the result is never worse than the seed.

**Risk.** The delta check drifting from the validator is exactly the fault phase A exists to remove. **Mitigation:** the agreement test above, plus the full-validator confirmation on every accepted move, plus the seed-is-the-floor guarantee.

#### C3. Optimize once, on the winning draw, by default

**Files.** `backend/apps/fixtures/services/preview.py` (the draw-retry loop at :697-717, `_schedule_and_payload` at :496-545), `backend/apps/fixtures/services/scheduler.py::apply_schedule` (:3409-3418), `frontend/src/features/fixtures/DryRunPreviewPage.tsx::schedulePayloadFrom` (:83-99).

**Change.** Three coordinated edits.
1. Run the draw-retry loop with the packing pass **off** (draw selection is about placement, which the greedy decides), then optimize the winning draw exactly **once**.
2. Default `pack = true` in `schedulePayloadFrom` and keep the toggle as an off switch. Preview and Publish already send the same memo, so preview equals commit is preserved.
3. Mirror the same "one greedy, one optimize" shape in `apply_schedule`, so the published run reproduces the previewed one.

**Why.** Measured: the deadline is checked only at the top of the loop, and a preview with `optimize` on costs 25.5 s against a 7.0 s draw budget, so enabling "Fill the gaps" silently collapses the documented ten draw attempts to **one**. The host gets the worse of both features on exactly the tournament where the retry matters. And with C1 and C2 landed, the packing pass is worth its seconds, so the organizer should not have to know to ask for it.

**Success criterion.** Preview wall time with the default payload stays **under 30 s** (gunicorn's request cap is 60 s and 5 workers share 2 cores, so measure under two concurrent previews); the draw loop performs more than one attempt on a draw that leaves matches unplaced; preview and publish on the same seeds produce identical assignments (assert in a test, not by eye). 613+ green and the frontend suite green.

**Risk.** More CPU on every preview, on a 2-core box that already OOMs on builds. **Mitigation:** C2 makes the pass cheaper than today's inert 20 s; measure under concurrency before landing; the toggle remains as an escape hatch, and `MAX_DRAW_SECONDS` is retuned in the same edit now that one attempt is measured at ~3 s of greedy.

#### C4. Unfreeze pinned matches (depends on A5)

**Files.** `optimizer.py`: `optimize_schedule` (:549-560).

**Change.** Stop freezing pinned matches. Filter their candidate lists through `_pin_ok` instead, now that `validate_schedule` checks the full pin (A5).

**Why.** The freeze exists only as a workaround for the validator gap, stated in the code's own comment. It excludes a whole class of matches, including the finals, from the search, which is where the last afternoon's holes are.

**Success criterion.** With a pinned-round record, the optimizer may move a pinned match **within** its pin window and never outside it; the finals-pin tests keep passing; idle on a pinned tournament improves or is unchanged. 613+ green.

**Tests** (`test_finals_venue_pin.py`): a pinned match relocated within its window; a proposal moving it outside the window rejected by the gate.

**Risk.** Unfreezing is a behaviour change of its own. **Mitigation:** land it as a separate commit from A5 so a regression in one is not attributed to the other.

---

### Phase D — tell the host the truth (reporting only, no scheduling change)

#### D1. A court that never played still appears in the Courts view

**Files.** `frontend/src/features/fixtures/courtLoad.ts::courtDayLoads` (:166-175).

**Change.** Pass the full expanded court list (the preview already knows it) and seed `byCourt` with an empty list for every (day, court) in range, so an unused court renders as a full-day free stretch.

**Why.** `byCourt` is built only from placed rows, so a court with no match on a day produces no row, no free minutes and no contribution to `courtTotals`. On the live clone `Audi · T2` on day 2 already reads 20 played against 370 free; one more constraint tips it to zero and it vanishes from the report entirely. The single worst case an organizer needs to see is the one case the model drops.

**Success criterion.** A vitest case with a court that has no matches on a day renders it with the full day free; `courtTotals.freeMinutes` includes it. Frontend suite green, `type-check` clean.

#### D2. Say which setting is making the day long

**Files.** `backend/apps/fixtures/services/readiness.py` (`_courts_for_leaf` already buckets supply per competition), plus the preview's Courts tab.

**Change.** Add a per-competition supply-versus-demand reading, and attribute each idle stretch to the rule that produced it (the greedy already knows: `phase_lo` is what refused the earlier slot). Wording is generated from the records, never naming a sport in code, no em-dashes or arrows.

**Why.** 1450 of the clone's 1840 free court-minutes are courts the host's own reservations forbid the busy sport from using, and 84% of the reclaimable idle sits immediately before a phase change the host authored. No placement heuristic can recover either. The honest product answer is to show the host which single setting is making the day long, rather than letting them believe the scheduler is lazy.

**Success criterion.** The Courts tab reports, per competition, playable minutes against demanded minutes and the binding rule; a backend test asserts the reading matches a hand-computed case. Nothing about the schedule changes.

---

## 5. What this plan does NOT do, and why

* **No CP-SAT rewrite.** A full-problem encoding is genuinely feasible and reaches 15 to 35 minutes of idle, but it needs 120 to 180 s on this 2-core box against a 60 s gunicorn cap, of which 6.5 to 9.5 s is presolve alone. It cannot be a synchronous default, and a background job with polling is a separate project. The existing `_cpsat_propose` is left alone: it cannot build its model at this size (about 130 minutes of pure-Python construction) and it models neither precedence, `phased_finish`, `official_capacity` nor the scoped link gaps, so it stays behind its opt-in engine flag as dead-but-harmless. Revisit after phase C is measured.
* **No most-constrained-first, no backtracking, no regret dispatch.** Measured: at decision time the minimum candidate domain across all 113 matches is 80 of 720 slots and no match ever has fewer than 20, so the premise (an early match stealing a later one's last slot) does not occur. A min-domain selector costs 13 to 20x the runtime for **zero** gain, and it would silently override the host's authored `competition_priority`, which the house rules forbid. Earliest-start dispatch packs harder but strands 15 to 16 matches, which violates goal 1.
* **No multi-start, annealing or RNG diversification.** All of them make the output depend on how many walks fit in the time available, which breaks determinism and preview equals commit.
* **No clock-driven search budget** (see C2).
* **No raising the gunicorn timeout.** If a run does not fit 60 s it belongs in a background job, not in a longer request.
* **No further changes to `_phase_sort`.** It was fixed today so a four-team category's round 1 (which IS its semi-final) is not pushed back. Any future change here needs a regression test that such a category still plays in the morning. The "pull the gating phase early" idea from the gaps audit is deferred: it is a heuristic worth 240 minutes on paper, but it interacts with a rule that was changed today and phase C reaches the same minutes from the safe side.
* **No change to `_score_soft`'s blend.** It is the displayed quality; the optimizer gets its own explicit objective instead (C1).
* **No honouring `hard: false` on `official_capacity`.** Records carrying it would silently lose their limit. Capacity stays hard by construction, and A4 documents that at the construction site.
* **No loosening of `phased_finish`, the court reservations or the officials cap to reclaim the 1450 structurally reserved minutes.** Those are the host's authored choices. D2 reports them; the engine obeys them.

## 6. Execution notes

* Land each step as its own commit with its tests, and run `backend/.venv/bin/python -m pytest -c backend/pyproject.toml backend/apps/fixtures -q` plus `ruff check backend/apps/fixtures` before each. Frontend steps additionally need `npm --prefix frontend run test` and `type-check`.
* Re-measure the live clone after each phase with the read-only probes; the numbers in section 2 are the reference. **Caveat:** the clone is being edited by other sessions (its constraint list moved from 14 to 18 records during the audits, and the measured idle read 310, 365 and 410 within minutes under an older snapshot). Freeze the inputs to a pickle before any A/B comparison, and never compare a number from one snapshot against a number from another.
* This box is the production server. The probes are read-only; do not run `migrate`, do not restart services, and gate any deploy on the owner.
