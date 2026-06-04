# Cross-Cutting Audit — Invariant #9: Typed Match Dependency References

**Scope:** Whole backend + frontend (excluding `backend/.venv`, `frontend/node_modules`).
**Invariant under test (#9):** `Match.home_source` / `Match.away_source` are JSONB **typed pointers**
(`winner_of` / `loser_of` / `group_position` / `team` / `tbd`), **not** inferred from bracket
structure. Advancement is a `transaction.on_commit` domain-event hook.
**Date:** 2026-06-04
**Auditor model:** Opus 4.8 (1M)

---

## Verdict (TL;DR)

Invariant #9 is **entirely Phase 1B** and **not yet implemented** — there is no `Match` model, no
`fixtures`/`matches`/`tournaments` app, no typed-reference field, and no advancement hook anywhere in
backend or frontend. **This is expected** (Phase 1B is unbuilt). The audit therefore focuses on
**(a)** confirming the invariant is genuinely absent (no half-built / non-conformant version exists
that would violate it), and **(b)** whether anything in Phase 1A **blocks or pre-empts** a correct
#9 implementation. **Conclusion: Phase 1A does NOT block #9; the prep substrate is healthy** (Postgres
JSONB available, UUIDv7 helper reusable, `transaction.on_commit` pattern established, audit log already
carries nullable `tournament_id`/`match_id`). Findings below are all `info`-severity prep/readiness
items plus the documentation-staleness issue. No `critical`/`high`/`medium` violations exist because
there is no code to violate the invariant.

---

## Findings

### F1 — Invariant #9 has zero implementation (Phase 1B not built) — confirmed
**Severity:** info (expected per project status)
**Files (absence):** entire `backend/apps/` tree; entire `frontend/src/` tree.
**Evidence:**
- No `matches`/`fixtures`/`tournaments`/`teams` app exists. `backend/fixture/settings/base.py:46-55`:
  ```python
  # Phase 1A apps. tournaments/teams/matches/disputes deferred to Phase 1B.
  # `apps.sports` is the Phase 1B-prep catalog (read-only metadata only).
  LOCAL_APPS = ["apps.accounts","apps.audit","apps.organizations","apps.permissions","apps.sadmin","apps.sports"]
  ```
- Grep for `home_source|away_source|winner_of|loser_of|group_position|MatchSource` across the backend
  source returns **only** the audit `on_commit` helper (`backend/apps/audit/services.py:80,87`,
  unrelated) — no model field, no constant, no enum.
- Frontend grep for `home_source|away_source|winner_of|loser_of|group_position|MatchSource|winnerOf|
  loserOf|groupPosition|tbd` returns **No matches found** in `frontend/src`.
- The only backend `class Tournament` (`backend/apps/permissions/scope.py:18`) is a **docstring
  example**, not a real model:
  ```python
  class Tournament(models.Model):
      organization = models.ForeignKey(Organization, ...)
  ```
**Why it matters:** Establishes the baseline — there is no non-conformant or partial implementation to
remediate. The risk for #9 is purely *forward* (getting the future implementation right), not *present*.
**Recommendation:** Track #9 as an explicit acceptance item in the Phase 1B `fixtures`/`matches` plan.
When the `Match` model lands, `home_source`/`away_source` MUST be `models.JSONField` typed-pointer
discriminated unions (`{type: "winner_of"|"loser_of"|"group_position"|"team"|"tbd", ...}`), NOT inferred
from `parent_match_id`/bracket shape, and advancement MUST fire via `transaction.on_commit`.

