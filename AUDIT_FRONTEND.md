# Frontend Phase 1A wiring audit — 2026-05-03

Scope: `frontend/src/**`. Verified routes in `App.tsx`, every `<Link>`/`<Navigate>`/`navigate()` target, every `src/api/*.ts` URL vs `backend/apps/*/urls.py`, dashboard cards, nav items, role-landing helper, auth bootstrap, and form ↔ serializer payloads. Build, type-check, and 25/25 vitest files (147/147 tests) pass.

---

## P0 — broken (route 404s on click, page crashes, undefined access, payload rejected)

- [ ] `src/api/auth.ts:43` — `authApi.signup` POSTs `{email,password,full_name}` but `SignupSerializer` (`backend/apps/accounts/serializers.py:14-17`) declares `email`, `password`, `name`. Backend silently drops `full_name`; the user’s name is lost. Symptom: signup completes but the new account has empty `name`, so the dashboard greets every signup as `(no name set)` (see `MyProfilePage.tsx:112`).
- [ ] `src/api/auth.ts:50` — `authApi.passwordResetComplete` posts `{token, password}` but `PasswordResetCompleteSerializer` (`backend/apps/accounts/serializers.py:38-40`) requires `{token, new_password}`. Backend will raise `ValidationError("This field is required: new_password")`. Symptom: clicking “Set password” always returns red “Reset failed” (`PasswordResetCompletePage.tsx:39-49`), regardless of token validity.
- [ ] `src/api/auth.ts:54-57` — `authApi.totpEnrollBegin` calls `POST /api/accounts/auth/2fa/enroll/begin/`. No such route — backend has only `auth/2fa/enroll/` (`backend/apps/accounts/urls.py:34`). Symptom: opening `/2fa/enroll` immediately renders “Could not start 2FA enrollment” (`TwoFactorEnrollPage.tsx:39`); 2FA can never be enabled in this build.
- [ ] `src/api/auth.ts:58-61` — `authApi.totpEnrollConfirm` calls `POST /api/accounts/auth/2fa/enroll/confirm/`. No such route — backend has `auth/2fa/confirm/` (`backend/apps/accounts/urls.py:35`). Symptom: even if enroll-begin worked, confirming the 6-digit code 404s.
- [ ] `src/api/auth.ts:63-64` — `authApi.totpChallenge` calls `POST /api/accounts/auth/2fa/challenge/`. No such backend route. The actual TOTP gate is part of `login_view` (it accepts `totp_code` in the same login body, `views.py:181`) or `auth/2fa/confirm/`. Symptom: any user with 2FA enabled cannot complete sign-in — `LoginPage` (`LoginPage.tsx:65-72`) and `TwoFactorChallengePage.tsx:24-31` both call `completeTotp`, which 404s.
- [ ] `src/api/auth.ts:47-48` — `authApi.passwordResetRequest` calls `POST /api/accounts/auth/password-reset/`. Backend has `auth/password_reset_request/` and the alias `auth/password-reset-request/` (`backend/apps/accounts/urls.py:22-26`). The route called by the frontend (`/auth/password-reset/`) exists for NEITHER. Symptom: password-reset request 404s but the page swallows it for anti-enumeration reasons (`PasswordResetRequestPage.tsx:29-31`), so the email is silently never sent.
- [ ] `src/features/auth/LoginPage.tsx:53` + `authStore.ts:54` — frontend sends `{email, password, totp}` (`api/auth.ts:21-24`); `LoginSerializer` (`backend/apps/accounts/serializers.py:24-27`) reads `email`, `password`, `totp_code`. The `totp` field is dropped, so 2FA-enabled users hitting the inline TOTP form (`LoginPage.tsx:97-117`) will get `requires_2fa: true` looped indefinitely.
- [ ] `src/api/orgs.ts:73-85` — `orgsApi.transferOwnership` posts `{to_user_id, reason, event_id, conflict_acknowledged}` to `/api/orgs/{slug}/ownership/transfer/`. `TransferOwnershipSerializer` (`backend/apps/organizations/views.py:692-708`) reads `new_owner_user_id`. Backend will 400 on every call. (Currently no caller exists — `OwnershipTransferModal.tsx` is dead code, see P1 — but if it gets wired up in any future phase, this will break instantly.)
- [ ] `src/api/orgs.ts:71-72` — `orgsApi.removeMember` does `DELETE /api/orgs/${slug}/members/${userId}/`. Backend `OrgMembersBySlugView` (`organizations/views.py:551`) implements only `GET`; there is no slug-routed DELETE. The UUID-based `OrgMemberRemoveView` (`urls.py:69-72`) expects `<uuid:uuid>/members/<uuid:membership_id>/`, not user_id. Symptom: clicking the “Remove member” menu item in `MemberDirectoryPage` (`MemberDirectoryPage.tsx:285-294`) → 404/405. The toast “Could not remove member” fires every time.
- [ ] `src/types/user.ts:38-49` and `src/api/auth.ts:39` — hand-written `User` type declares `full_name`, `is_active`, `is_staff`, `email_verified`, `totp_enabled`. The actual `MeSerializer` (`backend/apps/accounts/serializers.py:81-118`) returns `name`, `has_2fa_enrolled`, `email_verified_at`, `deleted_at` (no `full_name`/`is_staff`/`is_active`/`email_verified`/`totp_enabled`). Symptom: every read of `user.full_name` (`AppShell.tsx:157,174`; `MyProfilePage.tsx:45,49,53,98,112,171,182`; `dashboardCards.ts`; `OrgChooserPage.tsx`) returns `undefined`. Avatar initials (`MyProfilePage.tsx:52-58`) fall back to email; greeting reads `(no name set)` (`MyProfilePage.tsx:112`); 2FA-status pill always shows "Add an authenticator app…" because `user.totp_enabled` is undefined (`MyProfilePage.tsx:198-217`); email-verified hint always shows "Email not yet verified." (`MyProfilePage.tsx:149-152`); `ProtectedRoute` membership-redirect uses `user.is_staff` which is always undefined → falsy, so no super-admin escape (`ProtectedRoute.tsx:53`).
- [ ] `src/api/orgs.ts:53-54` — `orgsApi.list` is typed `OrgMembership[]` but `GET /api/orgs/` returns `OrganizationSerializer(many=True)` (`backend/apps/organizations/views.py:128-135`) — a list of `Organization` rows (with `id`, `slug`, `name`, `status`, `time_zone`, …) NOT memberships. No caller currently consumes it (graph search shows zero callers across `src/`), so this is latent. Listed here because the type is a lie waiting to bite.

