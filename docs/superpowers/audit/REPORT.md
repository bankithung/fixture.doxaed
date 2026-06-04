# Phase 1A Readiness + Phase 1B Gap Audit -- Final Consolidated Report

> Re-synthesized 2026-06-04 (FINAL). This supersedes the interim REPORT. It folds in
> the adversarial **Verify** phase (`_verify-results.json`) and six **deep-dive** passes
> (`deepdive-*.md`). Every Critical/High lead from the interim pass is now marked
> **CONFIRMED / refuted / unverified**. Findings cite `file:line` with quoted evidence
> in the underlying analysis files. Confidence is high unless noted.
>
> **Source corpus:** 138 phase-1 analysis files (14 maps + 98 area x lens audits + 26
> cross-cutting) -> `_phase-audit.json` aggregate -> `_verify-results.json` (42 confirmed,
> 7 refuted, 0 unsure) -> 6 deep-dives (tenant-isolation, sadmin-console, auth/session/2FA,
> audit-immutability, rbac-resolver, idempotency-concurrency).

## Per-domain design index (Phase 1B)

`docs/superpowers/specs/`: **v1Tournaments.md** | **v1Teams.md** | **v1Matches.md** |
**v1Live.md** | **v1Notifications.md** | **v1Disputes.md** | **v1Fixtures.md** (data-driven
constraint engine) | **v1Users.md** (locked RBAC) | PRD.
`docs/superpowers/audit/`: **design-selfserve-flow.md** (org-as-hidden-workspace +
TournamentMembership) | **design-uiux-overhaul.md** (shadcn/lucide/framer-motion overhaul).

---

## Verdict

The Phase 1A chassis is **structurally sound and functionally complete for what it
covers** -- backend boots and migrates clean, **350 backend + 162 frontend tests pass**,
frontend builds. Core architecture is genuinely strong: UUIDv7 PKs, trigger-enforced
append-only audit, a **correct and regression-tested** default-deny 22-module RBAC resolver
(the union math and `(user,org)` grant keying are sound), and pure session+CSRF / no-JWT.

**But it is NOT production-ready, and the deep-dives moved several items from "lead" to
"confirmed cluster."** Headline confirmed blockers: **no `prod.py` exists** (every
entrypoint hardcodes `dev`->`DEBUG=True`); a **real super-admin password sits in plaintext
`backend/.env`** (and `frontend/e2e/fixtures.ts`); the app **connects to Postgres as the
`postgres` superuser**, which the audit-immutability deep-dive proves makes the append-only
guarantee **effectively void** (6+ superuser bypasses + `TRUNCATE` + no `REVOKE`); the **2FA
second factor has no rate limit** (brute-forceable, ~p=0.26/day TOTP hit at 60/min); and
**cross-org isolation is verified by exactly one endpoint's test** despite CLAUDE.md making
isolation tests non-optional.

**Risk: MEDIUM-HIGH.** Safe to build Phase 1B on (substrate is healthy); unsafe to deploy
until the confirmed Critical/High config, auth, audit-role, and isolation items close.

---

## Verification scorecard

Of the interim Critical/High leads: **42 CONFIRMED, 7 refuted, 0 left unverified by the
Verify pass.** The deep-dives then **added** materially worse framings of four already-known
items (audit immutability, 2FA brute-force, ownership "DEFERRABLE" lie, admin-omnipotence
escalation chain) plus **new** findings (TRUNCATE wipe, recovery-code double-spend, fail-open
permission base reachable via non-existent org UUID, uncapped admin-minting invite tree).

### CRITICAL -- all CONFIRMED

