# Fixture Engine Redesign — Canonical Design Spec

**Date:** 2026-06-11 · **Status:** Draft v2 (v1 synthesized from codebase map, domain research, Nagaland scenario catalog, UX design; v2 adds binding Critique amendments — §9)
**Supersedes nothing; extends:** `2026-06-06-tournament-rules-constraints-design.md`, `v1Fixtures.md`, PRD §5.
**Prime directive:** extend `generate.py`, `scheduler.py`, `constraints.py`, `FixturesTab` + wizards — never rewrite. All ~710 backend / ~274 frontend tests stay green; every API change is backward-compatible (old payloads keep working).

---

## 1. Vision & scope

The **fixture stage is data preparation + generation, and nothing else.** It is a funnel:

```
Global setup (asked once) → per-competition format config → constraints review
→ readiness checklist → dry-run preview (pure simulate) → accept & persist
```

In scope: calendar/venues/defaults capture, per-competition draw configuration, the constraint catalog v2, pairing-time generation (round-robin ×1/×2, knockout, groups→knockout, third place, seeding methods), slot-time scheduling, readiness checks, a non-persisting preview, and the wizard UX that drives it.

Out of scope (explicitly): score entry / match management (ScoreRow, "Live" links move out of this stage), officials *assignment* (only a capacity cap in v1), Swiss / double-elim / Page playoff / ladders / pot-based draws, athletics multi-entrant events (2-team `Match` model cannot represent heats/lanes — flagged v2 `Event` entity), CP-SAT optimization (the `schedule_matches` interface is the swap point), candidate-schedule comparison.

Design tenets (from domain research, binding):
1. **Never re-ask what is known.** Globals asked once; per-competition wizards show them read-only with an Edit link.
2. **Explain, don't just reject.** Infeasibility returns the violating constraint records + concrete relaxations ("demote `category_session_window` to soft", "add a day", "add a venue"), never a generic error.
3. **Deterministic + replayable.** Seeded RNG; the seed is stored with the draw config and in the audit event so any draw can be reproduced and disputed.
4. **Preview persists nothing** until Accept (idempotent `event_id`, invariant 3).
5. **Two-phase generation stays.** The existing `generate.py` (pairings) vs `scheduler.py` (slots) split is correct — "generate draw now, schedule times later" is a supported path.

---

## 2. Data model deltas

### 2.1 Per-competition draw config → new `Tournament.draw_config` JSONB column

**Decision (owner to confirm — see Decisions log):** a new JSONB column on `Tournament`, **not** inside `Tournament.rules` and **not** a new model.

Rationale:
- `Tournament.rules` is frozen at `registration_open` (invariant 7) because it is the **participant contract** (points, match length, squad sizes). Draw config (format, group size, legs, seeding method, third place) is **organizer generation input** that is routinely finalized *after* registration closes — you cannot know group counts before you know team counts. Putting it in `rules` would force an amend+reason+notify cycle for every routine wizard edit, abusing invariant 7's grace machinery.
- A new model (`CompetitionConfig`) buys nothing over a keyed JSONB: competitions (leaves) are already JSONB-defined in `Tournament.sports`, there is no per-leaf FK target, and a model adds serializer/admin/migration surface for a pure config blob.
- A single additive, nullable-default migration is cheap and backward-compatible. (Deploy note: migrations are blocked while any tournament is `live` — schedule the deploy accordingly.)

Shape (`backend/apps/tournaments/models.py`):

```python
draw_config = models.JSONField(default=dict, blank=True)
# { "<leaf_key>": DrawConfig, "*": DrawConfig }   "*" = tournament-wide defaults
```

`DrawConfig` (validated by a whitelist merger mirroring `merge_rules`, new module `backend/apps/fixtures/services/draw_config.py`):

```json
{
  "format": "round_robin | knockout | groups_knockout",
  "group_size": 5,
  "advance_per_group": 2,
  "legs": 1,                      // 1 | 2 (double round-robin, mirrored 2nd leg)
  "seeding": "registration",      // registration | random | snake | seeded
  "seed": 1234567,                 // RNG seed; set on first random draw, replayable
  "third_place": false,            // knockout formats only
  "bye_policy": "seeded_byes",    // seeded_byes | preliminary_round (preliminary_round deferred)
  "min_entries_action": "prompt", // prompt | cancel (auto_champion DEFERRED — §9 A6)
  "constraints_reviewed_at": null  // ISO timestamp set by "Mark reviewed"; cleared when constraints change after review (§9 A10)
}
```

**Freeze semantics:** `draw_config[leaf]` is mutable until non-deleted matches exist for that leaf; after that, edits are allowed but flagged — the changed config alters `inputs_hash` (see §2.5) and surfaces the regenerate/keep/diff banner (invariant 10). This replaces — not bypasses — invariant 7 for this data: the participant contract stays in `rules` under the existing freeze; generation inputs are governed by invariant 10 instead.

**Back-compat:** the legacy `rules.format / rules.group_size / rules.advance_per_group` keys remain in `DEFAULT_RULES` (read-compatible) and act as a final fallback layer: effective config = `DEFAULT_DRAW_CONFIG < rules legacy keys < draw_config["*"] < draw_config[leaf] < explicit API request params`. Explicit request params always win, so every existing caller/test is unaffected.

