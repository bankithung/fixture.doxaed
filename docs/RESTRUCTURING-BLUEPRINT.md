# Fixture Platform — RESTRUCTURING BLUEPRINT

> The strategy + map for a complete restructuring of the platform's logic. **No code here** —
> this is the architecture assessment, the target seams/boundaries, candidate target
> architectures with trade-offs, an ordered dependency-aware set of restructuring workstreams,
> the client/server logic-unification strategy, and a risk register. It is the actionable
> companion to the technical dossier [`DEEP-DIVE.md`](./DEEP-DIVE.md). Each workstream is a map
> item, not a plan — per CLAUDE.md, real work goes brainstorm → write-plan → execute.
>
> Citations use `path::symbol`. Source verified 2026-06-08 against `/home/ubuntu/Fixture`.

---

## 1. Current architecture assessment (what to keep, what to cut)

### 1.1 The good (the restructuring's assets — preserve these)

1. **Clean service layering.** Thin DRF views delegate to `services/*.py` functions with explicit
   kwargs that raise `ValidationError`/`PermissionError` as the contract, atomic, idempotent on
   `event_id`, emit audit inline. **Most APIs can be re-fronted with low risk if the service return
   types and `emit_audit` event-type strings are preserved.** This is the single biggest asset.
2. **A single tenancy funnel.** `accessible_tournaments` + `can_manage_tournament` + the
   404-before-403 contract are applied uniformly and pinned by isolation tests in every domain app.
3. **A real append-only audit guarantee** at the DB level (trigger fires even for superuser),
   with one sanctioned write path (`emit_audit`).
4. **A genuine event-sourcing core** for match events (gapless seq under lock + derived score +
   on_commit publish), and **three genuine, near-identical guarded+audited state machines** —
   `transition_match` (`matches/services/state.py`), `transition_dispute`
   (`disputes/services/lifecycle.py`), and the **organization lifecycle** machine
   (`organizations/services/lifecycle.py`: approve/reject/suspend/unsuspend/archive/`detect_orphaned`).
   This is both an asset (a proven pattern) and a consolidation opportunity (see S5) — the
   restructure is **not** inventing the state-machine pattern, it already exists 3×.
5. **Data-driven JSONB engines** (rules/constraints, forms) with whitelist-merge semantics and a
   per-type handler registry pattern (`forms/fields.py::_HANDLERS`) — the right shape for a
   sport-agnostic chassis.
6. **A disciplined frontend** with three clean choke points (`apiFetch`, `lib/routes`, `authStore`),
   an anti-drift type contract (`api.generated.ts` from `openapi-typescript`), a token design system,
   and pure well-tested islands (`computeNavItems`, `formLogic`, `builderStore`, `redirectByRole`).

### 1.2 The structural problems (what the restructuring must fix)

| Class | Problem | Evidence |
|---|---|---|
| **Missing seam** | No Tournament state machine — invariants #6/#7/#14 hang off a hole. (NB: the pattern is **not** new — 3 realized SMs already exist: match, dispute, org-lifecycle) | DEEP-DIVE §4 inv 6, §2.2; STATE-MACHINES §1.2, §6 |
| **Duplicated state-machine code** | Three near-identical guarded-transition implementations (match `ALLOWED_TRANSITIONS`, dispute `ALLOWED_TRANSITIONS`, org per-verb guards) with no shared seam → the 4th (tournament) would be a 4th copy | DEEP-DIVE §2.2, §4 inv 6 |
| **Unbounded list endpoints** | No DRF default pagination; operator/public REST lists return whole querysets (matches, teams, disputes, form responses incl. CSV export) | DEEP-DIVE §6 M13 |
| **Duplicated authority** | Two un-unified role systems (`OrganizationMembership.role` for modules vs `TournamentMembership.role` for the live API); the module layer is unused by tenant endpoints | DEEP-DIVE §2.4; PERMISSIONS-AND-TENANCY §10 |
| **Divergent writers** | Two match score writers (`record_score` vs `recompute_score`) clobber each other; walkover never advances | DEEP-DIVE §6 H1/H2; verdicts V1/V2 |
| **Doc/code divergence** | SSE+WS documented, polling shipped; generator ignores rules; constraints inert; idempotency not universal | DEEP-DIVE §10 |
| **Logic forks** | Forms branching, standings, module codes, role enums, slug logic, hashed tokens duplicated across the client/server boundary and across files | DEEP-DIVE §2.9 |
| **Layering inversions** | `tournaments/urls.py` is a cross-app router (couples to 5 siblings); near-circular `accounts↔audit` and `tournaments↔disputes` | RESTRUCTURING-NOTES §1 |
| **Fragile idempotency** | Pre-checks outside the lock; cross-verb `event_id` collisions 500; storage inconsistent | DEEP-DIVE §6 H5/M4/M5 |
| **No DB-level tenancy guarantee** | Nothing ties `child.organization_id` to `tournament.organization_id`; deep-model isolation is service discipline only | DEEP-DIVE §6 H3 |
| **No durability for side effects** | on_commit hooks are synchronous, best-effort, lossy; no outbox; a crash drops them | DEEP-DIVE §6 LOW; audit-concurrency #7 |