| Finding | file:line | Status |
|---|---|---|
| Plaintext super-admin password committed | `backend/.env:7` (+ `frontend/e2e/fixtures.ts:13-22`) | **CONFIRMED** |
| No `prod.py`; every entrypoint hardcodes `dev`->DEBUG=True | `backend/fixture/settings/` | **CONFIRMED** |
| `effective_modules` early-return default `True` lets non-User objects bypass guard | `apps/permissions/services/resolver.py:113` | **CONFIRMED** (deep-dive N5: bug 0.95, currently reachable ~0.4 -> live latent fail-open) |
| `acceptInvitation` response lacks `org_slug`; redirect -> `undefined` | `frontend/src/api/orgs.ts:83` | **CONFIRMED** |
| Grant-matrix PUT never sends `reason` -> guaranteed 400 on every real save | `frontend/src/api/permissions.ts:32` | **CONFIRMED** |

### HIGH -- verification + deep-dive status (deduped)

**Security / auth (CONFIRMED)**
- `@csrf_exempt` on two authenticated sadmin mutations -- `apps/sadmin/views/superadmin.py:47,97`. **CONFIRMED** (sadmin deep-dive F1; cookie-auth + JSON != CSRF-safe; no compensating Origin/header check).
- Open redirect via login `?next=` (no `url_has_allowed_host_and_scheme` anywhere) -- `apps/sadmin/views/auth.py:51`. **CONFIRMED** (sadmin F3).
- ORM-filter / kwargs injection via `target_filter` in bulk-email -- `apps/sadmin/services/superadmin_verbs.py:409-411`. **CONFIRMED** (sadmin F5; count-oracle today, recipient-selection trap in 1B).
- Spoofable `X-Forwarded-For` (no `SECURE_PROXY_SSL_HEADER`/`NUM_PROXIES`) -- `apps/accounts/services/password_reset.py:41`, `apps/sadmin/middleware.py:22`, `apps/audit/services.py:54`. **CONFIRMED** (auth F3, sadmin F2: sadmin IP-allowlist trivially bypassed; per-IP reset limit defeated; forged audit IP).
- Weak TOTP key (single SHA-256 of `SECRET_KEY` as Fernet key; plaintext fallback) -- `apps/accounts/services/_crypto.py:35`. **CONFIRMED**.
- **NEW (deep-dive, CRITICAL-grade) -- 2FA/recovery brute force: no rate limit on the second factor.** `AXES_RESET_ON_SUCCESS=True` zeroes the counter on every correct password; the 2FA branch never touches axes; login carries only `60/min` AnonRateThrottle -- `apps/accounts/views.py:225-241`, `services/twofa.py:111-247`, `settings/base.py:160-183`. (auth F1)
- **NEW -- recovery-code double-spend race:** `_verify_recovery` lacks `select_for_update`; two concurrent logins consume one code twice -- `apps/accounts/services/twofa.py:197-214`. **CONFIRMED** (auth/idempotency; `confirm_totp` does lock the device, proving the omission is an oversight).
- Race: signup duplicate-email guard + create not in one atomic block -> IntegrityError -> 500 (not enumeration-safe 201) -- `apps/accounts/services/signup.py:242`. **CONFIRMED**.
- `/api/accounts/me/` returns 403 not 401 when unauthenticated -- `apps/accounts/views.py:416`. **CONFIRMED**.
- B.18 sensitive-verb re-auth is **dead code** (decorator applied to zero views): `twofa_disable`, `recovery_regenerate`, `user_soft_delete`, all sadmin destructive verbs unguarded -- `apps/accounts/decorators.py:23`, sadmin verbs. **CONFIRMED** (auth F2, sadmin F4; `SENSITIVE_REAUTH_WINDOW_MINUTES` constant exists but is referenced nowhere).