**Write path:** new service `update_draw_config(tournament, leaf_key, partial, by, event_id, request)` modeled on `rules.update_settings` (whitelist merge, `event_id` idempotency via AuditEvent, `emit_audit("draw_config_updated")`). Exposed as `PATCH /api/tournaments/{id}/draw-config/` body `{leaf_key|"*", config, event_id}` — gate `tournament.bracket_editor` manage verb.

### 2.2 Constraint records (no migration)

`Tournament.constraints` keeps the exact record shape `{type, scope, hard, weight, params}` from `constraints.py::validate_constraints`. Two changes:

- **Scope grammar** (currently stored, never read) becomes real:
  `"all" | "sport:<sport_id>" | "leaf:<leaf_key>" | "team:<team_id>" | "tag:<key>=<value>"`
  Tag keys resolved against existing data: `school=<institution_id>` (Team.institution FK), `district=<value>` (Stage-1 institution registration data), `seed_pot=<n>` (derived from Team.seed quartiles). `validate_constraints` gains scope-syntax validation; unknown grammar → ValueError (new records only; stored legacy records normalize to `"all"`).
- **`weight`** (soft constraints): integer 1–10, default 5; consumed by `_score_soft` as a multiplier. Hard constraints ignore weight (unchanged).

Adding a scenario = catalog entry + handler. **Never a migration.**

### 2.3 Venue model — reuse + one field

Reuse the existing org-scoped `Venue` (`backend/apps/fixtures/models.py`: UUID7, unique name per org, `venue_type`, `windows` JSONB). One additive field:

```python
count = models.PositiveSmallIntegerField(default=1)  # courts/tables/pitches at this venue
```

`build_slots` expands a `count=4` TT hall into 4 parallel sub-venues (`"MP Hall · T1"…`); `Match.venue` keeps storing the display name string (no FK migration — least invasive, matches current name-resolution behavior). Venue availability stays on `Venue.windows` — **no** `venue_hours` constraint type is added (it would duplicate the model). Daylight-only grounds are expressed as a window closing 16:30. The existing Venue CRUD API (`/api/tournaments/{id}/venues/`) finally gets a frontend consumer (GlobalSetupWizard, §6).

### 2.4 Officials — minimal in v1

**No `Official` model in v1.** Research shows referee assignment is its own NP-complete problem; the Nagaland v1 need is "we only have 2 qualified TT umpires, don't schedule 3 TT matches at once." That is a **capacity constraint**, not an assignment: new constraint type `official_capacity {count}` scoped `sport:<id>` caps concurrent in-flight matches per sport in the slot grid — implemented exactly like venue occupancy (the unifying insight: venues, officials, multi-sport students are all *resources with capacity + availability windows*; one interval-overlap engine serves all three). Full Official model + assignment + conflict-of-interest: **deferred v2**.

### 2.5 `inputs_hash` v2 (invariant 10)

Currently `sha256(sorted team ids)`. Becomes:

```
sha256(sorted_team_ids + canonical_json(effective_draw_config) + canonical_json(pairing_scope_constraints))
```

where `pairing_scope_constraints` = the subset of constraint records the **pairing layer** consumes (e.g. `keep_apart_until_round`). Slot-time constraints do NOT enter the draw hash (they hash into `scheduling_config` staleness separately). Existing matches keep their stored hash; the staleness check recomputes v2 and reports "inputs changed" — which is correct, because adding draw_config IS an input change. The generation audit event records `{seed, draw_config snapshot, constraint snapshot, algorithm: "generate.py", version}`.

### 2.6 New rules keys (participant-contract side, normal freeze applies)

Add to `DEFAULT_RULES` whitelist: `withdrawal_policy: {"fixtures": "walkover", "rr_results": "void_if_under_half_played"}` and `small_group_double_rr: {"max_size": 0}` (0 = off; when a group ≤ max_size, generator emits legs=2 for that group). These are participant-facing (they change competitive outcomes) so they correctly live under the invariant-7 freeze.

**Binding rule:** a rules key ships in the **same increment as its consumer**, never before — a frozen participant contract that nothing enforces is worse than no key (organizers would believe withdrawals are handled). `small_group_double_rr` lands with increment 3; `withdrawal_policy` lands with increment 16 (§9 A7).

---

## 3. Constraint catalog v2

Layer legend — **P** = pairing-time (consumed by `generate.py` when forming groups/brackets); **S** = slot-time (consumed by `scheduler.py` over the venue×time grid). The grid is built **subtractively**: daily window − recurring blackout windows − blackout dates − ceremony blocks − reserve days, intersected per-venue with `Venue.windows`; pinned rounds are placed first, then rounds fill chronologically.

