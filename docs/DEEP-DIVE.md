# Fixture Platform — DEEP-DIVE (Master Technical Dossier)

> The definitive, source-verified technical dossier for the Fixture Platform, assembled as the
> final artifact of the deep-analysis pass. It is the **navigable index** to every catalog,
> sequence trace, and audit produced under `docs/deep/`, the consolidated **system mental model**,
> the **cross-cutting patterns**, the **definitive numbered invariant list** (each with where it is
> enforced and whether the code actually honors it), the **adversarial-verification results table**
> (claim → holds? → evidence/counterexample), and the **consolidated audit findings ranked by
> severity**.
>
> Conventions: citations use `path::symbol` and `file:line` against the tree at
> `/home/ubuntu/Fixture` (verified 2026-06-08). **Source code is ground truth.** Where CLAUDE.md,
> the PRD, or a docstring disagrees with the code, the code wins and the divergence is flagged.
> Companion strategy doc: [`RESTRUCTURING-BLUEPRINT.md`](./RESTRUCTURING-BLUEPRINT.md).

---

## 0. How to read this dossier (artifact index)

This document sits at the top of a three-tier analysis. Tier 1 is the breadth pass
(`ARCHITECTURE.md`, `RESTRUCTURING-NOTES.md`, and the per-subsystem notes in
`docs/superpowers/analysis/`). Tier 2 is the deep pass: six exhaustive **catalogs**, seven
end-to-end **sequence traces**, and two adversarial **audits** under `docs/deep/`. Tier 3 is this
dossier + the blueprint. When a fact is contested, prefer Tier 2 over Tier 1, and prefer source
over both.

### 0.1 Catalogs (`docs/deep/`)

| Catalog | File | Items | What it answers |
|---|---|---|---|
| **API Reference** | [`deep/API-REFERENCE.md`](./deep/API-REFERENCE.md) | ~98 path+method combos | Every route, view, auth class, permission/scope gate, throttle, request/response shape, error codes, idempotency behavior, 404-vs-403 policy |
| **Data Model / ERD** | [`deep/DATA-MODEL.md`](./deep/DATA-MODEL.md) | 33 models | Every field/FK/on_delete/constraint/index; JSONB runtime shapes; idempotency-key table; tenancy-boundary patterns; ERD |
| **State Machines** | [`deep/STATE-MACHINES.md`](./deep/STATE-MACHINES.md) | 15 | Match machine (full), Tournament machine (enum only — not driven), advancement hook, pointer taxonomy claimed-vs-implemented |
| **Permissions & Tenancy** | [`deep/PERMISSIONS-AND-TENANCY.md`](./deep/PERMISSIONS-AND-TENANCY.md) | 23 modules + matrices | 23-module catalog, `effective_modules` resolver, two un-unified role systems, per-endpoint scope-enforcement table, 404-not-403 policy |
| **Frontend State** | [`deep/FRONTEND-STATE.md`](./deep/FRONTEND-STATE.md) | 62 | 4 Zustand stores, `apiFetch`, TanStack Query keys + invalidation map, routing/guards, and the **no-WS/SSE-client** finding |
| **Engines** | [`deep/ENGINES.md`](./deep/ENGINES.md) | 2 engines + parity | Rules/constraints engine, forms branching engine, full client↔server parity tables (F1–F14, R1–R5, V1–V7) |

### 0.2 Sequence traces (`docs/deep/flows/`)

| Flow | File | Spine |
|---|---|---|
| **Auth lifecycle** | [`deep/flows/auth.md`](./deep/flows/auth.md) | signup (Path A invite-accept vs Path B self-signup) → verify → login → 2FA → session → logout → reset |
| **RBAC resolution** | [`deep/flows/rbac.md`](./deep/flows/rbac.md) | tenant scope (404-before-403) → module visibility (`effective_modules`, deny-after-union) → verb gating; grant writes |
| **Tournament lifecycle** | [`deep/flows/tournament.md`](./deep/flows/tournament.md) | create → settings/rules/freeze → register → generate → score → standings → advance |
| **Event-sourcing + live** | [`deep/flows/event-live.md`](./deep/flows/event-live.md) | record → recompute → on_commit → channel → WS (dark) ; clients poll |
| **Forms engine** | [`deep/flows/forms.md`](./deep/flows/forms.md) | build → publish → public wizard → client/server branch eval → submit → validate → entity-map |
| **Registration** | [`deep/flows/registration.md`](./deep/flows/registration.md) | mint link → public self-register → `register_school` |
| **Fixtures** | [`deep/flows/fixtures.md`](./deep/flows/fixtures.md) | generate (RR / SE / groups→KO) → typed pointers → advancement |

### 0.3 Audits (`docs/deep/`)

| Audit | File | Verdict |
|---|---|---|
| **Security & Multi-Tenancy** | [`deep/audit-security-tenancy.md`](./deep/audit-security-tenancy.md) | REST isolation strong (404-before-403 uniform); gaps on public/non-REST edges (WS, public snapshot, prod REVOKE) |
| **Concurrency, Transactions & Idempotency** | [`deep/audit-concurrency-txn.md`](./deep/audit-concurrency-txn.md) | `ATOMIC_REQUESTS=True` reframes all on_commit/lock semantics; walkover-never-advances + dual score writers are the high-severity bugs |

### 0.4 Tier-1 references

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — "as-built" system reference + the 15-row invariant status table (§10) and the doc/code-divergence list (§11).
- [`RESTRUCTURING-NOTES.md`](./RESTRUCTURING-NOTES.md) — layering, coupling hotspots, duplication, tech-debt by severity, 15 natural seams, 9 ordered workstreams.

---

## 1. System mental model (the narrative)

### 1.1 What it is

A **multi-tenant sports fixture & tournament management platform** (Nagaland focus; v1 = a
**football** vertical slice over a sport-agnostic chassis). The platform owner provisions nothing
by hand: organizers self-serve. They sign up, receive a hidden personal **Organization** (the
tenant root), create **Tournaments**, invite a roster across 6 tournament-scoped roles, collect
team/player registrations through public links + a data-driven forms engine, generate **fixtures**
(round-robin / single-elimination / groups→knockout), score matches through an **event-sourced**
engine, view rules-driven standings + brackets, and work disputes. A bespoke **super-admin
console** at `/sadmin/` is the only operator surface (Django admin is disabled).

### 1.2 Topology

- **Backend**: Django 5.1 + DRF, Channels (ASGI) via `ProtocolTypeRouter` (`fixture/asgi.py`):
  `http` → Django; `websocket` → `AllowedHostsOriginValidator(AuthMiddlewareStack(URLRouter(...)))`.
- **DB**: PostgreSQL. UUIDv7 PKs everywhere (single helper `apps/accounts/models.py::uuid7`); no
  auto-increment. Append-only audit enforced by a PL/pgSQL `BEFORE UPDATE/DELETE` trigger +
  (in prod, out-of-band) a two-role grant model.
- **Async transport**: channel layer = in-memory in dev (single-process, no cross-worker fan-out),
  Redis in prod.
- **Frontend**: React 19 + Vite SPA, TanStack Query (server state) + Zustand (client state),
  react-router-dom, Tailwind token system, `openapi-typescript` codegen.