### 1.3 Verdict

The **chassis (Phase 1A) is sound and should be preserved, not rewritten** — restructure it
in-place behind its existing seams. The **competition layer (Phase 1B) needs the missing seams
built and the divergent paths unified**, but its service-layer shape is a good foundation. This is a
**"strangle and consolidate behind existing seams"** job, not a greenfield rewrite. The risk is
concentrated in (a) the two parity contracts and (b) the missing Tournament state machine — both
addressable incrementally.

---

## 2. Target seams & boundaries (the cut lines)

These are the interfaces the restructuring organizes around. Most already exist as a single
chokepoint; the work is to harden/centralize them and add the few that are missing. (Distilled from
RESTRUCTURING-NOTES §5, re-prioritized by dependency.)

| Seam | Today | Target | Preserve |
|---|---|---|---|
| **S1 Access/Policy** | `accessible_tournaments` + `can_manage_tournament` + `_can_score` + `HasModule` scattered | One `Policy`/`Scope` object: query-optimized, request-memoized, single source for visibility + verb + scope | **404-not-403** contract; exact predicates |
| **S2 Audit write** | `emit_audit` (free-string `event_type`) | Same kwargs, + a typed `event_type` enum/registry; wire accepted `event_id` into `idempotency_key` | exact `event_type` strings (continuity); inline-in-txn |
| **S3 Tenancy** | Service-enforced org FK; no DB tie | Tenant-aware base manager/viewset + DB-level composite FK/CHECK (or Postgres RLS) so org/tournament drift is impossible | partial-unique constraints; org-less `Person`/`Sport`/audit |
| **S4 Idempotency** | Per-service pre-checks outside the lock; mixed storage | One race-safe helper: "get-or-create on idempotency key under the lock → 200 on replay"; one storage mechanism | replay semantics; the contract that replay returns the existing record |
| **S5 State-machine seam (generic) + Tournament SM** | **Three** un-unified guarded-transition machines exist (match, dispute, org-lifecycle); the Tournament SM is the only one *absent* | Extract one generic `guarded_transition(entity, to, ALLOWED_TRANSITIONS, …)` helper (lock + guard + mutate + inline `emit_audit`) and collapse all four onto it. Add `tournaments/services/state.py::transition_tournament` as the 4th instance — model it on the **dispute** SM (the cleanest standalone `ALLOWED_TRANSITIONS` dict, `disputes/services/lifecycle.py:16-22`), not just "mirroring matches"; calls `freeze_rules` on → registration_open; TZ-lock; migrations-blocked-while-live. The org-lifecycle machine should also adopt the shared helper (move its per-verb guards into an `ALLOWED_TRANSITIONS` table for consistency) | the freeze gate's existing `can_edit_rules` read; each SM's exact `event_type` audit strings; dispute's ≥5-char resolution gate; org-lifecycle's per-verb preconditions |
| **S6 Match event-log** | `record_match_event`/`recompute_score`/`record_score` (two writers) | One `MatchEventLog` abstraction (append+lock+gapless+recompute+publish in one place); `record_score` delegates through it or is an explicit override | gapless seq; derived score; lineups freeze rule |
| **S7 Pointers** | Construction in `generate.py`, resolution in `advance.py`; only 2 of 5 types real | One `pointers.py` owning construction + resolution of all types; expose in `MatchSerializer` | the JSONB pointer schema |
| **S8 Registration write** | `register_school` (sole writer) + two ingestion channels (teams link vs forms) | Keep `register_school` as the only domain writer; collapse ingestion onto the forms engine; new params keyword-only | `(event_id,"school_registered")` idempotency; `Team(status=REGISTERED)` selection contract |
| **S9 Rules** | `merge_rules` called per-reader; generator ignores rules | One `resolve_rules(tournament)`; source `DEFAULT_RULES` from the Sport registry; generator reads rules | whitelist-merge semantics |
| **S10 Constraint engine** | shape-only validation, inert | `validate_schedule`/`score_schedule` behind a per-type handler registry keyed off `CONSTRAINT_TYPES` | the catalog + shape validation |
| **S11 Live transport** | `publish_match_event` (one producer) + one consumer; no client | Real SSE (viewers) / authed WS (scorer) behind the same producer; `useLiveMatch(matchId)` hook with polling fallback | the `{match,events}` snapshot shape; on_commit publish |
| **S12 Notification dispatch** | `create_notification` (single entry; `_publish` no-op) | Add channels/preferences/batching behind the same entry point; wire `_publish` | the single-entry-point contract; per-user isolation |
| **S13 Hashed-token** | `_hash_token` ×4; pattern ×4 models | One `HashedToken` model (mint/hash/verify/consume/expire) | sha256/argon2id at-rest; expiry semantics |
| **S14 Settings/config** | base/dev/prod; pytest points at dev | Add a dedicated **test** settings module + a startup system-check asserting the immutables | `ATOMIC_REQUESTS`, UTC, auth backends, hashers, throttles |
| **S15 Module-code/role-enum** | 3 module-code lists + 3 role enums, hand-maintained | Generate a typed module-code enum + canonical role enum from one source for Python + TS | the catalog as source of truth; app label `permissions_app` |
| **S16 Frontend** | `apiFetch`/`lib/routes`/`authStore`/`computeNavItems`/`builderStore` + token layer | Same seams + a shared `<FormWizard>`, a single field-type registry, single standings source, a `matchesApi` | the design-system API surface (treat as frozen during restructure) |
| **S17 List pagination** | No DRF default; whole-queryset REST lists; only sadmin HTML + audit REST are bounded | One default pagination policy in `REST_FRAMEWORK` (`DEFAULT_PAGINATION_CLASS`/`PAGE_SIZE`) + a deliberate cursor/limit on the high-cardinality lists (matches, teams, disputes, form responses + a streamed/chunked CSV export) | the audit view's existing cursor scheme (default 50 / max 200); the `?export=csv` contract |
| **S18 Scheduled jobs / lifecycle ops** | 5 management commands are the de-facto background-job + seed layer (`mark_orphaned_orgs`, `load_modules`, `load_sports`, `snapshot_kpi`, `run_e2e_demo`); no Celery in 1A | Treat them as a first-class job layer: a documented schedule/runbook now; if Option C lands, fold the cron jobs (orphan-detect, KPI) and the seeds into the same worker/outbox operational story | idempotency of each command; the org-lifecycle `detect_orphaned` transition; the module/sport catalog seeds (sources for S15/S9) |

