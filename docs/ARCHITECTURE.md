# Fixture Platform — Architecture Reference

> The canonical "how the system actually works" document. Synthesized 2026-06-08 from 16
> subsystem reads + 7 end-to-end flow traces (see `docs/superpowers/analysis/`). This describes
> the code **as built**, not the spec aspiration; where docs/spec and code diverge it is called
> out explicitly. Citations use `path::symbol`.

---

## 1. System overview & purpose

The Fixture Platform is a **multi-tenant sports fixture & tournament management system**
(Nagaland focus; v1 = a *football* vertical slice over a sport-agnostic chassis). A platform
owner provisions nothing manually — organizers self-serve: they sign up, get a hidden personal
**Organization** (the tenant), create **Tournaments**, invite a roster (6 tournament-scoped
roles), collect team/player registrations (public links + a data-driven forms engine), generate
**fixtures** (round-robin / single-elimination / groups→knockout), score matches through an
**event-sourced** engine, watch live scoreboards, view rules-driven standings + brackets, and
work disputes. A bespoke **super-admin console** (`/sadmin/`) is the only operator surface (Django
admin is disabled).

Two delivery phases are visible in the code:

- **Phase 1A** (production-grade, fully tested): accounts/identity, organizations + membership,
  two-layer module RBAC, append-only audit, the super-admin console.
- **Phase 1B** (substantially built): tournaments + (partial) state machine, teams/players/
  registration, fixture generation + advancement, event-sourced matches/scoring, lineups,
  incidents, disputes, notifications, live transport, data-driven rules/constraints.

The frontend is a same-origin React/Vite SPA with a complete design-system + token layer.

Test baseline to keep green: **~448 backend (pytest) + ~193 frontend (vitest)**, tsc clean.

---

## 2. Tech stack & topology

| Layer | Technology |
|---|---|
| Backend | Django 5.1.x + DRF, Channels + channels-redis (ASGI), django-rules, django-axes, drf-spectacular, argon2-cffi, pyotp, cryptography (Fernet), uuid-utils, django-environ |
| DB | PostgreSQL (UUIDv7 PKs everywhere; append-only audit enforced by PL/pgSQL triggers + two-role grant model) |
| Async transport | Channels WebSocket (`match_<id>` rooms); cache/channel layer = in-memory (dev) / Redis (prod) |
| Frontend | React 19 + Vite, TanStack Query (server state), Zustand (client state), react-router-dom, react-hook-form + zod, Tailwind (token-based), openapi-typescript codegen, lucide-react |
| Auth | **Session cookie + CSRF** (no JWT); same-origin SPA via Vite proxy in dev |
| Deploy | Native (no Docker): gunicorn + UvicornWorker behind nginx (TLS), systemd, two Postgres roles |

**Serving topology (`backend/fixture/asgi.py`, `deploy/`):** one ASGI app via
`ProtocolTypeRouter` — `http` → Django; `websocket` → `AllowedHostsOriginValidator(
AuthMiddlewareStack(URLRouter(websocket_urlpatterns)))`. WSGI exists but is vestigial (deploy is
ASGI-only). nginx serves the SPA build + `/static`/`/media`, proxies `/ws/` and `^/(api|sadmin)/`
to a unix socket (`proxy_buffering off` to allow streaming).

**Settings layering (`backend/fixture/settings/{base,dev,prod}.py`):** `base` holds all
substantive config and invariants (`ATOMIC_REQUESTS=True`, `USE_TZ=True`/UTC, Argon2 hashers,
SessionAuthentication-only, throttle budgets, in-memory channels/cache); `dev` adds DEBUG + CORS
for Vite + console email; `prod` adds TLS/HSTS, Redis cache+channels, SES email, and a hard
`assert DEBUG is False`. **Footgun:** the on-disk `.env` is a *production* env, but `manage.py`/
`asgi.py`/pytest all default `DJANGO_SETTINGS_MODULE=fixture.settings.dev` — a bare `manage.py`
invocation runs dev settings against the prod DB/role.

**App inventory (14 local apps):** `accounts`, `organizations`, `permissions` (label
`permissions_app`), `audit`, `tournaments`, `teams`, `forms`, `fixtures`, `matches`, `live`,
`notifications`, `disputes`, `sports`, `sadmin`.

---

## 3. The big-picture cross-file patterns

These patterns span many files. Understand them before reading any subsystem in isolation.

### 3.1 Event sourcing (the score is derived, never stored)

