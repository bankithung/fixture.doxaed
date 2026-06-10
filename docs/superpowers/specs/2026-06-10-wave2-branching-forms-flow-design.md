# Wave 2 — Progressive form branching, roster formats, focused setup flow, separation constraints

Date: 2026-06-10 · Status: Approved (owner directive) · Builds on `2026-06-10-category-hierarchy-and-per-leaf-engine-design.md`

## Owner asks (verbatim themes)

1. The auto institution form branches one level only ("i select one sport then
   another comes up i like that … but additionally right now it only does for
   one level"); deeper sub-categories are stacked flat in one field. Users
   should be able to build the same logic themselves (it must not be a
   hardcoded generator trick).
2. Category *types* (gender / age / format e.g. 1v1) should drive team
   registration: a 1v1 category's team enters exactly 1 player by default; the
   admin can widen it (3–4 with substitutes) by editing the generated form.
3. The setup flow (create → fixture generation) must NOT show the sidebar —
   a focused, job-site-onboarding-style flow with the delete-tournament button
   at the top. After fixtures are generated → the full SaaS workspace.
   The "Rules will be locked — later changes will need an amend reason" ack in
   the flow is unnecessary noise — remove it from the flow UI.
4. Deep sport logic for football, sepak takraw, table tennis, **badminton**.
5. Real-game generation/scheduling: same schools not paired in first matches;
   a player in two competitions must not have simultaneous matches; venues,
   durations, rest.
6. Polish: dark-mode toasts unreadable; topbar width ≠ content width; light
   mode is "all white"; form-delete must be mis-click-safe; published forms
   need a "view the live form" button; public registered-institutions pages
   grouped by sport/category.

## Verified current state (recon, 8 agents)

- `visibility` rules ({field, op, value}; 7 ops incl. `includes`) exist on
  fields AND sections, evaluated with strict client/server parity
  (`lib/formLogic.ts` ↔ `services/validation.py::_visible`); hidden answers are
  dropped server-side. The builder already has `VisibilityRuleEditor` +
  `BranchingEditor`. **Only the generator is single-level**: one
  `categories_<sport>` multi_choice carrying every leaf flat.
- Repeatable `group` fields have **no min/max row support anywhere** (schema,
  validator, renderer, builder); backend group validation is store-as-is.
- `setupMode` is hardcoded `false` (sidebar always on — superseded by this
  wave's owner directive). "Rules will be locked" renders from
  `warningText()` in StageStepper + StageContinue.
- SPORT_PROFILES: football/volleyball/table_tennis/sepak_takraw; badminton in
  the catalog (`sports.json`) but profile-less. Cards exist as event types;
  no discipline enforcement (out of scope this wave).
- Pairing is institution-blind (circle method/sequential seeding);
  `feasible()` checks venue + team conflicts only. `Player` has
  `unique (tournament, person)` — one person cannot legally be in two teams,
  so cross-competition entry is impossible today (contradicts ask #5).
- Toasts: translucent tints (`bg-destructive/10`, `bg-grant-muted`) with no
  opaque base → invisible in dark mode. Light `--background` == `--card` ==
  pure white. Topbar `px-4 sm:px-6` vs page `px-4 sm:px-6 lg:px-8`.

## Design

### W2-A Progressive branching (generated; user-editable)

`build_institution_form_schema` walks the node tree and emits **one
multi_choice per branch node** instead of one flat field per sport:

- sport top level: key `categories_<sport>`, options = top-level nodes
  (values = path keys `football.u19`), visibility
  `{field: sports, op: includes, value: <sport>}`, required.
- every node with children: key `categories_<path-slug>`, options = its
  children (values = full path keys), visibility
  `{field: <parent field>, op: includes, value: <parent path key>}`, required.
  Required-on-visible is sound: the server validates only visible fields, so
  picking a branch forces choosing within it; unpicked branches stay silent.
- Settings: keep `category_fields` (sport → top field) for back-compat; add
  `category_fields_all` (sport → [every field key]) and `leaf_values`
  (leaf-key snapshot). `_selected_leaves` = union of answers across a sport's
  fields ∩ `leaf_values` (non-leaf selections are navigation, not entries);
  legacy forms keep the old path.
- Team form gets the same chain in its selector; each per-leaf team section's
  visibility points at the **deepest field** containing that leaf option.
- Builder needs zero new machinery (rules round-trip and are editable today) —
  this is what makes the logic user-buildable rather than hardcoded.

### W2-B Category kinds + roster formats

- Node shape += `kind` ∈ {age_group, gender, format, level, custom} and
  `format` {players_per_side, squad_min, squad_max}; `NvN` names auto-detect
  (1v1 → players_per_side 1). New `leaf_roster_rules(sports, leaf_key)`:
  nearest ancestor's format wins; default squad_min = squad_max =
  players_per_side when known, else 1/∞.
- Generated team form stamps `min_items`/`max_items` on each leaf's players
  group (+ help text). New everywhere: schema validation accepts the keys;
  `validate_answers` enforces row bounds on repeatable groups
  (`too_few_items`/`too_many_items`); renderer disables Add at max / Remove at
  min and seeds min rows; FieldEditor exposes Min/Max rows for repeatable
  groups (the admin's "3–4 substitutes" edit).
- SportsTab node row: compact kind Select + players-per-side / squad-max
  inputs when kind = format (auto-filled from NvN names).

### W2-C Focused setup flow

- `setupMode = inTournamentContext && stage.can_manage && stage ≠ ready`.
  Sidebar + hamburger hidden; topbar keeps breadcrumb/bell/theme/avatar.
- TournamentWorkspace in setup mode renders flow chrome: compact stage
  progress, current-step title, **Delete tournament** (extracted
  `DeleteTournamentButton`, reused by SettingsTab) top-right.
- `rules_will_freeze` filtered out of the flow dialogs (freeze still happens +
  audited server-side; PRD invariant 7 untouched — only the ack noise goes).
- Non-managers and `ready`+ tournaments get the full SaaS shell as today.

### W2-D Badminton + separation

- SPORT_PROFILES += badminton (BWF: Bo3, 21, win-by-2, cap 30; deciding same),
  45 min, indoor_court.
- Pairing: `_separate_institutions(teams)` — group by institution, deal
  round-robin into the seeding order, pairwise repair so round-1/pair members
  differ where mathematically possible (round robin arr order + knockout
  entrant order).
- Player model: `unique (tournament, person)` → `unique (team, person)`
  (migration) so one person can enter multiple competitions; register_school
  dedupes Persons per (tournament, institution, normalized full_name) so
  sharing is detectable. Scheduler `feasible()` += shared-player conflict:
  teams sharing ≥1 person are treated as one busy-set (no overlapping
  matches, rest gap honored).

### W2-E Polish

- Toasts: opaque `bg-popover text-popover-foreground` base, kind icon +
  colored border accent, shadow-lg, X icon dismiss.
- Topbar `lg:px-8`; light `--background` → offwhite (cards stay white);
  AuthLayout mobile logo emerald-700 → tokens.
- Builder header: delete moves into an overflow (⋯) menu (confirm dialog
  kept); status `open` adds "View live form" (opens `/f/{id}`).
- PublicDirectoryPage: "By competition" grouping (sport → category tree) of
  registered institutions, from directory leaves data.

## Out of scope (tracked, not lied about)

Discipline/suspension enforcement, extra-time/penalty shootout flows, video
streaming, per-institution stage-2 leaf scoping + team review workflow
(P6 remainder), email link delivery. Live score delivery is already
event-sourced + WS/SSE.

## Decisions log

- D-W2-1: Branching is generated *as data* on the existing visibility
  primitive — never a renderer special case (owner: users must be able to
  build the same thing).
- D-W2-2: Required-on-visible is the gap-closer for partial branch picks.
- D-W2-3: Sidebar hidden during managed setup only; members/viewers never
  lose navigation (owner reversal of 2026-06-10 always-sidebar decision).
- D-W2-4: Person uniqueness relaxes to per-team so multi-competition entry is
  representable; same-leaf double-entry blocked in register_school.
- D-W2-5: rules_will_freeze stays server-side (PRD §7), hidden in flow UI.
