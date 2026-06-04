# Phase 1A Readiness + Phase 1B Gap Audit

> Synthesized 2026-06-04 from the deep multi-agent audit (138 analysis files in this directory:
> 14 area maps + 98 per-area×lens audits + 26 cross-cutting analyses). The audit's Gap-map/Verify/
> Synthesis phases stalled; this report was assembled by a single synthesis pass over the saved findings.
> Findings cite `file:line`. Most are **not yet adversarially verified** (the Verify phase did not run) —
> treat High/Critical as strong leads to confirm during fixing.

## Verdict
The Phase 1A chassis is structurally sound and functionally complete for what it covers — backend boots and migrates with no drift, **all 350 backend + 162 frontend tests pass**, frontend builds clean. Architecture is genuinely strong (UUIDv7 PKs, trigger-enforced append-only audit, correct default-deny 22-module RBAC resolver, pure session+CSRF / no-JWT). **But it is NOT production-ready:** there is **no `prod.py` at all** (every entrypoint hardcodes `dev` → `DEBUG=True`), a **real super-admin password sits in plaintext `.env`**, and **cross-org isolation is verified by exactly one test**. Risk: **MEDIUM-HIGH** — safe to build on, unsafe to deploy until the Critical/High config + isolation items close.

## Critical & High findings (deduped)

### Security
- **CRITICAL** plaintext super-admin password — `backend/.env:6-7` (also leaked in `frontend/e2e/fixtures.ts:13-22`).
- **HIGH** weak TOTP key — `backend/apps/accounts/services/_crypto.py:35-38` (unsalted SHA-256 of SECRET_KEY; silent plaintext fallback).
- **HIGH** `@csrf_exempt` on authenticated mutations — `backend/apps/sadmin/views/superadmin.py:47,97`.
- **HIGH** open redirect — `backend/apps/sadmin/views/auth.py:51-52`.
- **HIGH** ORM filter injection — `backend/apps/sadmin/services/superadmin_verbs.py:409-411`.
- **HIGH** no login throttle — `backend/apps/accounts/views.py:197`.
- **HIGH** spoofable `X-Forwarded-For` — `backend/apps/accounts/services/password_reset.py:39-42`, `backend/apps/sadmin/middleware.py:22`.

### Tenant isolation
- **HIGH** only `audit` has a cross-org test; `organizations`/`permissions` isolation tests missing.
- **HIGH** fail-open permission — `backend/apps/organizations/permissions.py:85-89` (returns True when org unresolved).
- **HIGH** grant IDOR — `backend/apps/permissions/views.py:161-165` (target user membership not verified).
- **HIGH** module-oracle + soft-delete leak — `backend/apps/permissions/views.py:128`.
- **MEDIUM** writable `last_active_org_id` — `backend/apps/accounts/serializers.py:108-132`.

### RBAC
- **HIGH** resolver fail-open default — `backend/apps/permissions/services/resolver.py:113` (`is_authenticated` defaults True; everywhere else False).
- **HIGH** invite-tree delegation unenforced (escalation to admin) — `backend/apps/organizations/services/invitation.py:107-146`.
- **MEDIUM** reauth decorator applied to zero views — `backend/apps/accounts/decorators.py:23`.

### Idempotency / Audit
- **HIGH** `event_id` dropped — `backend/apps/permissions/services/grants.py:135-213`, `backend/apps/organizations/services/ownership.py:40-115`.
- **HIGH** TOCTOU → 500 on concurrent replay — `backend/apps/audit/services.py:45-48`.
- **MEDIUM** email send inside `atomic()` — `backend/apps/organizations/services/invitation.py:188-225`.
- **HIGH** audit append-only is **trigger-only** (no role REVOKE; superuser + `session_replication_role=replica` bypass) — `backend/apps/audit/migrations/0002_audit_append_only.py:17-36`.

### Correctness / Contract (frontend↔backend)
- **HIGH** accept-invite response missing `org_slug` → undefined redirect — `frontend/src/api/orgs.ts:82-86`.
- **HIGH** grant-matrix never sends `reason` → 400 on every save.
- **HIGH** invite serializer `role` vs frontend `roles[]`/`token` mismatch.
- **MEDIUM** 403-not-401 banner on logged-out `/me` — `frontend/src/features/auth/authStore.ts:49`.
- **MEDIUM** logout / org-switch cache bleed (no query cache reset).
- **MEDIUM** dialog has no focus trap — `frontend/src/components/ui/dialog.tsx:18`.

### Config
- **CRITICAL** no `prod.py` — every entrypoint hardcodes `fixture.settings.dev`.
- **HIGH** InMemory channel layer + LocMem cache live in `base.py:185-196` (should be dev-only).
- **HIGH** no `SECURE_*` / HSTS / CSP headers.
- **MEDIUM** relative email URLs + unset `DEFAULT_FROM_EMAIL`.

