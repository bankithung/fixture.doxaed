# Cross-Contract Matrix — `frontend/src/api/*.ts` vs Backend Routes + Serializers

Audit date: 2026-06-04
Scope: every exported function in `frontend/src/api/*.ts`, cross-referenced against the
Django/DRF routes (`backend/apps/**/urls.py`, `backend/fixture/urls.py`) and the response/request
serializer shapes that back them, plus the TypeScript types each call is typed against
(`frontend/src/types/*.ts`).

Method: read real source (no schema generation run). Each row classified as:
- **route exists** (FE path resolves to a Django pattern),
- **serializer shape matches the FE type** (request body fields + response body fields),
- **unused** (FE method has no caller in `frontend/src`).

`.venv` and `node_modules` ignored entirely.

---

## Full FE → Backend route matrix

Legend: ✅ ok · ⚠️ partial/mismatch · ❌ missing/broken · 🅄 unused (no caller)

### `auth.ts`

| FE method | method + path | route? | shape match? |
|---|---|---|---|
| `me()` | GET `/api/accounts/me/` | ✅ `accounts.urls:me` | ✅ `MeSerializer` ↔ `User` |
| `login()` | POST `/api/accounts/auth/login/` | ✅ | ⚠️ response shape mismatch (see F1) |
| `logout()` | POST `/api/accounts/auth/logout/` | ✅ | ✅ (void) |
| `signup()` | POST `/api/accounts/auth/signup/` | ✅ | ⚠️ response shape mismatch (see F2) |
| `verifyEmail()` | POST `/api/accounts/auth/verify-email/` | ✅ (hyphen alias) | ⚠️ response shape mismatch (see F3) |
| `passwordResetRequest()` | POST `/api/accounts/auth/password-reset-request/` | ✅ (hyphen alias) | ⚠️ response shape mismatch (see F3) |
| `passwordResetComplete()` | POST `/api/accounts/auth/password-reset-complete/` | ✅ (hyphen alias) | ⚠️ response shape mismatch (see F3) |
| `totpEnrollBegin()` | POST `/api/accounts/auth/2fa/enroll/` | ✅ | ✅ `TwoFAEnrollResponseSerializer` |
| `totpEnrollConfirm()` | POST `/api/accounts/auth/2fa/confirm/` | ✅ | ✅ (`code` in, `recovery_codes` out) |
| `reauth()` | POST `/api/accounts/auth/reauth/` | ✅ | ⚠️ returns `{status:"ok"}` not `{ok:true}` (F3) |
| `patchMe()` | PATCH `/api/accounts/me/` | ✅ | ✅ `MeSerializer` |

### `orgs.ts`

| FE method | method + path | route? | shape match? |
|---|---|---|---|
| `list()` | GET `/api/orgs/` | ✅ `org-list` | ✅ `OrganizationSerializer[]` |
| `members()` | GET `/api/orgs/{slug}/members/` | ✅ `org-members-by-slug` | ✅ `OrgMemberDetailSerializer` ↔ `OrgMember` |
| `invitations()` | GET `/api/orgs/{slug}/invitations/` | ✅ `org-invitations-by-slug` | ❌ shape mismatch (see F4) |
| `createInvitation()` | POST `/api/orgs/{slug}/invitations/` | ✅ | ❌ response shape mismatch (see F4) |
| `revokeInvitation()` | DELETE `/api/orgs/{slug}/invitations/{id}/` | ✅ `org-invitation-by-id-slug` | ✅ (204) |
| `acceptInvitation()` | POST `/api/orgs/invitations/accept/` | ✅ `org-invitations-accept` | ❌ response shape mismatch (see F5) |
| `removeMember()` | DELETE `/api/orgs/{uuid}/members/{membership_id}/` | ✅ `org-member-remove` | ✅ (204) |
| `transferOwnership()` | POST `/api/orgs/{slug}/ownership/transfer/` | ✅ `org-ownership-transfer-by-slug` | ✅ (serializer accepts `new_owner_user_id` + alias) |

### `permissions.ts`

