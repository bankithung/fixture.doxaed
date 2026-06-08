# Tournament Flow + Flexible Constraint Engine — Design Spec (Draft v1)

Status: **capturing the vision** (2026-06-08). This is the north-star for the
logic restructuring. Decisions marked **[OPEN]** need confirmation before build.

---

## 1. The end-to-end flow (as the user described it)

A tournament moves through **explicit stages**. Each stage has its own
registration surface (a data-driven form) *or* direct admin entry, gates the
next stage, and is **reversible** (admin can always go back to edit/add). Moving
forward **auto-closes** the previous stage's form and **warns** the admin first.

```
Create tournament
      │
      ▼
[Stage 1] ORGANIZATION REGISTRATION
   • Option A: create a form → invite interested schools/colleges/orgs to apply
   • Option B: admin adds organizations directly
      │  (advancing → org-reg form auto-closes + admin warned; reversible)
      ▼
[Stage 2] TEAM REGISTRATION (per registered organization)
   • Admin creates a form → a registered person opens it, SELECTS their
     organization, sees that org's current teams, and adds / updates teams
   • Option B: admin enters teams directly by selecting a registered org
      │  (advancing → team-reg form auto-closes + admin warned; reversible)
      ▼
[Stage 3] MEMBERS & ROLES (run-the-tournament staff)
   • Admin invites members to THIS tournament and assigns each a role
   • Invited members see the tournament in their profile
      │
      ▼
[Stage 4] FIXTURE GENERATION (constraint-driven — see §3)
   • NOT one-click. A deep wizard: pick sport, pick tournament type, then a
     thorough requirements interview → fixtures generated to the user's needs.
```