- **Auth**: **session cookie + CSRF header**, no JWT; same-origin SPA (Vite proxies `/api` and
  `/sadmin` in dev — **not** `/ws`).
- **Settings layering**: `base` holds the substantive config and the immutables
  (`ATOMIC_REQUESTS=True`, `USE_TZ=True`, Argon2 hashers, SessionAuthentication-only, throttles);
  `dev` adds DEBUG/CORS/console-email; `prod` adds TLS/HSTS/Redis/SES + `assert DEBUG is False`.
  **Footgun:** `manage.py`/`asgi.py`/pytest all default `DJANGO_SETTINGS_MODULE=fixture.settings.dev`
  while the on-disk `.env` is a *production* env — a bare `manage.py` runs dev settings against the
  prod DB/role.

### 1.3 The request anatomy (the load-bearing shape)

Every authenticated mutation funnels through one canonical layering, and the restructuring's single
biggest asset is that **this layering is genuinely clean in most apps** (thin DRF views delegate to
`services/*` functions with explicit kwargs that raise `ValidationError`/`PermissionError` as their
contract, and emit audit inline inside the request transaction):

```
HTTP request  (ATOMIC_REQUESTS=True → the whole request is ONE transaction)
  └─ DRF view (thin)
       └─ scope gate : accessible_tournaments(user).filter(id=…).exists()  →  404 (no existence leak)
       └─ verb gate  : can_manage_tournament / _can_score / HasModule / IsOrgAdminOrOwner  →  403
       └─ body valid : serializer.is_valid()  →  400
       └─ service    : services/*.py  (transaction.atomic() = savepoint; idempotent on event_id;
                       select_for_update where it mutates; emit_audit INLINE inside the txn)
            └─ models : UUIDv7 PK + organization FK + JSONB columns + partial-unique constraints
            └─ on_commit : publish_match_event / advance_from_match  (best-effort, exceptions swallowed)
```

The canonical error sequence for a tenant-scoped mutation is
**`401 if !auth` → `404 if !visible` → `403 if !manager` → `400 if bad body` → `409 if frozen` →
success** (see `deep/API-REFERENCE.md` §1).

### 1.4 The two delivery phases (and the gap between them)

- **Phase 1A** (accounts/identity, organizations + membership, two-layer module RBAC, append-only
  audit, super-admin console) is **production-grade and fully tested**. The chassis is solid.
- **Phase 1B** (tournaments + state, teams/players/registration, fixture generation + advancement,
  event-sourced matches/scoring, lineups, incidents, disputes, notifications, live transport,
  data-driven rules/constraints) is **substantially built but has real correctness gaps and one
  large architectural hole**: there is **no Tournament state machine**, the live story is
  poll-driven (not the documented SSE+WS), and the match scoring layer has two unreconciled write
  paths plus a walkover bug.

The single most important framing fact discovered in the deep pass: **the documentation
(CLAUDE.md/PRD) describes the aspiration; the code is a narrower, partially-divergent reality.**
This dossier exists to make that gap precise.

---

## 2. Consolidated cross-cutting patterns

These patterns span many files. They are the "grammar" of the codebase; understand them before
reading any subsystem in isolation. (Expanded from `ARCHITECTURE.md` §3, cross-checked against the
deep catalogs.)

### 2.1 Event-sourced scores — the score is derived, then cached