| FE method | method + path | route? | shape match? |
|---|---|---|---|
| `modules()` | GET `/api/permissions/modules/` | ✅ `module-catalog` | ❌ shape mismatch + 🅄 unused (see F6) |
| `myModules()` | GET `/api/permissions/orgs/{slug}/me/modules/` | ✅ `my-modules-by-slug` | ✅ `{modules:string[]}` |
| `matrix()` | GET `/api/permissions/orgs/{slug}/grants/matrix/` | ✅ `matrix` | ✅ `MatrixResponseSerializer` ↔ `ModuleMatrixResponse` |
| `setGrants()` | PUT `/api/permissions/orgs/{slug}/users/{userId}/grants/` | ✅ `user-grants-by-slug` | ✅ (`cells`/`reason`/`event_id` accepted) |

### `audit.ts`

| FE method | method + path | route? | shape match? |
|---|---|---|---|
| `list()` | GET `/api/audit/orgs/{slug}/?…` | ✅ `org-audit-list` | ✅ `AuditEventListResponseSerializer` (cursor/next_cursor/previous_cursor all present) |

### `feedback.ts`

| FE method | method + path | route? | shape match? |
|---|---|---|---|
| `submit()` | POST `/api/feedback/submit/` | ✅ `feedback-submit` | ⚠️ request field-name mismatch (see F7) |

---

## Findings

### F1 — `login()` response type declares `user` the backend never sends
**Severity: low** (works by luck via a fallback)
`frontend/src/api/auth.ts:24-28`
```ts
export interface LoginResponse {
  requires_2fa?: boolean;
  user?: User;
}
```
Backend `login_view` (`backend/apps/accounts/views.py:243-253`) returns `{"status": "ok"}` on success and
`{"requires_2fa": True}` on the 2FA gate (line 227-230). It never returns a `user` key. The FE type advertises
`user?: User` as if it might be populated.

Why it matters: not currently a runtime bug because `authStore.ts:83` / `:119` do `const user = res.user ?? (await authApi.me())` — `res.user` is always `undefined`, so it silently falls back to a second `/me/` round-trip. The type is misleading and the extra round-trip is unnecessary.

Recommendation: either (a) make the backend embed `user: MeSerializer(user).data` in the login 200 response and drop the second `/me/` call, or (b) remove `user?` from `LoginResponse` and document the always-refetch behavior.

### F2 — `signup()` response type `{ user: User }` does not match backend
**Severity: low**
`frontend/src/api/auth.ts:55-56`
```ts
signup: (payload) => api.post<{ user: User }>("/api/accounts/auth/signup/", payload),
```
Backend `signup` (`backend/apps/accounts/views.py:119,125-126,148`) returns `{"status": "pending_verification"}` (200 on idempotent replay, 201 fresh). There is no `user` key — by design (signup creates a *pending, inactive* user that must verify email first).

Why it matters: any caller reading `res.user` gets `undefined`. `SignupPage.tsx:71` calls `authApi.signup(...)` but does not read the response body, so no live break today; the type is still a lie that will mislead the next developer.

Recommendation: change the type to `{ status: "pending_verification" }`.

### F3 — auth side-effect endpoints return `{status:...}`, FE types claim `{ok:true}` / `{ok:true}`/`{status:"verified"}`
**Severity: low**
`frontend/src/api/auth.ts:57-67,87-88`
```ts
verifyEmail: (token) => api.post<{ ok: true }>(".../verify-email/", { token }),
passwordResetRequest: (email) => api.post<{ ok: true }>(".../password-reset-request/", { email }),
passwordResetComplete: (token, new_password) => api.post<{ ok: true }>(".../password-reset-complete/", {...}),
reauth: (password) => api.post<{ ok: true }>(".../reauth/", { password }),
```
Actual backend responses:
- `verify_email` → `{"status": "verified"}` (`views.py:186`) or `{"detail":"invalid_or_expired_token"}` (400).
- `password_reset_request_view` → `{"status": "ok"}` (`views.py:304`).
- `password_reset_complete_view` → `{"status": "ok"}` (`views.py:323`).
- `reauth_view` → `{"status": "ok"}` (`views.py:285`).

