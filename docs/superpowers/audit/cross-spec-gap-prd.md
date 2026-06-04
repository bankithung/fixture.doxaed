# Cross-Spec Gap Audit — PRD vs Phase 1A Implementation

**Scope:** PRD §2 / §3 / §7 / §8 / §14 (accounts, organizations, RBAC, audit, sadmin) cross-referenced against the actually-implemented Phase 1A backend.
**Specs:** `docs/superpowers/specs/2026-04-30-fixture-platform-prd.md` (PRD, canonical for state machines/transport/security) and `docs/superpowers/specs/v1Users.md` (LOCKED user/RBAC model; supersedes PRD §3.1/§3.2/§7.5/§8 on conflict).
**Method:** Read real files; every finding cites `file:line` + quoted evidence. drf-spectacular warnings reproduced live via `manage.py spectacular`.
**Date:** 2026-06-04

---

## Summary of what's implemented vs missing vs contradicted (Phase 1A surfaces)

### Implemented and matching spec
- **UUID v7 PKs** via `uuid_utils.uuid7` everywhere (invariant 1) — `apps/accounts/models.py:28-30`, all models use `default=uuid7`.
- **Email-as-username custom User** with soft-delete + PII anonymization (PRD §2.6) — `apps/accounts/models.py:103-111`.
- **Argon2id hashing** (PRD §2.10) — `fixture/settings/base.py:108-113`.
- **2FA TOTP + recovery codes** (PRD §2.9, v1Users §1.4) — `apps/accounts/models.py:125-191`, hashed at rest.
- **Append-only audit at DB level via trigger** (invariant 5) — `apps/audit/migrations/0002_audit_append_only.py:17-36`; trigger fires even for superuser (stronger than role-deny). Production REVOKE noted as deploy concern.
- **AuditEvent service-layer emit + idempotency_key + B.5 actor_role taxonomy** — `apps/audit/models.py:22-100`.
- **Module catalog (22) + MembershipModuleGrant keyed on (user, org) + corrected multi-role resolver** (v1Users Appendix A.4) — `apps/permissions/models.py`, `apps/permissions/services/resolver.py:107-132`.
- **Org membership constraints** (single-org-per-admin, one-owner-per-org, owner-flag-only-on-admin, multi-role per user/org) — `apps/organizations/models.py:208-238`.
- **Login brute-force lockout (django-axes, 10 fails/30min)** (PRD §2.9) — `fixture/settings/base.py:180-183`.
- **Password reset: hashed single-use token, enum-safe response, session invalidation** (PRD §2.9/§2.10) — `apps/accounts/services/password_reset.py`.

### Missing (in spec, not implemented)
- HIBP/pwned password breach check (PRD §2.10, §7.7).
- Security headers: HSTS, CSP, Referrer-Policy, X-Content-Type-Options, Permissions-Policy (PRD §7.7).
- `OrganizationMembership` 8-value status enum (PRD §3.3, v1Users §2.7) — only an `is_active` boolean exists.
- `AdminInvitation.claimed_org_name` (PRD §8, §2.2 Flow A).
- Redis channel layer + Redis cache (invariants 4/11; A.4/B.3 cross-worker cache invalidation).
- Per-minute login rate limits 5/min IP, 20/min email (PRD §2.9) — only axes lockout + global 60/min anon throttle.

### Contradicted (implemented one way, spec/decision says another)
- **Self-signup approval gate**: implementation gates new orgs behind Super-admin approval (`pending_review`, membership `is_active=False`); the LOCKED product decision says NO super-admin approval gate. (PRD §2.2 Flow B is now stale vs the locked decision.)
- **drf-spectacular operationId/enum collisions** (9 warnings, reproduced live) — contradicts B.3 OpenAPI/TS-codegen commitment.
- **Enum naming**: `OrgStatus.PENDING_REVIEW` vs PRD/v1Users `pending_approval`.
- **Ownership-transfer comment** falsely claims a working DEFERRABLE constraint that the same file's docstring says does not exist.
- Root `CLAUDE.md` still declares "Greenfield, pre-implementation."
- `/api/accounts/me/` returns 403 (not 401) when logged out — premature error banner on `/login` (PRD §5.12 error-state catalog says 401 → "session expired" banner).

---

## Findings

