# Cross-cutting E2E Flow Audit — request → view → service → model → response (+ SPA route)

Scope: trace each user journey end to end across backend (Django/DRF) and the React SPA,
mark works / partial / broken / missing with `file:line`, then assess the LOCKED desired
flow ("any user signs up → starts a tournament → becomes that tournament admin → invites by
email → accept → assign roles") on the org-as-hidden-workspace model.

Status legend: ✅ works · 🟡 partial · 🔴 broken · ⛔ missing.

---

## 1. Journey-by-journey trace

### 1.1 Signup Path B (public self-signup) — 🟡 partial (works technically, violates locked product flow)

- Request: `POST /api/accounts/auth/signup/` → `signup()` view
  `backend/apps/accounts/views.py:90`.
- Serializer accepts `email,password,name,org_name,event_id`
  `backend/apps/accounts/serializers.py:14-31`.
- Service: `perform_signup()` atomically creates User(is_active=False), Organization
  (`status=PENDING_REVIEW`), OrganizationMembership(role=admin, is_org_owner=True,
  **is_active=False**), EmailVerificationToken, audit
  `backend/apps/accounts/services/signup.py:254-318` (membership inactive at line 287).
- Response: `{"status":"pending_verification"}` 201 (or 200 on idempotent replay)
  `backend/apps/accounts/views.py:118-148`.
- SPA: `SignupPage` posts via `authApi.signup`, shows "Check your email"
  `frontend/src/features/auth/SignupPage.tsx:71-75`.

Defects:
- The SPA form has NO `org_name` field, and `authApi.signup` sends only `{email,password,name}`
  `frontend/src/api/auth.ts:30-36, 55-56`; `SignupPage.tsx:71-75`. So a self-serve user can
  never name their tenant; the org slug is always email-local-part derived.
- The created org is `pending_review` and the admin membership is **inactive** — the user is
  NOT usable until a super-admin runs `approve_org` (`backend/apps/sadmin/views/orgs.py:68`,
  `backend/apps/organizations/services/lifecycle.py:84-109`). This is a hard SA approval gate,
  which directly contradicts the locked decision "self-serve signup, NO super-admin approval gate."

### 1.2 Signup Path A (invite-accept) — 🟡 partial

- There is NO separate Path A signup endpoint. An invited stranger must FIRST create an account
  via Path B (which mints an unwanted pending org), THEN accept the invite. `perform_signup`
  docstring and `signup()` both assume Path A goes through invite-accept, but invite-accept
  requires an already-authenticated user (`InvitationAcceptView.permission_classes=[IsAuthenticated]`)
  `backend/apps/organizations/views.py:461-485`. So an invited new user cannot sign up "as an
  invitee"; they self-signup (creating junk pending org + admin membership) then accept.

### 1.3 Email verification — 🔴 broken for membership/org activation

- `POST /api/accounts/auth/verify_email/` (+ hyphen alias) → `verify_email()`
  `backend/apps/accounts/views.py:155`, `urls.py:16-17`.
- Flips only `user.is_active=True` + `email_verified_at`
  `backend/apps/accounts/views.py:172-176`. It does NOT activate the OrganizationMembership
  nor the Organization. So even after a fully verified email, the Path-B founder still has zero
  ACTIVE memberships (membership stays `is_active=False`).
- SPA: `VerifyEmailPage` reads `?token=`, calls verify, links to login
  `frontend/src/features/auth/VerifyEmailPage.tsx:22, 63-68`. ✅ for the user-active flip.
- Net effect: verified founder logs in → `me.memberships=[]` → `ProtectedRoute` bounces to
  `/orgs` empty state `frontend/src/features/layout/ProtectedRoute.tsx:50-57`,
  `OrgChooserPage.tsx:41-47`. Dead end until SA approval.

### 1.4 Login + 2FA — ✅ works

- `POST /api/accounts/auth/login/` → `login_view()` `backend/apps/accounts/views.py:197`.
  `authenticate` (axes) → inactive/deleted guard (403) → if `has_2fa_enrolled` and no code,
  returns `{"requires_2fa":true}` 200; else verifies TOTP/recovery; `login()` + session cycle
  `views.py:222-253`.
- SPA folds 2FA into the same endpoint: `requires_2fa` → stash creds, show TOTP form, re-call
  with `totp_code` `frontend/src/features/auth/authStore.ts:63-137`,
  `LoginPage.tsx:77-96`. ✅
- 2FA enroll/confirm/disable/recovery-regen all present `views.py:338-396`, SPA pages exist
  (`TwoFactorEnrollPage.tsx`, `TwoFactorChallengePage.tsx`). ✅

### 1.5 Bootstrap `/me` when logged-out — 🔴 broken (403 vs 401 → premature error banner on /login)

- `me_view` is `IsAuthenticated` `backend/apps/accounts/views.py:417`. DRF is configured with
  ONLY `SessionAuthentication` `backend/fixture/settings/base.py:153-155`. `SessionAuthentication`
  does not implement `authenticate_header()`, so an unauthenticated request resolves to **403**
  `NotAuthenticated` ("Authentication credentials were not provided."), not 401.
- `bootstrap()` only treats `status === 401` as the clean "logged-out" case
  `frontend/src/features/auth/authStore.ts:50-53`; a 403 falls into the `else` and sets
  `error` `authStore.ts:54-59`. Bootstrap is invoked directly (not via TanStack Query)
  `frontend/src/main.tsx:8`, so the `queryCache.onError`/`isUnauthenticated` handling in
  `queryClient.ts:36-42` never runs for it.
- `LoginPage` renders that store `error` as a red alert on mount `LoginPage.tsx:39, 107-114`.
  Result: a fresh visitor to `/login` sees "Authentication credentials were not provided."
  (Note: `ApiError.isUnauthenticated` DOES match a 403 whose detail contains "authentication
  credentials" `frontend/src/types/api.ts:32-45`, but `bootstrap()` never consults it — it
  checks the raw status. Fix: make `bootstrap()` use `ApiError.isUnauthenticated` and/or have
  `me_view` return 401.)

### 1.6 Create / own an Org — 🔴 broken for normal users / ⛔ missing self-serve

- The only public-API org-create route, `POST /api/orgs/`, is **super-admin only**
  `backend/apps/organizations/views.py:141-143`. Normal users get `PermissionDenied`.
- The lifecycle `create_organization` defaults `status=pending_review` and emits a
  SUPER_ADMIN-actor audit `backend/apps/organizations/services/lifecycle.py:32-76`.
- SPA: there is NO "create org" / "create tournament" / "new workspace" UI anywhere in the
  route table `frontend/src/App.tsx:89-179`; the only tournament surface is a placeholder
  `ComingSoonPage` `App.tsx:171-174`. So owning an org is reachable ONLY by Path-B signup
  (which is gated + pending). No happy path.

### 1.7 Invite a member — ✅ works (with a latent conflict, see 1.10)

- `POST /api/orgs/{slug}/invitations/` → `OrgInvitationsBySlugView.post`
  `backend/apps/organizations/views.py:569-587`; UUID variant `OrgInvitationsView.post:419`.
  Gated `IsOrgAdminOrOwner`.
- Service `create_invitation` hashes token, stores sha256, emails plaintext, idempotent on
  `event_id`, picks highest-tier role from `roles[]`
  `backend/apps/organizations/services/invitation.py:107-227`.
- Guard: org must be ACTIVE or PENDING_REVIEW to invite `invitation.py:169-172` — so a
  pending org CAN send invites (good), but invitees still can't get an active membership if
  they need admin (see 1.10).
- SPA: `InviteCreateModal` + `InvitationsListPanel` on the member directory page. ✅

### 1.8 Accept an invite — 🟡 partial

- `POST /api/invitations:accept/` (root) and `/api/orgs/invitations/accept/` alias →
  `InvitationAcceptView` `backend/apps/organizations/views.py:461-485`, `fixture/urls.py:28-32`,
  `organizations/urls.py:93-97`. **Requires authentication** (line 468) — a brand-new invitee
  must already have an account/session.
- Service `accept_invitation`: hash lookup, status/expiry checks, create-or-reactivate
  membership, mark invite accepted, session cycle, audit
  `backend/apps/organizations/services/invitation.py:230-322`.
- SPA: `/accept` route → `InviteAcceptPage` `frontend/src/App.tsx:111`.
- Partial because: (a) it does NOT activate the org if `pending_review` (only checks status is
  ACTIVE/PENDING `invitation.py:275-278`); (b) accepting an `admin`-role invite while the user
  already holds an active admin membership elsewhere will hit the
  `single_org_per_admin_user` DB constraint and raise IntegrityError (uncaught — see 1.10).

### 1.9 Assign modules (per-user override grants) — ✅ works

- `GET/PUT /api/permissions/orgs/{slug}/users/{user_uuid}/grants/` → `UserGrantsBySlugView`
  (admin-gated) `backend/apps/permissions/views.py:303-337`; matrix at
  `GET /api/permissions/orgs/{slug}/grants/matrix/` `views.py:340-372`.
- Service `bulk_set_grants` + resolver `effective_modules` (role defaults ∪ grant/deny
  overrides, cached) `backend/apps/permissions/services/resolver.py:107-132`.
- Note: resolver keys off ACTIVE memberships only `resolver.py:53-64` — a user with an inactive
  admin membership resolves to ZERO modules.
- SPA: `ModuleMatrixPage` + `GrantCell` `frontend/src/features/permissions/`. ✅

### 1.10 Assign roles to an invited member — 🟡 partial / latent 🔴

- Roles are assigned only at invite time (one role per invitation row; highest-tier wins from
  `roles[]`) `backend/apps/organizations/services/invitation.py:102-104, 142`. There is no
  standalone "change a member's role" endpoint; to add a second role you send another invite.
- `OrgMemberRemoveView` only deactivates (no role edit) `organizations/views.py:368-399`.
- Latent break: inviting/accepting `role=admin` collides with `single_org_per_admin_user`
  `backend/apps/organizations/models.py:229-233`. The accept path creates the membership
  without catching IntegrityError `invitation.py:287-293`, so a second-admin accept 500s.

### 1.11 Org switch — 🟡 partial

- No dedicated switch endpoint. The SPA navigates to `/o/{slug}/dashboard` and best-effort
  PATCHes `last_active_org_id` `frontend/src/features/orgs/OrgSwitcher.tsx:26-42`,
  `frontend/src/api/auth.ts:90-91`. Backend persists it in `me_view` PATCH
  `backend/apps/accounts/views.py:423-441`; `last_active_org_slug` is resolved on read
  `serializers.py:177-184`. Works for multi-org users, but most users have exactly one org
  (single-admin constraint), so switching is largely moot.

---

## 2. LOCKED desired flow assessment (org-as-hidden-personal-workspace)

Desired: any user signs up → starts a tournament → auto-provision their personal workspace org
→ they become that tournament's admin → invite by email → accept → assign roles. Self-serve,
NO super-admin approval gate. Reuse the 5 locked roles + per-user MembershipModuleGrant. Invites
become tournament-scoped via a NEW `TournamentMembership`.

What exists and is reusable: User/2FA/email-verify/login (1.4), Organization +
OrganizationMembership + AdminInvitation models, invitation create/accept service, module
resolver + grant overrides, audit, session cycling. The chassis is solid.

What is MISSING or BLOCKING for the desired flow:

1. ⛔ No tournament domain at all. No `apps/tournaments`, `apps/teams`, `apps/fixtures`,
   `apps/matches`, `apps/live`, `apps/notifications`, `apps/disputes`; `INSTALLED_APPS` lists
   only Phase-1A apps `backend/fixture/settings/base.py:48-55`. No `TournamentMembership`
   model, no bracket/schedule generator. Confirmed: no tournament routes; the SPA tournaments
   surface is a `ComingSoonPage` `frontend/src/App.tsx:171-174`.

2. 🔴 `single_org_per_admin_user` constraint is the single biggest structural blocker
   `backend/apps/organizations/models.py:229-233`. "Org as a hidden personal workspace, one per
   tournament" means a user who creates two tournaments needs two workspace orgs and would be
   admin/owner of both — impossible under this constraint. It also 500s on a second admin-role
   invite-accept (1.10). Either drop/relax this constraint, or model tournament admin via the
   NEW `TournamentMembership` instead of an org admin membership.

3. 🔴 Self-serve gate removed in spec but enforced in code: signup creates
   `status=pending_review` + inactive admin membership `signup.py:273, 287`, and the only
   activation path is SA `approve_org` `sadmin/views/orgs.py:68`. For the locked flow, signup
   (or first tournament creation) must auto-provision an ACTIVE org + ACTIVE owner membership
   with no SA step.

4. 🔴 Email verification doesn't activate workspace membership/org (1.3) — needs to, or the
   founder lands on an empty `/orgs`.

5. ⛔ No "create tournament" entrypoint (API or SPA) that auto-provisions the workspace +
   owner membership. `POST /api/orgs/` is SA-only `views.py:141-143`; nothing maps "start a
   tournament" → "create workspace + become admin".

6. ⛔ Tournament-scoped invitations. Current `AdminInvitation` is org-scoped
   `models.py:256-312`; the desired flow wants invites scoped to a tournament via
   `TournamentMembership`. Either generalize the invitation target or add a tournament invite.

7. 🟡 Invite-accept requires a pre-existing authenticated account `views.py:468`; the desired
   "invite by email → accept" for a brand-new person needs an unauthenticated accept-then-signup
   (or signup-with-invite-token) path so invitees don't first mint a junk personal org.

### single_org_per_admin_user implication (called out specifically)

Under org-as-hidden-workspace, every tournament a user starts implies one workspace org in
which they are the admin/owner. `single_org_per_admin_user`
(`backend/apps/organizations/models.py:229-233`, `Q(role="admin", is_active=True)` unique on
`user`) caps a user at ONE active admin membership platform-wide. Consequences:
- A user cannot create a second tournament workspace (the second admin membership violates the
  unique constraint → IntegrityError).
- A user invited as `admin`/co-admin to someone else's tournament workspace also cannot accept
  if they already own one (and the accept path doesn't catch the IntegrityError → 500).
This constraint must be dropped or replaced (move "tournament admin" off OrganizationMembership
and onto the planned `TournamentMembership`, leaving the workspace org owner as the only
org-level admin) before the locked flow can work.

---

## 3. Secondary issues observed in passing (corroborating the brief's known-issues list)

- drf-spectacular collision risk: duplicate slug-vs-uuid org routes and
  password_reset hyphen/underscore aliases share view callables with no distinct `operation_id`
  `backend/apps/accounts/urls.py:21-32`, `backend/apps/organizations/urls.py:93-127`,
  `backend/apps/permissions/urls.py:32-46`. Schema generation will warn/collide.
- Dev transport not live-ready: `InMemoryChannelLayer` + `LocMemCache`
  `backend/fixture/settings/base.py:186-196` — must move to channels-redis for invariants #4/#11.
- The module-resolver cache invalidation is single-process only (TODO at
  `backend/apps/permissions/services/resolver.py:42-50`) — fine for 1A, needs Redis pub/sub for 1B.
