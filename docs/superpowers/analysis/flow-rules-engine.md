# Flow trace: Rules & constraints engine (FET-style, data-driven)

**Scope.** `Tournament.rules` + `.constraints` (JSONB) interpreted at runtime: `DEFAULT_RULES` →
`merge_rules` whitelist merge → freeze gate (amend/grace/notify) → `compute_standings` reading
`points`/`tiebreakers` → constraint catalog + shape validation → (intended) fixture-generation
/ scheduling integration. Spans **tournaments**, **matches**, **fixtures**, **audit**, and the
**React** frontend. Design source of truth:
`docs/superpowers/specs/2026-06-06-tournament-rules-constraints-design.md`.

## Diagram in prose

The Tournament row carries three columns added in
`apps/tournaments/migrations/0002_tournament_constraints_tournament_rules_and_more.py`:
`rules` (JSONB dict, default `{}`), `constraints` (JSONB list, default `[]`), `rules_frozen_at`
(nullable datetime), declared on `apps/tournaments/models.py::Tournament`. Nothing is stored
fully-resolved: `rules` holds only the manager's *overrides*; the canonical shape is reconstituted
on every read by layering overrides onto `DEFAULT_RULES`. Two consumer subsystems read that
resolved dict — **standings** (matches app) and the **generator** (fixtures app, partially) — and
one catalog (`CONSTRAINT_TYPES`) feeds the constraint UI. The write path is a single service,
`update_settings`, gated by status. The frozen flag is the boundary invariant #7.

## Ordered walkthrough