## P1 — missing wiring (page exists but nothing routes to it; helper exists but unused)

- [ ] `src/features/roles/redirectByRole.ts:27` — `pickLandingPathForUser` is **only** referenced by its own test (`__tests__/redirectByRole.test.ts`, 16 call sites). No production caller. The CLAUDE.md spec calls this out as a B5 deliverable; today the post-login routing actually flows through `LandingPage.tsx:30-36` (which only checks `last_active_org_slug` then `memberships[0]`). Symptom: a user with `match_scorer` role (no admin role) and a `last_active_org_slug` set lands on `/o/<slug>/dashboard` instead of `/o/<slug>/scoring`. The role-aware routing the helper encodes is dead.
- [ ] `src/features/roles/routes.tsx:19` — `roleRoutes` constant is exported but never imported (`grep` returns only its declaration). The role-landing routes are inlined in `App.tsx:142-153` instead. Either delete `routes.tsx` or wire it in; right now it's drift waiting to happen — adding a new role page here will silently never appear.
- [ ] `src/features/orgs/OwnershipTransferModal.tsx:41` — `OwnershipTransferModal` is exported but never imported. v1Users.md §2.14 ownership-transfer flow has no entry point in the SPA. Symptom: org owners cannot transfer ownership through the UI; the only way is direct API call.
- [ ] `src/features/layout/OrgComingSoonPage.tsx:16` — `OrgComingSoonPage` is exported but never imported. The duplicate `ComingSoonPage` in `features/errors/ComingSoonPage.tsx` is what `App.tsx:158-171` actually mounts. Dead module.
- [ ] `src/features/layout/OrgDashboardPage.tsx:112-145` — Feedback modal opens but “Send” button at line 138-143 is a no-op (`onClick={(): void => setFeedbackOpen(false)}` only closes the dialog). No POST to a feedback endpoint, no toast, no validation. The `personal.feedback_widget` module advertises a non-functional card.
- [ ] `src/features/auth/authStore.ts:118-119` — `clear()` does NOT reset `bootstrapped`. `App.tsx:48-58` calls `clear()` on a global 401 from the query bus. After that, `bootstrapped` is still `true` and `user` is `null`, so `ProtectedRoute` (`ProtectedRoute.tsx:45-48`) correctly redirects to `/login?next=...`. This is fine — flagged here only because the spec asked for race-condition checks; the path is sound. (No issue.)
- [ ] `src/features/auth/authStore.ts:51-79` — `login()` happy path sets `bootstrapped: true`, but the `requires_2fa` branch (line 55-58) does NOT, AND it sets `requires2FA: true` without clearing the previous `user`. If a user is already logged in and re-submits login with a different account that requires 2FA, `requires2FA=true` while `user` remains set. `ProtectedRoute.tsx:41` only redirects to `/2fa/challenge` when `!user`, so the rebound never fires. Edge case — unlikely in practice but a real footgun.
- [ ] `src/api/auth.ts:18` — `_ApiUserPlaceholder` exported solely to silence "unused import" for `ApiUser`. The generated type is verified to include `memberships[]`/`last_active_org_slug`/`is_superuser` per the audit prompt, but `GetMeResponse` is still aliased to the hand-written `User`. The "deferral note" inside `src/types/generated.ts:6-15` is now stale.

