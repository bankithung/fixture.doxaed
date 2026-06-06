# Tournament Rules & Constraints — Design

**Status:** Approved (shape), 2026-06-06. Scope chosen by owner: **Full** (structured rules + scheduling constraints).
**Goal:** Let an organizer define, when creating/running a tournament, the **rules** (how it's scored & played) and the **constraints** (how fixtures may be scheduled) as **data** (JSONB), so the platform behaves like FET — a constraint *interpreter*, not hardcoded logic.

**Supersedes nothing; implements** PRD invariant #7 (rule freeze) and #10 (auto-generate + manual-edit) for the rules surface.

---

## 1. Data model (backend/apps/tournaments/models.py)

Add two JSONB fields to `Tournament` (+ amendment tracking):

```python
rules = models.JSONField(default=dict, blank=True)          # structured rules
constraints = models.JSONField(default=list, blank=True)    # typed scheduling constraints
rules_frozen_at = models.DateTimeField(null=True, blank=True)  # set on registration_open
```

### 1a. `rules` schema (football v1) — all keys optional; service fills defaults
```jsonc
{
  "format": "round_robin" | "knockout" | "groups_knockout",   // default round_robin
  "group_size": 5,                                             // round_robin/groups_knockout
  "advance_per_group": 2,                                      // groups_knockout
  "points": { "win": 3, "draw": 1, "loss": 0 },               // default 3/1/0
  "tiebreakers": ["points","goal_difference","goals_for","head_to_head","name"], // ordered
  "match": { "halves": 2, "half_minutes": 45, "extra_time": false, "penalties": true },
  "squad": { "min_players": 7, "max_players": 23, "max_subs": 5 },
  "discipline": { "yellow_suspension_threshold": 2, "red_matches_banned": 1 }
}
```
A canonical `DEFAULT_RULES` dict + `merge_rules(partial)` helper lives in `apps/tournaments/services/rules.py`. Unknown keys are rejected (whitelist) so the schema stays clean.

### 1b. `constraints` schema — list of typed rules
```jsonc
[
  { "type": "no_double_booking_team", "scope": "all", "hard": true, "weight": null, "params": {} },
  { "type": "min_rest_minutes",       "scope": "all", "hard": true,  "params": { "minutes": 60 } },
  { "type": "venue_single_use",       "scope": "all", "hard": true,  "params": {} },
  { "type": "preferred_window",       "scope": "all", "hard": false, "weight": 5, "params": { "days": ["Sat","Sun"], "from": "09:00", "to": "17:00" } },
  { "type": "avoid_back_to_back",     "scope": "all", "hard": false, "weight": 3, "params": {} }
]
```
- **Hard** constraints: a schedule that violates one is **invalid** (rejected).
- **Soft** constraints: each contributes `weight × satisfaction` to a candidate schedule's score; the scheduler ranks candidates and keeps the best.
- Registry of constraint types in `apps/fixtures/services/constraints.py`: each type maps to a `validate(schedule)->bool` (hard) and/or `score(schedule)->float` (soft). Adding a type = add one handler (no migration).

---

## 2. Rule freeze (invariant #7) — `apps/tournaments/services/rules.py`

- `rules`/`constraints` are **editable** while `status in {draft, published}`.
- On transition to `registration_open`, set `rules_frozen_at = now()`.
- After freeze, the settings PATCH endpoint **rejects** edits unless an explicit **amend** is requested: `PATCH …/settings/?amend=true` with `{reason}` → allowed, audit-logged, notifies tournament members, recorded with a 24h grace note. (v1: enforce reason + audit + notify; the 24h grace is a stored `amended_at` + a notification, not a hard time-lock.)
- `match` rules additionally frozen once any match is `live` (don't retroactively apply) — enforced where match rules are read.

---

## 3. API (backend/apps/tournaments/views.py + urls.py)

- `GET  /api/tournaments/<id>/settings/` → `{ rules, constraints, rules_frozen_at, can_edit }` (any tournament member who can view).
- `PATCH /api/tournaments/<id>/settings/` body `{ rules?, constraints?, event_id, amend?, reason? }` → merge-validates, enforces freeze, audits. Idempotent on `event_id` (invariant #3). Permission: `can_manage_tournament`.
- Constraint type catalog: `GET /api/tournaments/constraint-types/` → static list `[{type, label, hard, params_schema}]` so the UI can render a builder without hardcoding.

Serializers in `apps/tournaments/serializers.py`: `TournamentSettingsSerializer` (validates against the whitelist + per-type params).

---

## 4. Generator & standings integration (read the data)

- `apps/fixtures/services/generate.py` `generate_*`: read `tournament.rules` for `format`, `group_size`, `advance_per_group` (the existing `format` param becomes a fallback/default; rules win). Before persisting, run **hard** constraint validation via `constraints.validate_schedule(matches, constraints)`; if a generated draft violates a hard constraint that scheduling can fix (slots), re-slot; otherwise surface a clear error listing violations.
- A new `apps/fixtures/services/schedule.py` `assign_slots(*, matches, constraints, slots)` — assigns kickoff times/venues honoring hard constraints and maximizing soft score (v1: greedy + local search; not a full ILP). Pure function over candidate slots → testable.
- `apps/matches/services/standings.py` `compute_standings`: read `rules.points` (win/draw/loss) and `rules.tiebreakers` (ordered comparator) instead of the hardcoded 3/1/0 + GD/GF/name. **(Touches the matches app — do this increment only after the lineup/incident agent's matches changes have merged, to avoid migration/file races.)**
- `squad` limits enforced in team registration + lineup set (min/max/subs). `discipline` thresholds feed the suspension calc (future hook; v1 stores the thresholds + exposes them).

---

## 5. Frontend

- **Create flow:** add a "Rules & constraints" step to `CreateTournamentPage` (or a post-create redirect to the Settings tab) — format + points + tiebreakers + match + squad as a token form; **all dropdowns are the custom `<Select>`**; constraint builder = add/remove typed rows driven by `constraint-types`.
- **Settings tab** on `TournamentDetailPage`: same form, with a **"Rules frozen" banner** + disabled inputs after `registration_open` (and an "Amend (reason required)" affordance that opens a `<Dialog>`). `useToast` for save results — no alerts.
- `api/tournaments.ts`: `getSettings(id)`, `patchSettings(id, {rules, constraints, event_id, amend, reason})`, `constraintTypes()`.

---

## 6. Testing (TDD)

Backend:
- `rules.py`: `merge_rules` fills defaults, rejects unknown keys.
- Freeze gate: PATCH allowed in draft; blocked after `registration_open`; allowed with `amend=true`+reason (audited + notifies).
- Generator reads `rules.format` (round_robin/knockout/groups_knockout) — parametrized.
- `compute_standings` honors custom `points` + `tiebreakers` (e.g. 2/1/0; head-to-head ordering).
- `constraints`: hard `no_double_booking_team` rejects an invalid schedule; `assign_slots` satisfies hard + ranks soft; per-type unit tests.
- Idempotent settings PATCH; cross-org isolation on the settings endpoints.

Frontend:
- Settings form renders rules + constraint rows; custom Select used (no native).
- Frozen state disables inputs + shows banner; amend dialog requires reason.
- `patchSettings` called with merged payload + `event_id`.

---

## 7. Build order (decomposition into TDD increments)

1. **Model + defaults + freeze service** (`rules`/`constraints` fields, migration, `merge_rules`, freeze on registration_open) + tests.
2. **Settings API** (GET/PATCH + freeze enforcement + idempotency + isolation) + `constraint-types` catalog + tests.
3. **Generator reads `rules.format`** (replace the `format` param plumbing) + tests.
4. **Constraints engine** (`constraints.py` registry: hard validate + soft score) + `schedule.assign_slots` + tests.
5. **Standings honors `points` + `tiebreakers`** (matches app — *after* the lineup/incident merge) + tests.
6. **Frontend**: Settings tab + create-flow step + constraint builder (custom Select, freeze banner, amend dialog) + tests.

Each increment ships green + committed.

---

## 8. Open questions (deferred, non-blocking)

- Venues/slots aren't modelled yet — `assign_slots` v1 takes a caller-provided slot list; a `Venue`/`Slot` model is a later increment (constraints reference venue by free-text id until then).
- Full ILP/CP-SAT solver (true FET parity) is out of v1 scope; greedy + local-search is the v1 scheduler. The data schema is solver-agnostic so we can swap the engine later without a migration.