## Architectural invariant compliance
1. UUIDv7 — **MET** (latent `BigAutoField` default trap).
2. Multi-tenancy isolation — **AT-RISK** (ScopedManager wired to 0 models; fail-open; 1 of ~18 endpoints tested).
3. Idempotent writes — **VIOLATED (partial)** (several services drop `event_id`).
4. DB-first / `on_commit` — **AT-RISK** (email inside atomic block).
5. Append-only audit — **VIOLATED as written / MET in spirit** (trigger-only, bypassable).
6. State machines — **MET** (some transition-rigor gaps).
7. Rule freeze — **N/A yet** (Phase 1B).
8. Person↔Player — **N/A yet**.
9. Typed match deps — **N/A yet**.
10. inputs_hash / manual-edit — **N/A yet**.
11. SSE/WS split — **N/A yet**.
12. RBAC module matrix — **MET** (hardening gaps).
13. i18n + a11y — **VIOLATED (partial)** (unwrapped strings, missing focus traps/aria).
14. UTC storage — **MET**.
15. Session-auth / no-JWT — **MET** (2 CSRF-exempt regressions).

## Phase 1B readiness & gaps
All seven Phase 1B apps are unbuilt; the 1A chassis does not block them (substrate healthy). Needed:
- **Tournaments:** FSM + rule-freeze + 24h-grace amend scheduler.
- **Teams:** Person/Player split + sport module.
- **Fixtures:** `GenerationRun` (inputs_hash) before any generator (see `docs/superpowers/specs/v1Fixtures.md` for the data-driven constraint engine design).
- **Matches:** typed JSONB home/away pointers + `on_commit` advancement + per-write `event_id` ledger.
- **Live:** ASGI `ProtocolTypeRouter` + `channels_redis` for SSE/WS.
- **Notifications + Disputes:** new apps.

**The locked self-serve flow is currently blocked three ways:**
1. Signup creates a `pending_review` org + inactive membership behind a super-admin approval gate the spec removed; **email-verify never activates the workspace**.
2. `single_org_per_admin_user` (`backend/apps/organizations/models.py:229-233`) caps a user at one workspace and **500s a second admin-accept**.
3. No create-tournament/workspace entrypoint; invite-accept requires a pre-existing account.
Also the `TournamentMembership` / `TeamMembership` / `MatchAssignment` scope tables (spec'd for Phase 1A) were never built.

## Recommended next steps
**P0 (deploy-blocking):** rotate secrets + scrub `.env`/fixtures; create `prod.py` (DEBUG off, `SECURE_*`/HSTS/CSP, Redis, SMTP) and move InMemory/LocMem to dev; add Postgres role-hardening SQL + non-superuser app role; wire `load_modules`/`load_sports` into deploy.
**P1 (security/RBAC):** drop the two `@csrf_exempt`; fix open redirect + `target_filter` allowlist; resolver default→False + fail-closed permission base; membership checks (grant IDOR, module oracle, `last_active_org_id`); apply reauth decorator; login throttle; trusted-proxy IP; HKDF TOTP key; enforce invite delegation.
**P2:** parametrized cross-org isolation harness + CI gate; atomic idempotency + thread `event_id`.
**P3:** contract fixes (accept-invite `org_slug`, grant `reason`, invite role/token); dialog focus trap; a11y/i18n.
**P4 (pre-scaffold):** resolve the self-serve blockers + build the scope tables; consolidate scope module + UUID-PK CI guard; design the `event_id` ledger + central FSM; refresh stale root `CLAUDE.md`; fix the 9 drf-spectacular collisions; remove dead code.

---

## Top 5 must-fixes
1. Rotate & remove plaintext super-admin password — `backend/.env:6-7` (CRITICAL).
2. Create `backend/fixture/settings/prod.py` — none exists; all entrypoints hardcode `dev` (CRITICAL).
3. Fix RBAC resolver fail-open default — `backend/apps/permissions/services/resolver.py:113`.
4. Remove `@csrf_exempt` on authenticated sadmin mutations — `backend/apps/sadmin/views/superadmin.py:47,97`.
5. Stand up the cross-org isolation test suite + flip fail-open → fail-closed — `backend/apps/organizations/permissions.py:85-89`.

Runners-up: grant-IDOR `backend/apps/permissions/views.py:161-165`; ORM injection `backend/apps/sadmin/services/superadmin_verbs.py:409-411`; TOCTOU idempotency `backend/apps/audit/services.py:45-48`; audit append-only trigger-only bypass.
