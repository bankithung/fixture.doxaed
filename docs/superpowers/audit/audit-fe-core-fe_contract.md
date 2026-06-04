# Audit: fe-core — API Contract
**Date:** 2026-06-04
**Scope:** `frontend/src` — api/*.ts calls hit real routes; request/response shapes match types/*.ts + serializers; non-2xx handling; loading/empty/error states present.
**Auditor:** Claude Sonnet 4.6

---

## Findings

### F-01 [HIGH] Login response type mismatch — frontend expects `{ user?, requires_2fa? }`, backend always returns `{ status: "ok" }` or `{ requires_2fa: true }`

- **File:** `frontend/src/api/auth.ts:28` / `backend/apps/accounts/views.py:228,253`
- **Evidence (FE):** `export interface LoginResponse { requires_2fa?: boolean; user?: User; }`
- **Evidence (BE):** `return Response({"requires_2fa": True})` on 2FA gate; `return Response({"status": "ok"})` on success (never a `user` key).
- **Why it matters:** `authStore.ts:83` does `res.user ?? (await authApi.me())`. The `user` field is always `undefined` so a second GET /me/ is always issued regardless of 2FA status. This is a silent extra round-trip on every login. The type promises a `user` that never arrives.
- **Recommendation:** Either strip `user?` from `LoginResponse` so the type is truthful, or have the backend include the Me payload in the success body. The current fallback to `authApi.me()` is safe but the type is misleading.
- **Confidence:** High

---

### F-02 [HIGH] `acceptInvitation` response shape mismatch — frontend expects `{ org_slug, membership }`, backend returns raw `OrganizationMembership` row

- **File:** `frontend/src/api/orgs.ts:83` / `backend/apps/organizations/views.py:482-485`
- **Evidence (FE):** `api.post<{ org_slug: string; membership: Membership }>("/api/orgs/invitations/accept/", { token })`
- **Evidence (BE):** `return Response(OrganizationMembershipSerializer(membership).data, ...)` — shape is `{ id, user, organization, role, is_org_owner, is_active, created_at, removed_at }`. No `org_slug` key.
- **Why it matters:** `InviteAcceptPage.tsx:46` does `setOrgSlug(res.org_slug)`. Since `org_slug` is `undefined` in the actual response, the success redirect to the org dashboard never fires (`state` becomes `"ok"` but `orgSlug` stays `null`, so the "Go to organization" button is never rendered).
- **Recommendation:** Either return `{ org_slug, membership }` from the backend view, or update the FE to derive `org_slug` from `membership.organization` via a secondary lookup.
- **Confidence:** High

---

### F-03 [HIGH] `permissionsApi.modules()` type mismatch — FE expects `ModuleDef[]` with `{ key, scope, label, description }`, backend returns `Module` rows with `{ id, code, name, description, category, default_for_roles }`

- **File:** `frontend/src/api/permissions.ts:10` / `backend/apps/permissions/serializers.py:9-15`
- **Evidence (FE):** `api.get<ModuleDef[]>("/api/permissions/modules/")` where `ModuleDef = { key: string; scope: ModuleScope; label: string; description: string }`
- **Evidence (BE):** `ModuleSerializer` returns fields `["id", "code", "name", "description", "category", "default_for_roles"]` — no `key` or `label` field, no `scope` field.
- **Why it matters:** The matrix UI (`ModuleMatrixPage.tsx`) is powered by the matrix endpoint (which uses `MatrixModuleSerializer` with `key/scope/label/description` — the correct shape). However if `permissionsApi.modules()` is ever called directly, the TypeScript type `ModuleDef` would not match the actual JSON. Any code iterating `modules` from that endpoint would silently get `undefined` for `key` and `label`.
- **Recommendation:** Either add `key`, `scope`, `label` to `ModuleSerializer` (aliasing `code`→`key`, `name`→`label`, `category`→`scope`), or update the FE type to match the actual backend shape. The matrix endpoint already returns the right shape via `MatrixModuleSerializer`.
- **Confidence:** High

---

### F-04 [HIGH] `permissionsApi.setGrants()` sends `{ cells, event_id }` but `reason` is REQUIRED by backend serializer

- **File:** `frontend/src/api/permissions.ts:30-39` / `backend/apps/permissions/serializers.py:106`
- **Evidence (FE):** `payload: { cells: Record<string, GrantState>; reason?: string; event_id: string }` — `reason` is optional.
- **Evidence (BE):** `BulkGrantsCellsSerializer: reason = serializers.CharField(min_length=20, max_length=2000)` — required field with `min_length=20`.
- **Why it matters:** `ModuleMatrixPage.tsx:95-97` calls `permissionsApi.setGrants(orgSlug, userId, { cells, event_id: newEventId() })` — `reason` is omitted. Backend will return a 400 validation error every time "Save row" is clicked.
- **Recommendation:** Make `reason` required in the FE type and add a reason field to the Matrix UI row-save action, OR reduce backend `min_length` to 0 and `required=False` if reason is optional by design.
- **Confidence:** High (confirmed by reading both serializer and calling code)

---

### F-05 [MEDIUM] `orgsApi.createInvitation` return type is `OrgInvitation` but backend returns `AdminInvitation` (no `token` field in the response)

- **File:** `frontend/src/api/orgs.ts:78-79` / `backend/apps/organizations/views.py:423-435`
- **Evidence (FE):** `api.post<OrgInvitation>(...)` where `OrgInvitation.token?: string`
- **Evidence (BE):** `OrgInvitationsBySlugView.post` returns `AdminInvitationSerializer(inv).data` — the `AdminInvitationSerializer` does NOT include a `token` field (it serializes from the model, and the token hash is stored, not the plaintext). The plaintext token `_plaintext` is computed but discarded in the view.
- **Why it matters:** `InviteCreateModal.tsx:104-108` calls `setSent(inv)` and then `SentView` tries to display `invitation.token`. Since the token is never returned, the "Copy invitation token" and "Share link" UI surfaces will show empty fields. The invite was created but the token cannot be shared.
- **Recommendation:** The backend should include the one-time plaintext token in the create response. Update `OrgInvitationsBySlugView.post` to return `{"token": _plaintext, **AdminInvitationSerializer(inv).data}`.
- **Confidence:** High

---

### F-06 [MEDIUM] `authStore` bootstrap only catches 401 to treat as "not logged in"; backend returns 403 for unauthenticated `/me/` access

- **File:** `frontend/src/features/auth/authStore.ts:50` / known issue (a) in task description
- **Evidence:** `if (e instanceof ApiError && e.status === 401) { set({ user: null, ... bootstrapped: true }); return; }` — only 401 clears state cleanly.
- **Evidence (types/api.ts:33-44):** `ApiError.isUnauthenticated` handles 403 with specific payloads, but `bootstrap()` only checks raw `e.status === 401`.
- **Why it matters:** If the backend sends 403 for an unauthenticated request to `/api/accounts/me/` (confirmed known issue), `bootstrap()` falls into the generic error branch, sets an error string, and `bootstrapped = true` with `user = null`, but the `error` field is set. The `ProtectedRoute` sees a bootstrapped-but-no-user state and redirects to `/login` correctly, but the error is surfaced — in `LoginPage` there is no error display from the store at mount; however any component that renders `authStore.error` would show a spurious error banner.
- **Recommendation:** In `bootstrap()`, also call `e.isUnauthenticated` (which handles 403 with unauthenticated payloads) to decide whether to treat as logged-out rather than errored.
- **Confidence:** High

---

### F-07 [MEDIUM] `signup()` — FE response type is `{ user: User }` but backend returns `{ status: "pending_verification" }` (no user)

- **File:** `frontend/src/api/auth.ts:56` / `backend/apps/accounts/views.py:119,126,148`
- **Evidence (FE):** `api.post<{ user: User }>("/api/accounts/auth/signup/", payload)`
- **Evidence (BE):** `return Response({"status": "pending_verification"}, status=HTTP_201_CREATED)` — never a `user` key.
- **Why it matters:** The return type is wrong. `SignupPage.tsx` does not use the return value (calls `setSubmittedEmail` on success without reading the return), so there is no runtime breakage today. But the type misleads any future caller who might try to use `result.user`.
- **Recommendation:** Change FE return type to `{ status: string }` or `void`.
- **Confidence:** High

---

### F-08 [MEDIUM] `authApi.verifyEmail` and `authApi.passwordResetRequest/Complete` return types are `{ ok: true }` but backend returns `{ status: "..." }`

- **File:** `frontend/src/api/auth.ts:58-67`
- **Evidence (FE):** `api.post<{ ok: true }>("/api/accounts/auth/verify-email/", ...)`, `api.post<{ ok: true }>("/api/accounts/auth/password-reset-request/", ...)`, `api.post<{ ok: true }>("/api/accounts/auth/password-reset-complete/", ...)`
- **Evidence (BE):** `return Response({"status": "verified"})`, `return Response({"status": "ok"})` — never an `ok` key.
- **Why it matters:** The return types are incorrect. Pages don't use the return value, so no runtime breakage today, but types are misleading.
- **Recommendation:** Change return types to `{ status: string }` or `void`.
- **Confidence:** High

---

### F-09 [MEDIUM] `auditApi.list()` uses `encodeURIComponent(slug)` in path but slugs are already safe ASCII; the bigger issue is `OrgAuditLogPage` has no loading skeleton on first render if `hasModule` check races

- **File:** `frontend/src/api/audit.ts:32` / `frontend/src/features/orgs/OrgAuditLogPage.tsx:70-92`
- **Evidence:** `api.get<...>(\`/api/audit/orgs/${encodeURIComponent(slug)}/\`)` — `encodeURIComponent` is harmless but redundant for slug-shaped strings.
- **Evidence (page):** The page checks `if (!hasModule) return <NoAccess/>` before the query results are available. If `hasModule` is momentarily `undefined` (e.g., `membership` is not yet resolved from the store), the no-access card flashes before the real content.
- **Why it matters:** The module gate uses `membership?.effective_modules?.includes(...)` synchronously from the Zustand store. If the store hasn't bootstrapped yet (user is null), `hasModule` evaluates to `undefined → falsy` and the "Access required" card is shown momentarily. After bootstrap this corrects itself, but there is a visual flash.
- **Recommendation:** Guard on `!bootstrapped` or check `user !== null` before rendering the module gate.
- **Confidence:** Medium

---

### F-10 [MEDIUM] `OrgMembersListView` (UUID-based, `/api/orgs/{uuid}/members/`) returns `OrganizationMembershipSerializer` rows (one per membership row), not the aggregated `OrgMemberDetailSerializer` rows that the FE expects

- **File:** `backend/apps/organizations/views.py:356` / `frontend/src/api/orgs.ts:72`
- **Evidence (BE UUID route):** `OrgMembersListView.serializer_class = OrganizationMembershipSerializer` — returns `{ id, user, organization, role, is_org_owner, is_active, created_at, removed_at }`.
- **Evidence (BE slug route):** `OrgMembersBySlugView.get` returns `OrgMemberDetailSerializer` — the aggregated shape with `user_id, email, full_name, roles[]`.
- **Evidence (FE):** `orgsApi.members(slug)` calls the slug route `/api/orgs/${slug}/members/` — correct, gets the aggregated shape. However `MembersResponse` type is `OrgMember[] | Paginated<OrgMember>` and `OrgMember` matches the slug-route response, not the UUID-route response. The UUID route (used by `OrgMembersListView`) returns a different shape that would not fit `OrgMember`.
- **Why it matters:** If any future code or test calls the UUID-based members endpoint, it gets a completely different shape. The slug-routed FE path is correct, but the UUID route is a latent trap and the OpenAPI schema reflects both under different schemas.
- **Recommendation:** Refactor `OrgMembersListView` to also use `OrgMemberDetailSerializer` for consistency, or clearly document the difference.
- **Confidence:** High

---

### F-11 [LOW] `authApi.reauth()` return type `{ ok: true }` but backend returns `{ status: "ok" }`

- **File:** `frontend/src/api/auth.ts:88` / `backend/apps/accounts/views.py:285`
- **Evidence (FE):** `api.post<{ ok: true }>("/api/accounts/auth/reauth/", { password })`
- **Evidence (BE):** `return Response({"status": "ok"})`
- **Why it matters:** Same pattern as F-08. Callers of `reauth()` that inspect the return value for `{ ok: true }` will not get the expected shape.
- **Recommendation:** Align types.
- **Confidence:** High

---

### F-12 [LOW] `orgsApi.transferOwnership` return type `{ ok: true }` but backend returns `OrganizationSerializer` data

- **File:** `frontend/src/api/orgs.ts:108` / `backend/apps/organizations/views.py:660`
- **Evidence (FE):** `api.post<{ ok: true }>(\`/api/orgs/${slug}/ownership/transfer/\`, payload)`
- **Evidence (BE):** `OwnershipTransferBySlugView.post` returns `Response(OrganizationSerializer(org).data)` — full org object.
- **Why it matters:** FE type says `{ ok: true }` but actual response is an Organization object. Any code reading `result.ok` will get `undefined`.
- **Recommendation:** Change return type to `Organization` or `void`.
- **Confidence:** High

---

### F-13 [LOW] `ModuleMatrixPage` missing `import React` — uses JSX `React.ReactElement` return type without the import at file level

- **File:** `frontend/src/features/permissions/ModuleMatrixPage.tsx:68`
- **Evidence:** `export function ModuleMatrixPage(): React.ReactElement {` — file top imports `{ useMemo, useState }` from `"react"` but does NOT import `React` as the namespace. The function signature references `React.ReactElement`.
- **Why it matters:** In React 17+ with the automatic JSX transform this doesn't fail at runtime, but TypeScript strict mode will error on `React.ReactElement` without an import of `React`. The TS build may silently pass if `tsconfig` has `"jsx": "react-jsx"` but this is still a bad pattern.
- **Confidence:** Medium

---

### F-14 [INFO] Loading and error states are consistently implemented across all query-using pages

All pages using `useQuery` (MemberDirectoryPage, ModuleMatrixPage, OrgAuditLogPage, InvitationsListPanel) implement:
- Loading skeleton or spinner with `aria-live="polite"`
- Error state with retry button
- Empty state with contextual help

No gaps found.

---

### F-15 [INFO] Non-2xx error handling is consistent — all mutations use `ApiError` discrimination

`authStore.ts`, `MemberDirectoryPage.tsx`, `ModuleMatrixPage.tsx`, `InviteCreateModal.tsx`, `InvitationsListPanel.tsx`, and `InviteAcceptPage.tsx` all catch errors, check `instanceof ApiError`, and surface `e.payload.detail` or fallback strings. No silent swallowing of actionable errors was found except the deliberate `logout()` swallow which is documented and correct.

---

## Gaps (Forward-looking)

| Item | Missing | Blocking | Effort |
|------|---------|----------|--------|
| No `sports` API module in `frontend/src/api/` | Backend has `GET /api/sports/` + `GET /api/sports/{code}/` (in OpenAPI schema), no FE API wrapper exists | No (Phase 1B) | S |
| No Phase 1B API modules (tournaments, matches, fixtures, live, notifications, disputes) | Entire Phase 1B backend is absent | No (Phase 1B) | XL |
| `BulkGrantsSerializer.reason` has `min_length=20` — no FE UI to enter a reason | Matrix row-save has no reason field; all saves will 400 until this is added | Yes (blocks `setGrants` mutation) | S |
| `permissionsApi.modules()` is typed as `ModuleDef[]` but is never actually called by any rendered component — the matrix page uses the matrix endpoint instead | Latent dead-weight type mismatch | No | S |
| `InvitationAcceptView` (backend) does not return `org_slug` | Blocks the invite-accept success redirect entirely | Yes | S |
| `OrgMembersListView` (UUID route) serves a different schema than the slug route | Inconsistency will confuse future developers | No | M |
