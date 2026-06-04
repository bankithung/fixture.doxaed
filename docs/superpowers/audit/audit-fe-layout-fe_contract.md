# Audit: fe-layout — API Contract
**Lens:** API calls hit real routes; request/response shapes match types/*.ts + serializers; non-2xx handling; loading/empty/error states.
**Date:** 2026-06-04
**Files audited:** frontend/src/features/layout/ (all), frontend/src/api/{auth,orgs,feedback,permissions,client}.ts, frontend/src/types/{user,api}.ts, backend/apps/accounts/{views,serializers,urls}.py, backend/apps/organizations/{views,serializers,urls}.py, backend/apps/sadmin/{views/feedback.py,serializers.py}, backend/fixture/urls.py

---

## Findings

### F-1 [HIGH] Login response carries `{status:"ok"}` but authStore expects `{user?, requires_2fa?}`

**File:** `backend/apps/accounts/views.py:253`
**Evidence:** `return Response({"status": "ok"})` on successful login.
**Frontend expects:** `frontend/src/features/auth/authStore.ts:83` — `const user = res.user ?? (await authApi.me());`
**Type declared:** `frontend/src/api/auth.ts:24-28` — `LoginResponse { requires_2fa?: boolean; user?: User; }`.

The backend never returns a `user` field in the login response; it always returns `{"status": "ok"}`. The authStore gracefully falls back to `await authApi.me()` when `res.user` is `undefined`, so this does NOT break functionality. However it causes an extra round-trip on every login (one `POST /login/` → one `GET /me/`). The `LoginResponse.user` field in the TS type is permanently dead code that misleads future developers.

**Why it matters:** Two extra round-trips on every login. If `GET /me/` returns 403 (known bug) instead of 401 on a fresh session, the fallback path silently fails with no error surface.

**Recommendation:** Either (a) have the backend return `{ status:"ok", user: <serialized user> }` on successful login so the fallback `me()` call is skipped, or (b) remove `user?` from `LoginResponse` and document the deliberate two-call pattern with a comment explaining the extra round-trip.

---

### F-2 [HIGH] `feedbackApi.submit` sends `source_url` but backend serializer expects `page_url`

**File:** `frontend/src/api/feedback.ts:14` — field `source_url?: string`
**OrgDashboardPage.tsx:82** — `source_url: typeof window !== "undefined" ? window.location.pathname : undefined`
**Backend serializer:** `backend/apps/sadmin/serializers.py:30` — `page_url = serializers.CharField(max_length=2048, required=False, allow_blank=True)`.

The frontend sends `source_url` in the POST body; the backend field is named `page_url`. Because both are `required=False`, the backend silently ignores the field and the page URL is never persisted. No runtime error occurs — the feedback still submits successfully — but the page-url context the super-admin expects to see in the triage UI is always missing.

**Why it matters:** Page-URL context data is lost on every feedback submission. Super-admin cannot trace feedback to the originating page.

**Recommendation:** Rename `source_url` to `page_url` in `FeedbackSubmitPayload` and in `OrgDashboardPage.tsx`. Add the backend field name as a comment so the mismatch cannot silently recur.

---

### F-3 [MEDIUM] `acceptInvitation` response type mismatch: FE expects `{org_slug, membership}` but backend returns a raw `OrganizationMembershipSerializer` row

**File:** `frontend/src/api/orgs.ts:83-85` — `api.post<{ org_slug: string; membership: Membership }>("/api/orgs/invitations/accept/", { token })`.
**Backend view:** `backend/apps/organizations/views.py:482-485` — `return Response(OrganizationMembershipSerializer(membership).data, status=HTTP_200_OK)`.
**Backend serializer fields:** `id, user, organization, role, is_org_owner, is_active, created_at, removed_at` — no `org_slug` wrapper key.

The FE type expects a nested `{ org_slug: string, membership: Membership }` envelope but the backend returns a flat `OrganizationMembershipSerializer` row. `InviteAcceptPage.tsx:45` does `const res = await orgsApi.acceptInvitation(token); navigate(routes.orgDashboard(res.org_slug))` — accessing `res.org_slug` will always be `undefined`, causing the post-accept redirect to land on `/o/undefined/dashboard`.

**Why it matters:** The invite-accept success flow breaks silently; the user lands on a non-existent org dashboard slug.

**Recommendation:** Either (a) have the backend return `{ org_slug: org.slug, membership: {...} }` envelope, or (b) change the FE to navigate using `res.organization` (the UUID FK) and look up the slug from the user's refreshed memberships. Option (a) is cheaper. This is a functional regression.

---

### F-4 [MEDIUM] `bootstrap` only catches 401 but backend `/api/accounts/me/` returns 403 for unauthenticated users (known bug)

**File:** `frontend/src/features/auth/authStore.ts:50-51`:
```
if (e instanceof ApiError && e.status === 401) {
    set({ user: null, isLoading: false, bootstrapped: true });
```
The known bug (referenced in task description item (b)) means that `GET /api/accounts/me/` returns 403 for logged-out users. The `bootstrap` catch only tests `e.status === 401`; a 403 falls into the generic error branch:
```
set({ user: null, isLoading: false, bootstrapped: true, error: "..." });
```
`ProtectedRoute.tsx:29-38` renders a loading spinner when `!bootstrapped`, then — once bootstrapped — checks `!user` and redirects to login. That redirect happens correctly, BUT `authStore.error` is set to a non-null string, which may surface a misleading error toast / message on the login page.

**Why it matters:** The login page may show a spurious "Bootstrap failed" or HTTP-403-detail error message for all unauthenticated visitors. Fix (b) in the issue list (make `/me/` return 401) is the proper fix; this finding documents the FE behaviour that makes the backend bug user-visible.

**Recommendation:** As an immediate FE defence, extend the bootstrap catch to also treat 403 with `detail` matching authentication-credential strings as "unauthenticated" (use `ApiError.isUnauthenticated` — it already covers 403+authentication-credentials phrases, `frontend/src/types/api.ts:34-44`). This makes the FE resilient regardless of whether the backend bug is fixed first.

---

### F-5 [MEDIUM] `OrgDashboardPage` has no loading state — `cards.length === 0` fallback text is wrong for the "no modules" case

**File:** `frontend/src/features/layout/OrgDashboardPage.tsx:145-148`:
```tsx
{cards.length === 0 ? (
  <p className="col-span-full text-sm text-muted-foreground">
    {t("Loading your modules...")}
  </p>
```
`computeDashboardCards` always returns at minimum the "My profile" card regardless of modules (`dashboardCards.ts:198-205`). So `cards.length === 0` only fires when `user` is null. Since `ProtectedRoute` guarantees `user` is set, this branch is unreachable in practice. A viewer with zero modules still gets the Profile card. The "Loading..." message will never appear and cannot communicate an actual loading state (there is no async fetch for dashboard cards — they derive from auth store).

**Why it matters:** The copy is misleading ("Loading...") for a state that can never actually occur. If future code paths make the profile card conditional, this silent failure mode activates.

**Recommendation:** Remove the dead `cards.length === 0` branch or replace the message with `t("No accessible areas for this organization.")` to correctly represent the empty-modules case.

---

### F-6 [LOW] `OrgChooserPage` calls `user.memberships.map(...)` without a null guard — crashes if `memberships` is absent

**File:** `frontend/src/features/layout/OrgChooserPage.tsx:26` — `{user.memberships.map(...)}`

The `User` type declares `memberships: OrgMembership[]` (not nullable), but during a partial auth-state update `memberships` could theoretically be undefined if the server returned an older response shape. The check at line 15 (`if (!user) return <div />;`) only guards against null user, not missing memberships. Additionally, the template-literal in `t(...)` at line 36 (`t(\`${m.effective_modules.length} modules accessible\`)`) breaks i18n — interpolated strings cannot be statically extracted.

**Why it matters:** Low risk of crash if `memberships` is absent; `t()` template-literal breaks localization pipeline.

**Recommendation:** Use `(user.memberships ?? []).map(...)` and convert the template literal to `t("{count} modules accessible", { count: m.effective_modules.length })` once i18n interpolation is wired.

---

### F-7 [LOW] `computeNavItems` uses role-only gating for `team_manager` nav item (acknowledged spec gap)

**File:** `frontend/src/features/layout/computeNavItems.ts:137-145`
```ts
// Team workspace: no Appendix A.2 module exists ...
if (roles.includes("team_manager")) {
```
The comment acknowledges this is a spec gap but the inconsistency is worth recording for tracking: 5 of 6 nav items are module-gated; `team` is role-only. The module-grant admin can deny team_manager all modules but the Team nav item still appears.

**Why it matters:** An admin-denied team_manager still sees the Team nav link and hits a Phase 1B placeholder, not a real 403. Minor UX inconsistency now; could break when Phase 1B lands.

**Recommendation:** Add `tournament.team_manager_workspace` to the Appendix A.2 module catalog (spec update) and gate the Team nav item by that module, consistent with the other items.

---

### F-8 [INFO] `FeedbackSubmitView` requires `IsAuthenticated` but `FeedbackSubmitPayload.event_id` is optional — no contract enforcement gap

**File:** `frontend/src/api/feedback.ts:16`, `backend/apps/sadmin/serializers.py:42`.
Both agree `event_id` is optional UUID. No mismatch. Noted for completeness.

---

## Gaps (forward-looking)

| # | Area | Missing | Effort | Needed for |
|---|------|---------|--------|------------|
| G-1 | authStore.bootstrap | No handling of DRF `{"detail": "..."}` 403 variant short of the phrase match in `isUnauthenticated` | S | Resilience until backend 403→401 fix lands |
| G-2 | feedbackApi | `FeedbackSubmitPayload` has no `subject` or `category` fields; backend accepts them (spec-gated functionality missing from FE payload type) | S | Richer feedback triage in sadmin |
| G-3 | OrgDashboardPage | Feedback submission uses `crypto.randomUUID()` with a fallback `undefined` — on browsers without SubtleCrypto (very rare) no event_id is sent, breaking idempotency | S | Invariant 3 |
| G-4 | Layout / ProtectedRoute | No test for the 403-instead-of-401 bootstrap path | S | Regression coverage for known bug (b) |
| G-5 | acceptInvitation | InviteAcceptPage not covered by this audit scope but relies on the broken response shape in F-3 | M | Invite-accept flow correctness |
