# Setup → Fixture: break timings, per-category durations, forms dedup

**Status:** Draft v1 (2026-06-27). Derived from a 7-reader code-map of the
setup→fixture-generation flow. Each feature extends an existing seam.

## 1. Break timings (Step 1 · When & where)

Goal: organizers set an **overall daily break** (all venues) and/or **per-venue
breaks**; no match is scheduled during a break.

### 1a. Overall daily break — NO backend change
The scheduler already subtracts `recurring_blackout_window` records at
`scope:"all"` from every venue's daily window in `build_slots`
(`scheduler.py:549-582`); an **empty `days`** list means *every* day
(`scheduler.py:573`). So an overall break is a single constraint record:

```json
{"type":"recurring_blackout_window","scope":"all","hard":true,
 "params":{"days":[],"from":"12:00","to":"13:00","label":"daily_break"}}
```

- Saved via the **settings PATCH** channel, like ceremonies. Add
  `recurring_blackout_window` to the wizard's `MANAGED_TYPES`, disambiguated
  from the Sunday-church record by `params.label` (`"daily_break"` vs the
  church record, matched by `days==["sun"]` / no label).

### 1b. Per-venue break — `Venue.breaks` field
Cleaner + lower-risk than threading a `venue:` scope through 30+
`scope_matches()` callsites (constraints reader, Option A risks).

- **models.py** — `Venue.breaks = JSONField(default=list)` → `[{from,to}]`. Migration.
- **scheduler.py** — `ScheduleConfig.venue_breaks: dict[str, list[(time,time)]]`;
  parse in `config_from_dict`; in `build_slots` add
  `cuts += cfg.venue_breaks.get(base, [])` (every day, that venue only).
- **plumbing** — include `breaks` in `preview.py::stored_venue_records`,
  `views.py::_venue_payload`, the scheduling-payload venue list (views.py:790),
  and venue create/update (`_clean_breaks`).
- **UI** — `VenueRow.tsx` gets optional break from/until inputs → Venue CRUD.

## 2. Per-category match durations (default + per-competition override)

Goal: each competition can have its own match length; generation honors it.

Engine already honors per-match `duration_minutes` (`scheduler.py:1088,1356`);
today it's resolved **per sport only** (`duration_for(sport)`,
`scheduler.py:1621-1626` ← `tournament.sports[].scheduling.duration_minutes`).

- **draw_config.py** — add layered scalar `match_duration_minutes` to
  `DEFAULT_DRAW_CONFIG` (default 90) + positive-int check in `_validate_layer`.
  `["*"]` = tournament default, `[leaf]` = per-category override (sparse,
  whitelist-merged — same as `legs`/`group_size`). Excluded from `inputs_hash`
  (scheduling-only; does not change WHO plays WHOM).
- **scheduler.py** — `duration_for(sport, leaf_key)` precedence:
  `effective_draw_config(t, leaf).match_duration_minutes` (only if leaf-set) →
  `sports[sport].scheduling.duration_minutes` → `SPORT_PROFILES` → global default.
  Pass `m.leaf_key` at the 3 call-sites (1666/1689/1702).
- **grid step** — add `ScheduleConfig.grid_step_minutes` = min of all resolved
  durations (floor 5) so short categories pack tightly; `build_slots` steps by
  it instead of `slot_minutes`. `slot_minutes` stays the default/fallback length.
- **UI** — default in Play-times; per-competition override on the format card
  (persists to `draw_config[leaf].match_duration_minutes`).

## 3. Forms dedup / unify (production-grade)

Repetitions found: contact fields (name/email/phone) collected in BOTH org &
team forms; the progressive sport→category chain duplicated across both; the
org form is **stale** (lists Sepak U-19 leaves that no longer exist) while the
team form is regenerated (v3).

- Extract `build_sport_category_chain(tournament)` in `generation.py`; both
  `build_institution_form_schema` and `build_team_form_schema` call it once.
- Prefill team-form contacts from the chosen `Institution` (confirm, not
  re-ask); render "Confirmed from Stage 1".
- Regenerate the stale org form from the current `tournament.sports`.

## 4. Increment plan
1. **Backend engine** (this change): durations (no migration) + per-venue breaks
   (migration) + tests. Overall break needs no backend code.
2. **Frontend**: break inputs (Play-times overall + VenueRow per-venue),
   per-category duration inputs; save channels per §1/§2.
3. **Forms**: shared chain + contact prefill + regenerate stale org form.
4. **Deploy**: migrate (owner role) + build + restart — gated on approval.

## 5. Risks (from the map)
- Per-leaf duration must also widen `preoccupied` booking intervals
  (scheduler.py:1702) — pass leaf there too, else overlaps go undetected.
- Validate venue breaks are chronological + within window (else empty grid).
- Duration must NOT enter `inputs_hash` (pairings unaffected) — verify.
- Forms: regenerate must be idempotent; team-form snapshot chain goes stale
  until regenerated — offer a regenerate action.
