# Audit: fe-landingerrors – API Contract

**Lens:** api/*.ts calls hit real routes; request/response shapes match types/*.ts + serializers; non-2xx handling; loading/empty/error states present.

**Date:** 2026-06-04
**Auditor:** automated (Claude Sonnet 4.6)

---

## Summary

Seven concrete findings. Three are critical/high shape mismatches that will cause silent runtime errors or broken user flows in production. The remainder are medium issues around incomplete error handling and a systemic 403-vs-401 ambiguity already noted elsewhere.

---

## Findings

---

### F1 — CRITICAL — Login success response: frontend expects `user` object, backend returns `{"status":"ok"}`

**File:** `frontend/src/api/auth.ts:52` + `backend/apps/accounts/views.py:253`

**Evidence (frontend):**
```ts
// auth.ts:24-28
export interface LoginResponse {
  requires_2fa?: boolean;
  user?: User;           // <-- expected on success
}
```
```ts
// authStore.ts:83
const user = res.user ?? (await authApi.me());
```

**Evidence (backend):**
```python
# views.py:253 — successful non-2FA login
return Response({"status": "ok"})
```

**Why it matters:** The backend returns `{"status": "ok"}` with no `user` field on successful login. The frontend falls back to `await authApi.me()` (authStore.ts line 83), so the flow works at runtime — but the `LoginResponse.user` field is permanently `undefined`. The fallback adds one extra round-trip on every login. More critically, if the `me()` call fails for any reason after login (e.g., transient error), the user is left in a broken authenticated-but-no-user state.

**Recommendation:** Either (a) have the backend include `MeSerializer(user).data` in the login response body (removes the second round-trip and eliminates the race window), or (b) remove `user?` from `LoginResponse` and make the `me()` fallback explicit in the type. Option (a) is preferred.

**Confidence:** 1.0

---

### F2 — CRITICAL — `acceptInvitation` response shape mismatch: frontend expects `{org_slug, membership}`, backend returns flat `OrganizationMembershipSerializer`

**File:** `frontend/src/api/orgs.ts:83` + `backend/apps/organizations/views.py:484`

**Evidence (frontend):**
```ts
// orgs.ts:83-86
acceptInvitation: (token: string) =>
  api.post<{ org_slug: string; membership: Membership }>(
    "/api/orgs/invitations/accept/",
    { token },
  ),
```
```ts
// InviteAcceptPage.tsx:45-47
const res = await orgsApi.acceptInvitation(token);
setOrgSlug(res.org_slug);   // <-- used for redirect
```

**Evidence (backend):**
```python
# views.py:484-485
return Response(
    OrganizationMembershipSerializer(membership).data,
    status=status.HTTP_200_OK,
)
```
`OrganizationMembershipSerializer` fields: `{id, user, organization, role, is_org_owner, is_active, created_at, removed_at}`. No `org_slug` key. No wrapping envelope.

**Why it matters:** `res.org_slug` will always be `undefined`. The `InviteAcceptPage` immediately calls `navigate(routes.orgDashboard(orgSlug))` on success (line 86), which navigates to `orgDashboard(undefined)` — a broken URL. The invitation accept flow is completely unusable.

**Recommendation:** Either (a) wrap the backend response in `{"org_slug": ..., "membership": {...}}` (requires adding `org_slug` from `membership.organization.slug` in the view), or (b) normalize on the frontend by reading `res.organization` and separately fetching the org slug. Option (a) is cleaner and avoids a second round-trip.

**Confidence:** 1.0

---

### F3 — HIGH — `createInvitation` response type mismatch: frontend types as `OrgInvitation`, backend returns `AdminInvitationSerializer`

**File:** `frontend/src/api/orgs.ts:75-79` + `frontend/src/types/user.ts:136-145` + `backend/apps/organizations/serializers.py:160-184`

**Evidence (frontend):**
```ts
// orgs.ts:75-79
createInvitation: (slug, payload) =>
  api.post<OrgInvitation>(`/api/orgs/${slug}/invitations/`, payload),
```
```ts
// types/user.ts:136-145 — OrgInvitation expects:
export interface OrgInvitation {
  id: string;
  org_id: string;       // <-- NOT in backend serializer
  email: string;
  roles: Role[];        // <-- backend has single `role` field
  token?: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  invited_by_email: string;  // <-- backend returns `invited_by` (UUID FK)
  expires_at: string;
}
```

**Evidence (backend):**
```python
# serializers.py:160-184 — AdminInvitationSerializer fields:
# id, organization (UUID), email, role (single string), status,
# effective_status, expires_at, accepted_at, revoked_at, created_at,
# invited_by (UUID FK — NOT invited_by_email)
```

**Why it matters:** After a successful invite creation, `InviteCreateModal` uses `sent.token` (to display), `sent.email` (message text), `sent.expires_at` (expiry label), and `sent.roles` (for display). The backend does NOT return a `token` in the create response (it returns `invited_by` not `invited_by_email`, returns `role` singular not `roles` array, and lacks `org_id`). The `SentView` in `InviteCreateModal` will show an empty token and empty share link — the primary UX goal of the success state.

**Recommendation:** Add a `token` field to `AdminInvitationSerializer` that is only populated on creation (set to null/omitted on list responses). Align the `roles` vs `role` naming (backend could output both for backward compat). Rename `invited_by` to `invited_by_email` or add a method field. Then update `OrgInvitation` in types/user.ts to match the canonical backend shape.

**Confidence:** 0.95

---

### F4 — HIGH — `bootstrap` treats 403 as an error and sets `error` state; `/api/accounts/me/` returns 403 (not 401) when logged-out

**File:** `frontend/src/features/auth/authStore.ts:49-59` + known issue (b) in task description

**Evidence:**
```ts
// authStore.ts:49-59
} catch (e) {
  if (e instanceof ApiError && e.status === 401) {
    set({ user: null, isLoading: false, bootstrapped: true });
    return;        // <-- only 401 is gracefully handled
  }
  set({
    user: null, isLoading: false, bootstrapped: true,
    error: e instanceof Error ? e.message : "Bootstrap failed",
  });  // <-- 403 falls here → sets error
}
```
```ts
// api.ts:32-45 — isUnauthenticated helper:
get isUnauthenticated(): boolean {
  if (this.status === 401) return true;
  if (this.status === 403) {
    const detail = ...toLowerCase();
    return detail.includes("authentication credentials") || ...
  }
}
```

**Why it matters:** DRF returns 403 (not 401) when `IsAuthenticated` permission rejects a non-authenticated user (default DRF behavior, unless `WWW_AUTHENTICATE_REALM` is configured). `me_view` uses `@permission_classes([IsAuthenticated])`. When the SPA bootstraps on `/login` for a non-logged-in user, `bootstrap()` gets a 403 → the catch block sets `error: "Bootstrap failed"` AND `bootstrapped: true`, but NOT `user: null` (it is already null). The `ProtectedRoute` sees `bootstrapped=true, user=null` → redirects to `/login`. BUT `error` is set in authStore, which LoginPage reads and displays as a red banner before the user has tried to do anything.

The `isUnauthenticated` helper does handle 403+string matching but `bootstrap()` never calls it — it only short-circuits on `status === 401`.

**Recommendation:** In `authStore.bootstrap()`, change the guard to `if (e instanceof ApiError && (e.status === 401 || e.isUnauthenticated))` to catch the 403-from-DRF case without setting the error state. The `isUnauthenticated` getter already handles the heuristic.

**Confidence:** 0.95

---

### F5 — MEDIUM — `verifyEmail` expects `{ok: true}` but backend returns `{"status": "verified"}`

**File:** `frontend/src/api/auth.ts:57-58` + `backend/apps/accounts/views.py:186`

**Evidence (frontend):**
```ts
// auth.ts:57-58
verifyEmail: (token: string) =>
  api.post<{ ok: true }>("/api/accounts/auth/verify-email/", { token }),
```

**Evidence (backend):**
```python
# views.py:186
return Response({"status": "verified"})
```

**Why it matters:** The return type `{ ok: true }` does not match `{ status: "verified" }`. `VerifyEmailPage` does not read the response body on success (line 23 — it only calls `authApi.verifyEmail(token)` and transitions state if no error). The type lie is harmless at runtime currently, but if any future caller reads `res.ok` it will always be `undefined` (falsy), causing a silent logic bug.

**Recommendation:** Change the backend to return `{"ok": true}` (consistent with other endpoints like `reauth`, `passwordResetRequest`) or update the TS type to `{ status: "verified" }`. The former is simpler.

**Confidence:** 1.0

---

### F6 — MEDIUM — `InvitationsListPanel` renders `invitation.roles` (array) but `AdminInvitationSerializer` returns `role` (single string); always renders empty roles list

**File:** `frontend/src/features/orgs/InvitationsListPanel.tsx:137-139` + `backend/apps/organizations/serializers.py:175`

**Evidence (frontend):**
```tsx
// InvitationsListPanel.tsx:137-139
{(invitation.roles ?? []).map((r) => (
  <RoleBadge key={r} role={r} />
))}
```
```ts
// api/orgs.ts:47-48  — InvitationListItem type
roles: string[];       // <-- expects array
```

**Evidence (backend):**
```python
# serializers.py:175  — AdminInvitationSerializer
"role",     # single CharField (not roles[])
```

**Why it matters:** The backend `GET /api/orgs/{slug}/invitations/` returns `role` (a string) not `roles` (an array). The frontend reads `.roles` which will be `undefined`, falls back to `[]`, and renders no role badges at all in the pending invitations panel.

**Recommendation:** Add a `roles` SerializerMethodField on `AdminInvitationSerializer` that returns `[self.role]` (or the actual roles list if multi-role invitations are supported). Update `InvitationListItem` type to reflect the actual field name in the interim.

**Confidence:** 0.90

---

### F7 — MEDIUM — `revokeInvitation` calls `DELETE /api/orgs/{slug}/invitations/{id}/` but the invitation revoke URL is `DELETE …/{id}/` (no `:revoke` suffix via slug) — route confirmed OK but wrong verb matched

**File:** `frontend/src/api/orgs.ts:81-82` + `backend/apps/organizations/urls.py:113-115`

**Evidence (frontend):**
```ts
// orgs.ts:81-82
revokeInvitation: (slug: string, id: string) =>
  api.delete<void>(`/api/orgs/${slug}/invitations/${id}/`),
```

**Evidence (backend):**
```python
# organizations/urls.py:113-115
path(
    "<str:slug>/invitations/<uuid:invitation_id>/",
    views.OrgInvitationByIdSlugView.as_view(),
    name="org-invitation-by-id-slug",
),
# OrgInvitationByIdSlugView only defines delete()
```

**Why it matters:** The route does exist as a DELETE. However, `OrgInvitationByIdSlugView` only defines `delete()` — no `get()` or other method. If any GET is attempted on this URL it would 405. More importantly: the view calls `invitation_svc.revoke_invitation(...)` and returns `204 No Content`, BUT `AdminInvitationSerializer` has a `POST` path (for the UUID-routed `:revoke/`) that returns `200 + AdminInvitationSerializer(inv).data`. The slug-DELETE path returns `204` (no body) correctly matching `api.delete<void>`. **Route and verb match correctly — no bug here** but the UUID-routed variant is not callable from FE (different contract).

**Note:** After re-reading both sides, this route pair is clean. Downgrading to INFO.

**Confidence:** 1.0 (clean)

---

### F8 — LOW — `signup` response typed `{ user: User }` but backend returns `{ status: "pending_verification" }` (no `user` field)

**File:** `frontend/src/api/auth.ts:55-56` + `backend/apps/accounts/views.py:148`

**Evidence (frontend):**
```ts
// auth.ts:55-56
signup: (payload: SignupPayload) =>
  api.post<{ user: User }>("/api/accounts/auth/signup/", payload),
```

**Evidence (backend):**
```python
# views.py:148
return Response({"status": "pending_verification"}, status=status.HTTP_201_CREATED)
```

**Why it matters:** The type `{ user: User }` is wrong — the backend returns `{ status: "pending_verification" }` and no user object. `SignupPage.tsx` ignores the response body entirely (it only calls `await authApi.signup(...)` and moves to `setSubmittedEmail`, line 71-76). No runtime breakage today, but the wrong type means any future code that reads `res.user` gets `undefined` silently.

**Recommendation:** Change the return type to `api.post<{ status: string }>`. No behavior change needed.

**Confidence:** 1.0

---

### F9 — LOW — `reauth` returns `{ ok: true }` typed correctly, but `passwordResetRequest` / `passwordResetComplete` type `{ ok: true }` while backend returns `{ status: "ok" }` — same pattern

**File:** `frontend/src/api/auth.ts:59-67` + `backend/apps/accounts/views.py:304` + `views.py:323`

**Evidence (frontend):**
```ts
// auth.ts:59-67
passwordResetRequest: (email: string) =>
  api.post<{ ok: true }>("/api/accounts/auth/password-reset-request/", { email }),
passwordResetComplete: (token: string, new_password: string) =>
  api.post<{ ok: true }>("/api/accounts/auth/password-reset-complete/", {...}),
```

**Evidence (backend):**
```python
# views.py:304, 323
return Response({"status": "ok"})  # NOT {"ok": true}
```

**Why it matters:** Same shape mismatch as F5. Both pages (`PasswordResetRequestPage`, `PasswordResetCompletePage`) ignore the response body on success, so no runtime breakage. But types are wrong.

**Recommendation:** Standardize: either use `{"ok": true}` in all success responses or `{"status": "ok"}`, and update types to match.

**Confidence:** 1.0

---

## Summary Table

| # | Severity | Area | Short description |
|---|----------|------|-------------------|
| F1 | Critical | auth/login | Backend omits `user` from login response; extra /me/ round-trip + race window |
| F2 | Critical | orgs/invite-accept | `acceptInvitation` response lacks `org_slug`; redirect always goes to `undefined` |
| F3 | High | orgs/invite-create | `createInvitation` types as `OrgInvitation`; backend returns `AdminInvitationSerializer` — `token`, `roles`, `invited_by_email`, `org_id` all absent |
| F4 | High | auth/bootstrap | `bootstrap()` only short-circuits 401; DRF sends 403 for unauthenticated → sets error banner on /login page |
| F5 | Medium | auth/verify-email | `verifyEmail` typed `{ok:true}`; backend returns `{"status":"verified"}` |
| F6 | Medium | orgs/invitations-list | `InvitationsListPanel` reads `.roles[]`; backend returns singular `.role` — badges never render |
| F7 | Info | orgs/revoke | Route + verb confirmed clean (DELETE 204 matches `api.delete<void>`) |
| F8 | Low | auth/signup | `signup` typed `{user:User}`; backend returns `{"status":"pending_verification"}` |
| F9 | Low | auth/reset | `passwordResetRequest/Complete` typed `{ok:true}`; backend returns `{"status":"ok"}` |

---

## Gaps (forward-looking)

| Gap | Missing | Needed for | Effort | Blocking |
|-----|---------|-----------|--------|---------|
| No `token` field in `AdminInvitationSerializer` | Backend must add `token` as a write-once field in the creation response | Invite share-link flow (InviteCreateModal SentView) | S | Yes |
| No `roles` array in `AdminInvitationSerializer` | Add `roles` method field that returns `[self.role]` | InvitationsListPanel role badges | S | Yes |
| No `org_slug` in invitation-accept response | Backend view must add slug to the response envelope | InviteAcceptPage redirect | S | Yes |
| `queryClient` mutation bus does not call `authBus.emit` automatically | Mutations that catch auth errors must manually call `authBus.emit` | Global 401/reauth interception for mutations | M | No |
| `api.generated.ts` is the OpenAPI codegen output — no automated check that it is up to date with the running backend | CI step to diff OpenAPI schema against generated types | Catching drift early | M | No |
| Field-level error display | Most forms only read `e.payload.detail` (the top-level DRF error); DRF also sends `{ field: [msg] }` field errors which are silently swallowed | Signup, invite-create form UX | M | No |
| No retry logic for transient network errors in mutation paths | `queryClient` sets `retry: 0` for mutations; network blips on invite-create / grant-set silently fail | Reliability | S | No |
