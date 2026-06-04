# Security Audit: frontend/src/features/layout

**Audit area:** `frontend/src/features/layout/` (AppShell, ProtectedRoute, OrgDashboardPage, OrgChooserPage, OrgComingSoonPage, computeNavItems)
**Lens:** dangerouslySetInnerHTML/XSS, sensitive data in localStorage, missing CSRF header on mutations, open redirects, UI-only authorization.
**Date:** 2026-06-04
**Auditor:** Claude Code

---

## Summary

The layout feature area is largely well-structured from a security perspective. CSRF is handled centrally in `apiFetch` for all unsafe verbs. No `dangerouslySetInnerHTML` or `localStorage`/`sessionStorage` use was found anywhere in the frontend source. No raw `innerHTML` or `eval` usage was found. The primary findings are:

1. **Open redirect partial bypass** — the `safeNext` validator in `LoginPage` (called from the redirect produced by `ProtectedRoute`) passes paths like `/\evil.com` or `///evil.com`. React Router's `navigate()` neutralises the browser-navigation risk, but the validation is incomplete and the test suite does not cover these edge cases.
2. **UI-only authorization on org-scoped routes in `App.tsx`** — multiple protected routes (`/o/:orgSlug/permissions`, `/o/:orgSlug/scoring`, etc.) are inside `<ProtectedRoute>` (authentication gate) but have **no client-side membership/module gate** before rendering. The backend enforces the real gate; this is correct architecture. However the UI-only surface in `computeNavItems` / `computeDashboardCards` is the only place on the client that suppresses navigation items based on roles/modules — if a user types the URL directly they reach the page and only a server 403 will stop them. This is acceptable by the "server is the real gate" invariant but there is no test proving the backend actually enforces access for those pages.
3. **`is_superuser` flag used client-side in `ProtectedRoute`** — the redirect bypass for super-admins (skipping the "zero-memberships" redirect) relies on a boolean surfaced from `GET /api/accounts/me/`. If the backend ever emits `is_superuser: true` for a non-superuser (e.g. during a bug), that user gets unrestricted navigation. Low probability but worth noting.
4. **CSRF token silently skipped when cookie is absent** — `getCsrfToken()` returns `null` if the `csrftoken` cookie is missing (e.g. session expired, cookie blocked), and `apiFetch` silently omits the header rather than aborting or warning. The backend's CSRF check will reject the request, so there is no CSRF vulnerability, but the UX is a silent 403 rather than a clear "re-authenticate" prompt.
5. **Feedback `source_url` leaks current pathname** — `OrgDashboardPage.tsx:83` sends `window.location.pathname` as `source_url` in the feedback API call. If the pathname contains a personal identifier (e.g. `/o/<slug>/permissions`) this is stored in the super-admin surface. Low severity; it is intended behaviour but worth flagging for data-minimisation.

---

## Findings

### F-1 (medium): Open-redirect validator passes `/\` and `///` prefixes

**File:** `frontend/src/features/auth/LoginPage.tsx:29-32`

**Evidence:**
```ts
function safeNext(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  return raw;
}
```

The check blocks `//evil.com` (protocol-relative) and `https://evil.com` (absolute), but passes:
- `/\evil.com` — starts with `/`, does not start with `//`. Some older browsers treat `\` as a path separator and navigate externally.
- `///evil.com` — starts with `/`, does not start with `//`. Modern browsers normalize this to `/evil.com` within React Router's history API but the validation intent is imprecise.

The redirect is consumed by React Router's `navigate()` (not `window.location.href`), which confines navigation to the SPA origin, so exploitation is blocked in practice. The test suite at `LoginPage.test.tsx:127-138` only covers `https://evil.example.com/x` and `//` was not tested.

**Why it matters:** Defense-in-depth is weakened. A future refactor that switches from `navigate()` to `window.location.href` would introduce an exploitable open redirect.

**Recommendation:** Strengthen `safeNext` to:
```ts
function safeNext(raw: string | null): string | null {
  if (!raw) return null;
  // Must start with exactly one slash; no protocol-relative, no backslash tricks.
  if (!/^\/[^/\\]/.test(raw) && raw !== "/") return null;
  return raw;
}
```
Add a test case for `/\evil.com` and `///evil.com`.

---

### F-2 (medium): UI-only authorization — no client-side org-membership gate on protected page routes

**Files:**
- `frontend/src/App.tsx:139-174` (route definitions)
- `frontend/src/features/layout/ProtectedRoute.tsx` (only checks `bootstrapped` + `user !== null`)

**Evidence:**
```tsx
// App.tsx:115-125
<Route
  element={
    <ProtectedRoute>
      <AppShell />
    </ProtectedRoute>
  }
>
  <Route path="/orgs" element={<OrgChooserPage />} />
  <Route path="/o/:orgSlug/permissions" element={<ModuleMatrixPage />} />
  <Route path="/o/:orgSlug/scoring" element={<ScorerLandingPage />} />
  ...
```

`ProtectedRoute` checks only that `user` is non-null (authentication). It does NOT verify:
- that `user.memberships` contains an entry for the `:orgSlug` in the URL
- that the user's `effective_modules` includes the required module for the page
- that the user's `roles` includes the required role