### F1 — [HIGH] Self-signup implements a Super-admin approval gate that the locked product decision removed
**File:** `apps/accounts/services/signup.py:263-289`
**Evidence:**
```
# 2. Organization (status=pending_review) ...
org = Organization.objects.create(... status=OrgStatus.PENDING_REVIEW ...)
# 3. Pending Admin OrganizationMembership
membership = OrganizationMembership.objects.create(... is_active=False,  # pending until SA approves the org ...)
```
**Why it matters:** The locked product direction is "self-serve signup, NO super-admin approval gate" with the org as a hidden personal workspace auto-provisioned on tournament creation. The current code follows the OLD PRD §2.2 Flow B (decision #39: "self-signup with approval"), so a brand-new user lands on an "awaiting approval" dead-end with `is_active=False`, exactly the flow the new decision discards. The PRD is now stale on this point and must be revised before Phase 1B builds tournament auto-provisioning on top.
**Recommendation:** Revise PRD §2.2 Flow B + decision-log #39 to the no-gate model; change signup to create the org `active` (or a new `personal_workspace`/hidden state) and the admin membership `is_active=True` with email verification still required for first login. Keep the `/sadmin` approval inbox only for any retained moderation path. Log the superseding decision in PRD §14 and v1Users.

### F2 — [HIGH] OrganizationMembership lacks the mandated 8-value status enum (uses only is_active boolean)
**File:** `apps/organizations/models.py:185`
**Evidence:** `is_active = models.BooleanField(default=True)` — there is no `status` field; PRD §3.3 mandates `status ∈ { invited, pending_email_verification, pending_approval, active, suspended, revoked, declined, left }` and v1Users §2.7 declares `status = enum(...)  # PRD §3.3 (8 values)`. No `MembershipStatus` enum exists anywhere in `apps/`.
**Why it matters:** Invariant 6 ("state machines, not boolean flags") is violated for membership lifecycle. A boolean cannot distinguish `invited` vs `pending_email_verification` vs `suspended` vs `revoked` vs `declined` vs `left`. The invite flow (v1Users §2.13), suspension (§2.10), and the member directory status filter (PRD §3.4) all key off these states. The spec's own constraint `unique_active_role_per_user_per_org` is written against `status__in=['active','invited','pending_email_verification','pending_approval']` (v1Users.md:421-424) but the implementation reduced it to `Q(is_active=True)` (models.py:213), losing the pending-state race protection the spec called out.
**Recommendation:** Add a `status` CharField with the 8 TextChoices; derive `is_active` as a property or migrate constraints to `status__in=[...]`. Update invite/suspend/revoke services to set explicit states. This is a schema migration; do it before Phase 1B adds membership-dependent flows.

### F3 — [HIGH] No Have-I-Been-Pwned breach check on passwords
**File:** `fixture/settings/base.py:115-120` (AUTH_PASSWORD_VALIDATORS)
**Evidence:** Validators are only `MinimumLengthValidator(12)`, `CommonPasswordValidator`, `NumericPasswordValidator`. No `pwned_passwords_django` validator, despite the package being installed in `.venv`. Grep for `pwned`/`PwnedPasswords` across `apps/` returns nothing.
**Why it matters:** PRD §2.10 ("Checked against Have I Been Pwned (k-anonymity API)") and §7.7 security baseline are explicit. This is a stated security control that is absent. Also note PRD §2.10 requires "≥1 letter and ≥1 digit"; the current validator set does not enforce a letter+digit composition rule (NumericPasswordValidator only rejects all-numeric).
**Recommendation:** Add `pwned_passwords_django.validators.PwnedPasswordsValidator` to `AUTH_PASSWORD_VALIDATORS`, plus a composition validator for ≥1 letter and ≥1 digit. Add a unit test asserting a known-breached password is rejected.

### F4 — [HIGH] InMemoryChannelLayer + LocMemCache are set in base.py (not just dev), breaking invariants 4/11 and the A.4 cache-invalidation contract
**File:** `fixture/settings/base.py:185-196`; not overridden in `fixture/settings/dev.py`
**Evidence:**
```
CHANNEL_LAYERS = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache", ...}}
```
**Why it matters:** Invariant 4 ("Redis publish only in transaction.on_commit") and 11 (SSE/WS) require a real Redis channel layer; InMemory cannot fan out across ASGI workers. The effective-modules resolver explicitly defers cross-worker invalidation because of this — `apps/permissions/services/resolver.py:42-50` ("Phase 1A is single-process safe via the shared backend; cross-worker invalidation lands in Phase 1B") and `:18-19`. With LocMemCache, the 5-minute module cache is per-process: a grant/revoke on worker A is invisible to worker B for up to 5 min, so a revoked module can still authorize requests. Acceptable for single-process dev, but the values live in `base.py` (shared with prod) with no prod override present, so this will silently ship to production.
**Recommendation:** Move InMemory/LocMem to `dev.py` only; add `prod.py` (or env-driven base) using `channels_redis.core.RedisChannelLayer` and `django.core.cache.backends.redis.RedisCache`. Implement the B.3/A.4 Redis pub/sub invalidation (`permcache:user:<uuid>:org:<uuid>`) before live features land.

### F5 — [MEDIUM] Nine drf-spectacular operationId / enum collisions (TS codegen breakage)
**File:** `apps/accounts/urls.py:16-32`, `apps/organizations/urls.py:64-115`, `apps/permissions/urls.py:24-46`; reproduced via `manage.py spectacular`
**Evidence (live run):**
```
Warning: encountered multiple names for the same choice set (RolesEnum)...
Warning: operationId "accounts_auth_password_reset_complete_create" has collisions [.../password-reset-complete/ , .../password_reset_complete/]...
Warning: operationId "accounts_auth_verify_email_create" has collisions [.../verify-email/ , .../verify_email/]...
Warning: operationId "orgs_invitations_list" has collisions [{slug}/invitations/ , {uuid}/invitations/]...
Warning: operationId "orgs_members_list" has collisions [{slug}/members/ , {uuid}/members/]...
Warning: operationId "permissions_orgs_users_grants_list" has collisions [{org_uuid}/.../grants/ , {slug}/.../grants/]...
Warnings: 9 (9 unique)  Errors: 0
```
Root cause: hyphen+underscore alias routes pointing at the same view (`accounts/urls.py:16-17, 22-26, 27-32`) and parallel slug-routed + uuid-routed views for the same resource (`organizations/urls.py` `OrgMembersListView`/`OrgMembersBySlugView`, `OrgInvitationsView`/`OrgInvitationsBySlugView`; `permissions/urls.py` `UserGrantsView`/`UserGrantsBySlugView`). RolesEnum is auto-named from two different serializer choice fields.
**Why it matters:** B.3 commits to `drf-spectacular` + `openapi-typescript-codegen`. Collisions are auto-resolved with numeral suffixes (`orgs_members_list_2`), producing unstable, meaningless generated client method names that churn whenever route order changes. The RolesEnum warning means the generated TS enum name is non-deterministic.
**Recommendation:** Pick ONE canonical URL shape (recommend slug for SPA-facing, uuid for verbs) and drop the duplicate aliases, OR set explicit `operation_id=` in each `@extend_schema` for the surviving aliases. Add `ENUM_NAME_OVERRIDES` for `RolesEnum`. Add a CI gate failing on any spectacular warning.

### F6 — [MEDIUM] /api/accounts/me/ returns 403 (not 401) when unauthenticated → premature error banner on /login
**File:** `apps/accounts/views.py:416-417` + `fixture/settings/base.py:153-158`
**Evidence:** `me_view` is `@permission_classes([IsAuthenticated])` with `DEFAULT_AUTHENTICATION_CLASSES = [SessionAuthentication]`. DRF's `SessionAuthentication.authenticate_header()` returns `None`, so an unauthenticated request to an `IsAuthenticated` view yields **403 Forbidden**, not 401. PRD §5.12 error catalog maps 401 → "session expired, please log in" banner + redirect, and 403 → "You don't have permission" designed page. The SPA bootstrap calling `/me/` while logged-out therefore gets a 403 and (per the known issue) renders a permission/error banner on `/login`.
**Why it matters:** UX contradiction with PRD §5.12; the login page shows an error banner on a perfectly normal logged-out state.
**Recommendation:** Either (a) return 401 for the unauthenticated case (custom auth/permission or a `me` view that returns `{authenticated: false}` 200 for anon), or (b) treat `/me/` as `AllowAny` returning an empty/anon payload so the SPA can branch cleanly. Add a frontend guard that does not surface an error banner for the 401/anon case on `/login`.

### F7 — [MEDIUM] Ownership transfer cannot target a Co-organizer (PRD §2.7 requires it) + misleading deferrable comment
**File:** `apps/organizations/services/ownership.py:74-97`
**Evidence:** `transfer_ownership` requires the recipient to ALREADY be an active admin: `incoming = OrganizationMembership.objects.select_for_update().get(user=new_owner_user, organization=org, role=MembershipRole.ADMIN, is_active=True)`. But PRD §2.7 says "pick a Co-organizer in the same Org" and v1Users §2.10 step 1 says "picks any Admin OR Co-organizer." A Co-organizer recipient has no admin row, and `single_org_per_admin_user` blocks promoting them inline if they're admin elsewhere. Separately, line 91-92 comments "Thanks to DEFERRABLE INITIALLY DEFERRED, the constraint is checked at COMMIT," which the file's own docstring (lines 1-21) refutes ("Postgres does not let ... be deferred ... Django therefore silently drops the deferrable flag").
**Why it matters:** A core PRD §2.7 path (transfer to a Co-organizer, who becomes Admin) is unimplemented; only Admin→Admin swap works. The false inline comment will mislead future maintainers into assuming a DB safety net that does not exist (the actual safety is the clear-then-set ordering).
**Recommendation:** Support a Co-organizer recipient: in one transaction, add/flip an admin membership for the recipient (respecting single-org-per-admin), then swap owner flag, optionally demote outgoing owner to chosen role (PRD §2.7 / v1Users §2.10 open question). Fix the inline comment to match the docstring.

### F8 — [LOW] Security headers (HSTS, CSP, Referrer-Policy, nosniff, Permissions-Policy) absent from Django settings
**File:** `fixture/settings/base.py` (entire) — grep for `SECURE_HSTS`/`CSP`/`Referrer-Policy`/`SECURE_CONTENT_TYPE`/`Permissions-Policy` returns nothing in `apps/`/`fixture/`.
**Evidence:** Only `SessionMiddleware`/`SecurityMiddleware`/`XFrameOptionsMiddleware` are present; no `SECURE_HSTS_SECONDS`, `SECURE_CONTENT_TYPE_NOSNIFF`, `SECURE_REFERRER_POLICY`, or CSP package configured. PRD §7.7 mandates "HSTS (1y), strict CSP, X-Content-Type-Options: nosniff, Referrer-Policy: strict-origin-when-cross-origin, Permissions-Policy deny-by-default."
**Why it matters:** PRD §7.7 security baseline partially unmet at the app layer. Some of this can be terminated at Caddy (v1Users §1.8), but `SECURE_*` Django settings and a CSP for the `/sadmin` HTMX surface should exist in-app. Lower severity because it is largely deploy-configurable and Phase 1A is pre-prod.
**Recommendation:** Add `SECURE_HSTS_SECONDS`, `SECURE_HSTS_INCLUDE_SUBDOMAINS`, `SECURE_CONTENT_TYPE_NOSNIFF=True`, `SECURE_REFERRER_POLICY="strict-origin-when-cross-origin"`, and a CSP (django-csp) scoped for the sadmin HTMX/Alpine surface. Gate behind `not DEBUG`.

### F9 — [LOW] AdminInvitation has no claimed_org_name field (PRD §8 / §2.2 Flow A)
**File:** `apps/organizations/models.py:256-312`
**Evidence:** `AdminInvitation` fields are `organization, email, invited_by, role, token_hash, status, expires_at, accepted_*, revoked_*`. PRD §8 defines `AdminInvitation (email, claimed_org_name, token_hash, ...)` and §2.2 Flow A step 2 has the Super-admin enter "claimed Organization name" before any Org row exists.
**Why it matters:** The implementation models invitations as always attached to an existing `organization` FK (the in-Org invite tree of v1Users §2.13), which is correct for Co-org/sub-role invites. But PRD §2.2 Flow A (Super-admin invites an Admin for an org that does not yet exist) cannot be represented — there is no Org to FK to, and `claimed_org_name` is gone. With the no-approval-gate decision (F1) this flow may be deprecated, but the contradiction should be resolved explicitly in the PRD, not left silent.
**Recommendation:** Decide whether Flow A (Super-admin pre-invite) survives the new self-serve model. If yes, add `claimed_org_name` and make `organization` nullable for pre-org invites. If no, remove Flow A from PRD §2.2 and log the decision.

### F10 — [LOW] Root CLAUDE.md is stale ("Greenfield, pre-implementation. No source code exists yet.")
**File:** `CLAUDE.md:13-15` (project root)
**Evidence:** `## Project status` / "**Greenfield, pre-implementation.** No source code exists yet." — yet Phase 1A (accounts, organizations, permissions, audit, sadmin, sports) is implemented with 350+ backend tests per memory.
**Why it matters:** Misleads any agent/contributor about project state; the "Repository layout (planned, not yet built)" and "No build / test / run commands exist yet" sections are also stale.
**Recommendation:** Update the status section to "Phase 1A implemented; Phase 1B not started," document the actual `manage.py`/pytest/spectacular commands, and mark the repo layout as partially built.

### F11 — [INFO] Enum value naming drift: pending_review vs spec's pending_approval
**File:** `apps/organizations/models.py:37`
**Evidence:** `PENDING_REVIEW = "pending_review", _("Pending review")`. PRD §2.2/§3.3 and v1Users §2.3 consistently use `pending_approval` (and `Organization.status = pending_approval`).
**Why it matters:** Cosmetic but real divergence between the canonical spec vocabulary and the DB value; any spec-driven test or analytics keyed on `pending_approval` will miss these rows.
**Recommendation:** Pick one term. If the no-gate decision (F1) lands, this state may be renamed (e.g., `active`/`personal`) anyway — fold the rename into that work and update the spec value.

### F12 — [INFO] Per-minute login rate limits (5/min IP, 20/min email) not configured
**File:** `fixture/settings/base.py:160-169, 180-183`
**Evidence:** Only `AnonRateThrottle 60/min` (global) + axes lockout (10 fails/30min). PRD §2.9/§7.7 specify login 5/min/IP and 20/min/email as distinct from the 10-fail lockout.
**Why it matters:** Lockout (threshold + cooloff) and rate-limit (sustained req/min) are different controls; only one is present. Low severity since axes covers the brute-force class.
**Recommendation:** Add a scoped login throttle (DRF ScopedRateThrottle or axes rate config) for 5/min/IP + 20/min/email if strict PRD §2.9 parity is required.

---

## Gaps (work needed to satisfy the spec / locked decisions)

| Item | Missing | Blocking | Effort | Needed for |
|------|---------|----------|--------|-----------|
| Membership status enum | 8-value `status` field; constraints keyed on it; invite/suspend/revoke set states | Yes | M | Invite flow, member directory, suspension (PRD §3.3/§3.4, v1Users §2.7/§2.13) |
| No-approval-gate signup | Revise PRD §2.2/#39; signup creates active org+admin; sadmin approval optional | Yes | M | Locked product decision; Phase 1B tournament auto-provisioning |
| HIBP + composition password validators | pwned validator + ≥1 letter/≥1 digit rule + test | No | S | PRD §2.10/§7.7 security baseline |
| Redis channel layer + cache + A.4/B.3 invalidation | channels-redis, RedisCache, pub/sub permcache invalidation | Yes (for live) | M | Invariants 4/11; module-grant correctness across workers |
| Spectacular collision cleanup | Dedup alias routes or explicit operation_id; ENUM_NAME_OVERRIDES; CI gate | No | S | B.3 TS codegen stability |
| 401-vs-403 for /me anon | Return 401 or anon-200; FE guard | No | S | PRD §5.12 error catalog; login UX |
| Ownership transfer to Co-organizer | Promote-then-swap path; fix deferrable comment | No | M | PRD §2.7 / v1Users §2.10 |
| Security headers | SECURE_HSTS/nosniff/Referrer-Policy + CSP for sadmin | No | S | PRD §7.7 |
| AdminInvitation.claimed_org_name / Flow A decision | Field + nullable org, or remove Flow A from PRD | No | S | PRD §2.2 Flow A / §8 |
| Root CLAUDE.md refresh | Update status/layout/commands | No | S | Contributor accuracy |
| Login per-minute throttles | 5/min IP + 20/min email scoped throttle | No | S | PRD §2.9/§7.7 |

---

## Notes / non-issues
- **Append-only audit** is implemented robustly (trigger fires for all roles incl. superuser); only the production REVOKE is left to deploy provisioning, which the migration explicitly documents — acceptable.
- **Migrations-blocked-while-tournament-live** (PRD §5/§6) is correctly a Phase 1B concern (no tournaments exist yet) — not a Phase 1A gap.
- **Password reset invalidates ALL sessions** (vs §2.10 "except current") is correct for the unauthenticated forgot-password flow; the "except current" rule applies to authenticated password *change*, which is a separate, not-yet-built endpoint.
- **permissions app uses `app_label = "permissions_app"`** to avoid clashing with Django's built-in `permissions` — intentional, not a bug.