| Type | Params schema | Default | Scope | Layer | v1? | Enforcement |
|---|---|---|---|---|---|---|
| `no_double_booking_team` | `{}` | hard | all/sport/leaf | S | ✅ exists | team interval overlap (built-in, always on) |
| `min_rest_minutes` | `{minutes:int}` | hard | all/sport/leaf/team | S | ✅ exists → scoped | rest gap between a team's matches; per-sport scoping new (football ≥ a day soft, TT 30min hard) |
| `venue_single_use` | `{}` | hard | all | S | ✅ exists | venue interval overlap (sub-venue aware after §2.3) |
| `max_matches_per_team_per_day` | `{count:int}` | hard | all/sport/leaf | S | ✅ exists → scoped | per-day cap; per-sport values (football 1, TT 4, badminton 3) |
| `blackout_dates` | `{dates:[date]}` | hard | all/sport/leaf | S | ✅ exists | dates excised from grid (exams, holidays) |
| `team_unavailable` | `{team_id, dates:[date]}` | hard | team | S | ✅ exists | removes that team's candidate slots (school exam dates) |
| `keep_apart_until_round` | `{key:"school"\|"district"\|"seed_pot"\|"tag:<k>", until_round:int}` | hard | all/sport/leaf | **P** | ✅ **implement (currently no-op)** | generalizes `_separate_institutions`: same-key teams → different groups / opposite bracket halves until round N; if mathematically infeasible, auto-degrade to soft + named warning |
| `preferred_window` | `{days:[weekday], from:time, to:time}` | soft | all/sport/leaf/team | S | ✅ exists | +weight score in window |
| `avoid_back_to_back` | `{}` | soft | all/team | S | ✅ exists | maps to built-in fresh-day scoring |
| `even_spacing` | `{}` | soft | all | S | ✅ exists | maps to built-in day-spread scoring |
| `balance_venues` | `{}` | soft | all | S | ✅ exists | 1/(1+load) venue scoring; counters host-school home advantage |
| `recurring_blackout_window` | `{days:[weekday]\|null, from:time, to:time}` | hard | all/sport/leaf | S | ✅ **new** | subtracted from every matching day; covers Sunday-morning church (default ON, days=[Sun], to=13:00) AND daily lunch/assembly breaks (days=null ⇒ all days) — one type, no separate `break_window` |
| `ceremony_block` | `{date, from:time, to:time, venues:[name]\|null}` | hard | all | S | ✅ **new** | block removed from grid; opening/closing ceremonies; optional marquee-match-after handled by UI placing a `round_pinned_to_window` |
| `round_pinned_to_window` | `{round:"final"\|"semi_final"\|int, date?:date\|"last_day", from?:time, to?:time}` | hard | leaf | S | ✅ **new** | pinned matches placed FIRST; earlier rounds back-fill respecting rest ("football final last day 14:00") |
| `category_session_window` | `{days:[weekday]\|null, from:time, to:time}` | **soft** (hard toggle) | sport/leaf | S | ✅ **new** | partitions grid per competition before solving (U14 mornings, U17 afternoons) |
| `no_person_overlap` | `{min_gap_minutes:int=30, cross_venue_gap_minutes:int=60}` | hard | all | S | ✅ **formalize** | already implemented implicitly (linked-team shared-Player non-overlap, invariant 8); becomes a visible catalog record with tunable gaps |
| `official_capacity` | `{count:int}` | hard | sport | S | ✅ **new** | caps concurrent matches of that sport (resource-capacity engine, §2.4) |
| `reserve_days` | `{dates:[date]}` | directive | all/sport | S | ✅ **new** | dates excluded at generation, reserved for the postponement repair tool; scope `sport:` lets indoor sports keep playing |
| `seed_separation` | — | — | — | P | ✅ | **not a new type**: `keep_apart_until_round` with `key:"seed_pot"` |
| `neutral_venue_for_round` | `{round, venue:name}` | hard | leaf | S | ⏳ v2 | pin a round to a venue (finals neutrality) |
| `final_order` | `{sequence:[leaf_key]}` | soft | all | S | ⏳ v2 | order finals on the last day (football last) |
| `cluster_team_matches` | `{max_span_days:int, same_day:bool}` | soft | tag/team | S | ⏳ v2 | minimize span for travelling-district teams (needs span objective) |
| `earliest_start_first_day` | `{time:time}` | soft | tag/team | S | ⏳ v2 | no early day-1 start for far districts |
| RobinX BR/FA/CA/SE families (break balance, carry-over, home/away counts, travel) | per ITC2021 | soft | — | S | ⏳ v2 | adopt naming from robinxval.ugent.be when a real optimizer lands |

Catalog served (as today) by `GET /api/tournaments/constraint-types/`, with `params_schema` driving the `ConstraintRow` field renderer. Hard = infeasibility (match goes to `unscheduled` with explanation); soft = weighted objective term — never blocking (FET model, unchanged).

**Infeasibility contract (binding):** when hard constraints jointly fail, the response's `explanation[]` is upgraded to structured `violations: [{constraint: <record>, matches: [ids], message, relaxations: [{action: "demote_to_soft"|"add_day"|"add_venue"|"raise_cap", target}]}]`.

---

## 4. Generation engine upgrades (`backend/apps/fixtures/services/generate.py`)

All upgrades are additive parameters on the existing functions; the API request body keeps working unchanged and wins over stored config.

### 4.1 Pure pairing core (enables preview)