### F2 — Canonical #9 contract is fully specified in the PRD (positive — no spec gap)
**Severity:** info
**File:** `docs/superpowers/specs/2026-04-30-fixture-platform-prd.md:951` (Match data-model row).
**Evidence:**
```
| **Match** | (tournament, stage, round, slot, home_source JSONB, away_source JSONB,
  home_team, away_team, venue, scheduled_at, status, score_home, score_away, periods JSONB,
  lineup_home_id, lineup_away_id, two_legged_aggregate JSONB, is_bye, parent_match_id,
  kicks_off_team_id, defends_side_team_id) |
```
Supporting clauses:
- `:241` — `Match dependencies (winner_of / loser_of / group_position)` listed In-Scope for v1.
- `:1045` — invariant `14. Match dependencies as typed references.` (PRD numbers it #14; project's
  15-invariant list numbers it #9 — same decision).
- `:859-862` — advancement is a `transaction.on_commit` domain-event hook:
  ```
  Domain-event hooks (on `transaction.on_commit`):
  - `match_finalized` → propagate advancement; ...
  - `dispute_resolved` → propagate advancement per `dispute_cascade_policy`.
  ```
- §5.5 transition table (`:416,420,422`) ties advancement to specific transitions
  (`awaiting_referee_approval → final`, `* → walkover`, `* → cancelled`).
**Why it matters:** The implementer has an unambiguous contract; the typed-pointer set, the JSONB
storage decision, and the `on_commit` advancement model are all locked. No clarification round needed.
**Recommendation:** When writing the Phase 1B plan, lift these line references verbatim into the
`Match` model task and the advancement-engine task so the typed-ref shape is not re-derived.

### F3 — PRD names a 5th typed-pointer variant (`team`/`tbd`) the project brief also lists — verify the full union
**Severity:** info
**File:** `docs/superpowers/specs/2026-04-30-fixture-platform-prd.md:241` vs project brief.
**Evidence:** PRD §4 in-scope row only enumerates three variants explicitly: `winner_of / loser_of /
group_position`. The project brief (invariant #9) enumerates **five**: `winner_of` / `loser_of` /
`group_position` / `team` / `tbd`. The `team` (a directly-seeded team) and `tbd` (unresolved
placeholder) variants are implied by the Match row's separate `home_team`/`away_team` columns and the
`is_bye` flag but are **not named in the §4 scope table**.
**Why it matters:** A future implementer reading only §4 could omit `team`/`tbd` from the discriminator
enum, producing an incomplete typed union and forcing a migration later (which #9 exists specifically
to avoid). Low-confidence as a *defect* (the brief is canonical and lists all five) but worth pinning.
**Recommendation:** In the Phase 1B spec, write the discriminator as a closed enum of exactly five
variants and add a test asserting any other `type` value is rejected by the JSON-schema validator.

### F4 — Postgres is the configured DB → JSONB typed pointers are supported (prep OK)
**Severity:** info (positive readiness)
**File:** `backend/fixture/settings/base.py:101`.
**Evidence:**
```python
DATABASES = {"default": env.db("DATABASE_URL")}
DATABASES["default"]["ATOMIC_REQUESTS"] = True
```
PRD §8 (`:974`) confirms `Postgres 16 (JSONB, UUID v7)`. `ATOMIC_REQUESTS = True` also means every
request is already wrapped in a transaction, so the `transaction.on_commit` advancement hook will fire
at request-commit boundaries as designed.
**Why it matters:** #9's typed pointers depend on real JSONB (indexable, queryable). The dev DB is
Postgres (not SQLite), so `JSONField` will map to native `jsonb`. No prep gap here.
**Recommendation:** None. When building `Match`, use `django.db.models.JSONField` (maps to `jsonb` on
Postgres) and add a GIN index if/when advancement queries filter on `home_source->>'type'`.

### F5 — `uuid7()` PK helper is reusable for `Match` (invariant #1 substrate present)
**Severity:** info (positive readiness)
**File:** `backend/apps/accounts/models.py:28-30`.
**Evidence:**
```python
def uuid7() -> uuid.UUID:
    """Return a UUID v7 as a stdlib uuid.UUID for DB storage."""
    return uuid.UUID(str(uuid_utils.uuid7()))
```
Already reused outside `accounts` (e.g. `apps/sports/models.py:21,71`, `apps/audit/models.py:19,47`).
**Why it matters:** #9's `winner_of`/`loser_of` pointers reference *other Match UUIDs* by id inside the
JSONB blob. A stable UUIDv7 PK on `Match` is the thing those pointers point at. The helper exists and
the cross-app reuse convention is established, so the typed-ref target id type is settled.
**Recommendation:** `Match.id = models.UUIDField(primary_key=True, default=uuid7, editable=False)` —
mirror `Sport`/`AuditEvent`. The JSONB pointer payload should store the referenced match id as a
string UUID (e.g. `{"type":"winner_of","match_id":"<uuid>"}`).

### F6 — Advancement `transaction.on_commit` pattern is established but no domain-event dispatcher exists yet
**Severity:** info (prep gap, Phase 1B-owned)
**File:** `backend/apps/audit/services.py:80-87`.
**Evidence:**
```python
def emit_audit_on_commit(**kwargs):
    """Defer audit emission until transaction commit."""
    transaction.on_commit(lambda: emit_audit(**kwargs))
```
This is the ONLY `transaction.on_commit` usage in the codebase. There is **no** generic domain-event
hook framework, no signal registry, and no `match_finalized`/`dispute_resolved` dispatcher (grep for
`domain_event|DomainEvent|dispatch` in `backend/apps` returns only Django framework import noise).
**Why it matters:** #9 mandates advancement as a `transaction.on_commit` domain-event hook (PRD
`:859-862`). The *primitive* (`transaction.on_commit`) is proven in-repo, but the *dispatcher* that #9
needs (resolve `home_source`/`away_source` pointers → populate dependent `Match.home_team`/`away_team`)
does not exist and is correctly deferred to Phase 1B.
**Recommendation:** In Phase 1B build an explicit `apps.matches.domain_events` (or `apps.fixtures`)
module with `match_finalized` / `dispute_resolved` handlers that (1) read dependent matches whose
`home_source`/`away_source` pointer references the just-finalized match, (2) resolve the pointer to a
concrete team, (3) write it, all inside `transaction.on_commit`. Reuse the `emit_audit_on_commit`
shape as the pattern.

### F7 — Audit log already carries nullable `tournament_id` / `match_id` — advancement audit is unblocked
**Severity:** info (positive readiness)
**File:** `backend/apps/audit/models.py:64-65`.
**Evidence:**
```python
tournament_id = models.UUIDField(null=True, blank=True, db_index=True)
match_id = models.UUIDField(null=True, blank=True, db_index=True)
```
These are **plain UUIDFields, not FKs**, so they do not require the (nonexistent) `Tournament`/`Match`
models to be present.
**Why it matters:** #9 advancement transitions are audit-logged (PRD §5.5 `:416,420,422`,
"Triggers advancement domain event"). The audit substrate already has scope columns ready to receive
those rows the day `Match` exists — no audit-schema migration is gated on #9.
**Recommendation:** None for now. When `Match` lands, emit advancement audit events with
`event_type="match_advanced"` (or similar), `match_id=<dependent match>`, payload describing the
resolved pointer (before: `{type:"winner_of",...}`, after: `{home_team:"<uuid>"}`).