### Stage mechanics (apply to every transition)
- **Forms auto-close** when the stage they belong to is left.
- **Warn before advancing** ("you're moving to Team Registration — the
  Organization form will close. Continue?").
- **Reversible**: admin can return to a prior stage to edit/add; re-opening a
  stage re-opens its form (with a note that downstream artifacts may need review
  — tie into the existing `inputs_hash` / `last_manual_edit_at` regeneration UX).
- Stage state is part of the tournament state machine (extends the existing
  Tournament status enum — see the analysis dossier's STATE-MACHINES section).

### Entities implied by this flow  **[OPEN — confirm in §4]**
- **Participant Organization** (school / college) = a first-class registered
  entity that **owns multiple Teams**. Hierarchy:
  `Participant Org → Team → Player (Person)`.
  - This is a NEW level above the current `Team` model. The current model treats
    a school *as* a Team. Confirm we want the two-level hierarchy.
- **Member** (Stage 3) = a platform user invited to help run the tournament with
  one of the tournament-scoped roles — reuse the existing `TournamentMembership`
  (6 roles, 3 statuses) and surface "tournaments I'm invited to" in the profile.

---

## 2. Registration surfaces (reuse + extend the forms engine)

Both Stage 1 and Stage 2 are the existing **data-driven forms engine**, with two
authoring affordances per stage: a shareable public form, OR direct admin entry.

- **Stage 1 form** (`purpose: organization_registration`): collects org details;
  on submit, creates/links a Participant Organization (entity mapping).
- **Stage 2 form** (`purpose: team_registration`): the respondent first
  **selects their registered organization** (a dynamic, data-bound field whose
  options are the Stage-1 orgs), then sees that org's existing teams and
  adds/updates. On submit, creates/updates Teams (+ Players) under that org.
  - New capability needed: **form fields bound to live tournament data**
    (the "select your organization" dropdown is populated from Stage-1 results),
    and **per-respondent scoping** (a school's people only see/edit their org's
    teams). This extends today's static-schema forms.

---

## 3. The flexible fixture-generation engine (FET-style)  ← the heart of it

**Principle: no hardcoded formats or rules. A dynamic, declarative constraint
engine** — the user expresses requirements; the engine produces a schedule that
satisfies all **hard** constraints and optimizes **soft** ones. Inspired by
**FET (Free Timetabling Software)**: a constraint catalog + a solver, not a
fixed algorithm.

### 3.A The fixture-generation wizard (deep requirements interview)
Driven by the chosen **sport** + **tournament type**, ask the right questions:

1. **Sport & format**: round-robin (single/double), knockout (single/double
   elim), groups → knockout, Swiss, league w/ playoffs, ladder, multi-event /
   multi-category (e.g. the Sepak Takraw + Table Tennis categories form), pool
   play, consolation brackets. Individual vs team sports.
2. **Calendar**: date range, excluded dates/holidays, match-days vs rest-days,
   number of rounds/legs, home/away.
3. **Timing**: daily time windows, slot length = expected match duration +
   buffer, warm-up/turnaround between matches, max matches per day overall and
   **per team** (rest rules), earliest/latest start.
4. **Venues**: list of venues/courts/grounds, capacity, availability per
   venue/day/slot, which sports/categories a venue supports, travel between
   venues.
5. **Seeding / draw**: seeded vs random, pots, byes handling (non power-of-2).
6. **Soft preferences**: spread a team's matches evenly, avoid back-to-back,
   prime-time for marquee matches, balance venue usage, minimize travel.

### 3.B Constraint taxonomy (hard vs soft; real-life scenarios)
Every constraint is a **typed, parameterized, declarative record** (JSONB),
interpreted at runtime — never hardcoded. Catalog (extensible):

**Hard (must hold):**
- No team plays two matches in the same slot (resource: team).
- No venue hosts two matches in the same slot (resource: venue).
- A team gets ≥ N minutes/hours rest between matches.
- Max matches per team per day.
- Respect venue/day/slot availability windows.
- **Same-organization teams cannot meet in the opening round/stage** (e.g. two
  teams from the same school avoid each other early) — and generalizable:
  "teams sharing attribute X are kept apart until round R".
- A team's blackout dates/times (unavailability).
- Category/age-group can only be scheduled in compatible venues.

**Soft (optimize / warn):**
- Even spacing of each team's fixtures across the date range.
- Avoid back-to-back matches for the same team.
- Balance matches across venues / time slots.
- Prefer certain venues/times for finals or seeded teams.
- Minimize total tournament span or travel.

The user assigns each constraint **hard | soft + weight**, and the engine
reports which soft constraints it could/couldn't satisfy.

### 3.C Engine architecture (declarative + solver)
- **Constraint model** (data): `Tournament.constraints` (JSONB) = a list of
  typed constraint records `{type, scope, params, severity, weight}` + a
  resources model (teams, venues, time-slots, availability). Builds on the
  existing `apps/fixtures/services/constraints.py` catalog — generalize it.
- **Generator/solver**: phase 1 = pairing generation by format (existing
  `generate.py` round-robin/knockout/groups), phase 2 = **assignment** of each
  pairing to a (date, slot, venue) honoring hard constraints + optimizing soft.
  - Start with a **constructive heuristic + repair** (greedy + backtracking /
    local search) — good enough, explainable, fast. Keep the solver behind an
    interface so a stronger backend (CP-SAT / OR-Tools) can replace it later if
    we want FET-grade optimization.  **[OPEN — heuristic vs full solver, §4]**
- **Explainability**: after generation, show satisfied/violated constraints,
  and offer manual edits with conflict warnings (reuse `inputs_hash` /
  `last_manual_edit_at`). Regeneration is idempotent on the same inputs.
- **Freeze**: constraints follow the existing rule-freeze invariant (mutable in
  draft/published, frozen at registration_open / once live).

---

## 4. Decisions
1. **Participant hierarchy** — CONFIRMED: introduce a first-class
   **Institution/Participant** entity owning Teams. Hierarchy
   `Institution → Team → Player(Person)`. (Named to avoid clashing with the
   existing tenant `Organization`.)
2. **Sports scope** — CONFIRMED: **multi-sport + multi-category from day one**.
   Engine must handle team sports AND individual sports, and multi-event
   tournaments (e.g. Sepak Takraw + Table Tennis with singles/doubles +
   age-group categories). Implications: a `Sport`-driven config (slot length,
   participants-per-match, scoring model), per-category sub-draws/brackets, and a
   constraint catalog that spans courts/grounds across sports.
3. **Solver ambition** — CONFIRMED: **layered**. Build the declarative
   constraint model + a solver interface once. Ship a **heuristic backend**
   first (constructive + repair/local-search; runs inline; instant wizard
   preview; explainable; satisfies hard, optimizes soft). Then add a committed
   **CP-SAT (OR-Tools) backend** as the "Optimize" engine for hard/optimal
   cases. Both sit behind the same interface (CP-SAT is a drop-in, not a
   rewrite). OR-Tools `cp314` manylinux wheel (v9.15, ~30 MB) is confirmed
   installable on the current venv (Python 3.14). Implication: the CP-SAT phase
   needs an **async job system** (background worker + progress) since solves
   can't block a request — evaluate Celery (educonnect already runs it) vs a
   Channels/Redis-backed task.
4. **Members stage** — reuse existing `TournamentMembership` (6 roles, 3
   statuses) + surface "invited tournaments" in the profile. CONFIRMED (default).

## 5. Grounding
This spec will be reconciled against the in-flight analysis dossier
(`docs/ARCHITECTURE.md`, `docs/DEEP-DIVE.md`, `docs/RESTRUCTURING-BLUEPRINT.md`)
and the engine sections (`docs/deep/ENGINES.md`,
`docs/deep/STATE-MACHINES.md`, `apps/fixtures/services/*`,
`apps/tournaments/services/rules.py`). The build plan becomes a workstream in the
restructuring blueprint.
