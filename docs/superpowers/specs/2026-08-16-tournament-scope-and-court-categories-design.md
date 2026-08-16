# Tournament scope (inter- vs intra-school) + per-category courts

Design, 2026-08-16. Owner asks, verbatim in intent:

1. **Scope at creation.** "Add an option when creating a tournament: between different
   schools, or within the school. Between different schools the flow remains the same. Within
   the school the institute registration is not required at all — there's only one. So we
   will have only the team registration, where the admin will set up all the houses… and the
   admin will add members so that the members who are in the respective house can add
   students also." House names are free text — "the admin or the host can give any name they
   want".
2. **A default form for the within-school flow** "just like we have for between different
   schools… a refined proper form that can be used directly too".
3. **Courts per category.** "Our court support only lets you select [by] sport, not
   categories. If I add one court I can only select the main sport. Inside the sport there
   can be two courts, so the user has to have the option to select a specific court for a
   specific category — in the sub-category I have girls and boys, so court one boys, court
   two girls."

---

## 1. Current logic, as it actually is

Established by a read-only survey of eight subsystems, each verified by a second pass. Line
anchors are from `main` at `1a9db6a`.

### 1.1 The setup funnel

`Tournament` carries two orthogonal enums: `TournamentStatus` (the PRD §5.2 lifecycle) and
`TournamentStage` (the setup funnel). `apps/tournaments/services/state.py` is the single
writer of both.

- `_ORDER = [SETUP, ORG_REGISTRATION, TEAM_REGISTRATION, FIXTURES, READY]` (`state.py:66`).
  `MEMBERS` was retired 2026-08-14 and survives only as a fractional rank.
- `_allowed(frm)` permits **exactly one step forward**, and backward to any earlier stage
  (`state.py:114`). There is no skip mechanism and no per-tournament order.
- `_STAGE_STATUS` (`state.py:107`) couples stage entry to the lifecycle:
  `ORG_REGISTRATION → published`, `TEAM_REGISTRATION → registration_open` (which fires
  `freeze_rules`), `READY → scheduled`. **`ORG_REGISTRATION` is the only path to
  `published`.**
- `FLOW_ORDER` is exported as *the* list and is re-served to the browser as the stage
  payload's `order`, so screen and prompt cannot drift.

A tournament is created name-only (`TournamentCreateSerializer` = `{name, sport_code,
event_id}`) through the single path `services/create.py::create_tournament`. There is **no**
scope/kind/participant column anywhere.

`rules` is not a viable home for a scope flag: `merge_rules` rejects unknown top-level keys,
and everything in `rules` freezes at `registration_open` — exactly when an intra-school event
would still be opening registration.

### 1.2 Competitors today

Two-stage, institution-centric:

- **Stage 1** — a generated *Institution registration* form (school details + a progressive
  sport→category chain). `map_response` → `_map_organization_registration` →
  `get_or_create_institution` creates one `teams.Institution` per school and stamps the chosen
  leaves into `Institution.attributes["leaves"]`.
- **Stage 2** — entering `team_registration` auto-generates a *Team registration* form whose
  first field is a live-bound `institution_id` dropdown
  (`data_source: {"type": "institution_list"}`), plus one conditional section per leaf.
  Submission is gated by an 8-char access code hashed onto `Institution.team_code_hash`,
  exchanged for a 2h signed token. `map_response` → `_map_team_registration_multi` →
  `register_school` writes `Team` + `Person` + `Player`, stamping `Team.sport` / `Team.leaf_key`.

Everything downstream keys on `Team.institution_id` **or** on the denormalised free-text
mirror `Team.school` — and the two are never reconciled. Standings, the public schedule and
fixture previews read the *string*; separation, constraints, records, lens, emails and
calendars read the *FK*.

### 1.3 The house spine that already exists

This is the part that changes the shape of the work:

- `teams.Season` — org-scoped academic year.
- `teams.TeamGroup` — `kind = house | class | form | department`, free-text `name`, optional
  `colour`, unique per `(season, name)`. Its docstring already states the intent: *"In an
  inter-school tournament the school is the participant; on a sports day the HOUSE is."*