`apps/matches/services/events.py::record_match_event` appends an immutable `MatchEvent` under a row
lock (`Match.objects.select_for_update()`) with a **gapless `sequence_no`** (`Max(sequence_no)+1`,
backstopped by `UniqueConstraint(match, sequence_no)`), then `recompute_score` re-derives
`home_score`/`away_score` from non-voided GOAL + PENALTY_SCORED (own side) + OWN_GOAL (opponent)
events. Corrections are append-only `VOID` events, never UPDATE/DELETE. `Match.home_score`/
`away_score` are a **cache** the public scoreboard trusts. **Caveat (verified):** there is a
*second* writer, `apps/matches/services/scoring.py::record_score`, that writes the cached score
*directly from the request body* with no events — the two writers are unreconciled (see §5,
verdict V1 and audit-concurrency findings #2).

### 2.2 State machines + on_commit advancement

**There are THREE fully-realized, guarded + audited state machines** (correcting an earlier claim in
this dossier that matches owned "the only" one) — all three share the same shape: a module-level
`from→{allowed-to}` map, a precondition check that raises `ValidationError` on an illegal jump, the
mutation, and an inline `emit_audit` in the same transaction. They are the obvious template for a
**generic state-machine seam** (see BLUEPRINT S5 / §2.2 below):

1. **Match** — `apps/matches/services/state.py::transition_match` + `ALLOWED_TRANSITIONS`
   (lines 22-31, 40-70), guarded by `can_transition` under `select_for_update`. On reaching a
   terminal-with-result status (`_TERMINAL_WITH_RESULT = (COMPLETED, WALKOVER)`, `state.py:33`), a
   `transaction.on_commit` hook fires `_fire_advancement` → `apps/fixtures/services/advance.py::
   advance_from_match`, which resolves typed `home_source`/`away_source` JSONB pointers to fill the
   next slot.
2. **Dispute** — `apps/disputes/services/lifecycle.py::transition_dispute` + a standalone
   `ALLOWED_TRANSITIONS` dict (lines 16-22, 60-95), also `select_for_update`-locked, with a
   ≥5-char-resolution gate on `resolved`/`rejected`. This is the *cleanest* template: its
   `ALLOWED_TRANSITIONS` dict is identical in shape to what BLUEPRINT S5 proposes building for
   tournaments.
3. **Organization lifecycle** — `apps/organizations/services/lifecycle.py` (lines 84-298): one
   guarded verb per transition (`approve_org` L84-109, `reject_org` L112-144, `suspend_org`
   L152-187, `unsuspend_org` L190-219, `archive_org` L227-257, `detect_orphaned` L265-298), each
   asserting the source `OrgStatus` and raising `ValidationError` on an illegal transition, with
   inline audit. This machine encodes its guards **per-verb** rather than in one `ALLOWED_TRANSITIONS`
   table, but it is just as real — and is **driven in production** by the `mark_orphaned_orgs`
   management command (cron-style; there is no Celery in 1A). See `deep/STATE-MACHINES.md` §6.

**The Tournament status enum is the one declared-but-unrealized machine**: it has no transition
service/endpoint and no `ALLOWED_TRANSITIONS` — status never advances past `draft` in production
(see §4 invariant 6, §6 M1). So the restructuring is **not inventing the pattern** (it exists 3×); it
is (a) adding the 4th instance for tournaments and (b) the prime candidate for extracting one generic
guarded-transition helper the other three collapse onto.

### 2.3 Multi-tenancy as a queryset funnel (not row-level security)

`Organization` is the tenant root and a *hidden personal workspace* (decision #91). Every
tenant-scoped row carries an `organization` FK. Isolation is enforced by funneling reads through
`apps/tournaments/scope.py::accessible_tournaments(user)` (orgs where the user is an active org
ADMIN ∪ tournaments with an active `TournamentMembership`) and the **404-before-403** existence-
hiding policy. **There is NO DB-level enforcement that `child.organization_id ==
tournament.organization_id`** — the denormalized org FK on deep rows (e.g. `MatchEvent`) is
*populated by the service copying* `locked.organization_id`, not derived or constrained.

### 2.4 Two-layer RBAC, with two un-unified role systems

- **Layer 1 — module visibility (surfaces).** `apps/permissions/` owns a 23-row module catalog,
  per-(user, org, module) tri-state override grants (`MembershipModuleGrant`), and the resolver
  `effective_modules` = **role-union THEN overrides** (so a single `deny` beats any multi-role
  union; the A.4 audit-fix keyed grants on `(user, org, module)`). Result is a frozenset cached
  5 min. Keyed to **`OrganizationMembership.role`**.
- **Layer 2 — verb authorization (actions).** No central table; enforced inline by role predicates,
  chiefly `can_manage_tournament` and `_can_score`. Keyed to **`TournamentMembership.role`** +
  org-admin fallback.

**Critical structural finding:** these are *two different role tables*. A user's `effective_modules`
can be empty while they fully manage a tournament via `TournamentMembership`, and vice-versa. The
module layer (`HasModule`) is effectively **unused by tenant/tournament endpoints** — only admin
permission surfaces gate on it (and even those gate on `IsOrgAdminOrOwner` instead, DEFECT-J).

### 2.5 Data-driven rules/constraints + forms branching (FET-style JSONB)

Four JSONB columns are interpreted at runtime, never hardcoded: `Tournament.rules` +
`.constraints`, `Form.schema` + `FormResponse.answers`. `DEFAULT_RULES` is both the football
baseline **and the whitelist** (`merge_rules` rejects unknown keys, layering
`defaults < stored < partial`). **Validation gap (verified):** `merge_rules` checks *key membership
only* — not value types/ranges, not the `tiebreakers` vocabulary, not the `format` enum. Constraints
are validated for *shape only* and are otherwise **inert** (no scheduler enforces them). The forms
engine runs the **same branching evaluator on both client and server** — the single highest
correctness risk in the codebase (see §5, verdict V5).

### 2.6 Append-only audit + idempotent writes

`apps/audit/services.py::emit_audit` is the only sanctioned `AuditEvent` writer (~30 callers), and
`AuditEvent` is append-only at the DB level via a PL/pgSQL `BEFORE UPDATE/DELETE` trigger raising
`ERRCODE 42501` (fires even for superuser). The audit table also doubles as the **idempotency
ledger** for several services (signup, school_registered, tournament_created, settings, record_score,
lineups) — a powerful but coupling-heavy pattern, because `AuditEvent.idempotency_key` is *globally*
unique and the per-verb replay lookups are *event_type-scoped*, so reusing one `event_id` across two
verbs passes the lookup then collides on insert → uncaught 500 (see §5, verdict V6).

### 2.7 ATOMIC_REQUESTS reframes everything

`DATABASES["default"]["ATOMIC_REQUESTS"] = True` (`fixture/settings/base.py:110`), with no per-view
override anywhere. Three consequences recur throughout the audits:
1. Every inner `transaction.atomic()` is a **savepoint**, not an independent transaction.
2. Every `transaction.on_commit(...)` fires only at the **outermost request commit**, in
   registration order — so all publish/advance hooks for one request batch together at the end.
   The per-verb "publish right after this event commits" intent in the code comments does **not**
   hold.
3. A `select_for_update()` lock is held for the **whole request**, widening contention windows.

### 2.8 Live transport split — documented as SSE+WS, actually polling

CLAUDE.md #11 claims "SSE for one-way viewers + bell; WebSockets for scorer rooms." **No SSE exists
anywhere** (no `text/event-stream`, `StreamingHttpResponse`, or `EventSource`). The only fan-out
producer is `publish_match_event` (a thin `{match_id, event_id}` ping to `match_<id>`, fired
on_commit, exceptions swallowed); `MatchConsumer` joins that group with **no auth/scope check**;
and **the frontend has no WS/SSE client at all** — `LiveViewerPage` + `MatchConsolePage` poll
`GET /api/live/match/{id}/` every 5s, `NotificationBell` polls every 30s. This is the single
largest doc/code divergence.

### 2.9 Dangerous duplication (logic forks that must stay in lockstep)

| Fork | Sides | Drift consequence |
|---|---|---|
| **Forms branching** | `frontend/src/lib/formLogic.ts` ↔ `backend/apps/forms/services/validation.py` | Field required server-side but hidden client-side → spurious unfixable 400 (verdict V5 proves a live divergence) |
| **Match state/event vocab** | FE `STATE_ACTIONS`/`EVENT_BUTTONS` (×3) ↔ `ALLOWED_TRANSITIONS`/`MatchEventType`/`SCORING_EVENT_TYPES` | New status falls through to `replace(/_/g," ")` |
| **Standings** | `BracketView.tsx::computeStandings` (hardcoded 3/1/0) ↔ `compute_standings` (data-driven `rules.points`/`tiebreakers`) | Same screen shows different standings than `TournamentDetailPage` |
| **Module codes** | `computeNavItems.ts` (`MODULE_FORMS`) + `dashboardCards.ts` (`MODULES`) + `modules.json` | A rename silently breaks gating |
| **6-role enum ×3** | `tournaments.TournamentMembershipRole` + `organizations.MembershipRole` + `audit.models` | Works only because string values coincide |
| **Slug logic ×3** | `organizations/services/slug.py` + `workspace.py` + private copy in `accounts/services/signup.py` | The signup copy also creates org as *pending_review* vs workspace's *active* |
| **`_hash_token` ×4** | accounts `views.py`/`signup.py`/`password_reset.py` + organizations `invitation.py` | — |
| **VOID/visibility derivation** | `live/views.py` reimplements "drop voids + voided events" already in `recompute_score` | Two definitions of "what counts" |

---

## 3. Subsystem map (one-line orientation each)

Full detail in `ARCHITECTURE.md` §4–5 and the per-subsystem notes. This is the navigation index.

**Backend (14 apps):**
- `accounts` — identity & auth (Phase 1A, production-grade): custom `User`, signup/verify/login/
  logout/reset, TOTP 2FA + argon2id recovery codes, two independent lockouts (axes vs 2FA),
  session cycling, `MeSerializer` (the RBAC hydration bridge).
- `organizations` — the tenancy boundary: `Organization`, `OrganizationMembership` (RBAC linchpin),
  `AdminInvitation`, `SlugRedirect`, ownership transfer (clear-before-set workaround for the
  IMMEDIATE `one_owner_per_org`). Two service modules carry the lifecycle logic, both underdocumented
  elsewhere: `services/lifecycle.py` is the **organization state machine** (create / approve / reject /
  suspend / unsuspend / archive / `detect_orphaned`, each a guarded `OrgStatus` transition with inline
  audit — see §2.2), and `services/workspace.py::provision_personal_workspace` is the org-as-hidden-
  workspace primitive (creates an ACTIVE org + ACTIVE admin/owner membership with **no** super-admin
  approval) the self-serve tournament-create flow builds on.
- `permissions` (label **`permissions_app`**) — Layer-1 module RBAC: `Module` catalog,
  `MembershipModuleGrant`, `effective_modules` resolver, `grants`, `matrix`, `HasModule`.
- `audit` — append-only `AuditEvent` + `emit_audit` (the single write path + idempotency ledger).
- `tournaments` — the 1B tenancy/authz spine: `Tournament`, `TournamentMembership`, the two
  most-depended-on primitives (`accessible_tournaments`, `can_manage_tournament`), rules service,
  and a **cross-app router** (`urls.py` aggregates fixtures/teams/forms/matches/disputes routes).
- `teams` — entrant layer: `Person` (org-less), `Player`, `Team`, `RegistrationLink`, and the sole
  entrant writer `register_school` (a thin MVP; never de-dups Person; `TeamStatus` vestigial).
- `forms` — data-driven forms engine: `Form`/`FormShareLink`/`FormResponse`/`FormFileUpload`,
  `schema`/`fields`/`validation`/`responses`/`mapping` services; client/server branching parity.
- `fixtures` — generation + advancement (no models): `generate_round_robin`/
  `generate_single_elimination`/`generate_knockout_from_groups`, `advance_from_match`, constraint
  catalog (shape-only validation).
- `matches` — event-sourced scoring: `Match`/`MatchEvent`/`Lineup`/`LineupEntry`/`MatchIncident`,
  `events`/`scoring`/`state`/`lineups`/`incidents`/`standings` services. **Two divergent score
  paths.**
- `live` — public snapshot view (AllowAny) + `MatchConsumer` (WS ping forwarder, no auth). No models.
- `notifications` — durable per-user `Notification`, `create_notification` (single entry point,
  idempotent only if `event_id` passed); `_publish` is a no-op stub; bell polls 30s.
- `disputes` — org+tournament+match-scoped `Dispute` with a real audited state machine
  (`services/lifecycle.py::transition_dispute` + standalone `ALLOWED_TRANSITIONS`, lines 16-22,
  60-95 — one of the system's THREE realized SMs, §2.2; advisory-only; score-dispute →
  re-advancement cascade unbuilt).
- `sadmin` — Django+Tailwind-CDN+HTMX console at `/sadmin/`: `superadmin_required` (404 surface-hide),
  IP allowlist, 13 audited verbs, feedback inbox (PII redaction at INSERT), KPI dashboard,
  `emit_usage` telemetry. Impersonation is **banner-only** (no `request.user` swap).
- `sports` — read-only platform-level catalog (59 planned sports; `code` slug = future plugin app
  suffix).

**Management commands — the de-facto background-job / seed layer (no Celery in 1A):** these are the
scheduled and one-shot jobs that the "no Celery / `_publish` is a no-op" gap is filled by, and are
load-bearing for several restructure proposals. All are idempotent.
- `organizations/.../mark_orphaned_orgs.py` → `lifecycle.detect_orphaned()` — **cron-style** orphan
  detection; the prod driver of the org state machine's `active → orphaned` transition.
- `permissions/.../load_modules.py` — seeds/upserts the **23-module catalog** from
  `permissions/fixtures/modules.json` (load-bearing for the WS1/S15 module-code codegen proposal).
- `sports/.../load_sports.py` — seeds/upserts the **Sport catalog** from `sports/fixtures/sports.json`
  (the catalog BLUEPRINT S9 wants to source `DEFAULT_RULES` from).
- `sadmin/.../snapshot_kpi.py` → `sadmin.services.kpi.compute_kpi_snapshot` — **cron** daily KPI
  rollup, idempotent on `snapshot_date` (v1Users.md Appendix B.7).
- `tournaments/.../run_e2e_demo.py` — one-shot end-to-end demo seed (org → tournament → schools/teams/
  players → roles → fixtures → scores → standings); creates a fresh tournament per run.

These scheduled jobs are the background-job layer the Option-C outbox/worker discussion (§3 of the
blueprint) would coexist with; WS8 (prod hardening) must account for them. See §6 M1's companion note
and BLUEPRINT WS8.

**Frontend areas:** core (routing/shell/state/api: `apiFetch`, `lib/routes`, `authStore`,
`ProtectedRoute`, `AppShell`); tournaments/teams/matches/live (operator + public 1B surface, all
polling); forms (builder + public wizard + responses; `lib/formLogic.ts` is parity-critical);
orgs/permissions/roles/invitations/notifications/theme (Phase-1A account-chassis UI); design system
(token layer + primitives; `api.generated.ts` anti-drift contract). Full detail in
`deep/FRONTEND-STATE.md`.

---

## 4. The definitive invariant list (numbered, with enforcement + status)

This is the authoritative consolidation of CLAUDE.md's 15 architectural invariants plus the
subsystem-level invariants, **each annotated with where it is enforced and whether the code honors
it** (verified against source and the deep pass). Status: ✅ Honored · ⚠️ Partial/divergent ·
❌ Not realized.

| # | Invariant | Enforced at | Status |
|---|---|---|---|
| **1** | UUIDv7 PKs everywhere via single `accounts.models.uuid7`; no auto-increment; public URLs `(slug, UUID)` | Every model's `id` field; `DATA-MODEL.md` §0 | ✅ |
| **2** | Multi-tenancy by `Organization`; every tenant row has an `organization` FK; cross-org access → **404 (no existence leak)** | `tournaments/scope.py::accessible_tournaments` + `can_manage_tournament`; `_get_tournament_or_404`/`_match_or_404` 404-before-403; isolation tests in every domain app | ✅ for DATA isolation; **service-enforced, NOT DB-enforced** (no composite FK/CHECK ties child org to tournament org). Org-scoped endpoints return **403 not 404** (existence oracle) — see verdict V4 |
| **3** | Idempotent writes: client `event_id` UUID + unique constraint; replay returns existing row **(200, not 201)** | `MatchEvent.event_id`/`Dispute.event_id`/`Notification.event_id`/`FormResponse(form,event_id)`/`AuditEvent.idempotency_key` | ⚠️ **Refuted as a universal** (verdict V6): events/incidents/create-tournament/register replay **201 not 200**; several mutations take **no event_id** at all (generate-fixtures, mark-read, dispute transitions, registration-link create, ~17/18 org mutations); cross-verb `event_id` reuse → 500; only `set_lineup` honors 200-on-replay |
| **4** | DB-first event log: `MatchEvent` is system of record; score derived by `recompute_score`; publish only on `transaction.on_commit` | `events.py::record_match_event`/`recompute_score`/`publish_match_event` | ⚠️ Honored for the event path, but **`record_score` writes a NON-derived score directly** and the two writers can clobber each other (verdict V1, audit-concurrency #2) |
| **5** | Append-only audit at DB level: UPDATE/DELETE on `AuditEvent` blocked by trigger (42501) even for superuser; sole write path `emit_audit` | `audit/migrations/0002_audit_append_only.py`; `emit_audit` | ✅ for UPDATE/DELETE (empirically proven against the postgres superuser, verdict V3). **Caveats:** TRUNCATE and `DISABLE TRIGGER` bypass the trigger (only the app role's lack of privilege blocks them); the prod app-role REVOKE is a **manual runbook step, not code** |
| **6** | State machines, not booleans: Tournament + Match status are guarded, audited enums | Match: `matches/services/state.py::ALLOWED_TRANSITIONS`/`transition_match`. Also (beyond the invariant's two named subjects): Dispute `disputes/services/lifecycle.py::transition_dispute`/`ALLOWED_TRANSITIONS`; Organization `organizations/services/lifecycle.py` per-verb guards. Tournament: enum only | Match ✅; **Dispute ✅ and Organization ✅** (THREE realized SMs — §2.2). **Tournament ❌ — declared but NOT driven**: no `ALLOWED_TRANSITIONS`, no `transition_tournament`, no endpoint; status never leaves `draft` in prod. The single largest architecture-vs-code gap. The 3 existing implementations are near-identical → extract one generic guarded-transition seam (BLUEPRINT S5) |
| **7** | Rule freeze at boundary: mutable in draft/published, frozen at registration_open (amend = reason + 24h grace + notify); match rules frozen once live | `rules.py::can_edit_rules`/`freeze_rules`/`update_settings` | ⚠️ Partial: freeze enforced by `status in {DRAFT,PUBLISHED}`; **`freeze_rules`/`rules_frozen_at` never fire in prod** (no caller); 24h grace + notify unimplemented; match-rule-freeze-once-live absent. Because status never advances, rules are in practice always editable |
| **8** | Person ↔ Player split: `Person` platform identity (no org FK); `Player` per-tournament; PROTECT on `person`; `unique_person_per_tournament` | `teams/models.py` | ✅ (but `register_school` **never de-dups Person** — always creates new) |
| **9** | Match dependencies as typed pointers (`home_source`/`away_source`), not inferred; advancement is an on_commit hook | `generate.py` (producer), `advance.py` (consumer), `state.py`/`scoring.py` on_commit | ⚠️ Honored for `team`/`winner_of`; **`loser_of` is a dead resolver branch (no generator emits it); `group_position`/`tbd` documented but never produced/consumed**; `MatchSerializer` omits the pointers so the bracket UI infers shape from geometry (verdict V2) |
| **10** | Auto-generate; manual edit allowed; conflict warnings via `inputs_hash` + `last_manual_edit_at` | `generate.py` (`inputs_hash` round-robin only) | ⚠️ Partial: **`Match.last_manual_edit_at` does not exist**; generation idempotency is presence-based not hash-based (edit-then-regenerate is a silent no-op); regenerate/keep/diff UX unbuilt |
| **11** | SSE one-way viewers + bell; WebSockets two-way scorer rooms | `live/consumers.py`, `live/views.py`, `notifications` | ❌ **Not realized**: no SSE; one undifferentiated public WS room with **no auth**; the frontend polls (5s/30s) with no WS/SSE client |
| **12** | Module RBAC + verb matrix both canonical; deny beats union; grants keyed (user,org,module) | `resolver.py::effective_modules`; `can_manage_tournament` | ⚠️ Module layer ✅ (deny-after-union verified). **Verb matrix not data-driven** (inline `can_manage_tournament`; 3/6 tournament roles inert: referee/game_coordinator/team_manager gate nothing in the live API) |
| **13** | i18n + a11y from day 1: every string via `t()`; WCAG AA | FE `lib/t`, design system | ⚠️ Largely honored; residual violations (one native `<select>`, emerald hardcodes, `mx-auto max-w-*` centered columns) |
| **14** | UTC storage (`USE_TZ=True`); render in tournament/viewer TZ; TZ change blocked once scheduled | `base.py`; models store UTC | ⚠️ UTC ✅; **TZ-change-blocked-once-scheduled NOT enforced** (no tournament state machine to gate on `scheduled`) |
| **15** | Session auth (no JWT), same-origin SPA, DRF + cookies + CSRF custom header | `base.py` SessionAuthentication-only; `apiFetch` X-CSRFToken | ✅ |

### 4.1 Subsystem-level invariants that also must hold (and their status)

- **accounts** ✅ — email canonical+lowercased; tokens hashed at rest (sha256/argon2id/Fernet);
  `is_active` is the verification gate; session cycled on every auth-state change; enumeration
  safety (dup-signup 201, resend 202, reset 200); two independent lockouts. ⚠️ TOTP secret key is
  `sha256(SECRET_KEY)` with a **silent plaintext fallback** if `cryptography` is missing.
- **organizations** ⚠️ — exactly one active owner per org + owner⇒admin (but `one_owner_per_org` is
  **IMMEDIATE, not the documented DEFERRABLE** — correctness depends on `transfer_ownership`'s
  clear-before-set ordering); multi-role/multi-org-admin **intentional** (don't reinstate
  `single_org_per_admin_user`); slug uniqueness spans `Organization.slug ∪ SlugRedirect.old_slug`;
  tournament-scoped invites create only `TournamentMembership`; invite email read from the signed
  invite, never the body.
- **permissions/audit** ✅ — union-then-overrides (deny wins); grants keyed (user,org,module);
  reason ≥20 chars; app label `permissions_app`; 23 modules; module FK PROTECT; `effective_modules`
  is a cached frozenset; `AuditEvent` has no `Meta.ordering` by design. ⚠️ Resolver cache
  invalidation is **single-process only** and runs **before commit** (cross-worker Redis pub/sub is
  a TODO).
- **tournaments** ✅ — 404-not-403; manage gate = ADMIN/CO_ORGANIZER or active org ADMIN;
  whitelist rule merge; last-admin guard; creator becomes ADMIN/ACTIVE atomically.
- **teams** ✅ — `register_school` is one atomic, idempotent-on-`(event_id,"school_registered")`
  write path; `Team(status=REGISTERED)` is exactly what fixtures selects; uniform 404 from
  `resolve_registration_link`. ⚠️ submission_count bump lives OUTSIDE the txn and re-runs on replay.
- **forms** ⚠️ — client/server branching parity (the highest-risk contract, with a verified live
  divergence on `gt`/`lt` against empty/null — verdict V5); hidden answers dropped server-side
  (real security boundary); triple-distinct idempotency keys; `form_version` pinning;
  `max_responses`/`one_response_per_email` **unenforced**; `map_response` runs synchronously in the
  public path and is NOT atomic with submit.
- **matches** ⚠️ — gapless sequence under lock ✅; score derived ✅ for the event path; VOID
  corrections append-only but **`void_match_event` has no API endpoint**; lineups freeze once not
  SCHEDULED; advancement post-commit; `winner_id`/`loser_id` None on draw/non-terminal. **Two score
  writers; walkover never advances.**
- **live/disputes/notifications** ⚠️ — publish-after-commit best-effort; per-user notification
  isolation ✅; dispute state machine + ≥5-char resolution ✅; public snapshot minimization ✅ for
  rosters but **no tournament/org-state gate** (draft/suspended leaks). Incident/dispute
  notifications pass **no `event_id`** (not idempotent).
- **sadmin** ✅ — non-SA → 404 surface-hide; one audit row per verb; PII redaction at INSERT.
  ⚠️ two `@csrf_exempt` JSON verbs; impersonation banner-only.
- **project config** ✅ — `ATOMIC_REQUESTS`; UTC; session-auth-only + CSRF; ASGI bootstrap order;
  WS origin-validator stack. ⚠️ Redis mandatory in multi-worker prod; dev-vs-prod-DB footgun.

---

## 5. Adversarial-verification results (claim → holds? → evidence)

Six load-bearing architectural claims were tested against source (some empirically against the
running Postgres). **Result: 1 holds, 5 refuted.** This is the most important table in the dossier
— it shows that several documented "invariants" are aspirational. Full evidence in the per-verdict
records of the analysis index; the most load-bearing line cites are reproduced here.

| # | Claim | Holds? | Evidence / counterexample (key cites) |
|---|---|:--:|---|
| **V1** | `MatchEvent.sequence_no` is gapless + race-safe (lock + Max+1), and score is derived **purely from non-voided GOAL events** | **❌ Refuted** | Gapless mechanism is real (`events.py:88-93` + `unique(match,sequence_no)`). But (a) `record_score` (`scoring.py:82-85`) writes the cached score **directly from the request body, no events** — a whole authorized path bypasses derivation; (b) `recompute_score` counts **PENALTY_SCORED + OWN_GOAL**, not only GOAL; (c) **cross-path clobber**: `record_match_event` has no status guard, so a GOAL after a `record_score`-completed match overwrites the official result; (d) the idempotency pre-check is **outside the lock** (`events.py:83-86`), so concurrent same-`event_id` requests → IntegrityError → **500, not the spec's 200 replay**. No concurrency test exists. |
| **V2** | Advancement resolves typed `winner_of`/`loser_of`/`group_position` pointers correctly and fires only via `on_commit` on completion/walkover | **❌ Refuted** | `winner_of`/`loser_of` resolution + on_commit firing are real (`advance.py:37-42`, `state.py:67-69`, `scoring.py:99-102`). But **`group_position` is NEVER resolved** (grep: one comment hit only) and never emitted by any generator; and **WALKOVER fires the hook but advances NO ONE** — `transition_match(WALKOVER)` sets no scores, `winner_id` is None when scores are None (`models.py:111-112`), so `advance_from_match` returns `[]` (`advance.py:23-24`). A walkover leaves the next slot **permanently unfilled**. Zero test coverage of walkover advancement. |
| **V3** | `audit_event` is append-only at the DB level for ALL roles incl. superuser (trigger), and the app role additionally lacks UPDATE/DELETE | **✅ Holds** (with caveats) | Trigger empirically rejects UPDATE/DELETE as the `postgres` superuser (ERRCODE 42501); `test_append_only.py` passes as table-owner (so it's the trigger, not privileges). App role `fixture_app` empirically has **only INSERT+SELECT** on `audit_event`. **Caveats demonstrated live:** `TRUNCATE` and `ALTER TABLE … DISABLE TRIGGER` both **bypass** the row-level trigger as superuser; and the app-role REVOKE exists only in **comments/docstrings** (no migration/SQL in the repo) — automated test DBs never apply it. |
| **V4** | Every tenant-scoped endpoint enforces cross-org isolation (404 on no-access, no existence leak); no endpoint leaks another org's data | **✅ Holds** (for data) / **❌ for the "404" wording** | No exploitable cross-org **data** leak found (63 isolation tests pass; child resources are re-parented to the scoped object; write side re-checks membership). **But** the literal "404, no existence leak" is true only for **tournament-scoped** endpoints: **org-scoped** endpoints return **403** for non-members (`OrgDetailView.get` line 198), disclosing org existence; `MyEffectiveModulesView` returns 200 with an empty set for a non-member org — both are existence oracles. The codebase treats 403/404 as equivalent ("the SPA treats them the same"). |
| **V5** | Forms branching + required-validation produce **identical** reachable-section/field results on client (`formLogic.ts`) and server (`validation.py`) for the same schema+answers | **❌ Refuted** | `gt`/`lt`: client uses `Number(val) > Number(target)` where `Number('')===0`/`Number(null)===0`; server uses `float(val)` in try/except returning **False** on `''`/`None`. So a present-but-empty optional number with rule `gt:-1` is **visible client-side (field required) but hidden server-side (field dropped)** → spurious 400. Confirmed end-to-end through both walkers. `gt`/`lt` are authorable in the builder UI and the rule `value` is not validated by `validate_schema`. (Secondary, write-time-guarded: duplicate section keys resolve first-match client vs last-match server.) |
| **V6** | Every mutation endpoint is idempotent via a unique client `event_id` (replay returns existing record, **200 not 201**) | **❌ Refuted** | `MatchIncidentView.post` (line 425) and `RecordMatchEventView.post` (line 221) hardcode **201 on every response incl. replay** — the repo's own `test_incident_idempotent_replay` asserts `r1==201 AND r2==201`. Same 201-on-replay in create-tournament, invitation-create, public-registration, dispute-raise. **Many mutations take no `event_id`** (generate-fixtures, mark-read, dispute transitions, registration-link create, ~17/18 org mutations). Cross-verb `event_id` reuse → IntegrityError 500 (global unique `idempotency_key` vs event_type-scoped lookups). Only `set_lineup` honors 200-on-replay. |

**Takeaway:** the codebase's *isolation* and *append-only audit* guarantees are real and strong
(V3, V4 for data). The *event-sourcing purity* (V1), *advancement completeness* (V2),
*forms parity* (V5), and *universal idempotency* (V6) claims are **not** — they are the four
correctness fronts the restructuring must close, and they are already armed with concrete
counterexamples to turn into regression tests.

---

## 6. Consolidated audit findings, ranked by severity

Merged from `deep/audit-concurrency-txn.md` (15 findings) and `deep/audit-security-tenancy.md`
(10 findings), de-duplicated and ranked. Each row: finding · location · why it matters.

### 6.1 HIGH (correctness or security — fix before/with any rewrite)

| # | Finding | Location | Why it matters |
|---|---|---|---|
| H1 | **Walkover transition fires advancement but never sets a score**, so the bracket never advances | `state.py:33,67-69`; `advance.py:20-24`; `models.py:107-124` | A walkover leaves the next knockout round permanently unresolved. Highest-impact correctness bug found. (verdict V2) |
| H2 | **Two unreconciled writers of cached `home_score`/`away_score`** (stored result vs event-derived) can diverge/clobber | `scoring.py:71-103`; `events.py:49-74,88-110` | A late goal after a final `record_score` recomputes and overwrites the official result; an event-only match never gets a `record_score` value. Invariant #4 says score is derived, yet `record_score` stores a non-derived value. (verdict V1) |
| H3 | **No DB enforcement of `child.organization_id == tournament.organization_id`** | all deep tenant models; isolation queries filter by `tournament`, not `org` | A service writing the wrong org id can leak across tenants; deep-model isolation relies entirely on service discipline. |
| H4 | **Forms branching parity is a hand-paired prose contract** with a verified live divergence | `lib/formLogic.ts` ↔ `validation.py` (`gt`/`lt` on empty/null) | Spurious unfixable 400s; no shared golden fixture; only parallel tests. (verdict V5) |
| H5 | **Cross-verb `event_id` collision → uncaught IntegrityError 500** | `AuditEvent.idempotency_key` global unique vs event_type-scoped lookups (`scoring.py:64-69`, `lineups.py`, `create.py`, `registration.py`) | A second mutation reusing an `event_id` 500s instead of replaying. (verdict V6) |

### 6.2 MEDIUM (architecture gaps / concurrency / abuse)

| # | Finding | Location | Why it matters |
|---|---|---|---|
| M1 | **No Tournament state machine** — status never transitions; `freeze_rules`/`rules_frozen_at` dead; TZ-lock unenforced | `tournaments` (absent); `rules.py:66-70` | Invariants #6/#7/#14 half-built; the largest feature-blocking hole. |
| M2 | **`generate_single_elimination` has no idempotency guard or lock** → concurrent generate creates duplicate brackets | `generate.py:90-143`; `views.py:30-43` | Two concurrent `POST .../generate {knockout}` both read count=0 and both create full brackets (no `unique(tournament, match_no)`). |
| M3 | **Advancement is non-atomic, unlocked, exception-swallowed, O(matches) full scan, not idempotent** | `advance.py:16-46`; `state.py:73-80` | Partial fan-out on error is silently left and never retried; concurrent completions feeding the same dependent can lose one side. |
| M4 | **`record_match_event` idempotency pre-check is outside the lock with no IntegrityError backstop** → concurrent replay 500s | `events.py:83-128` | Violates the 200-replay contract under concurrency; `forms/responses.py` has the correct savepoint pattern this lacks. |
| M5 | **`record_score` idempotency keyed on AuditEvent, pre-checked outside the lock** → concurrent replay returns 400 not 200 | `scoring.py:64-69` | Second request finds COMPLETED and raises `ValidationError`. Idempotency on a side-effect table is fragile. |
| M6 | **WebSocket `MatchConsumer.connect()` has no auth/scope** | `live/consumers.py:12-16` | Any client subscribes to any (even non-existent) `match_<id>`; room-enumeration/DoS vector; contradicts invariant #11. The only WS test *asserts* open access. |
| M7 | **Public live snapshot + public form GET ignore tournament/org state** (draft/suspended/archived leak) | `live/views.py:50-103`; `forms/views.py:190-201` | Data exposed by raw UUID regardless of parent visibility. |
| M8 | **Prod REVOKE UPDATE/DELETE on `audit_event` is a manual runbook step, not code** | `audit/migrations/0002:9-13`; `deploy/README.md:42-44` | If the operator skips it, only the trigger stands; no startup self-check asserts the role lacks UPDATE/DELETE. (verdict V3 caveat) |
| M9 | **Resolver cache invalidation is single-process and runs before commit** | `resolver.py:42-50`; `grants.py:111,211,266` | Multi-worker prod serves stale module sets up to 5 min; a concurrent read between delete-and-commit re-caches the pre-write value. |
| M10 | **`set_lineup` delete+recreate is visible to non-locking readers; `get_or_create` can collide with the partial unique index** | `lineups.py:76-95`; `models.py:156-162` | A GET between delete and bulk_create observes an empty lineup; a collision surfaces as uncaught 500. |
| M11 | **`one_owner_per_org` is IMMEDIATE, not the documented DEFERRABLE** | `organizations/migrations/0001`; model comment 219-229 | An in-transaction owner swap can trip the constraint mid-statement; correctness depends entirely on `transfer_ownership` clear-before-set ordering. |
| M12 | **`map_response` runs synchronously in the public AllowAny path; submit+map are not atomic together** | `forms/views.py:226-228`; `registration.py:114` | If `register_school` raises after submit committed, the response exists unmapped and the client sees a 500. |
| M13 | **No DRF default pagination → unbounded REST list endpoints** | `base.py:160-180` (no `DEFAULT_PAGINATION_CLASS`/`PAGE_SIZE`); `sports/views.py:43` is the only `pagination_class` (set to `None`) | The operator/public list endpoints return **whole querysets**: `TournamentMatchListView` (`matches/views.py:86-96`), `TournamentTeamsListView` (`teams/views.py:95+`), `TournamentDisputeView` GET (`disputes/views.py:46-51`), `FormResponsesView` GET + the `?export=csv` path which streams **all** rows (`forms/views.py:283-310`). Only the **sadmin HTML** console paginates (Django `Paginator`, 25-50/page: `sadmin/views/{users,orgs,feedback}.py`, `audit.py:34`) and the **audit REST** view cursor-paginates with a manual `limit` (default 50, max 200; `audit/views.py:37,156-187`). A real perf/DoS/scale concern as tournaments grow (ranks alongside the LOW "public live snapshot has no throttle"). *Note: `NotificationListView` is bounded but by a hardcoded `[:50]` (`notifications/views.py:18`), not real pagination — no way to page past the first 50.* |

### 6.3 LOW / INFO (consistency, perf, hardening, cosmetic)

- **Idempotency: 201-not-200 on replay** for matches events/incidents (and others); inconsistent
  idempotency storage (entity `event_id` column vs `AuditEvent.idempotency_key` lookups); lineup
  replay-after-soft-delete re-creates (non-idempotent). (verdict V6)
- **All on_commit hooks fire at the outermost request commit** (synchronous, best-effort, lossy;
  no outbox); a crash between commit and on_commit silently drops the hook.
- **Perf hotspots:** `recompute_score` O(events) per write under the lock; `advance_from_match`
  O(matches); `_invalidate_all_sessions_for_user`/`_delete_sessions_for_user` O(all-sessions) scans;
  groups→knockout N+1; `MeSerializer` per-org `effective_modules` N+1.
- **Public live snapshot has no endpoint throttle** (global 60/min only → cheap UUID enumeration).
- **`_OrgMembershipPermission` fails open** when org is unresolved (`permissions.py:85-90`) — not
  currently reachable but a fail-open default.
- **`@csrf_exempt` on two session-authed superadmin JSON verbs** (`superadmin.py:45-47,95-97`).
- **TOTP secret key = `sha256(SECRET_KEY)` with silent plaintext fallback** (`_crypto.py:32-49`).
- **2FA/rate-limit/reset counters are cache-only** (LocMem dev, per-process, lost on restart).
- **Incident/dispute notifications pass no `event_id`** → double-fire on re-delivery.
- **`max_responses`/`one_response_per_email` exist but are never enforced**; `response_count` drifts.
- **Production secrets in the working tree** (`deploy/CREDENTIALS-PROD.md`, gitignored but readable
  on this host — should be rotated); published demo passwords; SA not 2FA-enrolled.
- **Doc/code drift:** module-count docstrings say 22 (code pins 23); "4 constraints" text; stale
  DEFERRABLE comments; `SADMIN_HOST` dead config; B.18 reauth dead; `notify_many` dead;
  `dashboardCards.ts`/`roleRoutes`/`authBus.emit` orphaned; one native `<select>` + emerald
  hardcodes + `mx-auto max-w-*` violations.

---

## 7. The two parity contracts that MUST stay in sync (single highest correctness risk)

1. **Forms branching evaluator** — `frontend/src/lib/formLogic.ts` ↔
   `backend/apps/forms/services/validation.py`. Seven ops (`answered`/`equals`/`not_equals`/`in`/
   `includes`/`gt`/`lt`); identical traversal order (chosen-option `goto` → `section.next` →
   document order → `_end`); "first goto-bearing single_choice/dropdown wins"; empty =
   `None/""/[]/{}`; cycle guard; `DISPLAY_TYPES={section_text}` skip. **Already drifted** on
   `gt`/`lt` against empty/null (verdict V5). Guarded only by parallel tests with **no shared golden
   fixture**. Server-side hidden-answer dropping is the real security boundary; client filtering is
   UX-only.

2. **Live snapshot + match state/event vocab** — `LiveSnapshot` (`api/live.ts`) ↔
   `LiveMatchSnapshotView`; FE `STATE_ACTIONS`/`EVENT_BUTTONS` ↔ backend `ALLOWED_TRANSITIONS`/
   `MatchEventType`/`SCORING_EVENT_TYPES`; FE `BracketView.computeStandings` (3/1/0) vs server
   `compute_standings` (data-driven). All hand-mirrored.

---

## 8. JSONB / data-driven columns (interpret-at-runtime, never schema-migrated)

`Tournament.rules` + `.constraints`; `Match.home_source`/`away_source` (typed pointers);
`MatchEvent.detail`; `Form.schema`; `FormResponse.answers`; `Form.settings.bindings`;
`FormShareLink.bound_entity`/`prefill`; `Module.default_for_roles`; `AuditEvent.payload_before`/
`payload_after`; `UsageEvent.payload`; `KPISnapshot.metrics`. (See `DATA-MODEL.md` §3 for the
verified runtime shapes and which service reads/writes each blob.)

---

## 9. Idempotency, transactions & ordering (load-bearing semantics, consolidated)

- `ATOMIC_REQUESTS=True` — every request is one transaction; on_commit fan-out + idempotent replay
  depend on it (see §2.7).
- Gapless sequence: `select_for_update` + `Max+1` *inside* the atomic block; `unique_event_seq_
  per_match` is the backstop. **Never move `Max+1` out of the lock; never append a `MatchEvent`
  without first locking the Match** (the safety lives entirely in this discipline — no DB sequence).
- Publish/advancement fire only on `transaction.on_commit` (best-effort, swallow exceptions); a
  process death between commit and on_commit silently drops the hook (no outbox).
- Audit shares the verb's transaction (inline `emit_audit`) — atomic with the state change, but
  couples availability (an audit-write failure rolls back the user's verb; an `idempotency_key`
  collision 500s the verb).
- Ordering rules that are load-bearing: Django `login()` *then* session-cycle;
  `emit_audit("user_logout")` *then* `logout()`; invite session-cycle *after* the atomic block;
  `transfer_ownership` clears the outgoing owner *before* setting the incoming one.

---

## 10. Where documented architecture and code diverge (read before trusting CLAUDE.md)

The definitive divergence list (each backed by §4/§5/§6):
1. **No SSE; live is poll-driven** (inv #11). The WS room exists, has no auth, has no React consumer.
2. **No Tournament state machine** (inv #6/#7/#14): status never transitions; `freeze_rules` dead;
   TZ-lock unenforced.
3. **Two divergent score paths** that can disagree (inv #4); no reconciliation; `record_score` has
   no amend verb; `void_match_event` has no endpoint.
4. **Walkover never advances** the bracket (no score set).
5. **Generator ignores `Tournament.rules`** — reads request body; stored `format`/`group_size`/
   `advance_per_group` are ineffective.
6. **Constraints are inert** — validated for shape, never enforced by any scheduler.
7. **Idempotency is not universal** (inv #3): 201-on-replay, missing `event_id`s, cross-verb 500.
8. **Org-scoped endpoints return 403, not 404** (inv #2 wording) — an existence oracle; only
   tournament-scoped endpoints honor 404.
9. **`group_position`/`tbd`/`loser_of` pointer types** (inv #9) are documented but not produced.
10. **Forms client/server parity has already drifted** (`gt`/`lt`).
11. **`one_owner_per_org` is IMMEDIATE, not DEFERRABLE**; the prod audit REVOKE is not in code.
12. **`SADMIN_HOST` is dead config; impersonation is banner-only** (no `request.user` swap).

---

## 11. Glossary of load-bearing symbols (the seams everything hangs on)

| Symbol | File | Role |
|---|---|---|
| `accessible_tournaments(user)` | `apps/tournaments/scope.py` | The tenancy visibility funnel; 404-before-403; 6 apps depend on it |
| `can_manage_tournament(user, t)` | `apps/tournaments/permissions.py` | The verb-gate (manage); ADMIN/CO_ORGANIZER or active org admin |
| `_can_score(user, match)` | `apps/matches/views.py` | The 4th-layer match gate (manager / assigned scorer / active MATCH_SCORER) |
| `effective_modules(user, org)` | `apps/permissions/services/resolver.py` | Layer-1 RBAC authority; union-then-overrides; frozenset; 5-min cache |
| `emit_audit(...)` | `apps/audit/services.py` | The ONLY audit write path + idempotency ledger; exact `event_type` strings are a contract |
| `register_school(...)` | `apps/teams/services/registration.py` | The sole entrant writer; `(event_id,"school_registered")` idempotency |
| `record_match_event` / `recompute_score` | `apps/matches/services/events.py` | Event-sourcing core; gapless seq; derived score |
| `record_score` | `apps/matches/services/scoring.py` | The *second*, divergent score writer (stored, not derived) |
| `transition_match` / `ALLOWED_TRANSITIONS` | `apps/matches/services/state.py` | Realized state machine #1 (match); the on_commit-advancement trigger |
| `transition_dispute` / `ALLOWED_TRANSITIONS` | `apps/disputes/services/lifecycle.py` | Realized state machine #2 (dispute); cleanest `ALLOWED_TRANSITIONS`-dict template for the missing Tournament SM |
| `approve_org`/`suspend_org`/`archive_org`/`detect_orphaned` | `apps/organizations/services/lifecycle.py` | Realized state machine #3 (org `OrgStatus`); per-verb guards + inline audit; `detect_orphaned` driven by the `mark_orphaned_orgs` cron command |
| `provision_personal_workspace` | `apps/organizations/services/workspace.py` | The org-as-hidden-workspace primitive (ACTIVE org + ACTIVE admin/owner, no SA approval) the self-serve flow builds on |
| `advance_from_match` | `apps/fixtures/services/advance.py` | Typed-pointer advancement (on_commit) |
| `publish_match_event` | `apps/matches/services/events.py` | The only WS producer (`{match_id,event_id}` → `match_<id>`) |
| `merge_rules` / `DEFAULT_RULES` | `apps/tournaments/services/rules.py` | Rules whitelist + layered merge (key-only validation) |
| `apiFetch` / `lib/routes` / `authStore` | `frontend/src/api/client.ts` etc. | FE transport / URLs / identity choke points |
| `lib/formLogic.ts` | `frontend/src/lib` | The client half of the forms-branching parity contract |
