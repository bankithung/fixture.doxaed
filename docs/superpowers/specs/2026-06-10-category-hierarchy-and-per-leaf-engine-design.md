# Category Hierarchy & Per-Leaf Engine — Design Spec

**Date:** 2026-06-10
**Status:** Draft v1 — grounded in a 47-agent adversarially-verified code analysis (30 load-bearing claims checked against the tree at `b1d5aca`).
**Supersedes/extends:** `2026-06-08-tournament-flow-and-constraint-engine.md` (north star) and `2026-06-09-stage1-stage2-registration-handoff-design.md` (WS-A..E shipped in `b1d5aca`).

## 1. The owner's product model (ground truth)

1. **Create:** name the tournament → pick sports (catalog or custom) → per sport define a **flexible category hierarchy of arbitrary depth** (e.g. Football → U15 → Girls → 5v5). A leaf = one competition (one draw, one set of rules).
2. **Stage 1:** the institution-registration form is **auto-generated** and carries every sport/category/sub-category as conditional selections — zero manual building.
3. **Stage 2:** teams register **into a specific leaf**; one institution can field teams in many leaves; what an institution ticked in Stage 1 scopes its Stage 2.
4. **Stage 3:** member invites + role assignment.
5. **Stage 4:** fixtures generated **per leaf** (only that leaf's teams), honoring sport-specific rules (football, volleyball, table tennis, sepak takraw), venue availability, durations, team availability.
6. **Workspace:** sidebar SaaS shell; per-member permissions; members see/do only what their role allows.

## 2. Verified current state (what the analysis proved)

All six stages are **partial**. The scaffolding is genuinely good — stage machine with auto-close/auto-draft, JSONB forms engine with server-enforced conditional visibility, data-bound fields, share-link prefill/lock, FET-style greedy scheduler, 23-module RBAC catalog — but the **connecting logic breaks the pipeline in five confirmed places**:

| # | Break | Evidence |
|---|-------|----------|
| B1 | `_sport_for_pool` tests `pool in categories` where categories are **dicts** `{name, subcategories}` → never matches → `Match.sport = ''` → set scoring never engages in the real flow | `fixtures/services/generate.py:90-97` vs `tournaments/views.py:300` |
| B2 | Team-form generation harvests the org form's **first multi_choice** — which in the generated multi-sport form is the **sports selector** — so teams bucket by sport key and every category leaf is dropped | `forms/services/generation.py:36-48` vs `:237-241` |
| B3 | `TournamentSportsView.put` rebuilds entries as exactly `{key,name,custom,categories}` — **strips `scoring`** → the per-sport override read path (`matches/views.py:87-93`) is dead | `tournaments/views.py:301-306` |
| B4 | Hierarchy is **hard-capped at 2 levels** of plain strings (no recursion in normalizer or SportsTab); leaves are index-fallback slugs (`_slug(leaf, f'c{i}')`) with **no stable identity** — rename/reorder orphans `Team.pool` and stored answers | `tournaments/views.py:284-300`; `generation.py:273-274` |
| B5 | Stored `Tournament.constraints` are **never read by the scheduler**; config is per-request only; 7 of 11 catalog types have zero enforcement code | `fixtures/services/scheduler.py:269` (config_from_dict only); `constraints.py:3-5` |

Other confirmed defects to fix along the way: volleyball absent from `SPORT_SCORING_DEFAULTS` (falls through to goal scoring); deciding-set rules unrepresentable (uniform points/cap for all sets — wrong for takraw's 15/17 third set and volleyball's 15-point fifth); goal-score POST not blocked for set sports; `record_match_event` can clobber `set_scores` mirrors; scheduler rewrites live/completed matches and stores naive-as-UTC times ignoring `Tournament.time_zone`; `generate_round_robin` **overwrites `Team.pool`** with "Group A.."; no Venue model; `validate_schedule` orphaned; nav has zero permission gating (stale docstring claims it does); `game_coordinator`/`referee`/`team_manager` grant no verbs; module RBAC never reaches tournament surfaces (tournament-only invitees resolve to an empty module set); institution status PATCH unaudited/unguarded; team status workflow unreachable; `unique_team_name_per_tournament` wrong for leaves.

## 3. Core design decision: stable leaf identity

Everything hangs on one primitive: **a leaf key**.

- `Tournament.sports` becomes a list of sports each holding a **recursive node tree**:
  `{key, name, custom, scoring?, scheduling?, nodes: [{key, name, children: [...]}]}`.
  Same JSONB column; the PUT normalizer recurses; legacy `{name, subcategories}` and plain-string shapes are coerced (third accepted shape — the code already coerces legacy input).
- Every node gets a **stable slug `key` minted once at first write and never recomputed on rename**. A **leaf key** is the path join: `football.u15.girls.5v5`.
- A central service `apps/tournaments/services/sports.py` is the only reader:
  `iter_leaves(tournament) -> [{sport_key, leaf_key, path: [names], label}]`, `sport_for_leaf`, `leaf_label`.
- **Teams** carry `sport` + `leaf_key` columns (structural, not string-convention; `pool` stays as denormalized display label). **Matches** carry `leaf_key` alongside the existing `sport`/`group_label`.
- Form options for category selection use `value = leaf_key` (replacing index-fallback slugs), so renames never orphan answers.

This single primitive fixes B1 (leaf→sport lookup from the registry), B2 (team form built from `iter_leaves`, not field-order guessing), B4 (stable identity), and gives fixtures/scheduling/standings/RBAC their scoping dimension.

## 4. Sport profiles (data, not code)

`SPORT_PROFILES` registry (backend; served to the FE — kill the hand-mirrored `SET_RULES` in `shared.tsx`). Researched structures (SGFI/ISTAF/FIVB/ITTF school formats):

| Sport | Scoring | Set structure (default) | Duration est. | Venue type |
|---|---|---|---|---|
| football | goals | halves 2×45 (youth 2×35/2×30; 5v5/futsal 2×20) | 70–120 min | ground |
| volleyball | sets | Bo5 to 25, win-by-2, no cap; **5th set to 15**; school short Bo3 | 60–150 (Bo5), 45–90 (Bo3) | indoor court |
| table_tennis | sets | Bo5 games to 11, win-by-2 (Bo3/Bo7 variants) | 20–40 min | TT table/hall |
| sepak_takraw | sets | Bo3 to 21, win-by-2, cap 25; **3rd set to 15, cap 17**; variants regu 3v3 / doubles / quad | 25–60 min | indoor court |

Shape: `{scoring: {type: 'goals'|'sets', best_of, points, win_by, cap, deciding: {points, win_by, cap}}, duration_minutes, venue_type, variants}`. Per-tournament override via `sports[].scoring`/`sports[].scheduling` (persisted now that PUT preserves them); per-leaf override later if needed. The existing rules freeze/amend/audit machinery applies via the settings path.

## 5. Phased plan

**P1 — Leaf foundation (backend)** *(fixes B1–B4)*
Recursive normalizer + stable node keys; leaf registry service; preserve `scoring`/`scheduling` on PUT; `Team.sport`+`Team.leaf_key` and `Match.leaf_key` migrations; institution-form generator emits leaf-key options with path labels + `settings.category_field_keys` tag; team-form generator reads `iter_leaves` (fallback: settings tag, then first-multi_choice for hand-built forms); mapping stamps Team sport/leaf and writes `Institution.attributes['leaves']`; `by_category` buckets by `(sport, leaf_key)` and stamps `Match.sport` from the registry (delete `_sport_for_pool`); `generate_round_robin` stops destroying `Team.pool`. Tests throughout.

**P2 — Sport profiles + set-scoring correctness**
`SPORT_PROFILES` with deciding-set support; volleyball entry; takraw 15/17 third set; block the plain goal path for set sports and guard the event path from clobbering `set_scores`; expose resolved scoring rules on the match payload; FE set-entry consumes server rules.

**P3 — Per-leaf fixtures + scheduler upgrade** *(fixes B5)*
`GenerateFixturesView` takes `leaf_key` + per-leaf format; idempotency scoped per leaf; knockout byes (non-power-of-2); Venue model `{name, venue_type, windows}` (org-scoped); scheduler: per-match durations from profiles with interval-overlap venue occupancy, `venue_windows` populated, stored-constraints interpreter (blackout_dates, team_unavailable, rest, max/day, keep_apart_until_round), tournament-TZ aware, status guard (never touch live/completed), persisted scheduling config under `rules.scheduling`; standings/brackets filter by `leaf_key`; ready-gate counts per leaf.

**P4 — Frontend: recursive category editor + per-leaf fixtures UI**
SportsTab recursive node editor (arbitrary depth, leaf chips, per-sport scoring/scheduling override panel); FixturesTab per-leaf sections (per-leaf generate/schedule/status); ScheduleWizard venue/windows/excluded-dates inputs; render `scheduled_at`/venue on match surfaces.

**P5 — RBAC wiring (the SaaS workspace)**
`effective_tournament_modules(user, tournament)` resolver from `TournamentMembership` roles × the existing catalog's `default_for_roles`; `TournamentModuleGrant` (reuse tri-state grants service); `HasTournamentModule` permission replacing bare `can_manage_tournament` per verb (verb matrix as data); stage/`me` payload carries effective modules; `computeTournamentNav` gates on them (the stale docstring finally becomes true); ModuleMatrixPage mounted in the tournament Members tab; invite-role validation against the tournament enum + duplicate-role guard; optional `scope` JSONB on membership for per-sport roles.

**P6 — Registration handoff completion + hygiene**
WS-D Mode 1 (dropdown per-option prefill), WS-F (email links), generated-form staleness (`inputs_hash` + regenerate endpoint + SportsTab regenerate-when-stale + advance warning), auto-publish org form on advance (ack'd), per-institution Stage-2 leaf scoping (bound links filter to `attributes['leaves']`; `register_school` enforces eligibility server-side), institution status transitions guarded + audited, team review workflow endpoints, casefold institution dedupe, leaf-aware team uniqueness `(tournament, institution, leaf_key, name)`.

## 6. Decisions log

1. **Leaf identity = path-slug key minted at write, immutable on rename** — chosen over a `CategoryLeaf` FK table to avoid FK churn while the tree is still being edited during setup; revisit if cross-tournament leaf analytics demand a table.
2. **`Team.sport`/`leaf_key` as columns, `pool` retained as label** — structural binding with zero breakage of existing UI/queries.
3. **Profiles are backend data served to the FE** — one source of truth; FE mirrors removed.
4. **2-level UI ships until P4** — backend accepts arbitrary depth from P1 (legacy shapes coerced), so the existing SportsTab keeps working unchanged in the interim.
5. **Snapshot commit `b1d5aca` first** — protect 6.1k lines of green in-flight work before refactoring on top.