## P2 — spec drift / weak typing

- [ ] `src/types/user.ts:18-24` — `Role` union is `owner|admin|scorer|referee|viewer|guest`. v1Users.md catalog uses `match_scorer`, `co_organizer`, `game_coordinator`, `team_manager`. `computeNavItems.ts:110-137` works around the gap with `roleStrings.includes("match_scorer")`. `redirectByRole.ts:38` casts `m.roles as string[]`. `OrgSwitcher.tsx:44` types the role as the narrow `Role` and will silently mis-type any wider role at runtime. Choose one: widen the union, or split into `LegacyRole | V1Role`.
- [ ] `src/api/orgs.ts:99` — re-exports `Role` from `user.ts`, but `OrgMember.roles` is widened to `string[]` (line 22-26). Drift between `User.memberships[].roles` (narrow `Role[]`) and `OrgMember.roles` (`string[]`). MemberDirectoryPage and InviteCreateModal will silently lose narrowing on roles.
- [ ] `src/components/ui/RoleBadge` (referenced from `InviteCreateModal.tsx:19`, `MemberDirectoryPage.tsx:18`, `InvitationsListPanel.tsx:18`) — `ROLE_KEYS` defines `[admin, co_organizer, game_coordinator, match_scorer, referee, team_manager]`, but the legacy `Role` union excludes those. So the badge takes `string` not `Role`. Reading `r === "owner" || r === "admin"` (`MemberDirectoryPage.tsx:269-271`) misses `co_organizer`/`game_coordinator` that v1Users specs as admin-like.
- [ ] `src/features/orgs/dashboardCards.ts:62` and `computeNavItems.ts:25` — both define their own `ADMIN_ROLES = {owner, admin}` and the comment in computeNavItems even says "must stay in sync." Two sources of truth. v1Users defines admin-likes more broadly (`co_organizer`, `game_coordinator`).
- [ ] `src/api/orgs.ts:46-51` — `MembersResponse = OrgMember[] | Paginated<OrgMember>`. Backend (`OrgMembersBySlugView.get`, `views.py:566-598`) always returns a plain list. `unwrapList` works either way but the optionality is dead weight.
- [ ] `src/lib/routes.ts:43-45` — defines `myProfile()`/`myNotifications()` as aliases of `profile()`/`profileNotifications()`. Two names for the same path. Pick one.
- [ ] `src/features/auth/LoginPage.tsx:55-58` — when `res.requires_2fa` is true, the inline TOTP form renders (`LoginPage.tsx:92-117`) AND `ProtectedRoute.tsx:41-43` would also try to redirect to `/2fa/challenge` if any other protected route is in the URL. Two TOTP UIs (inline on `/login` and full-page at `/2fa/challenge`) doing the same thing — pick one.
- [ ] `src/features/auth/SignupPage.tsx:20-21` — zod requires `password.min(12)` matching backend. ✓ Aligned.
- [ ] `src/features/auth/PasswordResetCompletePage.tsx:18` — zod requires `min(12)`. Backend `PasswordResetCompleteSerializer` (`accounts/serializers.py:40`) requires `min_length=12`. ✓ Aligned (modulo the wrong field name P0 above).
- [ ] `src/features/auth/TwoFactorChallengePage.tsx` — no zod, just a numeric-only `<Input>` with `maxLength=6`. Backend `LoginSerializer` accepts `totp_code` as `CharField(allow_blank=True)` — no length/format constraint — so the front looser-validates and the back won't tell us why a wrong code failed beyond a generic "invalid_2fa".
- [ ] `src/features/orgs/InviteCreateModal.tsx:45-49` — zod requires `roles.min(1)`. Backend `AdminInvitationCreateSerializer` (per OpenAPI re-exports) takes `email`, `role` OR `roles` (`OrgInvitationsBySlugView.post`, `views.py:622-633`). Frontend always sends `roles[]`. ✓ but message field (`InviteCreateModal.tsx:47`) is sent in the form payload (`onSubmit` builds without it, line 99-103 — message is dropped before POST). Symptom: the optional invite message users type is silently discarded; backend never sees it.
- [ ] `src/types/api.ts:24-30` — `ApiError.isPasswordReauthRequired` checks `payload.detail === "password_reauth_required"`. Backend never emits that string in the verified views I scanned (login returns `account_inactive`/`invalid_credentials`/`invalid_2fa`; reauth returns `invalid_password`). Either backend hasn't shipped reauth-required emission yet, or the string contract is undocumented. `PasswordReauthModal` will never trigger in current backend behavior.
- [ ] `src/features/orgs/MemberDirectoryPage.tsx:286` — `removeMember.mutationFn` passes `m.user_id` to `orgsApi.removeMember(slug, userId)`. Even after the URL is fixed (P0 above), backend `OrgMemberRemoveView` expects a `membership_id` not a `user_id`. The frontend `OrgMember.id?` (membership UUID) is the right field; `user_id` is wrong.
- [ ] `src/api/auth.ts:69-71` — `patchMe` sends `{last_active_org_id?, full_name?}`. Backend `MeSerializer` writeable fields (`accounts/serializers.py:108-118` `read_only_fields`) are everything except `name` and `last_active_org_id`. So PATCHing `full_name` is silently dropped (backend reads `name`); PATCHing `last_active_org_id` works.