None ever returns an `ok` field.

Why it matters: callers (`VerifyEmailPage.tsx:22`, `PasswordReset*Page.tsx`, `PasswordReauthModal.tsx:46`) rely only on the absence of a thrown `ApiError` (2xx) rather than reading `.ok`, so behavior is correct, but the declared response contract is wrong across four methods.

Recommendation: retype all four as `{ status: string }` (or `void`) to match. Cheap, prevents a future caller from branching on a field that is always `undefined`.

### F4 — Invitation list/create: FE expects `roles[]` + `token`; backend returns `role` (singular), `invited_by` (UUID), `effective_status`, never `token`/`roles`
**Severity: high** (visible UI defect)
FE side:
- `orgs.ts:44-53` `InvitationListItem` declares `roles: string[]`, `status`, `invited_by_email`, optional `token`.
- `orgs.ts:75-79` `createInvitation` typed to return `OrgInvitation` (`types/user.ts:136-145`) — also `roles: Role[]`, `token?`, `invited_by_email`.
- Consumer `InvitationsListPanel.tsx:137` renders `(invitation.roles ?? []).map(...)` and `:114` builds a share link from `invitation.token`.

Backend side — both list and create return `AdminInvitationSerializer` (`backend/apps/organizations/serializers.py:160-184`, returned by `OrgInvitationsBySlugView.get/post` `views.py:560-587`):
```py
fields = ["id","organization","email","role","status","effective_status",
          "expires_at","accepted_at","revoked_at","created_at","invited_by"]
```
Mismatches:
- FE reads `roles` (plural array) → backend only has `role` (single string). Role badges in the pending-invitation list render **empty**.
- FE reads `token` → backend list/create responses **never include a token** (created plaintext token is discarded: `inv, _plaintext = invitation_svc.create_invitation(...)`, `views.py:574`). So the "copy invite link" affordance can never appear from the list, and the create-success surface (`InviteCreateModal.tsx:247` `invitation.token ?? ""`) is always empty.
- FE reads `invited_by_email` → backend returns `invited_by` (a UUID), not an email.

Why it matters: this is a real, user-visible contract break (empty role badges, no shareable invite link), not just a typing nit. The `status === "pending"` filter (`InvitationsListPanel.tsx:69`) happens to work because `status` exists, but `effective_status` is the field that actually flips pending→expired at read time.

Recommendation: pick one canonical shape. Either (a) extend `AdminInvitationSerializer` to emit `roles: [role]`, `invited_by_email` (resolve the FK), and surface the plaintext `token` on the create response only (list must stay token-less for security), or (b) change the FE types/consumers to `role` (singular) + `invited_by` and drop the token-from-list assumption. Note the create flow especially needs the token returned to be usable.

### F5 — `acceptInvitation()` expects `{ org_slug, membership }`; backend returns the membership row alone (no `org_slug`)
**Severity: high** (runtime: redirect target is `undefined`)
`frontend/src/api/orgs.ts:82-86`
```ts
acceptInvitation: (token) =>
  api.post<{ org_slug: string; membership: Membership }>("/api/orgs/invitations/accept/", { token }),
```
Backend `InvitationAcceptView.post` (`backend/apps/organizations/views.py:471-485`, inherited by `InvitationAcceptByPathView` line 621) returns:
```py
return Response(OrganizationMembershipSerializer(membership).data, status=200)
```
That serializer (`serializers.py:139-152`) emits `id,user,organization,role,is_org_owner,is_active,created_at,removed_at`. There is **no top-level `org_slug`** and **no `membership` wrapper** — the membership fields are at the top level, and `organization` is a UUID, not a slug.

Consumer `InviteAcceptPage.tsx:46` does `setOrgSlug(res.org_slug)` → this is `undefined` at runtime, so the post-accept redirect/label loses the org slug.

Why it matters: confirmed runtime defect — the accept page cannot show or route to the joined org by slug.

Recommendation: wrap the backend response as `{ org_slug: org.slug, membership: <serialized> }` to match the FE, or change the FE to read `res.organization` (UUID) and resolve slug separately. The former is less churn.