Extract the pairing logic of each `generate_*` into pure `plan_*` functions returning `MatchPlan` dataclasses (`stage, group_label, round_no, home/away team-or-source, leaf_key, sport`) with **zero DB writes**; the existing `generate_*` functions become thin persistence wrappers (plan → bulk-create with `match_no`/`inputs_hash`/idempotency exactly as today). Existing tests pass untouched; the preview endpoint (§5) calls `plan_*` directly.

### 4.2 Double round-robin

`legs: int = 1` param on `generate_round_robin` / `generate_round_robin_by_category`. `legs=2`: after the circle-method single cycle, emit a mirrored second cycle (home/away swapped per pair — "inverted" symmetry), `round_no` continuing. `rules.small_group_double_rr.max_size` auto-applies legs=2 only to groups at or under the threshold (every team in a 3-team group gets ≥2 matches). `compute_standings` already aggregates by completed matches — no change needed.

### 4.3 Seeding methods

`seeding: str = "registration"` + `seed: int | None` params, read from effective draw_config:
- `registration` — current behavior (`_registered_teams` order: seed field then name). Default; zero behavior change for existing callers.
- `random` — `random.Random(seed)` shuffle; if `seed` absent, generate one, **persist it into `draw_config[leaf].seed`** and the audit payload (replayable draws).
- `snake` — serpentine distribution into groups (A,B,C,C,B,A,…) replacing the chunking in `generate_round_robin`; for knockout, snake maps to `_bracket_order` placement by seed (already the standard order — alias).
- `seeded` — strict `Team.seed` order; readiness check fails if any registered team in the leaf lacks a seed. **New seed-setting API:** `PUT /api/tournaments/{id}/teams/seeds/` body `{leaf_key, seeds: [{team_id, seed}], event_id}` (bulk, gate bracket_editor, audited) — `Team.seed` finally becomes settable.

`_separate_institutions` (and its generalization via `keep_apart_until_round`) runs **after** seeding as the constraint-repair pass, exactly as today — constraints outrank raw seed order, deterministically, never worsening.

### 4.4 Third-place playoff

`third_place: bool = False` on `generate_single_elimination` / `generate_knockout_from_groups`. When the bracket has semifinals, emit one extra match, `round_no = final's round_no`, `match_no` before the final, sources `home_source={type:"loser_of", match_id:<semi1>}`, `away_source={type:"loser_of", match_id:<semi2>}`, `stage="knockout"`, `group_label="3rd Place"`. `advance.py` **already resolves `loser_of`** — this is the first generator to emit it. (Full consolation/compass/classification brackets: deferred.)

### 4.5 Generator reads stored config (the open "generator-default" increment)

`GenerateFixturesView` resolves effective config per §2.1 layering before dispatch. A request body of just `{leaf_key, event_id}` now works — the wizard saves format via draw-config PATCH, then generation needs no params. Idempotency, `leaf_key` scoping, `_next_match_no`, SCHEDULED status + sport stamping: all unchanged.

### 4.6 Pairing-time `keep_apart_until_round`

Generalize `_separate_institutions` to key extractors: `school` → `team.institution_id` (current), `district` → institution Stage-1 district answer, `seed_pot` → seed quartile, `tag:<k>` → team tag lookup. Groups: spread same-key teams across groups (round-robin assignment by key-bucket size desc). Brackets: place same-key teams in opposite halves/quarters until `until_round`. Infeasible (more same-key teams than groups/slots) → place best-effort, demote that record to soft for this run, and emit a named warning in the result. Removes the documented "no-op note" in `merge_stored_constraints`.

### 4.7 Scheduler upgrades (`scheduler.py`)