**Tenant isolation (CONFIRMED)**
- Grant IDOR: admin can write/read module grants for any platform user **not in their org**; `_apply_overrides` adds modules with no membership requirement -> privilege-grant-to-outsider, defeats default-deny -- `apps/permissions/views.py:161-165` + `resolver.py:98-100`. **CONFIRMED** (tenant deep-dive FINDING 1, the single material isolation gap; all other Group-A endpoints are correctly org-scoped).
- `last_active_org_id` writable via PATCH `/me/` without membership validation -- `apps/accounts/serializers.py:117`. **CONFIRMED**.
- No cross-org isolation tests for `organizations` or `permissions` endpoints (only `audit` has one) -- `apps/permissions/tests/test_matrix.py`, `apps/organizations/tests/`. **CONFIRMED**.
- `OrgDetailView` PATCH bypasses `org.settings` module (module-deny override on it has no effect) -- `apps/organizations/views.py:198`. **CONFIRMED**.
- UUID-routed members endpoint returns wrong serializer shape vs slug route -- `apps/organizations/views.py:356`. **CONFIRMED**.

**RBAC (CONFIRMED + deep-dive escalations)**
- Resolver fail-open default `True` (everywhere else `False`) -- `resolver.py:113`. **CONFIRMED**.
- **NEW -- admin is module-omnipotent: grant-write has no allow-list / no "admin-reserved" module class**, so an admin can self-mint all 22 modules; module layer offers **zero separation-of-duty containment** of an admin -- `services/grants.py:53-213`. (rbac deep-dive N1)
- **NEW -- uncapped admin-minting invite tree:** `create_invitation` accepts `role=admin` with no "can't invite above your tier" cap; `single_org_per_admin_user` does not cap admins-per-org; post-accept session-cycle is best-effort (swallows exceptions) -- `apps/organizations/services/invitation.py:107-322`. (rbac N3) Strongest chain: **N3->N1** (admin invites admin -> self-grants everything -> invites more). Under the locked no-approval self-serve model this is intended reach, but the threat model must state it explicitly.
- **NEW -- `_OrgMembershipPermission` fail-open is reachable:** a non-existent / soft-deleted org UUID makes `_resolve_org_from_view` return `None` -> `has_permission` returns `True`; saved today only by handler-level 404s -- `apps/organizations/permissions.py:85-89`. (rbac N2; matches the refuted interim claim -- see below -- but is a real latent default-deny violation; flip to `return False`.)
- Least-privilege defaults too broad: `org.audit_log` defaults ON for `referee`; `match.center_admin_view` (scorer/referee identities) defaults ON for `team_manager` -- `apps/permissions/fixtures/modules.json:21,126`. **CONFIRMED** (rbac N4, MEDIUM).