- `teams.HousePointEntry` — an append-only points ledger with `season_house_table()` and a
  meet-results placement ladder (7-5-4-3-2-1, relays doubled).
- `Team.group` FK → `TeamGroup`, and `Tournament.season_ref` FK → `Season`.
- Backend routes under `/api/orgs/{uuid}/seasons/…` and a `HousePointsPage` in the frontend.
- `TOURNAMENT_PRESETS` already ships `annual_sports_day`, `inter_house_league`,
  `inter_class_knockout` — each only a sports tree, with no UI calling `/presets/`.

**But `Team.group` and `Tournament.season_ref` are dead columns: nothing writes them and
nothing reads them.** `TeamGroup` is scoped to `(organization, season)` and never to a
tournament, so today no query can answer "which houses play in this tournament". There is no
model anywhere linking a user to a house. So the *scoreboard half* of intra-school is built
and the *competition half* is not.

### 1.4 Venues, courts and the scheduler

- `Venue` is an **org-level** facility (name / type / windows / breaks / unavailable dates /
  `count` / `sports`), shared across the org's tournaments, unique name per org.
- `count = N` is expanded at run time by `expand_venues` (`scheduler.py:509`) into N display
  strings `"<base> · T<n>"` (U+00B7). **Those strings are court identity**: the scheduler
  assigns `(datetime, venue_display_string)`, and `apply_schedule` / `reschedule_match` /
  `swap_slots` write it into `Match.venue`, mirroring it into `Match.court` via
  `CourtResolver`, which *lazily materialises* `Court` rows.
- Every resource attribute in `ScheduleConfig` — `venue_types`, `venue_windows`,
  `venue_breaks`, `venue_counts`, `venue_unavailable_dates`, `venue_sports` — is keyed by the
  **base venue name**, so all courts of one venue are indistinguishable to the engine. Even
  "court 1 = TT, court 2 = sepak" is unrepresentable.
- The only placement filter is a **sport-key allow-list** (`Venue.sports` → `cfg.venue_sports`),
  enforced in exactly two places: `schedule_matches.feasible` (`scheduler.py:960`) and
  `optimizer._single_match_ok` (`optimizer.py:153`). It is compared against `m.sport`, never
  `m.leaf_key`.
- `validate_schedule` has **no** sport check at all, and every repair verb routes through it —
  so a manual move already bypasses the sport binding today.
- `Court` has only `venue`, `name`, `index`. Its REST API is **read-only**
  (`apps/fixtures/views.py:1123`), the frontend has no client for it, and the venue editor
  models courts as an integer `count` expanded client-side by `lib/courts.ts`. There is
  literally nowhere to hang a category.
- `readiness._courts_for` buckets courts by sport only, so the feasibility warning would be
  blind to a per-leaf reservation.

### 1.5 The leaf_key contract

A competition's identity is `leaf_key` — the sport key followed by every node key on the
path, joined by a single ASCII dot: `table_tennis.u14.boys` (`LEAF_SEP = "."`,
`sports.py:28`; minted only in `_walk_leaves`, `sports.py:304`). `Team.leaf_key` and
`Match.leaf_key` are plain indexed `CharField(160)`. Labels join the path with `" · "`.

Every consumer matches by **exact string equality**. The only prefix mechanisms are the
`sport:<key>` pseudo-scope and ad-hoc `startswith(prefix + ".")` fan-outs — except
`apps/forms/views.py:349`, which already builds the full ancestor-prefix space for every leaf.
There is no shared, tested prefix resolver.

**This is the fact Feature B rests on.** `Venue.sports = ["table_tennis"]` is already a
prefix filter over the leaf key, truncated at the first segment.

---

## 2. Decisions

### D1 — `Tournament.scope` is a real column, set at creation, immutable afterwards

`scope = inter_school | intra_school`, default `inter_school`. Not in `rules` (freezes at the
wrong moment, and `merge_rules` rejects unknown keys). Immutable once the tournament leaves
`setup`, because it decides which stages exist and therefore which registration data can
exist.

### D2 — Intra-school **replaces** `ORG_REGISTRATION` with `HOUSE_SETUP`; it does not skip a stage

Rejected: a scope-conditional `_ORDER` (breaks the `FLOW_ORDER` ↔ `order` parity contract that
five frontend files and the assistant prompt depend on) and a legal `setup → team_registration`
edge (silently drops `published`, the only producer of that status).