---

## 3. Candidate target architectures (with trade-offs)

Three coherent end-states. They are not mutually exclusive in detail, but each represents a
different center of gravity for *how much* to change and *where the authority lives*. The
recommendation is **Option B** as the primary path, adopting Option C's outbox selectively where
durability matters.

### Option A — "Hardened monolith" (minimal structural change)

Keep the current Django service-layered monolith and the React SPA exactly as they are
topologically. Restructure **in-place behind the existing seams**: build S5 (tournament state
machine), unify S6 (one score writer), close S4 (idempotency helper), add S3's DB-level tenancy
CHECK, and codegen S15 (enums). Live stays poll-first; SSE/WS deferred.

- **Pros:** lowest risk and lowest cost; preserves all 448+193 tests with minimal churn; every
  change is a localized service edit behind a stable interface; ships value fastest (the
  correctness bugs H1/H2/H4/H5 are fixable here without moving any boundary).
- **Cons:** does not resolve the two-role-system duplication (S1 stays two predicates); on_commit
  fan-out stays synchronous/lossy (no outbox); the SSE/WS invariant stays aspirational (a doc edit,
  not a feature); perf hotspots (full-scan advancement, N+1s) remain.
- **Best when:** the priority is correctness + clarity over scale, and the team wants to de-risk
  before any boundary move. **This is the correct *first* destination regardless of final choice.**

### Option B — "Consolidated domain core" (recommended) 

Option A **plus** collapse the duplicated authority and write paths into single domain seams:
unify S1 into one `Policy` object (visibility + verb + scope, with the two role systems reconciled
into one effective-permission resolver), S6 into one `MatchEventLog`, S7 into one `pointers.py`,
S8/S9/S10 into the rules-driven generation+constraint engine, and ship real SSE/authed-WS behind
S11 with the `useLiveMatch` hook. The monolith and SPA stay, but the domain logic has one home per
concept and the client/server forks are codegen'd or shared-fixture-locked.

- **Pros:** eliminates the dangerous duplication class (DEEP-DIVE §2.9); makes the sport-agnostic
  chassis real (rules sourced from `Sport`, generator reads rules, constraints enforced); unifies
  RBAC so `effective_modules` and the verb gate agree; live becomes real. Highest long-term clarity.
- **Cons:** larger blast radius — S1 (role unification) and S6 (score unification) touch many tests
  and have product-decision dependencies (which role system is canonical? derived-only or
  stored-with-override score?). Requires owner decisions before execution (see §6 risk register).
- **Best when:** the platform is heading toward multi-sport + multi-worker scale and the team can
  absorb a multi-phase effort. **Recommended end-state.**

### Option C — "Event-driven core with an outbox" (highest ceiling)

Option B **plus** replace in-request `on_commit` fan-out with a **transactional outbox + worker**:
match events, advancement, notifications, and live publishes are written to an outbox table inside
the verb's transaction and delivered at-least-once by a worker (idempotent consumers). Advancement
becomes a transactional, locked, targeted, retryable consumer. Optionally introduce Postgres RLS
for S3 instead of a CHECK.

