# Fixture Platform — Restructuring-Readiness Notes

> Companion to `docs/ARCHITECTURE.md`. A map + strategy for a planned full restructuring — **no
> code changes proposed here**, only the layering picture, coupling hotspots, duplication that must
> stay in sync, a tech-debt inventory by severity, the natural seams to cut along, the
> risks/invariants that constrain any rewrite, and an ordered set of candidate workstreams.
> Synthesized 2026-06-08 from the 16 subsystem + 7 flow analyses. Citations use `path::symbol`.

---

## 1. Current layering & how clean it actually is

The backend is **service-layered and the layering is genuinely good in most apps**: thin DRF views
delegate to `services/*` functions that take explicit kwargs, raise `ValidationError`/`PermissionError`
as the contract, and emit audit inline inside the request transaction. This is the platform's single
biggest restructuring asset — most APIs can be re-fronted with low risk *if the service return types
and the `emit_audit` event-type strings are preserved*.

```
HTTP (DRF view, thin)
  └─ scope gate  : accessible_tournaments(user)            → 404-before-403 (no leak)
  └─ verb gate   : can_manage_tournament / HasModule / _can_score
  └─ service     : services/*.py  (atomic, idempotent on event_id, emit_audit inline)
       └─ models : UUIDv7 PK, organization FK, JSONB columns, partial-unique constraints
       └─ on_commit: publish_match_event / advance_from_match  (best-effort)
```

The frontend is a **TanStack-Query + Zustand presentation layer** with three clean choke points:
`api/client.ts::apiFetch` (transport policy), `lib/routes.ts` (URLs), and `authStore` (identity).
Pure, well-tested islands: `computeNavItems.ts`, `lib/formLogic.ts`, `builderStore.ts`,
`redirectByRole.ts`.

**Where layering is violated / inverted:**
- `apps/tournaments/urls.py` is a **cross-app router** importing views from fixtures, teams, forms,
  matches, disputes — it couples tournament routing to 5 siblings' import health.
- Two teams views and `TournamentFormsView` and the dispute list/raise route live in their own app
  but are **routed from `tournaments/urls.py`** (URL-ownership split; near-circular for disputes).
- `accounts↔audit` is a **near-circular import** (accounts.services import audit.services; audit.models
  import accounts.models) — safe only by layer separation today.
- The `MeSerializer` reaches into `organizations` + `permissions` (lazy) for an N+1-ish bootstrap.

---

## 2. Coupling hotspots (change these and the blast radius is large)

| Symbol / seam | Why it's load-bearing | Depended on by |
|---|---|---|
| `tournaments.scope::accessible_tournaments` + `permissions::can_manage_tournament` | The tenancy + manage contract; **404-not-403 semantics** asserted by isolation tests in every domain app | disputes, fixtures, forms, matches, teams, tournaments |
| `audit.services::emit_audit` | The ONLY audit write path; exact `event_type` strings asserted by tests + are audit-history continuity | ~30 files across nearly every app |
| `teams.services.registration::register_school` | Single atomic write path for entrants; `teams=[{name,players}]` shape + `(event_id,"school_registered")` idempotency | public registration endpoint, `forms.mapping`, most fixtures/matches/live test fixtures |
| `organizations.OrganizationMembership` (columns, role enum, `is_active`/`is_org_owner`, `user_org_ids`) | The RBAC linchpin | permissions.resolver/matrix/scope, tournaments.scope/permissions, matches.scoring, sadmin |
| `permissions.resolver::effective_modules` (cache key format + frozenset return) | Layer-1 RBAC authority; consumed at /me bootstrap | accounts.serializers, organizations, audit.views, the whole client nav/card gating |
| `matches.services.events::publish_match_event` payload `{match_id,event_id}` + group `match_<id>` | The only WS producer; tightly coupled to `MatchConsumer.match_event` | apps/live consumer, (future) any live client |
| `Match.home_source`/`away_source` JSONB pointer schema | Advancement source of truth | generate.py (producer), advance.py (consumer), state.py on_commit, bracket UI |
| FE `api/client.ts::apiFetch` + `lib/routes.ts` + `authStore` | Transport policy / URLs / identity | 17 / 39 / 24 importers respectively |
| FE design-system `Button`/`useToast`/`Select`/`Dialog` + tokens | UI hub | 11–39 files each; tokens app-wide |