### F6 — `permissionsApi.modules()` is both unused AND shape-mismatched
**Severity: medium** (dead code + wrong type)
`frontend/src/api/permissions.ts:10`
```ts
modules: () => api.get<ModuleDef[]>("/api/permissions/modules/"),
```
1. **Unused:** no component calls `permissionsApi.modules()` (grep across `frontend/src` finds only the definition). The matrix page reads modules from `matrixQ.data.modules` instead (`ModuleMatrixPage.tsx:160`).
2. **Shape mismatch:** the route exists (`ModuleCatalogView`, `permissions/urls.py:21`) but returns `ModuleSerializer` = `{id, code, name, description, category, default_for_roles}` (`backend/apps/permissions/serializers.py:9-14`). The FE `ModuleDef` (`types/user.ts:33-39`) is `{key, scope, label, description}`. Field-for-field divergent: `code`≠`key`, `name`≠`label`, no `scope`, extra `category`/`default_for_roles`/`id`. If ever called, every `m.key`/`m.scope`/`m.label` read would be `undefined`.

Note: the matrix endpoint's `modules` array IS `{key,scope,label,description}` (`MatrixModuleSerializer`, `serializers.py:68-74`) — so the two "module" payloads in the backend deliberately differ, and only the matrix one matches `ModuleDef`.

Recommendation: delete `permissionsApi.modules()` (dead), or if it's intended for a future standalone catalog UI, add a separate `ModuleCatalogItem` type matching `ModuleSerializer` and wire a mapper to `ModuleDef`.

### F7 — `feedback.submit()` sends `source_url`; backend serializer field is `page_url` (silently dropped)
**Severity: medium**
`frontend/src/api/feedback.ts:8-17` declares `source_url?: string`, and the live caller sends it:
`OrgDashboardPage.tsx:80-83`
```ts
await feedbackApi.submit({ message, source_url: window.location.pathname, event_id: ... });
```
Backend `FeedbackSubmitSerializer` (`backend/apps/sadmin/serializers.py:29-42`) defines `message, page_url, screenshot_data_uri, category, subject, event_id` — **no `source_url`**. DRF ignores unknown input keys by default, so the page context the user expects to attach is **silently discarded** (the view composes the body from `page_url`, `feedback.py:157,161-162`).

Also note FE `category?: string` is free-form, but backend `category` is a `ChoiceField` over `{bug,feature_request,complaint,praise,other}` — an out-of-set category would 400; current caller never sends one, so no live break there.

Why it matters: a feature (capturing the originating page URL with feedback) is wired on the FE but goes nowhere. Low blast radius but a genuine broken data path.

Recommendation: rename the FE field to `page_url` (and the caller key), or add a `source_url` alias on the serializer that maps to `page_url`.

### F8 — `me()` returns 403 (not 401) when logged out → confirmed; bootstrap handles it but `/login` may flash an error
**Severity: medium** (known issue, confirmed)
`authStore.ts:50` only treats `status === 401` as the clean "logged out" path:
```ts
if (e instanceof ApiError && e.status === 401) { set({ user:null, ... }); return; }
```
The accounts `me_view` is `@permission_classes([IsAuthenticated])` (`accounts/views.py:417`). With DRF `SessionAuthentication`, an unauthenticated request to an `IsAuthenticated` view returns **403** (not 401) unless an authenticator sets `WWW-Authenticate`. The FE has a 403-coping path (`ApiError.isUnauthenticated` in `types/api.ts:32-45` treats 403-with-"not authenticated"-detail as unauthenticated, and `queryClient.ts:38` emits an `unauthenticated` event), but `authStore.bootstrap`'s own `catch` does NOT use `isUnauthenticated` — it checks `status === 401` literally and otherwise sets `error: ...`. So a logged-out bootstrap can land in the generic-error branch and surface a transient error banner.

Why it matters: matches the reported "premature error banner on /login" symptom; the inconsistency is that `bootstrap` checks raw `401` while the rest of the app uses `isUnauthenticated` (which covers 403).