**Idempotency / audit (CONFIRMED)**
- `event_id` accepted but silently dropped on bulk grants, transfer-ownership, member-remove, and ~22 of ~25 verbs -- `apps/permissions/serializers.py:107`, `views.py:210`, `apps/organizations/views.py:331`. **CONFIRMED** (idempotency deep-dive: invariant #3 is **~12% implemented**; the public matrix-PUT API lies that it honors `event_id`).
- `emit_audit` idempotency is a check-then-create TOCTOU -> replay can 500 (and roll back the whole signup txn) instead of returning the existing row -- `apps/audit/services.py:45`. **CONFIRMED**.
- **NEW -- ownership transfer "DEFERRABLE INITIALLY DEFERRED" comment is false;** the constraint is an IMMEDIATE partial-unique (the promised RunSQL migration does not exist); swap is safe only by accident of statement order, and replay returns 400 not 200 -- `apps/organizations/services/ownership.py:91-97`, `models.py:216-226`. (idempotency Finding 2)
- send_mail / cache-invalidation fire **inside** `transaction.atomic()` (not `on_commit`); `emit_audit_on_commit` exists but is **never called** (invariant #4 ~ 0% implemented in 1A) -- `apps/organizations/services/invitation.py:188`, `apps/permissions/services/grants.py:110`. **CONFIRMED**.
- **Audit append-only is effectively NOT met under the documented connection identity.** The protection is **one trigger run as a superuser with no REVOKE**. Bypasses: `TRUNCATE` (no statement trigger), `DROP TRIGGER`, `DISABLE TRIGGER`, `SET session_replication_role=replica`, `CREATE OR REPLACE FUNCTION` no-op, sanctioned `REVERSE_SQL`; a future REVOKE is itself a **no-op while connected as `postgres`** -- `apps/audit/migrations/0002_audit_append_only.py`, `backend/.env:3`. Plus insert-time **forgery** (`actor_role` is a verbatim CharField, IP spoofable). **CONFIRMED + escalated** (audit-immutability deep-dive B1-B11; first pass under-rated this as a single LOW gap -- it is a HIGH cluster).
- Promised deploy-time REVOKE / role-provisioning has no script, Makefile, or CI pre-flight -- `backend/scripts/dev.sh`. **CONFIRMED**.

**Config / i18n / a11y / contracts (CONFIRMED)**
- `InMemoryChannelLayer` + LocMem cache in `base.py` (must be dev-only; breaks multi-worker SSE/WS fan-out **and** makes every cache-based rate limit per-process) -- `backend/fixture/settings/base.py:185`. **CONFIRMED**.
- No `LocaleMiddleware` / `LOCALE_PATHS` / catalogs -> `gettext` inert; serializer/service error strings hardcoded English; FE `t()` shim has no interpolation (12 untranslatable call sites) -- `settings/base.py:59`, `apps/organizations/serializers.py:64`, `frontend/src/lib/t.ts:7`. **CONFIRMED**.
- Invitation list/create contract mismatch (BE `role` scalar + `invited_by` UUID, no token; FE expects `roles[]` + `invited_by_email` + token) -- `apps/organizations/serializers.py:160`. **CONFIRMED**.
- `logout()` does not purge TanStack Query cache; `bootstrap()` only short-circuits 401 (DRF returns 403) -> error banner on `/login`; Dialog has no focus trap -- `frontend/src/features/auth/authStore.ts:49,139`, `frontend/src/components/ui/dialog.tsx:18`. **CONFIRMED**.
- Spec conflict: PRD section 8 `PersonAccount(user, person)` join table vs locked `Person.user` OneToOneField -- PRD section 8. **CONFIRMED** (resolve in PRD section 14).
- Two divergent scope implementations, one dead -- `apps/organizations/scope.py:21`. **CONFIRMED**.

### Refuted by the Verify pass (7) -- do NOT spend fix time on these

These interim leads were checked and **did not reproduce**; the code is correct as written:
- Login success response: FE expects user object -- backend `{status:'ok'}` shape was claimed mismatched. **REFUTED.**
- Login endpoint "no throttle, relies solely on axes." **REFUTED** as framed (axes is wired) -- but note the auth deep-dive's F1 is a **different, confirmed** defect: the 2FA branch has no throttle. Don't conflate.
- `MyEffectiveModulesView` returns module data for non-member orgs. **REFUTED** as a data-leak (outsiders get `[]`); the residual is only an org-existence oracle (tenant deep-dive FINDING 2, MEDIUM).
- `_OrgMembershipPermission` "silently passes when org unresolved." **REFUTED** as currently exploitable -- every live route carries an org kwarg and handlers 404. (The rbac deep-dive N2 keeps it as a **latent** fail-open worth a one-line `return False` hardening; not a present breach.)
- `LoginPage.resolveDestination` stale-closure / navigate race. **REFUTED.**
- `OrgSwitcher` cross-org cache bleed on switch. **REFUTED** (the logout-cache item authStore.ts:139 is the real one).
- ".env.example connects as Postgres superuser so REVOKE is a no-op." **REFUTED** as stated for `.env.example` -- but the live `backend/.env:3` does connect as `postgres`, and the audit-immutability deep-dive confirms that is the actual, serious problem (B7). Fix the real `.env`, not the example.

---

## Architectural invariant compliance

| # | Invariant | Status (post-verification) |
|---|---|---|
| 1 | UUIDv7 PKs | **MET** (latent `BigAutoField` default trap; add a CI guard) |
| 2 | Multi-tenancy isolation | **AT-RISK** -- bulk of surface correctly scoped (tenant deep-dive Group A), but grant-IDOR (FINDING 1) is a real privilege-grant-to-outsider; only 1 endpoint has an isolation test; fail-open permission base latent |
| 3 | Idempotent writes | **VIOLATED** -- ~12% implemented; 3 of ~25 verbs thread `event_id`; matrix-PUT contract lies; TOCTOU on the one shared gate |
| 4 | DB-first / `on_commit` | **VIOLATED (~0% in 1A)** -- `emit_audit_on_commit` never called; email + cache-invalidation inside `atomic()` |
| 5 | Append-only audit at DB **role** level | **VIOLATED as built** -- trigger-only, superuser-bypassable (TRUNCATE/DROP/DISABLE/replica/REPLACE/REVERSE), no REVOKE, no de-privileged role; insert-time forgery possible |
| 6 | State machines | **MET** (some transition-rigor + reason-length gaps in sadmin verbs) |
| 7 | Rule freeze | **N/A** (Phase 1B) |
| 8 | Person<->Player | **N/A** (Phase 1B; PRD section 8 spec conflict to resolve first) |
| 9 | Typed match deps | **N/A** (Phase 1B) |
| 10 | inputs_hash / manual-edit | **N/A** (Phase 1B) |
| 11 | SSE/WS split | **N/A** (Phase 1B; InMemoryChannelLayer blocks multi-worker) |
| 12 | RBAC module matrix (default-deny) | **MET in the resolver core**, AT-RISK at the gates -- admin self-grant omnipotence, uncapped admin invites, two fail-open returns |
| 13 | i18n + a11y day 1 | **VIOLATED (partial)** -- inert gettext, unwrapped strings, no `t()` interpolation, missing focus traps |
| 14 | UTC storage | **MET** |
| 15 | Session-auth / no-JWT | **MET** except 2 `@csrf_exempt` regressions on sadmin mutations |

---

## Phase 1B readiness & gaps

All seven Phase 1B apps are unbuilt; the 1A chassis does **not** block them (substrate is
healthy). Per-domain designs now exist (see index above). Needed, per spec:
- **Tournaments** (`v1Tournaments.md`): FSM + rule-freeze + 24h-grace amend scheduler.
- **Teams** (`v1Teams.md`): Person/Player split + sport module (resolve PRD section 8 vs locked OneToOne first).
- **Fixtures** (`v1Fixtures.md`): data-driven constraint DSL; `GenerationRun` (inputs_hash) before any generator; zero hardcoded rules.
- **Matches** (`v1Matches.md`): typed JSONB home/away pointers + `on_commit` advancement + per-write `event_id` ledger.
- **Live** (`v1Live.md`): ASGI `ProtocolTypeRouter` + `channels_redis`; SSE one-way / WS two-way.
- **Notifications / Disputes** (`v1Notifications.md`, `v1Disputes.md`): new apps.

**Self-serve flow is currently blocked three ways** (see `design-selfserve-flow.md` for the
target model):
1. Signup creates a `pending_review` org + inactive membership behind a super-admin approval
   gate the locked decision **removed**; email-verify never activates the workspace.
2. `single_org_per_admin_user` (`apps/organizations/models.py:229-233`) caps a user at one
   workspace and **500s a second admin-accept**.
3. No create-tournament/workspace entrypoint; invite-accept requires a pre-existing account.
The `TournamentMembership` / `TeamMembership` / `MatchAssignment` scope tables were never built.

---

## Recommended next steps (prioritized)

**P0 -- deploy-blocking**
1. Rotate secrets; scrub `backend/.env:7` and `frontend/e2e/fixtures.ts`.
2. Create `backend/fixture/settings/prod.py` (DEBUG off, `SECURE_*`/HSTS/CSP, Redis cache +
   channel layer, SMTP, `NUM_PROXIES`/trusted-proxy); move InMemory/LocMem to dev only.
3. **Stop connecting as `postgres`.** Provision a non-superuser, non-owner app role -- this
   single change defeats audit bypasses B3-B6/B8 and makes a REVOKE meaningful. Then add the
   checked-in hardening migration: `BEFORE TRUNCATE` trigger + `REVOKE UPDATE,DELETE,TRUNCATE
   ON audit_event` owned by a separate admin role; make `0002` reverse irreversible in prod;
   add the missing TRUNCATE/replica/privilege tests. Wire `load_modules`/`load_sports` + role
   provisioning into a deploy pre-flight.

**P1 -- security / auth / RBAC**
4. Add a dedicated 2FA-attempt lockout (separate per-user|ip counter; do not reset on
   password success) -- auth F1.
5. Apply `@require_recent_password_reauth` to `twofa_disable`, `recovery_regenerate`,
   `user_soft_delete`, and all sadmin destructive verbs -- auth F2 / sadmin F4.
6. Recovery-code consumption: `select_for_update` + conditional `UPDATE ... WHERE used_at IS
   NULL`, check rowcount -- idempotency Finding 3.
7. Remove both `@csrf_exempt`; fix open redirect (`url_has_allowed_host_and_scheme`);
   allowlist `target_filter` keys -- sadmin F1/F3/F5.
8. Resolver default `True`->`False`; permission base `org is None`->`return False`; add the
   grant-IDOR target-membership check; enforce invite-tier cap + reason-length; harden
   `emit_audit` to derive actor/role/IP server-side.

**P2 -- isolation + idempotency**
9. Parametrized cross-org isolation harness over every org-tenanted endpoint + CI gate
   (non-optional per CLAUDE.md).
10. Make `emit_audit` an atomic get-or-create (try-INSERT/except-IntegrityError-SELECT);
    introduce a real cross-cutting idempotency mechanism so all verbs thread `event_id`;
    fix/remove the false ownership "DEFERRABLE" comment; move post-write work to `on_commit`.

**P3 -- contracts / a11y / i18n**
11. Accept-invite `org_slug`; grant `reason`; invite `roles[]`/`invited_by_email`/token;
    serializer shape parity (UUID vs slug routes). Dialog focus trap; wire `LocaleMiddleware`
    + `LOCALE_PATHS`; FE `t()` interpolation; mark unwrapped strings.

**P4 -- pre-scaffold**
12. Implement the self-serve flow per `design-selfserve-flow.md` (remove approval gate,
    relax `single_org_per_admin_user`, add workspace/tournament entrypoint, build the scope
    tables); consolidate the duplicate scope module; resolve PRD section 8 Person spec conflict;
    add UUID-PK CI guard; fix drf-spectacular collisions; remove dead code; apply the UI/UX
    overhaul (`design-uiux-overhaul.md`).

---

## Top 5 must-fixes (all CONFIRMED)

1. Rotate & remove the plaintext super-admin password -- `backend/.env:7`.
2. Create `backend/fixture/settings/prod.py` -- none exists; all entrypoints hardcode `dev`.
3. Provision a non-superuser DB app role + audit-table hardening (TRUNCATE trigger + REVOKE)
   -- `backend/.env:3`, `apps/audit/migrations/0002_audit_append_only.py`. (The append-only
   guarantee is currently void; a REVOKE alone is a no-op while connected as `postgres`.)
4. Add a 2FA second-factor lockout -- `apps/accounts/views.py:225-241`, `services/twofa.py`.
   (Brute-forceable second factor; recovery-code double-spend rides the same surface.)
5. Stand up the cross-org isolation test suite + close grant-IDOR + flip both fail-open
   returns to fail-closed -- `apps/permissions/views.py:161-165`, `resolver.py:113`,
   `apps/organizations/permissions.py:85-89`.

Runners-up: drop the two `@csrf_exempt` (`apps/sadmin/views/superadmin.py:47,97`); apply the
dead B.18 reauth decorator; `target_filter` allowlist (`superadmin_verbs.py:409`); atomic
`emit_audit` get-or-create (`apps/audit/services.py:45`); thread `event_id` through the
remaining ~22 mutation verbs.