---

## 3. Duplication that must stay in sync (the dangerous kind)

These are **logic forks across the client/server boundary or across files** where silent drift
causes correctness bugs, not just maintenance pain.

### 3.1 Client/server logic forks (highest risk)
- **Forms branching evaluator** — `frontend/src/lib/formLogic.ts` ↔
  `backend/apps/forms/services/validation.py`. Seven ops, identical traversal order, "first
  goto-bearing single_choice/dropdown wins", identical emptiness/DISPLAY semantics. Drift →
  spurious unfixable 400s. Guarded only by parallel tests with **no shared golden fixture**.
- **Match state machine + event/score vocab** — FE `STATE_ACTIONS`/`EVENT_BUTTONS`/`statusBadge`/
  `statusMeta` (×3) ↔ backend `ALLOWED_TRANSITIONS`/`MatchEventType`/`SCORING_EVENT_TYPES`. New
  status falls through to a `replace(/_/g," ")`.
- **Standings computation** — `BracketView.tsx::computeStandings` hardcodes 3/1/0 + fixed tiebreaks,
  **ignoring** the data-driven `rules.points`/`rules.tiebreakers` that backend `compute_standings`
  honors. The same screen can show different standings than `TournamentDetailPage`.
- **Live snapshot shape** — `LiveSnapshot` (`api/live.ts`) ↔ `LiveMatchSnapshotView` (hand-mirrored).
- **VOID/visibility derivation** — `live/views.py` re-implements "drop voids + voided events" that
  already lives in `matches.services.events::recompute_score` (two definitions of "what counts").
- **Module codes** — duplicated in `computeNavItems.ts` (`MODULE_FORMS`), `dashboardCards.ts`
  (`MODULES`), and `modules.json`; a rename silently breaks gating.