Recommendation: in `authStore.bootstrap` use `e instanceof ApiError && e.isUnauthenticated` instead of `e.status === 401`. Optionally also have DRF return a true 401 for unauthenticated API requests (set a 401-yielding authenticator / `WWW-Authenticate` header) so the whole stack is consistent.

---

## Gaps (no FE client exists for these backend routes)

The FE only covers Phase 1A surfaces. The following backend routes have **no `frontend/src/api/*.ts` client function** (some are intentionally console-only):

| Backend route | name | Has FE client? | Note |
|---|---|---|---|
| POST `/api/orgs/{uuid}:change_slug/` | `org-change-slug` | ❌ | UUID colon-verb; FE has no slug-change call |
| POST `/api/orgs/{uuid}:suspend/` / `:unsuspend/` / `:archive/` | org lifecycle | ❌ | super-admin/owner verbs; no SPA client (sadmin console drives these via HTML) |
| POST `/api/orgs/{uuid}:transfer_ownership/` | `org-transfer-ownership` | ⚠️ | FE uses the slug alias `/ownership/transfer/` instead; UUID colon-verb unused by SPA |
| GET/POST `/api/orgs/{uuid}/members/`, `/invitations/`, `:revoke/` | UUID-routed canonical | ❌ | FE exclusively uses the slug aliases; UUID variants are dead w.r.t. the SPA |
| POST `/api/invitations:accept/` | `invitations-accept` (root) | ⚠️ | FE uses the `/api/orgs/invitations/accept/` path alias; the root colon-verb has no FE caller |
| GET `/api/accounts/auth/verify_email/` (underscore), `password_reset_request/`, `password_reset_complete/` (underscore) | accounts | ❌ | FE uses only the hyphen aliases; underscore originals unused by SPA |
| POST `/api/accounts/auth/2fa/disable/` | `twofa_disable` | ❌ | no FE client method (no disable-2FA UI wired) |
| POST `/api/accounts/auth/2fa/recovery_codes:regenerate/` | `twofa_recovery_regenerate` | ❌ | no FE client method |
| POST `/api/accounts/users/{uuid}:soft_delete/` | `user_soft_delete` | ❌ | super-admin only; sadmin console territory |
| GET `/api/permissions/me/modules/?org={uuid}` | `my-modules` (query-param form) | ❌ | FE uses the slug alias only |
| GET/PUT `/api/permissions/orgs/{org_uuid}/users/{uuid}/grants/` | `user-grants` (UUID form) | ❌ | FE uses the slug alias only |
| GET `/api/sports/`, GET `/api/sports/{code}/` | sports catalog | ❌ | no `frontend/src/api/sports.ts` exists at all |
| `/sadmin/...` (all) + `/sadmin/api/...` | super-admin console | n/a | HTML console + console-only JSON; not SPA contract |

### Larger structural gaps
- **No Phase 1B API clients** exist (`tournaments`, `teams`, `fixtures`/bracket+schedule, `matches`, `live`, `notifications`, `disputes`). Confirmed: `frontend/src/api/` contains only `auth, orgs, permissions, audit, feedback, client, queryClient`. This is expected per project status, recorded here for completeness.
- **Duplicate-route surface from drf-spectacular**: the hyphen vs underscore auth aliases (`accounts/urls.py:16-17,26,32`), and slug-vs-UUID org/permission routes, will collide on `operationId` in the OpenAPI schema and on enum names (`RoleEnum` vs `RolesEnum`, `api.generated.ts:1164,1174` — both identical 6-value enums). This is a schema-generation hygiene gap, not an FE↔BE call break, but it pollutes `api.generated.ts`.

---

## Summary of severities
- **high:** F4 (invitation list/create shape — empty role badges, no invite link/token), F5 (accept response missing `org_slug` → undefined redirect).
- **medium:** F6 (`modules()` unused + wrong shape), F7 (`source_url` silently dropped), F8 (403-vs-401 bootstrap inconsistency).
- **low:** F1/F2/F3 (auth response types claim fields the backend never returns; harmless today only because callers don't read them).