### F8 — `ScopedManager` chassis ready for `Match` org-scoping (multi-tenancy + #9 interplay)
**Severity:** info (positive readiness)
**File:** `backend/apps/permissions/scope.py:1-30, 38-122`.
**Evidence:** The module docstring explicitly names matches as a future consumer
(`:3-5`: "future tournaments, teams, matches") and provides `ScopedManager.from_queryset(...)`.
**Why it matters:** Resolved teams flowing through `home_source`/`away_source` pointers must stay
org-scoped (invariant #2). The advancement engine must NOT leak a team/match across orgs. The scoping
primitive already exists, so #9's advancement queries can be written against `Match.objects.scoped_for_user`.
**Recommendation:** Phase 1B advancement queries that walk `home_source`/`away_source` must operate on
the org-scoped queryset and add an isolation test: a `winner_of` pointer can never resolve to a match
in another org (it can't, since matches share a tournament/org, but assert it).

### F9 — Root `CLAUDE.md` is stale ("greenfield, pre-implementation") — misleads #9 readiness assessment
**Severity:** low
**File:** `CLAUDE.md` (root), "Project status" section.
**Evidence:** Root `CLAUDE.md` states: *"**Greenfield, pre-implementation.** No source code exists
yet."* and *"Repository layout (planned, not yet built)"*. This is false: Phase 1A is implemented and
runs (accounts/audit/organizations/permissions/sadmin/sports apps with migrations + tests exist).
**Why it matters:** Not a #9 code violation, but it directly corrupts any reader's mental model of #9
readiness — a contributor could conclude "nothing is built, so #9 prep is also nonexistent," when in
fact the JSONB DB, UUIDv7 helper, `on_commit` pattern, and audit scope columns are all in place and
ready. Stale status docs are a recurring risk for greenfield→Phase-1A transitions.
**Recommendation:** Update root `CLAUDE.md` "Project status" to reflect Phase 1A complete / Phase 1B
pending, and change "Repository layout (planned, not yet built)" to mark which apps now exist. (Already
flagged in the project's known-issues list item (e).)

---

## Gaps (Phase 1B prep checklist for invariant #9)

All gaps below are **Phase 1B-owned**; none are blocked by Phase 1A. Listed so the writing-plans phase
can fold them in.

| # | Gap | Missing | Needed for | Blocking 1A? | Effort |
|---|-----|---------|------------|--------------|--------|
| G1 | `Match` model | No `matches` app / `Match` model at all | The home of `home_source`/`away_source` typed pointers | No | L |
| G2 | Typed-pointer JSON schema | No JSON-schema validator for the 5-variant discriminated union (`winner_of`/`loser_of`/`group_position`/`team`/`tbd`) | Enforcing #9's "typed", not free-form, contract; rejecting unknown `type` | No | M |
| G3 | Advancement domain-event engine | No `match_finalized`/`dispute_resolved` `on_commit` handlers; only `emit_audit_on_commit` primitive exists | #9's "advancement is a `transaction.on_commit` domain-event hook" | No | L |
| G4 | Pointer-resolution logic | Nothing that walks dependents whose `home_source`/`away_source` references a finalized match and writes the concrete team | Actually advancing teams through a bracket via typed refs (not bracket-shape inference) | No | L |
| G5 | `parent_match_id` vs typed-ref discipline | `Match` row also has `parent_match_id` (`prd:951`); risk an implementer infers advancement from it, violating #9 | Keeping advancement driven by JSONB typed pointers, with `parent_match_id` only a denormalized convenience | No | S |
| G6 | `inputs_hash` / `last_manual_edit_at` on generated brackets | No `GenerationRun` model yet (`prd:962`); bracket gen will set the source pointers | Invariant #10 interplay — regenerating a bracket must rewrite typed pointers, not orphan them | No | M |
| G7 | Multi-tenancy isolation test for advancement | No test asserting a typed pointer cannot resolve cross-org | Invariant #2 + #9 interplay | No | S |
| G8 | Frontend types | No `MatchSource` / `home_source` TS types in `frontend/src/types`; only "tournaments-coming-soon" route stubs (`frontend/src/lib/routes.ts:33-34`) | Rendering "Winner of QF1" style TBD placeholders in the bracket UI | No | M |
| G9 | Stale root status doc | `CLAUDE.md` says greenfield (F9) | Accurate readiness picture | No | S |

### Prep substrate that is ALREADY in place (do NOT rebuild)
- Postgres + JSONB + `ATOMIC_REQUESTS` (`settings/base.py:101-102`) → typed pointers + `on_commit` ready.
- `uuid7()` UUIDv7 PK helper, cross-app reuse convention (`accounts/models.py:28`).
- `transaction.on_commit` pattern proven (`audit/services.py:80-87`).
- Audit log nullable `tournament_id`/`match_id` scope columns (`audit/models.py:64-65`).
- `ScopedManager` org-scoping chassis explicitly anticipating `matches` (`permissions/scope.py:3-5`).
- Full canonical #9 contract specified in PRD (§4 `:241`, §8 `:951`, §7.3 `:859-862`, §5.5 `:416,420,422`).