- **Grid subtraction**: `build_slots` consumes `recurring_blackout_window`, `ceremony_block`, `reserve_days` (and per-venue `count` expansion).
- **Pinned-first placement**: matches matching a `round_pinned_to_window` are assigned first (error → violation record if they don't fit), then the greedy pass fills remaining rounds chronologically as today.
- **Scope resolution**: `merge_stored_constraints` filters records by scope against each `MatchSlotReq` (sport/leaf/team/tag) instead of applying globally; `weight` multiplies soft scores.
- **Resource capacities**: `official_capacity` enforced via the same busy-interval structure as venues.
- Greedy + local-search remains the solver; `schedule_matches` stays the CP-SAT swap point. `validate_schedule` (currently caller-less) gets its first production callers: the preview endpoint and (v2) the manual repair APIs.

---

## 5. Readiness checklist + dry-run/preview API

### 5.1 `GET /api/tournaments/{id}/fixture-readiness/`

Server-computed (FE never replicates logic). Gate: tournament member. Response:

```json
{
  "global": {"checks": [
    {"id": "calendar_set",  "status": "ok|warn|fail", "hint": "…", "fix": "settings"},
    {"id": "venues_defined","status": "…", "fix": "venues"},
    {"id": "constraints_reviewed", "status": "…", "fix": "constraints"}
  ]},
  "competitions": [
    {"leaf_key": "football.u15.girls", "label": "Football · U15 · Girls",
     "ready": false, "summary": "3/5",
     "checks": [
       {"id": "enough_teams",   "status": "fail", "hint": "1 registered team — minimum 2 (or choose auto-champion)", "fix": "teams"},
       {"id": "format_chosen",  "status": "ok"},
       {"id": "seeds_set",      "status": "warn", "hint": "Seeding method is 'seeded' but 4 teams have no seed", "fix": "seeds"},
       {"id": "calendar_set",   "status": "ok"},
       {"id": "constraints_reviewed", "status": "ok"},
       {"id": "already_generated", "status": "ok", "hint": "No existing draw"}
     ]}
  ]
}
```

Checks: `enough_teams` (≥2 registered in leaf, honoring `min_entries_action`), `format_chosen` (draw_config resolves), `seeds_set` (only when seeding=seeded), `calendar_set` (scheduling_config or wizard-saved dates exist), `venues_defined` (≥1 active Venue or config venues), `constraints_reviewed` (draw_config flag), `already_generated` (informational; existing draw + changed inputs_hash ⇒ `warn` with diff link — invariant 10). Hard-`fail` checks gate the dry-run CTA; `warn` does not.

### 5.2 `POST /api/tournaments/{id}/fixtures/preview/` — pure simulate

**Persists nothing. Touches no rows. No `event_id` (read-only POST).** Gate: bracket_editor.

Request: `{leaf_key?: str, draw?: <DrawConfig overrides>, schedule?: <ScheduleConfig overrides>, include_schedule: bool}`. Effective configs resolved exactly as the real endpoints would (so preview ≡ commit).

Pipeline: `plan_*` (pairing core, §4.1) → `build_schedule_inputs()` (shared with `apply_schedule` — synthetic `MatchSlotReq`s **plus `preoccupied` + `linked`**, §9 A1) → `schedule_matches` (already pure — operates on requests + config, returns `ScheduleResult` without writing) → response:

```json
{
  "matches": [{"ref": "p1", "leaf_key": "…", "stage": "group", "group_label": "A",
               "round_no": 1, "home": {"team_id"|"source"}, "away": {…},
               "scheduled_at": "…", "venue": "…"}],
  "unscheduled": ["p7"],
  "violations": [{"constraint": {…record…}, "hard": true, "matches": ["p7"],
                  "message": "…plain language…", "relaxations": [{…}]}],
  "soft_score": 0.91,
  "fairness": {"rest_min_by_team": {…}, "venue_distribution": {…}, "days_used": 6},
  "seed": 1234567,
  "inputs_hash": "…"
}
```

The `seed` returned is the seed that WILL be used on accept; Accept = the existing `generate-fixtures` + `schedule` endpoints with `event_id` + that seed, guaranteeing committed output equals the preview (determinism). Regenerate (re-roll) = preview again with `seed: null`.

### 5.3 Draw deletion (escape hatch)

`DELETE /api/tournaments/{id}/fixtures/?leaf_key=…&event_id=…` — soft-deletes a leaf's matches **only if every match in scope is still `scheduled` status** (nothing live/completed), audited (`draw_deleted`). Unblocks the "accepted the wrong draw" path that pure idempotency currently forbids.

---

## 6. Wizard flow (frontend, `frontend/src/features/fixtures/` — new dir)

`tabs/FixturesTab.tsx` becomes a thin shell rendering the hub. All strings `t()`, tokens only, custom Select/dialog/toast, `font-tabular` numbers, full-width pages, `useBreakpoint` for mobile.

| # | Screen | Asked | Components |
|---|---|---|---|
| 1 | **Fixture Setup hub** | — | `FixtureSetupHub.tsx`; `GlobalSetupCard.tsx` (answered globals as dl grid, per-row Pencil → reopens wizard at that step via `initialStep`); one `ReadinessChecklist.tsx` per competition (server checks §5.1, Check/Circle/AlertTriangle icons, "3/5 ready" + progress bar, deep-link fix actions); "Run dry run" gated on hard checks |
| 2 | **Global setup wizard** — **asked ONCE, edited forever** | Calendar (date range, `BlackoutDatesField` chips, `CeremonyField` opening/closing), Venues (`VenueRow`: name, type Select ground/court/hall, hours, **count**) → consumes the existing Venue CRUD API, Defaults (rest, max/day, slot minutes, Sunday-church toggle default ON), Review dl | `GlobalSetupWizard.tsx` (Dialog `variant="sheet"`), step rail extracted from ScheduleWizard → `components/ui/StepRail.tsx`; persists via settings PATCH (constraints) + venues API + draw-config `"*"` |
| 3 | **Competition format wizard** — per competition | format radio-cards (kept from `GenerateDrawWizard`), group size (live "→ N groups"), advance-per-group (**stored; `AdvanceToKnockoutDialog` prefills, never re-asks**), two-legs toggle, seeding Select (registration/random/snake/seeded → `SeedListEditor.tsx`, keyboard up/down, buttons on mobile), third-place toggle (knockout only). Header shows globals read-only ("Jun 20–28 · 2 venues · From global setup" + Edit). Footer **"Save format"** persists draw-config PATCH without generating | `CompetitionFormatWizard.tsx` (evolves `GenerateDrawWizard.tsx`), `SeedListEditor.tsx` |
| 4 | **Constraint builder** — inline hub section (not a dialog) | "Add constraint" Select from `constraint-types` catalog; `ConstraintRow.tsx` renders params from `params_schema` (int→number, time→time, dates→BlackoutDatesField, team_id→team Select), scope Select (All / competition chips / team), Hard/Soft segmented toggle (+weight 1–10 for soft), seeded Nagaland defaults badged "default", "Mark reviewed" → readiness flag | `ConstraintBuilder.tsx`, `ConstraintRow.tsx` |
| 5 | **Dry-run preview** — full page `routes.tournamentFixturesPreview(id)` | — | `DryRunPreviewPage.tsx`; `MatchesByDayGrid.tsx` (days × venue/slot, competition-colored chips, stacks on mobile); `ViolationsPanel.tsx` (hard `border-destructive` + plain language + relaxation buttons, soft amber, soft-score %); sticky footer Regenerate / Adjust constraints / **Accept & save** (`event_id`) |
| 6 | **Post-generation** | — | `CompetitionResultCard.tsx` (mini `BracketView` / group tables, soft-score chip, read-only — score entry is NOT this stage); `InputsChangedBanner.tsx` (invariant 10 regenerate/keep/diff). Locks + `SwapPairDialog`/`ReslotMatchDialog`/`RegenerateRestDialog` repair suite: **v2** (needs manual-edit API) |

Asked **once** (global): calendar, blackouts, ceremonies, venues, rest/caps defaults, recurring religious windows. Asked **per competition**: format, group size, legs, advance-per-group, seeding, third place. Asked **never twice**: anything above (prefill from stored config everywhere).

---

## 7. Build order — TDD increments (each independently shippable, value-ordered)

Tests first for every increment (state machine + permission-matrix + multi-tenancy isolation suites mandatory where touched). Run backend pytest + `npm --prefix frontend run test` + `type-check` per increment; commit per verified increment.

**v1 (this wave):**

1. **`draw_config` storage + generator-default read** — migration (Tournament.draw_config, Venue.count), `backend/apps/fixtures/services/draw_config.py` (DEFAULT_DRAW_CONFIG, merge, per-leaf freeze check), `update_draw_config` service, `PATCH /draw-config/` view+url, `GenerateFixturesView` resolves effective config. Closes the open "generator-default" increment. *Files:* `apps/tournaments/models.py`, `apps/fixtures/models.py`, `apps/fixtures/services/draw_config.py` (new), `apps/fixtures/views.py`, `apps/tournaments/urls.py`.
2. **Third-place playoff** — `third_place` in `generate_single_elimination`/`generate_knockout_from_groups`; first `loser_of` emitter; advancement test through `advance.py`. *Files:* `apps/fixtures/services/generate.py`, tests.
3. **Double round-robin** — `legs=2` mirrored cycle + `rules.small_group_double_rr`; standings aggregation test. *Files:* `generate.py`, `apps/tournaments/services/rules.py`.
4. **Seeding methods + seeds API** — `seeding`/`seed` params (random w/ persisted seed, snake, seeded), `PUT /teams/seeds/` bulk endpoint. *Files:* `generate.py`, `apps/teams/views.py` + urls.
5. **Pairing core extraction** — pure `plan_*` + `MatchPlan`; `generate_*` become persistence wrappers; zero behavior change (existing tests prove it). *Files:* `generate.py`.
6. **Constraint catalog v2 + scope/weight** — scope grammar validation, new types (`recurring_blackout_window`, `ceremony_block`, `round_pinned_to_window`, `category_session_window`, `official_capacity`, `no_person_overlap`, `reserve_days`), scope-aware `merge_stored_constraints`, weight in `_score_soft`. *Files:* `apps/fixtures/services/constraints.py`, `scheduler.py`.
7. **Scheduler grid + pinned-first** — subtractive grid (recurring windows, ceremonies, reserves, venue `count` sub-venues), pinned-round placement, structured `violations` with relaxations. *Files:* `scheduler.py`.
8. **Pairing-time keep-apart** — generalize `_separate_institutions` to key grammar; remove the no-op. *Files:* `generate.py`, `scheduler.py` (drop note).
9. **Readiness endpoint** — `GET /fixture-readiness/`. *Files:* `apps/fixtures/views.py` (or `services/readiness.py` new), `apps/tournaments/urls.py`.
10. **Preview endpoint + draw delete** — `POST /fixtures/preview/` (pure simulate via increments 5+7), guarded `DELETE /fixtures/`. *Files:* `apps/fixtures/views.py`, `services/preview.py` (new), urls.
11. **FE: StepRail + GlobalSetupWizard + GlobalSetupCard** — extract rail, build Screen 2 (first consumer of Venue CRUD). *Files:* `frontend/src/components/ui/StepRail.tsx`, `frontend/src/features/fixtures/{GlobalSetupWizard,GlobalSetupCard,VenueRow,BlackoutDatesField,CeremonyField}.tsx`.
12. **FE: hub + readiness** — Screen 1. *Files:* `features/fixtures/{FixtureSetupHub,ReadinessChecklist}.tsx`, slim `features/tournaments/tabs/FixturesTab.tsx`.
13. **FE: CompetitionFormatWizard + SeedListEditor** — Screen 3, prefilled, "Save format" without generating; AdvanceToKnockoutDialog prefills advance_per_group. *Files:* `features/fixtures/{CompetitionFormatWizard,SeedListEditor}.tsx`.
14. **FE: ConstraintBuilder** — Screen 4 inline section driven by `params_schema`. *Files:* `features/fixtures/{ConstraintBuilder,ConstraintRow}.tsx`.
15. **FE: DryRunPreviewPage + accept** — Screen 5, new route, Accept→generate+schedule with `event_id`+seed+`expected_inputs_hash` (§9 A1); post-gen `CompetitionResultCard` (read-only) + `InputsChangedBanner`. *Files:* `features/fixtures/{DryRunPreviewPage,MatchesByDayGrid,ViolationsPanel,CompetitionResultCard,InputsChangedBanner}.tsx`, `lib/routes.ts`.
16. **Team withdrawal (minimal)** — `withdraw_team(team, by, event_id, reason)` service: marks the team withdrawn, walkovers its remaining `scheduled` matches via the existing transition (advance.py ripple is free), `compute_standings` honors `rules.withdrawal_policy.rr_results`; a walkover-loser semifinalist does **not** auto-fill a `loser_of` third-place slot (slot → walkover for the other side). `POST /api/tournaments/{id}/teams/{team_id}/withdraw/`, gate bracket_editor, audited. Ships `rules.withdrawal_policy` (§2.6). *Files:* `apps/teams/services/` (new), `apps/tournaments/services/standings` path, views/urls. Full postponement/repair stays v2.

**Deferred (v2+):** repair suite (lock/swap/reslot/regenerate-rest + manual-edit API wiring `validate_schedule`), `neutral_venue_for_round`, `final_order`, `cluster_team_matches`/`earliest_start_first_day` (travel), postponement repair workflows (reserve-day filling, match `postponed` flow), preliminary-round bye policy, `min_entries_action: auto_champion` (needs a leaf-status/champion entity — §9 A6), two-legged knockout ties (aggregate scoring), `best_n_thirds` cross-group qualification + points-per-game normalization for unequal groups, `venue_for_team {team_id, venue, mode: prefer|avoid}` (host-school home/away pinning), Official model + assignment, Swiss / double-elim / Page / ladders / pots, RobinX BR/FA adoption + fairness scorecard, candidate-schedule comparison, CP-SAT backend, athletics `Event` entity.

---

## 8. Decisions log

| # | Decision | Rationale |
|---|---|---|
| D1 | Draw config in a **new `Tournament.draw_config` JSONB column** keyed by leaf (not inside `rules`, not a model) | Invariant 7 freezes the participant contract at registration_open; draw config is generation input finalized after registration — governing it by invariant 10 (inputs_hash) instead avoids abusing the amend/notify path. **Owner to confirm** (brief offered "inside rules" vs "new model"). |
| D2 | Officials = `official_capacity` concurrency cap only in v1; no Official model | Real need is "don't exceed N concurrent matches per sport"; assignment is NP-complete and deferred. |
| D3 | Venue availability stays on `Venue.windows` (+ new `count`); no `venue_hours` constraint type; `Match.venue` stays a name string | Avoid duplicating the model; FK migration is not needed for v1 value. |
| D4 | `break_window` folded into `recurring_blackout_window` (days=null ⇒ all days) | One type, one handler. |
| D5 | `seed_separation` = `keep_apart_until_round` with key grammar | One pairing mechanism for school/district/seed-pot separation. |
| D6 | Preview is a no-`event_id`, zero-persistence POST; Accept reuses existing generate/schedule endpoints with the previewed seed | Invariant 3 stays on the mutating endpoints; determinism guarantees preview ≡ commit. |
| D7 | Guarded `DELETE /fixtures/?leaf_key=` added | Idempotency otherwise makes a mistaken accepted draw permanent. |
| D8 | Athletics excluded from v1; wizard says so when athletics is selected | 2-team Match model cannot represent heats/lanes. |
| D9 | `inputs_hash` v2 includes draw_config + pairing constraints; old hashes read as "inputs changed" | That IS an input change; invariant 10 banner handles it. |
| D10 | Preview and commit share one `build_schedule_inputs()`; Accept carries `expected_inputs_hash`, mismatch → 409 | Without this, preview ≡ commit (tenet 3 / D6) is a lie under concurrency. See A1. |
| D11 | Rules keys ship with their consumers; minimal `withdraw_team` is v1 (increment 16) | An enforced-by-nothing frozen contract misleads participants; walkover machinery already exists. See A7. |
| D12 | `auto_champion` deferred; sub-venue expansion must absorb legacy bare-name bookings | No champion entity exists (A6); base-name bookings would otherwise double-book sub-venues (A2). |

---

## 9. Critique amendments (adversarial completeness review, 2026-06-11) — binding

Gaps found reviewing Draft v1 against the codebase (`scheduler.py`, `constraints.py`, `generate.py`, `advance.py`) and CLAUDE.md invariants. Each amendment is binding; where it conflicts with §1–§7, the amendment wins.

**A1 — Preview ≡ commit is not guaranteed as written (tenet-3 violation).** §5.2's pipeline omits `preoccupied` (other leaves' / live matches' bookings) and `linked` (shared-player team links) — both computed inside `apply_schedule` today. A preview without them diverges from commit whenever another leaf has matches or a student plays two sports. Fix: extract `build_schedule_inputs(tournament, leaf_key) -> (reqs, preoccupied, linked)` from `apply_schedule`; preview and commit both call it. Additionally, state can change between preview and Accept (new registration, another leaf generated): Accept therefore sends `expected_inputs_hash` (from the preview response); `generate-fixtures`/`schedule` recompute and return **409 + fresh readiness pointer** on mismatch. Determinism alone cannot guarantee preview ≡ commit; optimistic concurrency closes the gap.

**A2 — `Venue.count` sub-venue expansion vs legacy bookings (double-booking bug).** Existing `Match.venue` strings hold the bare name ("MP Hall"); new matches get "MP Hall · T1". Interval-overlap keyed by exact venue string would never see them conflict → real-world double-booking of the hall. Fix: when building `venue_busy`, a booking under the bare name consumes one unit of that venue's capacity (assign to the lowest-numbered free sub-venue); if bare-name bookings ≥ `count`, all sub-venues block for that interval. Test required.

**A3 — Scope/weight need a `ScheduleConfig` shape change (increment 6 understated).** `rest_minutes`/`max_per_team_per_day` are single scalars and `preferred_windows`/`balance_venues` are weightless tuples/bools — they cannot carry per-record scope or weight. Fix: these fields become lists of scoped, weighted records resolved per `MatchSlotReq` inside `feasible()`/`preference()` (most-specific scope wins for hard scalars; soft scores sum weight-multiplied terms). Defaults reproduce current behavior so existing callers/tests pass unchanged. Note: `no_person_overlap.cross_venue_gap_minutes` requires venue-tagged busy intervals (`team_busy` entries gain the venue) — small but real.

**A4 — Constraint times are wall-clock tournament-local (invariant 14).** All time/date params in constraint records (`recurring_blackout_window`, `ceremony_block`, `round_pinned_to_window`, `category_session_window`, venue windows) are interpreted in the tournament's timezone — matching `apply_schedule`'s tz handling — and stored as local wall-clock values, never UTC-converted ("church until 13:00" is a wall-clock rule).

**A5 — Violations must be i18n-structured (invariant 13).** `violations[].message` / `relaxations[].label` as server-rendered English breaks i18n. Each violation/relaxation carries a stable `code` + `params` dict; the FE renders localized strings from the code, with the gettext-wrapped server message as fallback. The FE never string-matches messages.

**A6 — `min_entries_action: auto_champion` is unimplementable in v1.** Standings/champions derive from matches; there is no leaf-status or champion entity to write, so "auto champion" has nowhere to land. v1 supports `prompt` and `cancel`; readiness renders a 1-team leaf as `fail` with hint "1 team — add entries or cancel this competition". `auto_champion` moves to deferred (needs a leaf-status entity).

**A7 — Withdrawals: minimal v1 path added (was a dangling contract).** Draft v1 stored `rules.withdrawal_policy` (frozen, participant-facing) with **no executor** until v2 — organizers would wrongly believe withdrawals were handled. Increment 16 (new) ships the minimal consumer using existing machinery: walkover remaining matches (advance ripple already works), standings honor `rr_results: void_if_under_half_played`, and a walkover-loser does not occupy a `loser_of` third-place slot. Postponement repair (reserve-day filling) remains v2; `reserve_days` still excludes dates at generation in v1 so the manual fallback (edit `scheduled_at`) has room.

**A8 — Validation gaps in config/constraints (previously unaskable/uncheckable).**
- `update_draw_config` rejects `advance_per_group >= group_size` and `group_size < 2`.
- `seeding: "seeded"` and `keep_apart key="seed_pot"` both readiness-`fail` when any team in scope lacks a seed (the latter was unchecked in v1).
- `keep_apart key="district"` with teams whose institution has no Stage-1 district answer: those teams are excluded from the constraint with a named warning (manually-created institutions never answered the form — the data is not guaranteed to exist).
- `official_capacity` additionally accepts scope `all` — caps total concurrent matches tournament-wide (scorer/stream/medic capacity, not just per-sport umpires).
- `category_session_window` semantics clarified: soft = per-leaf scoped `preferred_window` scoring; the hard toggle = grid filter. Two hard windows that jointly starve a leaf must produce a structured violation with `demote_to_soft` relaxation, not silent unscheduled matches.

**A9 — Missing scenarios acknowledged and routed.** Two-legged knockout ties (`legs` is RR-only in v1), best-N-thirds cross-group qualification (3 groups × top-2 = 6 is fine via byes, but "2 best thirds" is common and unsupported), points-per-game normalization for unequal group sizes (7 teams → 4+3 groups makes raw points unfair), and `venue_for_team` (host school must/must-not play at home as a hard rule — `balance_venues` is only soft) are all explicitly **deferred v2** and listed in §7. Wizard copy must not imply they exist.

**A10 — `constraints_reviewed` becomes `constraints_reviewed_at` + staleness.** A boolean can go stale silently: review, then edit constraints, checklist still green. Store the ISO timestamp (+ reviewer id in the audit event); any constraint-record or global-calendar change after that timestamp clears it, flipping the readiness check back to `warn`. (Spirit of invariant 6: state with provenance, not a boolean.)