A match score is **derived from an append-only `MatchEvent` log**, not authored.
`apps/matches/services/events.py::record_match_event` appends an immutable event under a row lock
(`Match.objects.select_for_update()`) with a **gapless `sequence_no`** (`Max(sequence_no)+1`,
backstopped by `UniqueConstraint(match, sequence_no)` = `unique_event_seq_per_match`), then
`recompute_score` re-derives `home_score`/`away_score` from non-voided GOAL/PENALTY_SCORED (own
side) + OWN_GOAL (opponent) events. Corrections are **append-only `VOID` events**
(`void_match_event`), never UPDATE/DELETE. `Match.home_score`/`away_score` are a *cache*; the
public scoreboard trusts them, so every write path must run `recompute_score`. (Invariant #4.)

### 3.2 State machines + advancement

`apps/matches/services/state.py` owns the **only fully-realized state machine**:
`ALLOWED_TRANSITIONS` + guarded/audited `transition_match` (under `select_for_update`), matching
PRD §5.5. On reaching a terminal-with-result status (`COMPLETED`/`WALKOVER`), a
`transaction.on_commit` hook fires `_fire_advancement` →
`apps/fixtures/services/advance.py::advance_from_match`, which resolves **typed match-dependency
pointers** (`Match.home_source`/`away_source` JSONB) to fill the next slot. (Invariants #6, #9.)
**Gap:** the **Tournament** status enum exists (`TournamentStatus`: draft→published→
registration_open→scheduled→live→completed→archived) but has **no transition service/endpoint** —
status is never written after create in production. This is the single largest architecture-vs-code
gap (see §10 invariant table and the restructuring notes).

### 3.3 Multi-tenancy (hidden personal workspace)

`Organization` is the tenant root and a *hidden personal workspace* (decision #91): users see
tournaments, never "orgs". Every tenant-scoped row carries an `organization` FK
(`Tournament`, `Team`, `Player`, `Match`, `Lineup`, `MatchEvent`, `MatchIncident`, `Dispute`,
`Form*`, `MembershipModuleGrant`). Deliberately org-less: `Person`, `Sport` (platform metadata),
and audit/usage rows (which store `organization_id` as a *bare UUID*, no FK, so they survive org
deletion). Isolation is a **queryset funnel, not row-level security**:
`apps/tournaments/scope.py::accessible_tournaments(user)` (orgs where user is active org ADMIN ∪
tournaments with an active `TournamentMembership`) is the load-bearing seam ~6 apps route through.
**404-before-403 is invariant:** `_get_tournament_or_404` / `_match_or_404` raise `NotFound` for
inaccessible resources so existence never leaks; the verb gate (403) runs only after access is
confirmed. (Invariant #2.)

### 3.4 Two-layer RBAC

- **Layer 1 — module visibility (surfaces).** `apps/permissions/` owns a **23-row module catalog**
  (`fixtures/modules.json`, upserted by `load_modules`), per-(user, org, module) tri-state
  override grants (`MembershipModuleGrant`, keyed on `(user, org, module)` — the A.4 audit fix),
  and the resolver `services/resolver.py::effective_modules` = **role-union THEN overrides**, so a
  single `deny` beats any multi-role union; result is a `frozenset` cached 5 min. The `HasModule`
  DRF gate enforces it server-side. (Invariant #12.)
- **Layer 2 — the PRD §3.2 verb matrix (fine-grained actions).** There is **no central verb
  table**; it is enforced inline by role predicates, chiefly
  `apps/tournaments/permissions.py::can_manage_tournament` (ADMIN/CO_ORGANIZER tournament role OR
  active org ADMIN). Only 3 of 6 tournament roles currently gate behavior (ADMIN, CO_ORGANIZER,
  MATCH_SCORER); the other three are inert.

The two layers are intentionally distinct (CLAUDE.md #12). Note **DEFECT-J**: admin permission
endpoints gate on `IsOrgAdminOrOwner` (role), *not* `HasModule`, because co-organizers hold
`org.member_directory` by default and a module gate would over-grant the override matrix.

### 3.5 Data-driven rules & constraints (FET-style)

`Tournament.rules` (dict) + `.constraints` (list) are JSONB interpreted at runtime, never
hardcoded. `apps/tournaments/services/rules.py::DEFAULT_RULES` is both the football baseline **and
the whitelist**; `merge_rules(partial, base)` folds `defaults < stored < partial` and raises on
any unknown top-level/nested key (schema can't drift). Stored `rules` is only the manager's
*overrides* — **every reader must call `merge_rules` first** (`compute_standings` and
`_settings_payload` both do). `apps/matches/services/standings.py::compute_standings` reads
`rules["points"]` + `rules["tiebreakers"]`. Constraints are validated for *shape* only
(`apps/fixtures/services/constraints.py::validate_constraints`) and are otherwise **inert** — no
scheduler enforces them. (Invariants #7, #10.)

### 3.6 Forms branching engine (client/server parity)

`apps/forms` is a data-driven, branching, multi-section form engine mirroring the rules-JSONB
pattern: `Form.schema` (JSONB) defines sections + typed fields + visibility/goto branching;
`FormResponse.answers` holds a submission. **The same branching evaluator runs on both sides** and
they MUST agree op-for-op: `frontend/src/lib/formLogic.ts` (`isVisible`/`nextSectionKey`/
`reachableSections`) ↔ `backend/apps/forms/services/validation.py` (`_visible`/`_next_section`/
`validate_answers`). Server drops hidden/unreached answers (branch-bypass guard); `form_version`
pins responses against the schema they were submitted against; `team_registration` submissions are
mapped to domain entities via `services/mapping.py::map_response` → reused `register_school`. (See
§7.5; this hand-paired parity is the single highest correctness risk in the codebase.)

### 3.7 Append-only audit + idempotent writes

`apps/audit/services.py::emit_audit` is **the only sanctioned write path** for `AuditEvent`
(~30 cross-app callers), and `AuditEvent` is **append-only at the DB level** — a PL/pgSQL
`BEFORE UPDATE/DELETE` trigger (`migrations/0002_audit_append_only.py`) raises `ERRCODE 42501`
even for superusers; prod additionally connects as a non-owner role with UPDATE/DELETE revoked.
(Invariant #5.) **Idempotency** is universal: every mutation takes a client `event_id` UUID with a
unique constraint; replay returns the existing row (`MatchEvent.event_id`, `Dispute.event_id`,
`Notification.event_id`, `FormResponse(form,event_id)`, `AuditEvent.idempotency_key`). The audit
table doubles as the idempotency ledger for several services (signup, school_registered,
tournament_created, settings updates) — a powerful but coupling-heavy pattern. (Invariant #3.)

### 3.8 Live transport split (documented as SSE+WS; actually polling+WS-ping)

**Ground-truth correction:** CLAUDE.md #11 and several docstrings claim "SSE for one-way viewers +
notification bell; WebSockets for scorer rooms." **No SSE exists** anywhere (no `text/event-stream`,
`StreamingHttpResponse`, or `EventSource`). Reality:
- The only fan-out producer is `apps/matches/services/events.py::publish_match_event`, fired on
  `transaction.on_commit` (best-effort, exceptions swallowed), sending a **thin `{match_id,
  event_id}` ping** to channel group `match_<id>`.
- `apps/live/consumers.py::MatchConsumer` joins that group with **no auth/scope check** (one
  undifferentiated public room per match) and forwards the ping.
- **The frontend has no WS/SSE client at all** — `LiveViewerPage` and `MatchConsolePage` poll
  `GET /api/live/match/{id}/` every 5s; `NotificationBell` polls every 30s.

So the WS path is "notify-then-poll" with no React consumer; in practice the platform is
poll-driven. This is the single biggest doc/code divergence. (Invariant #11 is aspirational.)

---

## 4. Backend subsystem map

### 4.1 `accounts` — identity & auth (Phase 1A, production-grade)

Owns the custom **`User`** (`AUTH_USER_MODEL`; UUIDv7 PK, `email` canonical+lowercased, `is_active`
False until verification, soft-delete via `deleted_at`, `last_active_org_id` as a bare UUID).
Session/CSRF auth, no JWT. Full surface: Path B public self-signup (user+org+membership atomic +
idempotent via the `user_signup` audit row, `services/signup.py::perform_signup`), email
verification, login/logout, password reset, TOTP **2FA** with single-use argon2id recovery codes
(`services/twofa.py`), and super-admin soft-delete. Tokens hashed at rest (verify/reset = sha256;
recovery = argon2id; TOTP secret = Fernet keyed off `SECRET_KEY`). Two **independent lockouts**:
django-axes (password, 10/15min) vs a separate cache-backed 2FA counter (5/15min) — they must stay
separate so a correct password can't reset the 2nd-factor budget. Session key is cycled on every
auth-state change (`services/session_security.py::cycle_session_on_role_change`, after Django
`login()`). `MeSerializer` aggregates memberships + per-org `effective_modules` (the RBAC hydration
bridge). **Notable dead code:** B.18 `require_recent_password_reauth` is scaffolded but unwired
(sensitive verbs bypass it). `_hash_token` is triplicated.

### 4.2 `organizations` — the multi-tenancy boundary

Owns `Organization` (lifecycle pending_review→active→suspended/archived/orphaned, soft-delete),
**`OrganizationMembership`** (the RBAC linchpin read by ≥5 apps; multi-role per (user,org) and
multi-org admin per user are *intentional* per decision #91), `AdminInvitation` (org- and
tournament-scoped, hashed tokens, idempotent via audit key), `SlugRedirect` (slug history → 301s),
and the `ScopedQuerySetMixin`. Membership constraints: `unique_active_role_per_user_per_org`,
`one_owner_per_org` (partial unique — **IMMEDIATE, not the documented DEFERRABLE**; `transfer_
ownership` works around this by clearing-before-setting), `owner_flag_only_on_admin_role` (Check).
Self-serve `services/workspace.py::provision_personal_workspace` creates an **ACTIVE** org;
`services/lifecycle.py::create_organization` creates a **pending_review** org — two divergent
provisioning constructors. Slug logic is **triplicated** (slug.py, workspace.py, and a private copy
in `accounts/signup.py`). Tournament-scoped invites create only a `TournamentMembership`, never an
org-wide membership (isolation).

### 4.3 `permissions` + `audit` — Layer-1 RBAC + audit trail

See §3.4 and §3.7. `permissions` (app label **`permissions_app`** — renaming breaks migrations +
the `"permissions_app.module"` FK string): `Module` catalog (23 rows, `default_for_roles` JSON),
`MembershipModuleGrant` (module FK is PROTECT), `effective_modules` resolver (union-then-overrides,
frozenset, 5-min cache), `grants.py` (set/bulk/clear; reason ≥20 chars; emits one
`module_grant_changed` audit per changed module), `matrix.py::build_matrix` (recomputes
role-defaults independently of the resolver — a lockstep-duplication risk), `scope.py`
(ScopedQuerySet — largely unused by production models), `HasModule` (per-call class factory).
`audit`: `AuditEvent` (denormalized scope UUIDs, **no FKs**, three indexes, intentionally no
`Meta.ordering` — UUIDv7 PK gives stable cursors), `emit_audit` (idempotency-key dedupe, IP/UA from
request, inline create inside the caller's txn), cursor-paginated org feed gated by
`HasModule("org.audit_log")`. **Smell:** resolver cache invalidation is single-process only
(cross-worker Redis pub/sub is a documented TODO); event_type is a free string (~25+ values, no
enum/registry).

### 4.4 `tournaments` — the tenancy & authorization spine of 1B

Owns `Tournament` (org-scoped, status enum, slug/UUID identity, rules/constraints JSONB,
`inputs_hash`/`last_manual_edit_at`), `TournamentMembership` (6 roles, 3 statuses), and the **two
most depended-on primitives in the platform**: `scope.py::accessible_tournaments` (visibility) and
`permissions.py::can_manage_tournament` (mutation gate). Self-serve `services/create.py::
create_tournament` (atomic, provisions workspace, creator-as-ADMIN, idempotent). Data-driven rules
service (`services/rules.py`: `DEFAULT_RULES`/`merge_rules`/`can_edit_rules`/`freeze_rules`/
`update_settings`). `urls.py` is a **cross-app router** — it aggregates routes owned by fixtures,
teams, forms, matches, disputes under `<tournament_id>`. **Largest gaps:** no Tournament state
machine (status never transitions in prod; `freeze_rules` is dead), 3 of 6 roles inert, the 6-role
enum is **triplicated** (tournaments / organizations / audit).

### 4.5 `teams` — Person / Player / registration (deliberate MVP)

Owns the entrant layer: **`Person`** (platform identity, NO org FK — the invariant #8 exception),
`Player` (per-tournament registration referencing a Person; `person` FK is PROTECT so stats never
orphan; `unique_person_per_tournament`), `Team` (org+tournament-scoped, status defaults
`REGISTERED`), and the public self-registration channel (`RegistrationLink` + AllowAny
`/api/register/{token}/`). The domain heart is `services/registration.py::register_school` — atomic,
idempotent on `(event_id, "school_registered")`, the **single write path** shared by the public
endpoint AND the forms-mapping path. **It is a thin MVP of `v1Teams.md`:** soft-delete is a column
never written, the `TeamStatus` state machine is vestigial (only `REGISTERED` ever set),
`register_school` always creates a *new* Person (no de-dup), and TeamMembership/team-manager authz/
eligibility/DOB-encryption/REST CRUD are absent.

### 4.6 `forms` — the data-driven forms engine

See §3.6 and §7.5. Owns `Form` (schema JSONB, status, version for response-pinning, settings.bindings
for mapping), `FormShareLink` (hashed tokens), `FormResponse` (cleaned answers, `form_version`
snapshot, promoted indexed columns, `event_id` idempotency), `FormFileUpload` (claimed on submit).
Services: `schema.py` (structural validation at the boundary), `fields.py` (`_HANDLERS` per-type
coerce/validate registry — "add a type = add a handler"), `validation.py` (branching-aware answer
walk), `forms.py` (lifecycle + destructive-edit version bump), `links.py`, `responses.py`
(idempotent atomic submit), `mapping.py` (`team_registration` → `register_school` with a
**distinct uuid5 audit key** so it doesn't collide with the submit audit). **Smell:** `map_response`
runs synchronously in the public request path (no on_commit/queue boundary), `max_responses` is
never enforced, group fields stored unvalidated.

### 4.7 `fixtures` — generation + advancement (thin service layer, no models)

Turns registered teams into `Match` rows. `services/generate.py`: `generate_round_robin` (circle
method, grouped, sets `team.pool`, per-group `inputs_hash`), `generate_single_elimination`
(power-of-2, `team`/`winner_of` typed pointers), `generate_knockout_from_groups` (top-N per group
via `compute_standings`, cross-seeded). `services/advance.py::advance_from_match` resolves
`winner_of`/`loser_of` pointers (the post-commit hook from matches). `services/constraints.py`:
catalog + shape-only validation. The one HTTP endpoint
(`POST /api/tournaments/<id>/generate-fixtures/`) is routed from `tournaments/urls.py`. **Smells:**
generation idempotency is presence-based not hash-based (edit-then-regenerate is a silent no-op);
`last_manual_edit_at` doesn't exist on `Match` (invariant #10 half-implemented); pointer types
`group_position`/`tbd` are documented but never produced/consumed; `loser_of` resolved but never
generated; `advance_from_match` is an O(matches) full scan.

### 4.8 `matches` — event-sourced scoring (the domain unit that gets scored)

See §3.1/§3.2. Owns `Match` (typed source pointers, cached score, derived `winner_id`/`loser_id`),
the append-only `MatchEvent` log, `Lineup`/`LineupEntry` (freeze once not SCHEDULED, full-replace),
`MatchIncident` (append-only). Services: `events.py` (the event-sourcing core), `scoring.py`
(`record_score` aggregate path + `assign_scorer`), `state.py` (state machine + advancement),
`lineups.py`, `incidents.py`, `standings.py` (rules-driven). `_can_score` =
`can_manage_tournament` OR assigned scorer OR active MATCH_SCORER. **Biggest correctness seam:
TWO divergent score paths** — `record_score` sets score+COMPLETED directly (no events) vs the event
path's `recompute_score` — with no reconciliation. Also: `void_match_event` is unguarded and has
**no API endpoint** (VOID corrections unreachable via HTTP), replay returns 201 not 200 for
events/incidents, WALKOVER excluded from standings but counts for advancement.

### 4.9 `live` + `notifications` + `disputes` — delivery/workflow

- **`live`** (no models): public snapshot view (`LiveMatchSnapshotView`, AllowAny — drops VOID +
  voided events, hides rosters unless live/half_time/completed) + `MatchConsumer` (the WS ping
  forwarder; no auth). See §3.8.
- **`notifications`**: durable per-user `Notification` (no org FK; `event_id` unique),
  `services/dispatch.py::create_notification` (idempotent; the single entry point all callers
  lazy-import; `_publish` is a no-op stub). Bell polls 30s.
- **`disputes`**: org+tournament+match-scoped `Dispute` with a real audited state machine
  (`ALLOWED_TRANSITIONS`: open→{under_review,resolved,rejected,withdrawn}, under_review→{resolved,
  rejected}; resolve/reject need ≥5-char resolution). List/raise routed from `tournaments/urls.py`;
  transitions from `disputes/urls.py` (near-circular coupling). Score-dispute → re-advancement
  cascade is unbuilt (disputes are advisory-only).

### 4.10 `sadmin` + `sports` — admin console & catalog

- **`sadmin`** (Django+Tailwind-CDN+HTMX at `/sadmin/`): `superadmin_required` gate (non-SA → 404,
  surface-hide), `SadminIPAllowlistMiddleware` (B.15), 13 audited verbs
  (`services/superadmin_verbs.py` — each `@atomic` + one inline `emit_audit`), feedback inbox with
  B.11 PII redaction at INSERT, live KPI dashboard (`compute_metrics_live` is the single KPI source
  of truth), public feedback API. Owns `Feedback`/`UsageEvent`/`KPISnapshot` + the platform-wide
  `emit_usage` telemetry. **Smells:** impersonation is **banner-only** (no `request.user` swap),
  `SADMIN_HOST` is dead config, feedback idempotency is recovered *through* the audit table,
  `_delete_sessions_for_user` is an O(all-sessions) scan.
- **`sports`**: read-only, platform-level (not org-scoped) catalog of 59 planned sports;
  `code` slug doubles as the future plugin app suffix; `load_sports` idempotent upsert. Phase-1B
  prep — per-sport plugin apps arrive later via `python_module_path`.

### 4.11 `project config` — settings / ASGI / deploy

See §2. Owns no domain logic but encodes nearly every cross-cutting infra invariant
(`ATOMIC_REQUESTS`, UTC, append-only-via-DB-role, throttle budgets, ASGI bootstrap order, the WS
origin-validator stack, session-auth-only). The root URL map (`fixture/urls.py`) hand-builds
`api_v1` (12 app includes + AIP-136 colon-verb invitation routes + feedback) and is part of the
SPA + schema.yml contract.

---

## 5. Frontend area map

### 5.1 Core (routing / shell / state / api) — `features/layout`, `features/auth`, `api/`, `lib/`

The SPA spine: provider tree + route table (`App.tsx`; order is load-bearing — ErrorBoundary inside
Toast, outside Router), the auth gate (`ProtectedRoute.tsx` — redirect ladder: not-bootstrapped →
spinner; requires2FA → /2fa/challenge; no user → /login?next=; zero-membership non-superuser →
/orgs unless in `ORG_OPTIONAL_PATHS`), the authenticated `AppShell` (Sidebar + topbar + drawer +
context recovery via `useMatch`), the Zustand `authStore` (bootstrap must *always* set
`bootstrapped:true` or the gate hangs; `pendingCredentials` held in module scope, never in store),
the global 401 event bus (`api/queryClient.ts` → `App.tsx::AuthBusBridge`), and `apiFetch` (the
single transport choke point: `credentials:'include'` + `X-CSRFToken` on unsafe verbs). Highest
blast-radius modules by importer count: `lib/t` (72), `lib/routes` (39), `lib/tailwind` `cn` (37),
`authStore` (24), `api/client` (17).

### 5.2 Tournaments / teams / matches / live — `features/tournaments|matches|live|registration`

The operator + public 1B surface. `TournamentDetailPage` is the center of gravity (KPIs, onboarding
state machine, link minting, fixture generation buttons, inline `ScoreRow`, standings, mounted
`DisputesPanel`). `MatchConsolePage` (scorer console — `STATE_ACTIONS` mirrors backend transitions;
event palette posts `recordEvent`) and `LiveViewerPage` (public scoreboard) both **poll 5s**.
`BracketView`/`KnockoutTree` is pure-CSS connector geometry (assumes clean power-of-2 brackets) and
contains a **client-side `computeStandings` that hardcodes 3/1/0** — diverging from the data-driven
server standings. Public surfaces (`/m/:matchId`, `/register/:token`) render outside AppShell/auth.
No `api/matches.ts`; match calls split between `tournaments.ts` (`score`) and `live.ts`
(events/transition/export).

### 5.3 Forms — `features/forms`, `lib/formLogic.ts`

Builder (Zustand `builderStore`, debounced autosave, `FormCanvas`/`FieldEditor`/`FieldPalette`),
public wizard (`PublicFormPage`, branching via `formLogic.ts`), responses dashboard (optimistic
status workflow, CSV export, Stage-2 link minting). The parity-critical module is `lib/formLogic.ts`
(must match backend `validation.py`). **Smells:** three near-duplicate wizard renderers
(`FormPreview`/`FormPreviewDialog`/`PublicFormPage`), type-label/CHOICE_TYPES maps duplicated 3-4×,
`group` field is a stub, `types.ts` is hand-mirrored (drift risk).

### 5.4 Orgs / permissions / roles / invitations / notifications / theme — `features/orgs|permissions|roles|invitations|notifications|theme`

The Phase-1A account-chassis UI: org+role switcher (URL `:orgSlug` is source of truth;
`OrgSwitcherStore` is a read-only mirror), org admin surfaces (settings/branding-stub/member
directory/audit), the module-RBAC override matrix (`ModuleMatrixPage` + `GrantCell` tri-state;
PUT replaces the full per-user cell map), the full membership lifecycle (two parallel invitation
flows — org-side token/`/accept` vs invitee-side colon-verb `/invites`), role landing pages +
`pickLandingPathForUser`, and chrome (NotificationBell, ThemeToggle). **Smells:** `dashboardCards.ts`
and `roleRoutes` are orphaned dead code; admin/canEdit gating logic is copy-pasted across 5 pages
with subtly different rules; `newEventId`/`shareLinkFor`/clipboard/relative-time duplicated.

### 5.5 Design system + shared types — `components/ui`, `index.css`, `tailwind.config.js`, `types/`

Token system (light/dark HSL CSS vars → semantic Tailwind colors; `.dark` class-driven), component
primitives (`Button`/`Input`/`Select` custom listbox/`Dialog`/toast/`Card`/`PasswordInput` +
`Avatar`/`RoleBadge`), and the shared type layer (`api.generated.ts` from openapi-typescript — the
anti-drift contract; never hand-edit). Tokens-only color, no native `<select>`/`alert`, `t()` on
every string, WCAG AA. Hub coupling: `ui/button` (~39 files), `useToast`/`ui/Select` (~16),
`ui/dialog` (~11) — treat as **API-frozen during restructuring**. Known violations: one native
`<select>` survives in `OrgSettingsPage`; emerald hardcodes in `OrgBrandingPage`/`InviteAcceptPage`/
`OrgChooserPage`; `CreateTournamentPage`/`BracketPage` use forbidden `mx-auto max-w-*`.

---

## 6. The seven end-to-end flows

Cross-referenced; full traces in `docs/superpowers/analysis/flow-*.md`.

### 6.1 Auth lifecycle (`flow-auth.md`)
Signup Path B (`accounts.views::signup` → `perform_signup`: atomic User+Org+Membership+verification
token+audit; enumeration-safe; idempotent on the audit row) **or** Path A invite-accept
(`organizations.views::InvitationAcceptView` → `accept_invitation`; email from the signed invite,
never the body; never resets a password) → email verification → login (`login_view`: axes →
unverified-gate → 2FA gate → `login()` then `cycle_session_on_role_change` then audit) → logout
(audit *before* `logout()`) → password reset (cache rate-limits, silent no-op for unknown user,
invalidates all sessions). Frontend: `main.tsx` bootstrap → `ProtectedRoute` ladder; 2FA is folded
into `/login/` (no challenge endpoint, credentials held client-side in module scope); global 401 →
bus → `/login`. **Crosses:** accounts, organizations, audit, Django auth/session/axes, SPA auth.

### 6.2 RBAC resolution (`flow-rbac.md`)
`modules.json` → `Module` rows → `effective_modules(user, org)` (role-union THEN overrides; deny
wins; frozenset cached 5min) → server enforcement (`HasModule` / `IsOrgAdminOrOwner` / inline
`can_manage_tournament`) + scope (`accessible_tournaments`, 404-before-403) → client hydration via
`MeSerializer` → nav/card gating (`computeNavItems`/`dashboardCards`). Server is authoritative;
client gating is convenience. **Crosses:** permissions, organizations, tournaments, accounts (/me),
audit, frontend layout/orgs/permissions.

### 6.3 Tournament lifecycle (`flow-tournament.md`)
Create + auto-provision workspace (`create_tournament`, gated on `email_verified_at`) → **status
machine is declared but undriven** → rules + freeze gate (`update_settings`; freeze enforced by
`status in {DRAFT,PUBLISHED}` since `freeze_rules` is never called) → registration (two channels →
`register_school`) → fixture generation (`GenerateFixturesView` dispatch) → scoring → standings →
advancement (on_commit). **Crosses:** tournaments, organizations, audit, teams, forms, fixtures,
matches, live, permissions, + the React tournament/registration/forms/matches features.

### 6.4 Event-sourcing + live delivery (`flow-event-live.md`)
Scorer console mints `event_id` → `POST /events/` → `record_match_event` (idempotency short-circuit
→ lock → gapless `Max+1` → append immutable event → `recompute_score` → audit → on_commit
`publish_match_event`) → channel group `match_<id>` → `MatchConsumer` ping → **but no React WS
client; clients poll the snapshot 5s.** `record_score` and `transition_match` share the on_commit
discipline (advancement) but do **not** publish to the room. **Crosses:** frontend matches/live,
matches domain, live transport + ASGI + channel layer, audit, tenancy/RBAC, fixtures advancement.

### 6.5 Forms data-driven engine (`flow-forms.md`)
Build (Zustand store, debounced autosave) → persist + `validate_schema` → publish → public GET
(`is_open` / `resolve_share_link`) → render as paged wizard with **client branching**
(`reachableSections`) → submit → **server branching re-eval** (`validate_answers`, identical
traversal; drops hidden answers) → promote + atomic create + claim uploads + counters + audit →
`map_response` → `register_school` → review/CSV/stage-2. **Central contract:** `formLogic.ts` ↔
`validation.py` parity. **Crosses:** frontend forms + `lib/formLogic`, forms app, teams
(register_school), audit, tournaments (scope/permissions), permissions (forms module).

### 6.6 Data model / ERD / multi-tenancy (`flow-data-model.md`)
UUIDv7 PK convention (single `uuid7` helper) → `Organization` tenant root → `organization` FK
fan-out → cross-org read isolation (`accessible_tournaments`, 404-no-leak) → object-level isolation
(`_match_or_404` re-checks via tournament) → write authz (`can_manage_tournament`) → JSONB columns →
event-sourced gapless writes → state + advancement (on_commit) → append-only audit (DB trigger) →
idempotency/scoped-unique constraints. **Crosses:** all persistence-owning apps + the frontend's
server-resolved tenancy assumption (client never sends an org id on writes).

### 6.7 Rules & constraints engine (`flow-rules-engine.md`)
`DEFAULT_RULES` whitelist → `merge_rules` (resolved-on-read) → GET settings (`_settings_payload`
returns merged rules + `can_edit`) → PATCH settings (`update_settings`: idempotent, freeze gate →
409, amend needs reason, stamps `last_manual_edit_at`) → freeze semantics (status-based;
`rules_frozen_at` never set in prod) → constraint catalog + shape validation → standings reads
`points`/`tiebreakers` → generator **ignores rules** (reads request body) → frontend renders
standings only (no Settings UI). **Crosses:** tournaments, matches (standings), fixtures, audit,
React (standings render only).

---

## 7. Data model / ERD overview & tenancy boundary

**~32 models across 11 model-owning apps.** Every model defaults a UUIDv7 PK via the single
`apps/accounts/models.py::uuid7` helper; no auto-increment; UUIDv7 time-ordering gives natural
`created_at + PK` ordering (relied on by `AuditEvent` and `order_by("-id")`).

### 7.1 ERD in prose
`User` 1—* `OrganizationMembership` *—1 **`Organization`** 1—* `Tournament` 1—* {`Team`, `Match`,
`Form`, `Dispute`, `RegistrationLink`}. `Team` 1—* `Player` *—1 **`Person`** (platform-global, no
org). `Match` references `home_team`/`away_team` (`Team`, SET_NULL) + `home_source`/`away_source`
(JSONB pointers to other Matches); `Match` 1—* `MatchEvent` (event log) + 1—* `Lineup` 1—*
`LineupEntry` + 1—* `MatchIncident`. `Tournament` *—1 `Sport` (PROTECT). `User` *—* `Tournament`
via `TournamentMembership`. `Form` 1—* {`FormResponse`, `FormShareLink`, `FormFileUpload`}.
`MembershipModuleGrant` keys (user, org, module). `AuditEvent` / `UsageEvent` are leaves with
bare-UUID scope columns (no FK in).

### 7.2 Tenancy boundary
The `organization` FK is present on every tenant-scoped row and **must match its tournament's
org** — *service-enforced, not DB-enforced* (no composite FK/CHECK ties `child.organization_id` to
`tournament.organization_id`; the denormalized FK on deep rows like `MatchEvent` is *populated* by
the service copying `locked.organization_id`, not derived). Org-less by design: `Person`, `Sport`,
`Module`, and audit/usage rows (bare UUID so they survive deletion). The frontend never sends an
org id on writes; tenancy is server-resolved from the session.

### 7.3 FK on_delete semantics
- **CASCADE** for ownership edges (org→tournament→{team,player,match,event,form,…}; Match→
  {Lineup,LineupEntry,MatchEvent,MatchIncident}). App prefers soft-delete; a hard org delete still
  cascades and bypasses soft-delete invariants.
- **PROTECT** where deletion must be blocked: `Tournament.sport`, `Player.person`,
  `MembershipModuleGrant.module`.
- **SET_NULL** to preserve history: all `created_by`/`reported_by`/`scorer`/`assigned_by`,
  `Match.home_team`/`away_team`, `MatchEvent.team`/`player`, `Dispute.match`, `AuditEvent.actor_user`
  (with `deleted_user_handle` snapshot). `MatchEvent.voids = FK(self, SET_NULL)`.

### 7.4 Scoped uniqueness constraints (load-bearing)
`unique_tournament_slug_per_org`, `unique_team_slug_per_tournament`, `unique_team_name_per_tournament`,
`unique_person_per_tournament`, `unique_jersey_per_team`, `unique_captain_per_team`,
`unique_event_seq_per_match`, `unique_active_role_per_user_per_org`, `unique_active_tournament_role`,
`one_owner_per_org`, `unique_grant_per_user_org_module`, `unique_form_slug_per_tournament`,
`unique_form_response_event_id`, `unique_pending_invite_per_email_per_org_tournament`. Most use
partial `condition=Q(deleted_at__isnull=True)` / `Q(status="active")` so soft-deleted/inactive rows
don't block re-use. **Note:** `one_owner_per_org` is IMMEDIATE despite docstrings claiming
DEFERRABLE (no such migration exists).

### 7.5 The two parity contracts that MUST stay in sync
1. **Forms branching:** `frontend/src/lib/formLogic.ts` ↔ `backend/apps/forms/services/validation.py`
   (seven ops; resolution order option.goto → section.next → document order → `_end`; first
   goto-bearing single_choice/dropdown wins; empty = `None/""/[]/{}`; cycle guard). Drift → spurious
   unfixable 400s. Guarded only by parallel tests, no shared fixture.
2. **Live snapshot + state vocab:** `LiveSnapshot` (`api/live.ts`) ↔ `LiveMatchSnapshotView`;
   `STATE_ACTIONS`/`EVENT_BUTTONS` (`MatchConsolePage`) ↔ `ALLOWED_TRANSITIONS`/`MatchEventType`.

---

## 8. JSONB / data-driven columns (interpret-at-runtime, never schema-migrated)
`Tournament.rules` + `.constraints`; `Match.home_source`/`away_source` (typed pointers);
`MatchEvent.detail`; `Form.schema`; `FormResponse.answers`; `Form.settings.bindings`;
`FormShareLink.bound_entity`/`prefill`; `Module.default_for_roles`; `AuditEvent.payload_before`/
`payload_after`; `UsageEvent.payload`; `KPISnapshot.metrics`.

---

## 9. Idempotency, transactions & ordering (load-bearing semantics)
- `DATABASES["default"]["ATOMIC_REQUESTS"]=True` — every request is one transaction; on_commit
  fan-out + idempotent replay depend on it.
- Gapless sequence: `select_for_update` + `Max+1` *inside* the atomic block; `unique_event_seq_per_match`
  is the backstop. Never move `Max+1` out of the lock.
- Publish/advancement fire only on `transaction.on_commit` (best-effort, swallow exceptions; never
  roll back the write). A process death between commit and on_commit silently drops the hook (no
  outbox).
- Audit shares the verb's transaction (inline `emit_audit`), so audit + state change commit atomically.
- Ordering rules: Django `login()` *then* session-cycle; `emit_audit("user_logout")` *then*
  `logout()`; invite session-cycle *after* commit; `transfer_ownership` clears outgoing owner
  *before* setting incoming.

---

## 10. Architectural invariants that MUST be preserved

These are the platform's non-negotiables (CLAUDE.md + per-subsystem). Status flags where the code
diverges from the documented invariant.

| # | Invariant | Status in code |
|---|---|---|
| 1 | **UUIDv7 PKs everywhere** via single `accounts.models.uuid7`; no auto-increment; public URLs = `(slug, UUID)` | Honored |
| 2 | **Multi-tenancy by `Organization`**; every tenant row has an `organization` FK; cross-org access → **404 (no existence leak)** via `accessible_tournaments` + `can_manage_tournament` | Honored (service-enforced, not DB-enforced) |
| 3 | **Idempotent writes**: client `event_id` UUID + unique constraint; replay returns existing row | Honored; replay returns **201 not 200** for matches events/incidents (minor violation) |
| 4 | **DB-first event log**: `MatchEvent` is the system of record; score derived by `recompute_score`; publish only on `transaction.on_commit` | Honored |
| 5 | **Append-only audit at DB level**: UPDATE/DELETE on `AuditEvent` blocked by PL/pgSQL trigger (ERRCODE 42501) even for superuser; sole write path `emit_audit` | Honored |
| 6 | **State machines, not booleans**: Tournament + Match status are guarded, audited enums | Match: honored. **Tournament: declared but NOT driven (no transition service/endpoint)** |
| 7 | **Rule freeze at boundary**: rules mutable in draft/published, frozen at registration_open (amend = reason + 24h grace + notify); match rules frozen once live | Partial: enforced by status check; `freeze_rules`/`rules_frozen_at` never fire; grace+notify unimplemented; match-rule-freeze-once-live absent |
| 8 | **Person ↔ Player split**: `Person` platform identity (no org FK); `Player` per-tournament; PROTECT on `person`; `unique_person_per_tournament` | Honored (but `register_school` never de-dups Person) |
| 9 | **Match dependencies as typed pointers** (`home_source`/`away_source`), not inferred; advancement is an on_commit hook | Honored for `team`/`winner_of`; `loser_of`/`group_position`/`tbd` documented but not produced; bracket UI infers shape from geometry |
| 10 | **Auto-generate; manual edit allowed; conflict warnings** via `inputs_hash` + `last_manual_edit_at` | Partial: `Match.last_manual_edit_at` absent; `inputs_hash` only set by round-robin; regenerate/keep/diff UX unbuilt |
| 11 | **SSE one-way viewers + bell; WebSockets two-way scorer rooms** | **Not realized**: no SSE; one undifferentiated public WS room (no auth); frontend polls (5s/30s), no WS/SSE client |
| 12 | **Module RBAC + verb matrix both canonical**; deny beats union; grants keyed (user,org,module) | Module layer honored; **verb matrix not data-driven** (inline `can_manage_tournament`; 3/6 roles inert) |
| 13 | **i18n + a11y from day 1**: every string via `t()`; WCAG AA | Largely honored; a few token/native-`<select>`/centered-column violations |
| 14 | **UTC storage** (`USE_TZ=True`); render in tournament/viewer TZ; TZ change blocked once scheduled | UTC storage honored; **TZ-change-blocked-once-scheduled not enforced** (no tournament state machine) |
| 15 | **Session auth (no JWT)**, same-origin SPA, DRF + cookies + CSRF custom header | Honored |

### Subsystem-level invariants that also must hold
- **accounts:** email canonical+lowercased; tokens hashed at rest (sha256/argon2id/Fernet);
  `is_active` is the verification gate; session cycled on every auth-state change; enumeration
  safety (duplicate-signup 201, resend 202, reset 200); two independent lockouts (axes vs 2FA).
- **organizations:** exactly one active owner per org + owner⇒admin; multi-role/multi-org-admin
  intentional (don't reinstate `single_org_per_admin_user`); slug uniqueness spans
  `Organization.slug ∪ SlugRedirect.old_slug`; tournament-scoped invites create only
  `TournamentMembership`; invite email read from the signed invite, never the body.
- **permissions/audit:** resolution = union-then-overrides (deny wins); grants keyed (user,org,module);
  reason ≥20 chars; app label `permissions_app`; 23 modules; module FK PROTECT; `effective_modules`
  is a cached frozenset; `AuditEvent` has no `Meta.ordering` by design.
- **tournaments:** 404-not-403 on inaccessible; manage gate = ADMIN/CO_ORGANIZER or active org
  ADMIN; whitelist rule merge; last-admin guard; creator becomes ADMIN/ACTIVE atomically.
- **teams:** `register_school` is one atomic, idempotent-on-`(event_id,"school_registered")` write
  path; `Team(status=REGISTERED)` is exactly what fixtures selects; uniform 404 from
  `resolve_registration_link`.
- **forms:** client/server branching parity; hidden answers dropped server-side; triple-distinct
  idempotency keys (submit / submit-audit / register_school uuid5); `form_version` pinning.
- **matches:** gapless sequence under lock; score derived; VOID corrections append-only; lineups
  freeze once not SCHEDULED; advancement post-commit; `winner_id`/`loser_id` None on draw/non-terminal.
- **live/disputes/notifications:** publish-after-commit best-effort; per-user notification isolation;
  dispute state machine + ≥5-char resolution; public snapshot minimization.
- **sadmin:** non-SA → 404 surface-hide; one audit row per verb (inline, never double-emit); PII
  redaction at INSERT; B.21 alarms log-only.
- **project config:** `ATOMIC_REQUESTS`; UTC; session-auth-only + CSRF; append-only-via-DB-role;
  ASGI bootstrap order; WS `AllowedHostsOriginValidator → AuthMiddlewareStack → URLRouter`;
  Redis mandatory in multi-worker prod.

---

## 11. Where the documented architecture and the code diverge (read before trusting CLAUDE.md)
1. **No SSE; live is poll-driven** (invariant #11). The WS room exists, has no auth, and has no
   React consumer.
2. **No Tournament state machine** (invariant #6/#7/#14): status never transitions in prod;
   `freeze_rules` is dead; TZ-lock-once-scheduled unenforced.
3. **Two divergent score paths** in matches that can disagree; no reconciliation; `record_score`
   has no amend verb; `void_match_event` has no endpoint.
4. **Generator ignores `Tournament.rules`** (reads request body); set `format:knockout` in settings
   then generate with defaults → round-robin.
5. **Constraints are inert** — validated for shape, never enforced by any scheduler.
6. **The "frozen" banner must key on the server `can_edit` flag, not `rules_frozen_at`** (which is
   always null in prod).
7. **One native `<select>` + emerald hardcodes + centered-column violations** survive on the
   frontend despite the design-system rules.
8. **`SADMIN_HOST` is dead config; impersonation is banner-only** (no `request.user` swap).