## Section A — Route table

| Path | Element | Page file | Uses `:orgSlug` | Protected | Renders ok |
|---|---|---|---|---|---|
| `/` | `<LandingPage />` | `features/landing/LandingPage.tsx` | n | n | yes (auth-aware redirect at line 30-36) |
| `/about` | `<AboutPage />` | `features/landing/AboutPage.tsx` | n | n | yes (stub) |
| `/login` | `<LoginPage />` | `features/auth/LoginPage.tsx` | n | n | yes |
| `/signup` | `<SignupPage />` | `features/auth/SignupPage.tsx` | n | n | yes (but signup loses `name`, P0) |
| `/verify-email` | `<VerifyEmailPage />` | `features/auth/VerifyEmailPage.tsx` | n | n | yes |
| `/password-reset` | `<PasswordResetRequestPage />` | `features/auth/PasswordResetRequestPage.tsx` | n | n | yes (request 404s silently, P0) |
| `/password-reset/complete` | `<PasswordResetCompletePage />` | `features/auth/PasswordResetCompletePage.tsx` | n | n | renders, submit always errors (P0) |
| `/2fa/enroll` | `<TwoFactorEnrollPage />` | `features/auth/TwoFactorEnrollPage.tsx` | n | n | shows error on mount (P0) |
| `/2fa/challenge` | `<TwoFactorChallengePage />` | `features/auth/TwoFactorChallengePage.tsx` | n | n | renders, verify always 404s (P0) |
| `/accept` | `<InviteAcceptPage />` | `features/orgs/InviteAcceptPage.tsx` | n | n | yes |
| `/orgs` | `<OrgChooserPage />` | `features/layout/OrgChooserPage.tsx` | n | y | yes |
| `/me` | `<MyProfilePage />` | `features/roles/MyProfilePage.tsx` | n | y | renders but `full_name`/`totp_enabled`/`email_verified` undefined → wrong empty/disabled state (P0 #10) |
| `/me/notifications` | `<NotificationPrefsPage />` | `features/roles/NotificationPrefsPage.tsx` | n | y | yes (stub) |
| `/o/:orgSlug/dashboard` | `<OrgDashboardPage />` | `features/layout/OrgDashboardPage.tsx` | y | y | yes (feedback modal "Send" no-ops, P1) |
| `/o/:orgSlug/members` | `<MemberDirectoryPage />` | `features/orgs/MemberDirectoryPage.tsx` | y | y | renders, Remove menu always errors (P0) |
| `/o/:orgSlug/permissions` | `<ModuleMatrixPage />` | `features/permissions/ModuleMatrixPage.tsx` | y | y | yes |
| `/o/:orgSlug/scoring` | `<ScorerLandingPage />` | `features/roles/ScorerLandingPage.tsx` | y (read via `useParams`) | y | yes (Phase 1B teaser only) |
| `/o/:orgSlug/referee` | `<RefereeLandingPage />` | `features/roles/RefereeLandingPage.tsx` | y | y | yes (Phase 1B teaser only) |
| `/o/:orgSlug/team` | `<TeamManagerLandingPage />` | `features/roles/TeamManagerLandingPage.tsx` | y | y | yes (Phase 1B teaser only) |
| `/o/:orgSlug/audit` | `<ComingSoonPage />` | `features/errors/ComingSoonPage.tsx` | y (no, slug not used; falls back to `last_active_org_slug`) | y | yes |
| `/o/:orgSlug/settings` | `<ComingSoonPage />` | same | y (same — slug from URL ignored) | y | yes |
| `/o/:orgSlug/branding` | `<ComingSoonPage />` | same | (slug unused) | y | yes |
| `/o/:orgSlug/tournaments-coming-soon` | `<ComingSoonPage />` | same | (slug unused) | y | yes |
| `*` | `<NotFoundPage />` | `features/errors/NotFoundPage.tsx` | n | n | yes |

Note: `ComingSoonPage` ignores the `:orgSlug` URL param and reads from `user.last_active_org_slug` instead (`ComingSoonPage.tsx:36-41`). If a user deep-links to `/o/foo/audit` while `last_active_org_slug` is `bar`, the “Back to dashboard” button takes them to `/o/bar/dashboard`. Mild surprise.

## Section B — Navigation destinations

Every `<Link to=>` / `<Navigate to=>` / `navigate(...)` target across `src/`:

| Caller | Target | In route table? |
|---|---|---|
| `AuthLayout.tsx:41` | `/` | ✓ |
| `LandingPage.tsx:34` | `routes.orgDashboard(slug)` | ✓ |
| `LandingPage.tsx:35` | `routes.orgChooser()` (`/orgs`) | ✓ |
| `LandingPage.tsx:44,61,66,100,108,182,188` | `/`, `/login`, `/signup`, `/about` | ✓ |
| `LoginPage.tsx:57,68` | `next` (validated absolute path or `/`) | ✓ unless `next` was a deep link mistyped |
| `LoginPage.tsx:143,168` | `/password-reset`, `/signup` | ✓ |
| `SignupPage.tsx:113,230,250` | `/login`, `/about`, `/login` | ✓ |
| `VerifyEmailPage.tsx:64` | `/login` | ✓ |
| `PasswordResetRequestPage.tsx:51,92` | `/login` | ✓ |
| `PasswordResetCompletePage.tsx:42,68` | `/login`, `/password-reset` | ✓ |
| `TwoFactorChallengePage.tsx:28` | `routes.root()` (`/`) | ✓ |
| `TwoFactorEnrollPage.tsx:94` | `/` | ✓ |
| `InviteAcceptPage.tsx:76,86` | `/login?next=...`, `/o/<slug>/dashboard` | ✓ |
| `MyProfilePage.tsx:86,212,249,273` | `/login`, `/2fa/enroll`, `/o/<slug>/dashboard`, `/password-reset` | ✓ |
| `NotificationPrefsPage.tsx:49` | `/me` | ✓ |
| `RoleLandingShell.tsx:98,109` | `/me`, `/me/notifications` | ✓ |
| `AppShell.tsx:81,130,183,191,255,261` | `/login`, `/`, `/me`, `/me/notifications` | ✓ |
| `App.tsx:54` | `/login` | ✓ |
| `ProtectedRoute.tsx:42,47,56` | `/2fa/challenge`, `/login?next=...`, `/orgs` | ✓ |
| `OrgChooserPage.tsx:27` | `/o/<slug>/dashboard` | ✓ |
| `OrgComingSoonPage.tsx:31` (DEAD CODE) | `/o/<slug>/dashboard` | ✓ |
| `ComingSoonPage.tsx:39-41` | `/o/<slug>/dashboard` or `/orgs` | ✓ |
| `OrgSwitcher.tsx:40` | `/o/<slug>/dashboard` | ✓ |
| `NotFoundPage.tsx:38,44` | `/`, `/login` | ✓ |
| `dashboardCards.ts` (every `href`) | `routes.orgMembers/orgSettings/orgPermissions/orgAudit/orgBranding/orgTournamentsComingSoon/profile/profileNotifications` | all ✓ |
| `computeNavItems.ts` (every `href`) | `routes.orgDashboard/orgMembers/orgPermissions/orgAudit/orgScoring/orgReferee/orgTeam` | all ✓ |
| `redirectByRole.ts` returns `routes.orgChooser/orgDashboard/orgScoring/orgReferee/orgTeam` | (helper unused) | ✓ in theory |

**No broken links found.** All `<Link>`/`navigate()` destinations resolve to a registered route.

## Section C — API → backend endpoint map

| Frontend (`src/api/`) | URL | Backend route | Match? |
|---|---|---|---|
| `auth.me()` | `GET /api/accounts/me/` | `accounts/urls.py:43` | ✓ |
| `auth.login(payload)` | `POST /api/accounts/auth/login/` | `accounts/urls.py:18` | URL ✓ — payload field `totp` should be `totp_code` (P0) |
| `auth.logout()` | `POST /api/accounts/auth/logout/` | `accounts/urls.py:19` | ✓ |
| `auth.signup(payload)` | `POST /api/accounts/auth/signup/` | `accounts/urls.py:15` | URL ✓ — payload `full_name` should be `name` (P0) |
| `auth.verifyEmail(token)` | `POST /api/accounts/auth/verify-email/` | `accounts/urls.py:17` | ✓ |
| `auth.passwordResetRequest(email)` | `POST /api/accounts/auth/password-reset/` | NO MATCH — backend has `password_reset_request/` and `password-reset-request/` only | ✗ (P0) |
| `auth.passwordResetComplete(token, password)` | `POST /api/accounts/auth/password-reset/complete/` | NO MATCH — backend has `password_reset_complete/` and `password-reset-complete/` only | ✗ (P0) |
| `auth.totpEnrollBegin()` | `POST /api/accounts/auth/2fa/enroll/begin/` | NO MATCH — backend has `auth/2fa/enroll/` only | ✗ (P0) |
| `auth.totpEnrollConfirm(totp)` | `POST /api/accounts/auth/2fa/enroll/confirm/` | NO MATCH — backend has `auth/2fa/confirm/` (also accepts `code`, not `totp`) | ✗ (P0) |
| `auth.totpChallenge(totp)` | `POST /api/accounts/auth/2fa/challenge/` | NO MATCH | ✗ (P0) |
| `auth.reauth(password)` | `POST /api/accounts/auth/reauth/` | `accounts/urls.py:20` | ✓ |
| `auth.patchMe(patch)` | `PATCH /api/accounts/me/` | `accounts/urls.py:43` | URL ✓ — `full_name` field silently dropped (backend reads `name`) |
| `orgs.list()` | `GET /api/orgs/` | `organizations/urls.py:36` | URL ✓ — return shape mismatch: backend returns `Organization[]`, frontend types `OrgMembership[]` (P0/latent) |
| `orgs.members(slug)` | `GET /api/orgs/{slug}/members/` | `organizations/urls.py:99-103` | ✓ |
| `orgs.invitations(slug)` | `GET /api/orgs/{slug}/invitations/` | `organizations/urls.py:104-108` | ✓ |
| `orgs.createInvitation(slug, body)` | `POST /api/orgs/{slug}/invitations/` | same | URL ✓ — `message` field never sent (form drops it before POST), see P2 |
| `orgs.revokeInvitation(slug, id)` | `DELETE /api/orgs/{slug}/invitations/{id}/` | `organizations/urls.py:111-114` | ✓ |
| `orgs.acceptInvitation(token)` | `POST /api/orgs/invitations/accept/` | `organizations/urls.py:93-97` | ✓ |
| `orgs.removeMember(slug, userId)` | `DELETE /api/orgs/{slug}/members/{userId}/` | NO MATCH — slug-routed view is GET-only; UUID-routed `OrgMemberRemoveView` expects `{org_uuid}/members/{membership_id}/` | ✗ (P0) |
| `orgs.transferOwnership(slug, body)` | `POST /api/orgs/{slug}/ownership/transfer/` | `organizations/urls.py:117-121` | URL ✓ — body `to_user_id` should be `new_owner_user_id` (P0) |
| `permissions.modules()` | `GET /api/permissions/modules/` | `permissions/urls.py:21` | ✓ |
| `permissions.myModules(slug)` | `GET /api/permissions/orgs/{slug}/me/modules/` | `permissions/urls.py:36-41` | ✓ |
| `permissions.matrix(slug)` | `GET /api/permissions/orgs/{slug}/grants/matrix/` | `permissions/urls.py:32-36` | ✓ |
| `permissions.setGrants(slug, userId, body)` | `PUT /api/permissions/orgs/{slug}/users/{userId}/grants/` | `permissions/urls.py:42-46` | ✓ (backend accepts both `cells` and `grants` payloads, `views.py:217-232`) |

## Section D — Build/test status

```
npm run type-check  →  exit 0
> tsc -b --noEmit
(silent, clean)

npm run build       →  exit 0
> tsc -b && vite build
✓ 1929 modules transformed.
dist/index.html                   0.45 kB │ gzip:   0.29 kB
dist/assets/index-B7hefB4V.css   26.91 kB │ gzip:   5.99 kB
dist/assets/index-C5YocpI5.js   496.61 kB │ gzip: 147.74 kB
✓ built in 1.16s

npm test            →  exit 0
> vitest run
 Test Files  25 passed (25)
      Tests  147 passed (147)
   Start at  01:33:24
   Duration  12.18s
```

All green. The audit findings above are runtime / contract issues that the type-check cannot catch (URLs are string literals; payloads are typed only on the frontend side; `User.full_name` is "real" in TS but absent in the JSON the backend actually sends).

---

## Cross-cutting summary

The biggest single source of P0 bugs is **`src/api/auth.ts` ↔ `backend/apps/accounts/urls.py + serializers.py`**: 6 of the 11 P0 entries are auth-route or auth-payload mismatches. Every flow that exits the basic email+password login path (signup name, password reset, 2FA enroll, 2FA challenge, password-reset complete) is broken. The second-biggest cluster is the **`User`-shape lie** between hand-written `types/user.ts` and `MeSerializer` — the field renames (`full_name`→`name`, `totp_enabled`→`has_2fa_enrolled`, `email_verified`→`email_verified_at`, removed `is_active`/`is_staff`) cascade into `MyProfilePage`, `AppShell`, `dashboardCards`, and `ProtectedRoute`. Fix the `User` type alone, and 4 P0/P1 visible-symptom bugs collapse into one corrected serializer-driven type.

Two helpers were merged into `src/features/roles/` but never wired (`pickLandingPathForUser`, `roleRoutes`); two components were built and never imported (`OwnershipTransferModal`, `OrgComingSoonPage`). They’re safe to delete or wire up; what they cannot remain is unused.

Otherwise the route table is internally consistent — every `<Link>`/`navigate()` target resolves to a registered route, no in-app navigation falls through to `<NotFoundPage>`.