1. **Canonical schema + merge.** `apps/tournaments/services/rules.py::DEFAULT_RULES` is the *whitelist*
   and the football v1 baseline (`format`, `group_size`, `advance_per_group`, `points` 3/1/0,
   `tiebreakers` `[points, goal_difference, goals_for, head_to_head, name]`, plus nested `match`,
   `squad`, `discipline`). `merge_rules(partial, base)` deep-copies the defaults, then folds
   `base` (the tournament's stored overrides) and `partial` (the incoming patch) in order:
   `defaults < base < partial`. Unknown top-level keys, and unknown keys inside the four `_NESTED`
   dicts (`points`/`match`/`squad`/`discipline`), raise `ValueError` — the schema cannot silently
   drift. Nested dicts are *per-key merged* (`out[key].update(value)`); scalars/lists are replaced
   wholesale (so `tiebreakers` is all-or-nothing). Confirmed by
   `apps/tournaments/tests/test_rules.py::test_merge_rules_*`.

2. **Read path (GET settings).** `apps/tournaments/views.py::TournamentSettingsView.get` →
   `_get_tournament_or_404` (scope check, no existence leak) → `_settings_payload`, which returns
   `merge_rules(tournament.rules)` (fully resolved), `constraints or []`, `rules_frozen_at`, and a
   computed `can_edit = can_edit_rules(t) and can_manage_tournament(user, t)`. So the *server* is the
   single source of the resolved ruleset and the edit-affordance flag.

3. **Write path (PATCH settings).** `TournamentSettingsView.patch` → manager gate
   (`can_manage_tournament`, else 403) → `apps/tournaments/services/rules.py::update_settings`.
   That service: (a) **idempotency** — if an `AuditEvent` with `idempotency_key == event_id` and
   `event_type == "tournament_settings_updated"` already exists, returns the tournament unchanged
   (invariant #3, replay → 200); (b) **freeze gate** — `if not can_edit_rules(t) and not amend:
   raise PermissionError("rules_frozen")` (mapped to **HTTP 409** in the view); (c) `amend` requires
   a non-blank `reason` else `ValueError("amend_reason_required")` (→ 400); (d) inside
   `transaction.atomic()`: `rules = merge_rules(rules, base=tournament.rules)` and/or
   `constraints = validate_constraints(constraints)`, stamps `last_manual_edit_at` (invariant #10),
   `save(update_fields=[...])`, then `emit_audit(...)` with the after-image + `amend`/`reason`.
   Behavior pinned by `apps/tournaments/tests/test_settings_api.py` (merge-onto-current, unknown-key
   400, idempotent replay keeps the first value, frozen→409 then amend→200, outsider→404).

4. **Freeze gate semantics.** `can_edit_rules(t)` is purely `status in {DRAFT, PUBLISHED}`
   (`apps/tournaments/services/rules.py`). `freeze_rules(t)` idempotently stamps `rules_frozen_at =
   now()`. **The gate is enforced by `status`, not by the stamp** — the 409 fires whenever status has
   left draft/published, regardless of whether `rules_frozen_at` was ever set.

5. **Constraint catalog + validation.** `apps/fixtures/services/constraints.py::CONSTRAINT_TYPES`
   is the FET-style hard/soft registry (`no_double_booking_team`, `min_rest_minutes`,
   `venue_single_use` = hard; `preferred_window`, `avoid_back_to_back` = soft). `validate_constraints`
   (called from `update_settings`) checks the value is a list, rejects unknown `type`, and normalizes
   each row to `{type, scope, hard, weight, params}` (defaulting `hard` from the spec, `scope="all"`).
   The catalog is exposed read-only at `GET /api/tournaments/constraint-types/`
   (`apps/tournaments/views.py::ConstraintTypesView`) for a future UI builder.

6. **Standings interpret `points` + `tiebreakers`.** `apps/matches/services/standings.py::
   compute_standings` calls `merge_rules(getattr(t, "rules", None))`, then reads `rules["points"]`
   (win/draw/loss) and `rules["tiebreakers"]`. It tallies non-deleted `COMPLETED` matches into per-team
   rows, derives `GD`, then sorts via `_sort_key(row, tiebreakers)`, which maps each tiebreaker name to
   a sort term. **`head_to_head` and unknown tiebreakers are silent no-ops in v1** (need pairwise data);
   `name` is always appended as a stable final fallback. Served by
   `apps/matches/views.py::TournamentStandingsView` (groups by `group_label`). Pinned by
   `apps/matches/tests/test_standings_rules.py::test_standings_uses_configured_win_points`.

7. **Generator (partial integration).** `apps/fixtures/views.py::GenerateFixturesView.post` dispatches
   by **request-body** `format`/`group_size`, NOT by `tournament.rules`. `generate_round_robin`
   (circle method, groups) and `generate_single_elimination` (power-of-2, `winner_of` pointers, invariant
   #9) ignore the stored ruleset. The one indirect read: `generate_knockout_from_groups` calls
   `compute_standings(t, group_label=g)` to pick the top `advance_per_group` per group — but
   `advance_per_group` is a hardcoded default (2), not pulled from `rules`. **No constraint enforcement
   runs anywhere in generation/scheduling** — `constraints` is validated on write and otherwise inert.

8. **Frontend consumption.** `frontend/src/api/tournaments.ts` exposes `standings(id)` (typed
   `StandingsGroup[]`) and `generateFixtures(id, {groupSize, format})` — the latter defaults
   `group_size: 5`, `format: "round_robin"` *client-side*. `TournamentDetailPage.tsx::StandingsTable`
   renders a fixed column set `["P","W","D","L","GF","GA","GD","Pts"]` over server-sorted rows. There is
   **no settings/rules/constraints page, no `getSettings`/`patchSettings`/`constraintTypes` binding,
   and no route** (only `OrgSettingsPage` exists) — the Settings UI (spec increment 6) is unbuilt.

## Subsystems crossed

tournaments (model, rules service, settings views/urls, audit emission) → matches (standings consumer)
→ fixtures (constraint catalog/validation + generator) → audit (idempotency lookup + after-image) →
React frontend (standings render only; settings write-path absent).

## Invariants this flow depends on

- **#7 rule freeze:** mutable in `draft`/`published`, frozen once status leaves that set; amend = reason
  + audit (+ intended notify/grace). Enforced by `can_edit_rules` (status-based).
- **#3 idempotent writes:** `event_id` → `AuditEvent.idempotency_key`; replay returns the prior record.
- **#10 manual-edit tracking:** `last_manual_edit_at` stamped on every settings write.
- **Whitelist-as-schema:** `DEFAULT_RULES` keys are the only legal keys; merge raises on drift.
- **Resolved-on-read:** stored `rules` is a partial; *every* consumer must call `merge_rules` before
  reading, or it gets bare overrides. `compute_standings`, `_settings_payload`, and any future reader
  share this contract.
- **Atomicity + on_commit ordering:** `update_settings` wraps save + audit in `transaction.atomic()`.
  No `on_commit` here today, but a future notify-on-amend MUST fire on `transaction.on_commit` (mirror
  `apps/matches/services/events.py`) so members aren't notified of a rolled-back amendment.

## Failure modes

- **Freeze stamp vs. gate divergence.** `rules_frozen_at` is never set in production — no
  tournament-status transition calls `freeze_rules` (grep: only `test_rules.py` calls it; there is no
  status-transition endpoint/service for tournaments at all). The gate still works via the status check,
  but `rules_frozen_at` will read `null` even on a `registration_open` tournament, so any UI banner or
  client logic keying on that timestamp would be wrong. **Client and server must agree to key the
  "frozen" banner on `can_edit`, not on `rules_frozen_at`.**
- **Notify/grace not implemented.** Spec §2 requires amend → notify members + a 24h grace note
  (`amended_at`). `update_settings` records `amend`/`reason` in the audit payload only — no notification,
  no `amended_at`. Members are silently un-notified of post-freeze rule changes.
- **Generator ignores rules.** `format`/`group_size`/`advance_per_group` come from the request/defaults,
  not `rules` — a manager who sets `format: "knockout"` in settings then generates with the default body
  gets a round-robin. Client and server both default to `round_robin`, so the divergence is consistent
  but wrong relative to stored intent.
- **Constraints are inert.** Hard constraints (`no_double_booking_team`, `min_rest_minutes`,
  `venue_single_use`) are validated for *shape* but never enforced during generation/scheduling
  (`validate_schedule`/`score_schedule` unimplemented). A schedule can violate every "hard" rule.
- **`tiebreakers` replace-not-merge.** PATCHing `tiebreakers` replaces the whole list; a partial intent
  (e.g. drop one tiebreaker) silently loses the rest of the default ordering.
- **`head_to_head` silent no-op.** Configuring it changes nothing — no error, no effect.
- **Match-rule freeze missing.** Spec §2 says `match` rules additionally freeze once any match is `live`;
  `apps/matches/services/state.py` has no rules reference, so this sub-invariant is unenforced.

## Restructuring seams (clean re-architecture points)

1. **A single `resolve_rules(tournament)` accessor** to centralize `merge_rules(t.rules)` (today
   duplicated in `compute_standings` and `_settings_payload`); make consumers depend on the resolved
   dict, never the raw column. Cleanest seam for adding caching/versioning.
2. **Wire the freeze stamp into a real tournament state-machine** (mirroring
   `apps/matches/services/state.py`): a `transition_tournament` service calls `freeze_rules` on entry
   to `registration_open`, emits audit, and (on_commit) notifies — closing the stamp/notify/grace gaps
   in one place.
3. **Make the generator read `rules`.** `GenerateFixturesView`/`generate_*` should take `format`,
   `group_size`, `advance_per_group` from `resolve_rules`, with the request body as override-only;
   keep the frontend defaults in sync (`api/tournaments.ts::generateFixtures`).
4. **Constraint engine behind `constraints.py`.** Add `validate_schedule(matches, constraints)` (hard
   reject) + `score_schedule` (soft ranking) with a per-type handler registry keyed off
   `CONSTRAINT_TYPES`, invoked from generation before persist — solver-agnostic per spec §1/§7.
5. **Promote tiebreakers to a typed comparator registry** so `head_to_head` and future keys are
   pluggable handlers rather than the inline `if/elif` ladder in `standings._sort_key`.
6. **Build the Settings surface** (`getSettings`/`patchSettings`/`constraintTypes` in
   `api/tournaments.ts` + a `TournamentDetailPage` Settings tab with a frozen banner keyed on
   `can_edit` and an amend dialog) — the only consumer that closes the loop end-to-end.

## Sync / ordering flags

- **Client↔server:** the "rules frozen" affordance must key on the server's `can_edit`
  (`_settings_payload`), not `rules_frozen_at` (which is null in practice). Generator defaults
  (`group_size: 5`, `format: "round_robin"`) are duplicated in
  `frontend/src/api/tournaments.ts::generateFixtures` and `apps/fixtures/views.py` — keep in lock-step
  until both read `rules`.
- **Transactions/on_commit:** settings write is atomic (save+audit together). Any future
  amend-notification MUST be `transaction.on_commit` so a rolled-back amend doesn't notify.
- **Migration ordering:** spec §4 explicitly sequenced the standings change *after* the
  lineup/incident matches changes to avoid file/migration races — relevant when re-touching the matches
  app.