Instead the funnel keeps five stages and swaps the identity of the second:

| # | inter_school | intra_school |
|---|---|---|
| 1 | Setup | Setup |
| 2 | **Institution registration** | **Houses & members** |
| 3 | Team registration | Team registration |
| 4 | Fixtures | Fixtures |
| 5 | Ready | Ready |

`_STAGE_STATUS[HOUSE_SETUP] = published`, so the lifecycle is identical in both modes.
`flow_order(tournament)` replaces the module constant `FLOW_ORDER`; the payload's `order`
still comes from the one function, so screen, prompt and server cannot drift.

### D3 — The competitor is a house, but the host school stays a real `Institution` row

An intra-school tournament auto-creates **one** `Institution` (the host school, derived from
the operator `Organization`) at creation, already `registered`. Every team keeps
`Team.institution` → that row, and carries `Team.group` → the house.

This is deliberate: ~40 readers key on `Team.institution` / `Team.school`, including
`PROTECT`ed FKs and email targeting. Forking all of them is a much larger and riskier change
than giving them one satisfied row to read. One accessor —
`competitor_of(team)` / `competitor_label(tournament)` — decides which of the two the UI
labels and groups by.

### D4 — Houses stay season-scoped; a tournament selects which ones play

`TeamGroup` already hangs off `(organization, season)`, and the points ledger sums a whole
year across events — houses are a property of the school year, not of one event. So:

- an intra-school tournament **requires** a `season_ref`, auto-created/attached at creation
  (the org's current season, else one minted from the event year);
- a new `TournamentHouse(tournament, group)` join records which houses take part, defaulting
  to every house in the season;
- `TeamGroup` gains `deleted_at` (soft delete) + rename, which it lacks today.

The *kind* is chosen at creation too — House (default), Class, Form or Department — so the
same machinery runs an inter-class tournament, and no user-visible string hardcodes "house".

### D5 — House managers are assigned users, not codes

New `TeamGroupMembership(user, group, role=manager, status)`. A user assigned to a house may
register **only** that house's students. The existing per-institution code/link path is
generalised, not replaced, so an account-less house captain can still be given a link.

**Found while surveying, and fixed as part of this work:** the Stage-2 submit gate is
`can_access_module(user, tournament, "forms")` (`apps/forms/views.py:606`), and `forms` is a
role default for `team_manager`. So today *any* tournament team-manager can submit — and via
`authorized_inst_id`, supersede and replace — the team set of *any* institution, with no code.
That is a live authorization hole in the inter-school flow, not only a problem for houses.

### D6 — One generated form for intra-school, mirroring the two-form school flow

No Stage 1 means one generated form is the whole registration. Same generator, same
`settings` tags, same `inputs_hash` regeneration contract, same single traversal engine on
both sides:

1. **Which house** — first question, live-bound via a new `house_list` data source, the exact
   shape the `institution_list` source already returns (so `_public_payload` and
   `PublicFormPage` need no branch). Pre-filled and locked for a member assigned to one house.
2. **The competition chain** — the generated sport→category branching questions.
3. **The students** — a repeatable group with school-internal fields: name, **class and
   section**, roll number, date of birth, jersey number, captain. "School" and "Region" do not
   appear; they are meaningless inside one school.

`bindings` gains a competitor-agnostic `competitor_id` + `competitor_kind`, threaded through
the six call sites that currently read `bindings["institution_id"]`.

### D7 — Court restriction is a list of leaf-key **prefixes**, stored on `Court`

`Court.competitions: list[str]`, empty = anything. A stored value matches a match when it
equals the match's `leaf_key` or is a **segment-aligned** prefix of it — so
`table_tennis` = the whole sport (exactly today's behaviour), `table_tennis.u14` = both
genders, `table_tennis.u14.boys` = one competition. `table_tennis.u1` matches nothing.

On `Court` and not `Venue`, because the owner's example is two courts in one hall. The
venue's `sports` list stays as the coarse filter above it: a match must pass **both**.

This is a widening of an existing contract rather than a new one — today's stored
`["table_tennis"]` already reads correctly under the new rule, so no data migration and no
behaviour change for existing venues.

Consequences that are part of this work, not follow-ups:

- **Courts become real rows, eagerly.** Materialise `Court` rows when a venue's `count`
  changes (the lazy `CourtResolver` path stays as a backstop), and give `Court` real CRUD —
  today an admin cannot address "court 2" before a match has landed on it.
- **The scheduler learns a court axis.** `expand_venues` must carry per-court attributes;
  `ScheduleConfig` gains `court_competitions` keyed by the *expanded* court name (every
  existing key is the base name). Filter sites: `schedule_matches.feasible`,
  `optimizer._single_match_ok`, the `relaxed_venue_type_sports` satisfiability probe — and
  `validate_schedule`, with a new violation code, which closes the pre-existing hole where a
  manual repair bypasses even the sport binding.
- **Capacity has to be told.** `readiness._courts_for` buckets supply by sport and demand by
  sport; pinning boys to court 1 halves the real supply for that leaf. The readiness warning
  must bucket by leaf once any court is restricted, or the generator will happily emit a day
  that cannot be played.

### D8 — Corrections in the competitor pipeline that intra-school forces

Each of these is a real defect under one shared institution, not a nicety:

| Site | Today | Under intra-school | Fix |
|---|---|---|---|
| `register_school` Person dedupe | reuses a `Person` by `full_name__iexact` **within the institution** | one institution ⇒ two different students of the same name in different houses collapse into one Person | dedupe by `(institution, group)` |
| blank team name default | defaults to the **institution** name, suffixing " 2"/" 3" on collision | every house fights over `"<School>"` and silently becomes `School 2`, `School 3` | default to the **house** name |
| `unique_team_name_per_competition` | `(tournament, leaf_key, name)` | no per-house namespace | add a uniqueness rule of one team per `(leaf_key, group)` |
| `_separate_institutions` (always on) | buckets by `Team.institution_id` | every team in one bucket ⇒ the guard returns the input order; the pass is dead weight | bucket by **competitor**: institution inter-school, group intra-school |
| `team_tag_map` | emits `school` / `district` tags from `Institution` | `tag:school=<id>` is a constant that matches everything | emit a `house` tag; keep-apart by house |
| supersede + duplicate-name validation | filter prior responses on the `institution_id` answer | a house would not supersede its own prior entry | key on `competitor_id` |

---

## 3. Increments

Each lands green (`pytest` + `vitest` + `tsc`) and is committed on its own.

1. **Scope + funnel.** `Tournament.scope`, `TournamentStage.HOUSE_SETUP`, `flow_order()`,
   `_STAGE_STATUS`, creation (scope + season + host institution + group kind), stage payload,
   immutability guard. Tests: both funnels end to end, `published` reached in both, illegal
   skips still rejected, scope frozen after `setup`.
2. **Houses as tournament participants.** `TeamGroup` soft-delete + rename,
   `TournamentHouse`, `TeamGroupMembership`, tournament-scoped house CRUD + member assignment,
   permission predicates. Tests: cross-org isolation, a house manager sees only their house.
3. **The intra-school registration form.** `house_list` data source, the generated default
   form, `competitor_id` bindings, `register_house`, the D8 corrections, and the D5
   authorization fix. Tests: submit, re-submit supersedes, a manager cannot submit for
   another house, same-name students in two houses stay two people.
4. **Courts per category.** `Court.competitions` + eager materialisation + CRUD, the scheduler
   filter at all four sites, the new validation code, readiness capacity by leaf. Tests: a
   restricted court refuses the wrong leaf, prefix matching is segment-aligned, a manual
   repair is now blocked, capacity warns before generating an unplayable day.
5. **Frontend.** Scope choice at creation, the Houses & members stage, the court editor with a
   category picker, and the competitor-label accessor across the operations and public pages.

## 4. Deliberately not doing

- Not moving house points onto match results automatically (`HousePointEntry` stays manual);
  it is a separate feature and the owner did not ask for it.
- Not reconciling `Team.school` (free text) with `Team.institution` (FK). It is a real latent
  bug, but unrelated to these two asks and large on its own.
- Not making `Venue` tournament-scoped. Venues stay an org-level pool.