### 3.2 Server-side duplication
- **Slug logic ×3** — `organizations/services/slug.py`, `organizations/services/workspace.py`, and a
  private copy in `accounts/services/signup.py` (which also inlines Org+Membership creation as
  *pending_review* vs workspace's *active* — divergent org status).
- **6-role enum ×3** — `tournaments.TournamentMembershipRole`, `organizations.MembershipRole`,
  `audit.models` (works only because string values coincide; `create_invitation` validates a
  tournament role against `MembershipRole.values`).
- **`_hash_token` (sha256) ×4** — accounts `views.py`, `signup.py`, `password_reset.py`,
  organizations `invitation.py`.
- **Hashed-token pattern ×4 models** — `RegistrationLink`, `FormShareLink`, `AdminInvitation`, and
  the auth tokens all repeat sha256+expires_at+counter.
- **Matrix role-defaults** — `matrix.build_matrix` recomputes role-defaults independently of
  `resolver._base_modules_for_roles` (two code paths must change in lockstep).
- **Two invite-accept paths** — `accept_invitation` vs `accept_invitation_by_id` with copy-pasted
  status/expiry guards; advancement fired from both `state.py` and `scoring.py`.

### 3.3 Client-side duplication
- Three near-duplicate wizard renderers (`FormPreview`/`FormPreviewDialog`/`PublicFormPage`);
  type-label/CHOICE_TYPES maps ×3-4; `newEventId` ×3; `shareLinkFor` ×2; relative-time formatters ×3;
  admin/canEdit gating logic copy-pasted across 5 org pages; two parallel invitation flows
  (org-side token vs invitee-side colon-verb).

---

## 4. Tech-debt inventory by severity

### CRITICAL (correctness or security; fix before/with any rewrite)
- **Two divergent match score paths** (`record_score` direct vs event-path `recompute_score`) with
  no reconciliation — a match scored both ways disagrees. No amend verb; `void_match_event` has no
  HTTP endpoint (VOID corrections unreachable).
- **Forms branching parity is a hand-paired prose contract** — the single highest correctness risk;
  no shared fixture/cross-check.
- **No DB enforcement of `child.organization_id == tournament.organization_id`** — a service writing
  the wrong org id can leak across tenants (deep-model isolation queries filter by tournament, not org).
- **Cross-verb `event_id` collision in matches** — `AuditEvent.idempotency_key` is globally unique but
  per-verb lookups filter on `event_type`; reusing one `event_id` across two verbs passes the lookup
  then hits the unique constraint → uncaught IntegrityError 500.
- **`one_owner_per_org` is IMMEDIATE, not the documented DEFERRABLE** (no RunSQL migration exists) —
  an in-transaction owner swap can trip the constraint mid-statement; correctness depends entirely on
  `transfer_ownership`'s clear-before-set ordering.
- **`MatchConsumer.connect()` has no auth/scope** — fine for the current public-only ping, but a hole
  the moment any private/scorer payload is added.

### HIGH (architecture gaps that block features / mislead)
- **No Tournament state machine** — status never transitions in prod; `freeze_rules`/`rules_frozen_at`
  dead; TZ-lock-once-scheduled unenforced; the freeze gate works only via the DRAFT/PUBLISHED check.
- **SSE is documented but unimplemented**; no React WS/SSE client; everything polls. Reconciling this
  is a doc+invariant edit (CLAUDE.md #11, PRD), not just code.
- **Generator ignores `Tournament.rules`** — reads request body; stored `format`/`group_size`/
  `advance_per_group` ineffective.
- **Constraints are inert** — validated for shape, never enforced (no `validate_schedule`/
  `score_schedule`).
- **Generation idempotency is presence-based, not `inputs_hash`-based** — edit-then-regenerate is a
  silent no-op; `Match.last_manual_edit_at` doesn't exist (invariant #10 half-built).
- **Resolver cache invalidation is single-process only** — cross-worker Redis pub/sub is a TODO;
  multi-worker prod serves stale module sets up to 5 min. Also invalidation runs *before* commit.
- **Impersonation is banner-only** (no `request.user` swap) — anyone building on real impersonation
  will break.
- **`map_response` runs synchronously in the public AllowAny request path** (no on_commit/queue);
  form submit + entity mapping are not atomic together.
- **`.env`-vs-settings footgun** — bare `manage.py` runs dev settings against the prod DB/role.

### MEDIUM (perf / consistency / scale)
- `recompute_score` O(events) full rescan per write; `advance_from_match` O(matches) full scan per
  completion; `_delete_sessions_for_user` and `_invalidate_all_sessions_for_user` O(all-sessions)
  table scans; `detect_orphaned` N+1; groups→knockout N+1 (`Team.objects.get` in loop);
  `module_gated` per-org loop; `MeSerializer` per-org `effective_modules` N+1.
- Replay returns **201 not 200** for matches events/incidents (invariant #3 partial violation).
- `max_responses`/`one_response_per_email` exist but unenforced; `response_count` can drift.
- 2FA/rate-limit/reset counters are cache-only (LocMem dev) — lost on flush, per-process.
- `tournamentsApi.get(id)` fetches the full list and filters client-side (no retrieve endpoint).
- Free-text `kind` on `Notification`/`Dispute` (no enum); free-string `role`/`status`/`stage` FE types.
- On_commit hooks have no outbox — a crash between commit and on_commit drops the hook silently.

### LOW (cosmetic / doc drift / dead code)
- Module-count docstrings say 22 (code/tests pin 23); "4 constraints" docstring lists a dropped
  constraint; stale DEFERRABLE comments; `SADMIN_HOST` dead config; `django-tailwind`/
  `django-browser-reload` dead deps; `require_recent_password_reauth` (B.18) dead; `notify_many`
  dead/non-idempotent; `dashboardCards.ts` + `roleRoutes` orphaned; `OrgComingSoonPage` unused;
  `authBus.emit` dead path; `get_client_ip_address` imported-unused; one native `<select>` +
  emerald hardcodes + `mx-auto max-w-*` violations; `lucide-react@^1.14` unusually low major;
  no `components/ui` barrel + mixed file casing (Linux case hazard); `duplicate_form` emits no audit.

---

## 5. Natural seams / boundaries to restructure along

These are the cut lines where the existing code already has a clean interface or a single chokepoint.

1. **Access/policy seam** — `accessible_tournaments` + `can_manage_tournament` (+ `_can_score`,
   `HasModule`). Fold into one Policy/Scope object with query optimization + request-level
   memoization, **preserving the 404-not-403 behavior contract**. 6 apps depend on it.
2. **Audit write seam** — `emit_audit`. Preserve the kwarg signature; introduce a typed `event_type`
   registry/enum to make the taxonomy enforceable; wire accepted `event_id` into `idempotency_key`
   to make grant writes (and others) truly idempotent.
3. **Tenancy seam** — a tenant-aware base manager / DRF base viewset (or Postgres RLS keyed on a
   session org id) + a DB-level composite FK/CHECK so no new endpoint can forget scoping and org/
   tournament drift can't happen.
4. **Hashed-token seam** — a single `HashedToken` model (mint/hash/verify/consume/expire) collapsing
   `EmailVerificationToken`/`PasswordResetToken`/`RecoveryCode`/`RegistrationLink`/`FormShareLink`/
   `AdminInvitation` and removing the quadruplicated `_hash_token`.
5. **Tournament state-machine seam** — introduce `tournaments/services/state.py::transition_tournament`
   mirroring `matches/services/state.py` (ALLOWED_TRANSITIONS + guarded/audited + call `freeze_rules`
   on → registration_open + TZ-lock + migrations-blocked-while-live). Everything downstream hangs off
   this one missing seam.
6. **Match event-log seam** — extract a `MatchEventLog` abstraction (append + lock + gapless-seq +
   recompute + on_commit-publish in one place); have `live/views.py` reuse the same visible-events
   selector; unify the two score writers behind it.
7. **Pointer seam** — one `pointers.py` owning construction + resolution of all four pointer types,
   consumed by both generation seeding and advancement; expose `home_source`/`away_source` in
   `MatchSerializer` so the bracket renders from authoritative pointers.
8. **Registration write seam** — keep `register_school` as the sole domain writer; collapse the two
   ingestion channels (teams `RegistrationLink` vs forms) onto the forms engine (mapping already
   proves the pattern); add new params keyword-only with defaults.
9. **Rules seam** — a single `resolve_rules(tournament)` accessor (centralize `merge_rules`); source
   `DEFAULT_RULES` from the Sport/registry to make it sport-agnostic; make the generator read rules.
10. **Constraint-engine seam** — `validate_schedule`/`score_schedule` behind a per-type handler
    registry keyed off `CONSTRAINT_TYPES`; promote tiebreakers to a typed comparator registry.
11. **Live-transport seam** — `publish_match_event` is one function behind on_commit + one consumer
    handler; a real SSE/WS push is a one-function + one-handler change. On the client, a
    `useLiveMatch(matchId)` hook returning the same `{match,events}` shape with polling as fallback.
12. **Notification dispatch seam** — `create_notification` is the single entry point (all callers
    lazy-import); add channels/preferences/batching without touching call sites; `_publish` is the
    symmetric push seam.
13. **Frontend seams** — `apiFetch` (transport interceptors), `lib/routes` (URL rewrite),
    `authStore` (identity), `computeNavItems` (nav), `builderStore` (forms authoring island), the
    design-system token layer; plus a shared `<FormWizard>` and a single field-type registry.
14. **Settings/config seam** — split base/dev/prod + a dedicated **test** settings module (stops
    pytest pointing at dev + the dev-against-prod-DB footgun); add a startup system-check asserting
    the immutables (`ATOMIC_REQUESTS`, UTC, auth backends, hashers, throttles).
15. **Module-code/role-enum seam** — generate a typed module-code enum + canonical role enum for both
    Python and TS from `modules.json` / a single source (the SPA already runs `gen:types`).

---

## 6. Risks & invariants that constrain any rewrite

**Behavior contracts that tests pin verbatim (a rewrite must keep them):**
- 404-not-403 on inaccessible resources (isolation tests in every domain app).
- Exact `emit_audit` `event_type` strings (audit suites + audit-history continuity).
- `ALLOWED_TRANSITIONS` table + the `ValidationError → {"detail": ...}` mapping + exact status codes
  (matches `test_state`/`test_event_api`/`test_lineups`/`test_incidents`/`test_scorer_flow`).
- Idempotency contracts: signup on the `user_signup` audit row; `register_school` on
  `(event_id,"school_registered")`; forms triple-distinct keys; `effective_modules` cache key format +
  frozenset return type.
- Resolution order union-then-overrides (deny wins) — the A.4 audit-fix bug must not regress.
- Grants keyed on `(user, org, module)` — never re-key to membership rows.
- App label `permissions_app` (renaming breaks migrations + the `"permissions_app.module"` FK string).
- Load-bearing partial-unique constraints (§7.4 in ARCHITECTURE.md) — any model split must carry them.
- The append-only trigger lives in one raw-SQL migration; any rename/squash must re-create both
  triggers and keep the 42501 contract.
- The forms branching parity (§3.1) — touching one side requires the other; add a shared fixture first.

**Structural facts a restructurer must not "fix" by accident:**
- Multi-role per (user,org) and multi-org-admin per user are *intentional* (decision #91) — do not
  reinstate `single_org_per_admin_user`.
- `Person` and `Sport` are *deliberately* org-less; audit/usage scope UUIDs are *deliberately* bare
  (no FK) so rows survive deletion — do **not** normalize them (breaks survive-deletion + the
  `(organization_id, -created_at)` hot-path index).
- `AuditEvent` has no `Meta.ordering` by design (UUIDv7 + created_at give stable cursors).
- `Team(status=REGISTERED)` is exactly what the generator selects — building the approval state
  machine silently changes generation; treat as a coordinated change.
- Two independent lockouts (axes vs 2FA) must stay separate.

**Operational constraints:**
- Migrations are blocked while any tournament is `live` (deploy pre-flight) — model changes ship
  behind it.
- Redis is mandatory in multi-worker prod (in-memory channel layer silos rooms; cache invalidation
  is single-process).
- Many downstream test suites build their world via `register_school`/`generate_round_robin`/
  `create_tournament` — a service signature change is a repo-wide test break (keep params
  keyword-only with defaults).

**Open ambiguities to resolve with the owner before relying on them:**
- Is B.18 reauth intended for v1 (scaffolded, inert)? Is impersonation meant to be real?
- Is `freeze_rules` wiring deferred or abandoned? Are `loser_of`/`group_position`/third-place
  pointers in v1 scope?
- Should `max_responses` hard-block? Is the URL-ownership split intentional? Is `deleted_at` on teams
  live or scaffolding? Is the model-vs-serializer form `purpose` default divergence intentional?

---

## 7. Ordered candidate restructuring workstreams

Sequenced so each lands on a stable base and unblocks the next. Each is a map item, not a plan —
brainstorm → write-plan → execute per CLAUDE.md.

**Phase 0 — Reconcile docs ↔ code & free, test-backed cleanups (low risk, high clarity).**
Decide and document the SSE-vs-polling reality (CLAUDE.md #11 + PRD), the Tournament-state-machine
gap, the constraint-engine gap, and impersonation. Fix the 22→23 docstrings, the "4 constraints"
text, stale DEFERRABLE comments. Delete or wire the dead code (`dashboardCards.ts`, `roleRoutes`,
B.18 reauth, `notify_many`, `OrgComingSoonPage`, `authBus` decision, dead deps, `SADMIN_HOST`).
Add the dedicated **test settings module** + startup system-check for the immutables.

**Phase 1 — Lock the parity contracts (de-risk before any structural move).**
Add a shared golden fixture asserting identical reachable-key sets for forms branching on both
client and server. Generate the module-code enum + canonical role enum from a single source
(`modules.json` / role source) for Python + TS, killing the three module-code lists and the
triplicated role enum. Generate `forms/types.ts` from the backend schema.

**Phase 2 — Harden the access/audit/tenancy core (the most-depended-on seams).**
Fold `accessible_tournaments`/`can_manage_tournament`/`_can_score` into one Policy object with query
optimization + request memoization, preserving 404-not-403. Introduce the typed `event_type`
registry behind `emit_audit` and wire `event_id` into `idempotency_key`. Move resolver cache
invalidation to `transaction.on_commit` + finish the Redis pub/sub contract. Add the DB-level
composite FK/CHECK for org/tournament + (optionally) the tenant-aware base manager. Ship the missing
RunSQL DEFERRABLE migration for `one_owner_per_org` (then simplify `transfer_ownership`).

**Phase 3 — Consolidate the write paths.**
Extract the `HashedToken` model. Consolidate the 3 slug implementations into
`organizations.services` and have `accounts.signup` call `provision_personal_workspace` (resolves
active-vs-pending divergence). Unify the two invite-accept paths. Keep `register_school` as the sole
entrant writer and collapse registration onto the forms engine; move `map_response` to an on_commit
hook so submit+map are atomic.

**Phase 4 — Build the Tournament state machine + complete the rules/freeze story.**
Add `tournaments/services/state.py::transition_tournament` (ALLOWED_TRANSITIONS + guarded/audited),
call `freeze_rules` on → registration_open, enforce TZ-lock-once-scheduled and migrations-blocked-
while-live. Add `resolve_rules(tournament)`, make the generator read rules, source `DEFAULT_RULES`
from the Sport. Implement the 24h-grace + notify-on-amend (on_commit). Build the Settings UI keyed on
the server `can_edit` flag.

**Phase 5 — Unify the match score/event/advancement core.**
Extract the `MatchEventLog` abstraction; unify the two score writers (delegate `record_score` through
the event log or make it an explicit mutually-exclusive override with documented precedence). Add the
VOID endpoint + a `record_score` amend verb. Centralize the post-commit dispatch bus (advancement +
publish fire from one place). Make `recompute_score` incremental. Centralize pointer construction/
resolution and expose source pointers in `MatchSerializer`.

**Phase 6 — Real-time transport + constraint engine + perf.**
Implement real SSE (viewers) / authed WS (scorer rooms) behind `publish_match_event` + a
`useLiveMatch` hook (polling fallback); harden `MatchConsumer.connect()` auth. Build the constraint
engine (`validate_schedule`/`score_schedule` + typed tiebreaker comparators). Fix the perf hotspots
(session-scan lookups, full-scan advancement, N+1s, `inputs_hash`-based regenerate/diff with
`Match.last_manual_edit_at`).

**Phase 7 — Frontend consolidation.**
Single standings source (delete `BracketView.computeStandings`, feed server `StandingsGroup[]`).
Consolidate a `matchesApi`. Extract a shared `<FormWizard>` + single field-type registry. Promote
module codes to `lib/modules.ts` + one `canAccessModule`/`isOrgAdmin` helper. Extract shared
utilities (`newEventId`, `<CopyField>`, `<Menu>`, relative-time). Add the `components/ui` barrel +
normalize casing. Fix the residual design-system violations (native `<select>`, emerald hardcodes,
centered columns). Add a real `tournaments` retrieve endpoint and replace the list-and-filter `get`.

**Phase 8 — Prod hardening (prerequisite for scale, after the above).**
Persist 2FA/rate-limit/reset counters; transactional outbox for on_commit; CSRF consistency on the
sadmin JSON ops + CDN removal; parameterize deploy artifacts (paths/socket/host); decouple feedback
idempotency from the audit table; replace banner-only impersonation with a real (or explicitly
renamed) implementation.