`computeNavItems` and `computeDashboardCards` hide nav items from the UI, but a user can navigate directly by URL to `/o/<any-slug>/permissions` and the client will render `ModuleMatrixPage`. The real authorization enforcement is backend-only (API returns 403). This is correct per invariant 2 but:
1. There are no isolation tests that prove the backend actually enforces this for each route.
2. If a page has a bug that reads from client state before the API call completes, it could display stale data belonging to a different org.

**Why it matters:** Client-side org-scope enforcement is entirely absent. Any authenticated user can see the rendered shell for another org's pages until the API call fails. Stale TanStack Query cache could serve data from a prior org session.

**Recommendation:**
- Add an `orgSlug` membership check in `ProtectedRoute` or a per-route `OrgGuard` wrapper that redirects to `/orgs` if `user.memberships.find(m => m.org_slug === orgSlug)` is null.
- Add backend isolation tests (pytest, parametrized) asserting that `GET /api/orgs/<foreign-slug>/members/` returns 403/404 for non-members. These are required by architectural invariant 2 but are absent for Phase 1B endpoints.

---

### F-3 (low): `is_superuser` client-side bypass in `ProtectedRoute` is trust-on-server-data

**File:** `frontend/src/features/layout/ProtectedRoute.tsx:53`

**Evidence:**
```tsx
if (
  memberships.length === 0 &&
  !user.is_superuser &&         // <-- trusts client-side value from /me/
  location.pathname !== routes.orgChooser()
) {
  return <Navigate to={routes.orgChooser()} replace />;
}
```

`is_superuser` is sourced from `GET /api/accounts/me/` and stored in Zustand. If the backend ever returns `is_superuser: true` incorrectly, or if there is a prototype-pollution attack on the Zustand store (in a bundled dependency), the redirect is bypassed.

**Why it matters:** Low probability; backend controls the value. But the `is_superuser` flag is only needed here to prevent a redirect loop for platform staff who have no org memberships. The same could be accomplished without storing a privileged flag client-side.

**Recommendation:** This is acceptable as written since the server is the source of truth. To reduce reliance on the flag, consider redirecting super-admins to `sadmin.fixture.doxaed.com` server-side (Django middleware) rather than trusting the SPA to make that call.

---

### F-4 (low): CSRF token silently omitted when `csrftoken` cookie is absent

**File:** `frontend/src/api/client.ts:59-61`

**Evidence:**
```ts
if (!skipCsrf && UNSAFE_METHODS.has(method)) {
  const csrf = getCsrfToken();
  if (csrf) headers.set("X-CSRFToken", csrf);
  // No else: request proceeds without the header.
}
```

If the `csrftoken` cookie is missing (session expired, cookie rejected by browser policy, or cleared by logout), the `X-CSRFToken` header is silently absent. The Django backend will reject the request with a 403 CSRF failure, but the error is indistinguishable from a permission-denied response to the user.

**Why it matters:** Not a CSRF vulnerability (the request is blocked server-side). The UX issue is that users see a cryptic 403 instead of "please log in again." The layout's `AuthBusBridge` only reacts to 401, so a 403-CSRF does not trigger the re-login flow.

**Recommendation:** Add a branch in `apiFetch` (or in `AuthBusBridge`) that treats a 403 with a CSRF-failure body as an authentication event and prompts re-login.

---

### F-5 (info): `source_url` in feedback submission leaks pathname to admin surface

**File:** `frontend/src/features/layout/OrgDashboardPage.tsx:83`

**Evidence:**
```ts
source_url:
  typeof window !== "undefined" ? window.location.pathname : undefined,
```

The current page pathname (e.g. `/o/acme-fc/dashboard`) is sent to `POST /api/feedback/submit/` and stored in the super-admin console. This is intended but can leak org slugs and navigation context for users who want privacy.

**Why it matters:** Low impact. The super-admin is a platform operator who already has full access. No sensitive data (tokens, PII beyond the slug) is in `window.location.pathname`.

**Recommendation:** Document this behavior in the backend's `FeedbackSubmission` model. Consider hashing or truncating the org slug before storage if user pseudonymity becomes a requirement.

---

### F-6 (info): No `dangerouslySetInnerHTML`, no `localStorage`, no raw `innerHTML` found

All user-controlled strings are rendered via React's JSX text nodes (e.g. `user.name`, `user.email`, `orgName`, `roles.join(", ")`). No `dangerouslySetInnerHTML` is used anywhere in the layout feature or its direct dependencies. No `localStorage` or `sessionStorage` calls were found in the frontend source. Auth state is held in Zustand in-memory store only (correct per invariant 15).

---

## Gaps (forward-looking)

| # | Gap | Blocking? | Effort | Needed for |
|---|-----|-----------|--------|------------|
| G-1 | No `OrgGuard` / membership check in the route tree — any authenticated user can reach `/o/<foreign-slug>/*` pages (server 403 is the only gate) | No | S | Invariant 2 isolation tests |
| G-2 | Backend isolation tests for org-scoped Phase 1B routes do not yet exist | No | M | Phase 1B launch (matches PRD §7.7 security baseline) |
| G-3 | `safeNext` test suite does not cover `/\` or `///` bypass patterns | No | S | Defense-in-depth for open redirect |
| G-4 | CSRF-absent 403 does not trigger re-login flow in `AuthBusBridge` | No | S | UX robustness |
| G-5 | `computeNavItems` silently falls back to role-only gating for `team_manager` nav item because `tournament.team_manager_workspace` module is missing from the Appendix A.2 catalog — acknowledged in code comment | No | M | Spec completeness (v1Users.md Appendix A.2 update) |