- **Pros:** durable side effects (no silent hook loss on crash); decouples publish latency from the
  request; advancement is reliable and retryable; the cleanest answer to the ATOMIC_REQUESTS-makes-
  on_commit-batched-and-lossy problem (audit-concurrency #7). Scales to multiple workers cleanly.
- **Cons:** highest operational complexity (a worker, an outbox table, delivery monitoring,
  idempotent consumers everywhere); over-engineered if the platform stays single-region/low-volume;
  RLS adds a session-org-id contract to every connection. A bigger lift than the correctness bugs
  warrant on their own.
- **Best when:** real-time fidelity and side-effect durability become product requirements (live
  scoring at scale). Adopt **selectively** — the outbox is most justified for the live/advancement
  path; the rest of the system does not need it.

### Decision summary

```
Phase target:  A (correctness floor)  →  B (consolidated core, recommended)  →  C (outbox where it pays)
```

Treat A as non-negotiable groundwork, B as the destination, and C as an opt-in upgrade for the
live/advancement subsystem. Every workstream in §4 is tagged with the option it belongs to.

---

## 4. Ordered, dependency-aware restructuring workstreams

Sequenced so each lands on a stable base and unblocks the next. Each workstream lists **scope**,
**risk**, the **invariants it must preserve**, and **suggested verification**. Tags: `[A]`/`[B]`/`[C]`
map to §3. (Refines RESTRUCTURING-NOTES §7's 9 phases into 9 workstreams with explicit guards.)

### WS0 — Reconcile docs ↔ code + free, test-backed cleanups `[A]`

- **Scope:** Decide and document the SSE-vs-polling reality (CLAUDE.md #11 + PRD), the
  Tournament-state-machine gap, the constraint-engine gap, and impersonation. Fix the cosmetic
  drift (22→23 module count, "4 constraints" text, stale DEFERRABLE comments, `SADMIN_HOST`).
  Delete or wire the dead code (`dashboardCards.ts`, `roleRoutes`, B.18 reauth, `notify_many`,
  `OrgComingSoonPage`, `authBus.emit`, dead deps). Add the **dedicated test settings module** + a
  **startup system-check** asserting the immutables (S14).
- **Risk:** Low. No behavior change.
- **Preserves:** all 15 invariants (this only changes docs/dead code/config wiring).
- **Verify:** full test suite stays green; the new system-check fails loudly if an immutable is
  wrong; a CI assertion that pytest uses the test settings module, not dev.

### WS1 — Lock the parity contracts (de-risk before any structural move) `[A]`

- **Scope:** Add a **shared golden fixture** asserting identical reachable-key sets + required-field
  results for forms branching on both client and server (close verdict V5: the `gt`/`lt`-on-empty
  divergence is the first regression test). Codegen the **module-code enum** + **canonical role
  enum** from one source (`modules.json`/a role source) for Python + TS, killing the three
  module-code lists and the triplicated role enum (S15). Generate `forms/types.ts` from the schema.
- **Risk:** Low–Medium. The shared fixture may surface *more* existing divergences (good).
- **Preserves:** forms branching parity (§7 of DEEP-DIVE); module catalog as source of truth; app
  label `permissions_app`; resolution order (union-then-overrides, deny wins).
- **Verify:** the golden fixture runs in both `vitest` and `pytest` over the same JSON cases;
  `gen:types` is wired into CI so a drift fails the build.

### WS2 — Harden the access/audit/tenancy core (most-depended-on seams) `[A→B]`

- **Scope:** Fold S1 (`accessible_tournaments`/`can_manage_tournament`/`_can_score`) into one
  Policy object with query optimization + request memoization, **preserving 404-not-403**.
  Introduce the typed `event_type` registry behind `emit_audit` (S2) and wire `event_id` into
  `idempotency_key` (fixes grant-write idempotency). Move resolver cache invalidation to
  `transaction.on_commit` + finish the Redis pub/sub contract (M9). Add the DB-level composite
  FK/CHECK for org/tournament (S3, fixes H3). Ship the missing RunSQL DEFERRABLE migration for
  `one_owner_per_org` (M11), then simplify `transfer_ownership`. **`[B]` extension:** reconcile the
  two role systems into one effective-permission resolver (owner decision required — see RR-2).
- **Risk:** Medium. S1 touches every domain app's gates; S3's CHECK can reject existing bad rows
  (audit first). Role unification is high blast radius (defer to `[B]`).
- **Preserves:** **404-not-403** (the load-bearing contract); exact `emit_audit` event-type strings;
  grants keyed on `(user,org,module)`; deny-after-union; the last-admin guard; multi-role/multi-org
  intentionality (do NOT reinstate `single_org_per_admin_user`).
- **Verify:** every existing isolation test stays green (they pin 404-not-403); a new test that the
  org/tournament CHECK rejects a mismatched write; a multi-worker cache-invalidation test; a
  concurrent owner-swap test against the DEFERRABLE constraint.

### WS3 — Consolidate the write paths `[A→B]`

- **Scope:** Extract the `HashedToken` model (S13). Consolidate the 3 slug implementations into
  `organizations.services` and have `accounts.signup` call `provision_personal_workspace` (resolves
  the active-vs-pending org-status divergence). Unify the two invite-accept paths. Keep
  `register_school` as the sole entrant writer and collapse registration onto the forms engine (S8);
  move `map_response` to an on_commit hook so submit+map are atomic (M12). Standardize idempotency
  on the S4 helper across all verbs (fixes H5/M4/M5, the 201-vs-200 inconsistency, and verdict V6).
- **Risk:** Medium. Many downstream test suites build their world via `register_school`/
  `create_tournament` — signature changes are repo-wide breaks.
- **Preserves:** `register_school`'s `teams=[{name,players}]` shape + `(event_id,"school_registered")`
  idempotency; the forms triple-distinct idempotency keys; `Team(status=REGISTERED)` selection
  contract; hashed-token at-rest semantics. **Keep all new service params keyword-only with defaults.**
- **Verify:** the existing registration/forms/teams suites stay green unchanged; a new concurrent
  same-`event_id` test proves 200-on-replay (not 500); a cross-verb `event_id`-reuse test proves a
  clean replay (not IntegrityError); a submit-then-map-fails test proves atomic rollback.

### WS4 — Extract the generic state-machine seam + build the Tournament SM + complete the rules/freeze story `[B]`

- **Scope:** First extract the shared **guarded-transition helper** (S5) — the system already has
  **three** near-identical implementations (`matches/services/state.py::transition_match`,
  `disputes/services/lifecycle.py::transition_dispute`, `organizations/services/lifecycle.py`'s
  per-verb guards), so this is a *consolidation*, not a green-field invention. Collapse the existing
  three onto it (preserving each one's exact `event_type` strings and extra gates: dispute's ≥5-char
  resolution, org's per-verb preconditions). Then add `tournaments/services/state.py::
  transition_tournament` (S5) as the 4th instance — model the `ALLOWED_TRANSITIONS` dict on the
  **dispute** SM (the cleanest standalone template), guarded + audited, idempotent. Call
  `freeze_rules` on → registration_open; enforce TZ-lock-once-scheduled (inv #14) and
  migrations-blocked-while-live. Add `resolve_rules` (S9), make the generator read rules (closes
  "generator ignores rules"), source `DEFAULT_RULES` from the `Sport` (seeded by the `load_sports`
  command — S18). Implement the 24h-grace + notify-on-amend (on_commit). Build the Settings UI
  keyed on the **server `can_edit` flag** (not `rules_frozen_at`, which is always null).
- **Risk:** Medium–High. The *pattern* is proven (3 existing SMs), so the new Tournament instance is
  low-novelty; but it is still new **product surface** (the PRD §5.2 target has 6 states absent from
  the v1 enum — a PRD edit must precede the code, CLAUDE.md rule). The riskier sub-task is
  retrofitting the 3 existing machines onto the shared helper without changing any `event_type` string
  or guard behavior (their test suites are the safety net). Generator-reads-rules changes generation
  behavior for existing tournaments.
- **Preserves:** invariant #6/#7/#14 intent; the existing `can_edit_rules` read; the rules
  whitelist-merge; the freeze gate's HTTP 409 mapping; **the three existing SMs' exact `event_type`
  strings, audit shape, and per-machine extra gates** (dispute resolution length, org per-verb
  preconditions).
- **Verify:** the existing match/dispute/org SM suites stay green after the helper extraction
  (regression gate on the consolidation); a full Tournament state-machine suite ("every transition +
  every blocked transition", per CLAUDE.md mandate — currently absent for tournaments); a
  freeze-after-registration_open test; a TZ-change-blocked-once-scheduled test; a
  generate-honors-`format`-from-rules test.

### WS5 — Unify the match score/event/advancement core `[B]` / outbox `[C]`

- **Scope:** Extract the `MatchEventLog` abstraction (S6); unify the two score writers — either make
  `record_score` delegate through the event log, or make it an explicit, documented,
  mutually-exclusive override with precedence (owner decision RR-1). **Fix the walkover bug (H1):** a
  single "finalize result" verb that always produces a winner for terminal-with-result states. Add
  the VOID endpoint + a `record_score` amend verb. Centralize pointer construction/resolution
  (S7); expose `home_source`/`away_source` in `MatchSerializer` so the bracket renders from
  authoritative pointers (not geometry). Make advancement transactional + locked + targeted +
  idempotent (M3). Make `recompute_score` incremental (M8). **`[C]`:** move publish + advancement
  onto a transactional outbox + worker.
- **Risk:** High. The score path is the most safety-critical domain logic; the walkover/clobber
  fixes change persisted-result behavior; advancement changes affect bracket correctness.
- **Preserves:** gapless seq under lock; score-derived intent (inv #4); lineups freeze rule;
  `winner_id`/`loser_id` None on draw; the on_commit-after-durable-commit guarantee; the
  `ALLOWED_TRANSITIONS` table + `ValidationError → {"detail":…}` 400 mapping.
- **Verify:** the verdict V1/V2 counterexamples become passing regression tests (walkover advances;
  a late goal after a final score does not silently clobber; concurrent generate does not duplicate);
  a concurrency test (currently none exists) for gapless seq under real concurrent writers; bracket
  renders from pointers.

### WS6 — Real-time transport + constraint engine + perf `[B]` / `[C]`

- **Scope:** Implement real SSE (viewers) / authed WS (scorer rooms) behind `publish_match_event`
  (S11) + a `useLiveMatch(matchId)` hook with polling fallback; harden `MatchConsumer.connect()`
  auth (M6) and add a `public_visible(entity)` gate to the snapshot + WS room (M7). Build the
  constraint engine — `validate_schedule`/`score_schedule` behind a per-type handler registry +
  typed tiebreaker comparators (S10). Fix perf hotspots (session-scan lookups, full-scan
  advancement now targeted from WS5, N+1s, `inputs_hash`-based regenerate/diff with a real
  `Match.last_manual_edit_at`, closing inv #10). Add the public-snapshot throttle. **Bound the list
  endpoints (S17/M13):** set a DRF `DEFAULT_PAGINATION_CLASS`/`PAGE_SIZE` and add cursor/limit
  pagination to the high-cardinality REST lists (matches, teams, disputes, form responses) plus a
  streamed/chunked CSV export, so growth in tournament size can't return unbounded querysets.
- **Risk:** Medium. WS auth is a security-sensitive change; the constraint engine is net-new logic.
- **Preserves:** the `{match,events}` snapshot shape; on_commit-publish; SSE-one-way/WS-two-way
  intent (inv #11 finally realized); the constraint catalog + shape validation.
- **Verify:** a WS reject-outsider test (currently the only WS test asserts open access); a
  public-snapshot state-gating test (draft/suspended hidden); constraint-violation tests;
  regenerate/keep/diff UX tests keyed on `inputs_hash` + `last_manual_edit_at`.

### WS7 — Frontend consolidation `[B]`

- **Scope:** Single standings source (delete `BracketView.computeStandings`, feed server
  `StandingsGroup[]`). Consolidate a `matchesApi`. Extract a shared `<FormWizard>` + single
  field-type registry (kills the 3 wizard renderers). Promote module codes to `lib/modules.ts` + one
  `canAccessModule`/`isOrgAdmin` helper (consumes the WS1 codegen). Extract shared utilities
  (`newEventId`, `<CopyField>`, `<Menu>`, relative-time). Add the `components/ui` barrel + normalize
  casing. Fix the residual design-system violations (native `<select>`, emerald hardcodes, centered
  columns). Add a real `tournaments` retrieve endpoint and replace the list-and-filter `get`.
- **Risk:** Low–Medium. UI-layer; the design-system primitives stay API-frozen.
- **Preserves:** the design-system token API; `apiFetch`/`lib/routes`/`authStore` contracts; the
  `api.generated.ts` anti-drift contract.
- **Verify:** `vitest` + `tsc` clean; visual/e2e regression on the consolidated pages; the standings
  shown on `BracketView` and `TournamentDetailPage` are now identical.

### WS8 — Prod hardening (prerequisite for scale) `[C]`

- **Scope:** Persist 2FA/rate-limit/reset counters (out of LocMem). Transactional outbox for
  on_commit (S6/S11 `[C]`). CSRF consistency on the sadmin JSON ops + CDN removal. Encode the audit
  role-REVOKE as a managed migration or startup self-check (M8). Decouple secret derivation (2FA key
  off `SECRET_KEY`, fail-closed if crypto missing). Parameterize deploy artifacts. Replace
  banner-only impersonation with a real (or explicitly renamed) implementation. Decouple feedback
  idempotency from the audit table. **Account for the scheduled-job layer (S18):** the 5 management
  commands are the de-facto background-job + seed layer (no Celery in 1A) — document/own their
  schedule (the `mark_orphaned_orgs` and `snapshot_kpi` crons especially), ensure each remains
  idempotent under the new infra, and — if Option C's outbox/worker lands — fold the cron jobs into
  that worker rather than leaving two parallel job mechanisms; keep the catalog seeds (`load_modules`/
  `load_sports`, the sources for S15/S9) in the deploy bootstrap.
- **Risk:** Medium. Deploy/infra-touching; do last, after correctness is locked.
- **Preserves:** the append-only trigger as primary control; session-auth-only + CSRF; UTC; the
  two-independent-lockouts invariant.
- **Verify:** a startup self-check that the connected DB role lacks UPDATE/DELETE on `audit_event`;
  a deploy pre-flight that fails on demo data / SA-without-2FA; counters survive a restart.

### Dependency graph (summary)

```
WS0 ─┬─> WS1 ──> WS2 ──> WS3 ──┬─> WS4 ──> WS5 ──> WS6 ──> WS8
     │                         └─> WS7 (parallel after WS1+WS3)
     └─ (test settings + system-check unblock everything else)
```

WS0/WS1 are pure de-risking and gate everything. WS2 (core seams) precedes WS3 (write paths) which
precedes WS4/WS5 (domain machines). WS7 (frontend) can proceed in parallel once WS1's codegen and
WS3's API shapes land. WS8 is last.

---

## 5. Client/server logic-unification strategy

The platform has **three logic forks across the client/server boundary** that cause correctness
bugs (not just maintenance pain). The unification strategy is **"one authority, generated or
shared-fixture-locked mirrors, server always wins."**

1. **Forms branching (the highest risk).**
   - **Authority:** the server (`validation.py`) is the security boundary — it drops hidden/unreached
     answers regardless of what the client did. The client mirror exists only for UX (showing the
     right sections live).
   - **Strategy:** keep both implementations (the client *must* branch locally for UX), but
     **lock them with a shared golden fixture** of `{schema, answers} → {reachable_sections,
     required_fields}` run in both `vitest` and `pytest` (WS1). Fix the existing `gt`/`lt`-on-empty
     divergence (verdict V5) as the first fixture case. Long-term, consider compiling the evaluator
     from one spec, but a shared fixture is the pragmatic, low-risk lock.

2. **Standings.**
   - **Authority:** the server (`compute_standings`, data-driven `rules.points`/`tiebreakers`).
   - **Strategy:** **delete the client computation** (`BracketView.computeStandings`, hardcoded
     3/1/0). The client renders the server's `StandingsGroup[]` and never recomputes (WS7). This is a
     pure deletion — the safest kind of unification.

3. **Module codes + role enums + match state/event vocab.**
   - **Authority:** the backend catalog (`modules.json`) + the enum definitions.
   - **Strategy:** **codegen** a typed module-code enum, a canonical role enum, and the match
     state/event vocab for both Python and TS from one source (WS1/WS15). The SPA already runs
     `gen:types`; extend it. A rename then fails the build instead of silently breaking gating.

4. **Live snapshot shape.**
   - **Authority:** `LiveMatchSnapshotView` (server).
   - **Strategy:** generate `LiveSnapshot` from the DRF schema (anti-drift), and have the future
     `useLiveMatch` hook return the same `{match,events}` shape whether fed by polling, SSE, or WS —
     so the transport can change without touching consumers (S11).

**General principle:** where the client *must* duplicate logic (forms branching), lock it with a
shared fixture; where it duplicates a *value* (standings, module codes, types), make the server the
single source and either delete the client copy or generate it. The server is always authoritative
for security (403/404 + hidden-answer dropping); the client is convenience.

---

## 6. Risk register

Risks that constrain or could derail the restructuring, with mitigation. Severity = impact ×
likelihood if unmanaged.

| ID | Risk | Sev | Mitigation |
|---|---|---|---|
| **RR-1** | **Unifying the two score writers changes persisted results.** Deciding derived-only vs stored-with-override is a product decision; getting it wrong corrupts official scores. | High | Owner decision *before* WS5. Pick one source of truth; migrate existing matches; gate behind the verdict-V1 regression tests; keep the event log as the system of record either way. |
| **RR-2** | **Reconciling the two role systems** (`OrganizationMembership.role` modules vs `TournamentMembership.role` verbs) could over- or under-grant if merged naively. | High | Owner decision: is the module layer meant to gate tournament endpoints (currently it does not)? Keep them separate in `[A]`; unify only in `[B]` behind the S1 Policy object with parametrized tests over both role tables. |
| **RR-3** | **Tournament state machine = new product surface.** PRD §5.2 has 6 states absent from the v1 enum; coding before the PRD edit violates the CLAUDE.md rule and risks rework. | High | PRD edit first (§5.2/§5.5 are binding), code second. Scope WS4 to the v1 happy path + freeze first; defer side states (paused/disputed/orphaned). |
| **RR-4** | **Service-signature changes break the world** — many test suites build fixtures via `register_school`/`create_tournament`/`generate_*`. | High | Keep all new params **keyword-only with defaults**; never change existing positional args; run the full suite per increment. |
| **RR-5** | **The forms parity fix surfaces more divergences** than just `gt`/`lt`. | Med | This is desirable — the shared fixture (WS1) is meant to find them. Triage each as a separate small fix; do not block WS1 on a clean sweep. |
| **RR-6** | **DB-level org/tournament CHECK rejects existing bad rows** (H3 mitigation can fail to migrate). | Med | Audit for mismatched `organization_id` *before* adding the constraint; backfill/repair; add the CHECK as a separate migration after the data is clean. Remember migrations are **blocked while any tournament is `live`**. |
| **RR-7** | **`one_owner_per_org` IMMEDIATE → DEFERRABLE migration** could break the existing `transfer_ownership` clear-before-set if applied without simplifying that code in lockstep. | Med | Ship the DEFERRABLE migration and the `transfer_ownership` simplification together; test concurrent owner-swap. |
| **RR-8** | **Outbox/worker (`[C]`) adds operational complexity** that may not be justified. | Med | Adopt the outbox *only* for the live/advancement path; keep the rest on in-request on_commit. Make it an opt-in WS8 item, not a prerequisite. |
| **RR-9** | **WS auth hardening (M6) could break the (dark) WS path** or future clients. | Low | The WS path has no in-flow consumer today (poll-driven), so hardening `connect()` is low-risk now — do it *before* shipping any real WS client (WS6). Add the reject-outsider test. |
| **RR-10** | **Cache-invalidation move to on_commit + Redis pub/sub** (M9) could regress in multi-worker prod if the pub/sub contract is incomplete. | Med | Implement the versioned-key + pub/sub contract from `v1Users.md:2242-2250` fully; test with ≥2 workers. |
| **RR-11** | **Dev-vs-prod-DB footgun** — a bare `manage.py` runs dev settings against the prod DB/role; an accidental migration could fire. | Med | WS0's dedicated test settings + startup system-check; make prod the explicit default for deploy entrypoints; assert the connected role/DB matches the settings module. |
| **RR-12** | **Losing a behavior contract a test pins verbatim** (404-not-403, exact `event_type` strings, `ALLOWED_TRANSITIONS`, idempotency keys, app label `permissions_app`). | High | Treat the "behavior contracts" list (below) as frozen acceptance criteria; never green a workstream that changes them without an explicit owner sign-off + PRD/test update. |

### 6.1 Behavior contracts a rewrite must keep (frozen acceptance criteria)

- **404-not-403** on inaccessible tournament-scoped resources (isolation tests in every domain app).
- **Exact `emit_audit` `event_type` strings** (audit suites + audit-history continuity).
- **`ALLOWED_TRANSITIONS`** table + the `ValidationError → {"detail":…}` 400 mapping + status codes.
- **Idempotency contracts:** signup on the `user_signup` audit row; `register_school` on
  `(event_id,"school_registered")`; forms triple-distinct keys; `effective_modules` cache-key format
  + frozenset return type.
- **Resolution order union-then-overrides (deny wins)** — the A.4 audit-fix must not regress; grants
  keyed on `(user, org, module)`.
- **App label `permissions_app`** (renaming breaks migrations + the `"permissions_app.module"` FK
  string).
- **Load-bearing partial-unique constraints** (DATA-MODEL §7.4) — any model split must carry them.
- **The append-only trigger + 42501 contract** — any migration rename/squash must re-create both
  triggers.
- **Structural intentionalities (do NOT "fix"):** multi-role per (user,org) + multi-org-admin;
  org-less `Person`/`Sport` + bare-UUID audit scope; `AuditEvent` has no `Meta.ordering`;
  `Team(status=REGISTERED)` is the generation selector; two independent lockouts (axes vs 2FA).

### 6.2 Open ambiguities to resolve with the owner before relying on them

- Is the **module layer (`HasModule`)** meant to gate tournament/match endpoints in a later phase,
  or are the two role systems intentionally orthogonal forever? (RR-2)
- **Score authority:** derived-only, or stored-with-explicit-override? (RR-1)
- Is **`freeze_rules` wiring** deferred or abandoned? Are **`loser_of`/`group_position`/third-place**
  pointers in v1 scope?
- Is **impersonation** meant to be real (`request.user` swap) or stay banner-only?
- Should **`max_responses`/`one_response_per_email`** hard-block?
- Is the **URL-ownership split** (`tournaments/urls.py` cross-app router) intentional?
- Is **`deleted_at` on teams** live or scaffolding? Is B.18 reauth intended for v1?

---

## 7. Summary

The Fixture Platform is a well-layered Django + React system with a **production-grade chassis
(Phase 1A)** and a **substantially-built but partially-divergent competition layer (Phase 1B)**.
The restructuring is a **strangle-and-consolidate-behind-existing-seams** effort, not a rewrite:
the service layer, the tenancy funnel, the append-only audit, and the design system are assets to
preserve. The work concentrates on **building the one missing seam (the Tournament state machine),
unifying the duplicated authority (two role systems) and the divergent writers (two score paths),
closing four correctness fronts already armed with counterexamples (event-sourcing purity,
advancement completeness, forms parity, universal idempotency), and locking the client/server forks
with codegen + shared fixtures.** Sequence it WS0→WS8, gate every step on the frozen behavior
contracts, and target Option B (consolidated domain core) with Option C's outbox adopted selectively
for the live/advancement path.
