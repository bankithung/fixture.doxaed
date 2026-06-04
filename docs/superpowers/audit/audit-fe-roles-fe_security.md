# Security Audit — `frontend/src/features/roles`

**Lens:** dangerouslySetInnerHTML/XSS · sensitive data in localStorage · missing CSRF header on mutations · open redirects · UI-only authorization  
**Date:** 2026-06-04  
**Status:** Phase 1A implemented; Phase 1B not built.

---

## Findings

### F1 — MEDIUM — Role-landing pages have no frontend role/membership check (UI-only authz risk, partial)

**File:** `frontend/src/features/roles/routes.tsx` lines 20-22; `frontend/src/App.tsx` lines 145-155  
**Evidence:**
```tsx
// routes.tsx:20-22
{ path: "/o/:orgSlug/scoring", element: <ScorerLandingPage /> },
{ path: "/o/:orgSlug/referee", element: <RefereeLandingPage /> },
{ path: "/o/:orgSlug/team", element: <TeamManagerLandingPage /> },
```
```tsx
// App.tsx: all three routes are inside <ProtectedRoute> which only checks user != null + memberships.length
// No role-string or module check is applied at the route level.
```
**Why it matters:** Any authenticated user — including an `admin` in a completely different org — can navigate directly to `/o/<any-slug>/scoring`, `/o/<any-slug>/referee`, or `/o/<any-slug>/team` and see the Phase 1A placeholder pages (hero copy + "coming in Phase 1B" tiles). The pages themselves contain no server-fetched data in Phase 1A, so the information disclosure is limited to UI copy. However, once Phase 1B activates these routes with real scoring/referee data, the absence of a frontend role/membership guard will mean any logged-in user can reach those surfaces; the only protection will be whatever the backend enforces. The pattern of "Phase 1B lands here without adding a guard" is an architectural footgun.  
**Recommendation:** Add an org-membership + role (or module) guard inside each landing page or as a wrapper component at the route level. At minimum, verify that `user.memberships.find(m => m.org_slug === orgSlug)` returns a membership with the appropriate role or module before rendering content. Display a 403-like "Access denied" view otherwise. This guard is cheap in Phase 1A and prevents the gap from being forgotten in Phase 1B.  
**Confidence:** 0.95

---

### F2 — MEDIUM — `orgSlug` URL param is reflected into a `data-` attribute without sanitization (low-risk but noteworthy)

**File:** `frontend/src/features/roles/RoleLandingShell.tsx` line 53  
**Evidence:**
```tsx
<section
  aria-label={ariaLabel}
  className="flex flex-col gap-6 p-6"
  data-org-slug={orgSlug}
>
```
**Why it matters:** `orgSlug` comes from `useParams()` (the URL), which originates from user-supplied URL path segments. React escapes attribute values when setting them via JSX, so there is no direct XSS vector here — the value will never be executed as HTML or JavaScript via this pattern. However, any future code that reads `data-org-slug` via `getAttribute` and uses it inside `innerHTML`, `eval`, or `document.write` would create an XSS sink. The attribute also leaks the slug into the DOM where automated scraping tools or injected third-party scripts can read it.  
**Recommendation:** Remove the `data-org-slug` attribute unless it serves a concrete, tested purpose (e.g. Playwright selectors). If it is needed for testing, prefer `data-testid` and make the value static (e.g. `"role-landing-shell"`).  
**Confidence:** 0.80

---

### F3 — LOW — `?feedback=1` query-param pattern appended to orgSlug-derived URL (low open-redirect risk, contained)

**File:** `frontend/src/features/roles/RoleLandingShell.tsx` line 130  
**Evidence:**
```tsx
to={`${routes.orgDashboard(orgSlug)}?feedback=1`}
```
**Why it matters:** `orgSlug` is sourced from `useParams()` (URL). `routes.orgDashboard()` calls `encodeURIComponent(slug)` (see `frontend/src/lib/routes.ts` line 25), so the slug is properly encoded before being embedded in the path segment. The `?feedback=1` suffix is a static literal. React Router's `<Link to=...>` performs client-side navigation only and will never navigate to an external URL via this path; the router matches only relative paths of the SPA. There is no open-redirect risk in the current implementation. Logging as LOW/informational because the `orgSlug` comes from a URL parameter and future changes (e.g. building the URL differently or passing it to `window.location`) could introduce a risk.  
**Recommendation:** No immediate action required. Add a comment noting that the encoding is intentional, and include a unit test asserting the produced href when orgSlug contains special characters (e.g. `"acme & sons"`). The existing test in `ScorerLandingPage.test.tsx` line 47 covers the happy path but not special-character slugs.  
**Confidence:** 0.90

---

### F4 — LOW — `MyProfilePage` PATCH mutation sends user-supplied `name` — CSRF header present but trim-only validation

**File:** `frontend/src/features/roles/MyProfilePage.tsx` lines 60-61, 169  
**Evidence:**
```tsx
const saveName = useMutation({
  mutationFn: (newName: string) => authApi.patchMe({ name: newName }),
  ...
});
// Called as:
onClick={() => saveName.mutate(name.trim())}
```
**Why it matters:** The CSRF token IS correctly attached — `apiFetch` (client.ts lines 59-61) adds `X-CSRFToken` from the `csrftoken` cookie on every PATCH. No CSRF issue exists. The concern is frontend-only input validation: only `.trim()` is applied before the API call; no length cap, no character-set restriction. A user can submit a very long string (server should enforce max_length, but if the backend validation is misconfigured the DB write could fail loudly or silently). This is a low-severity quality/defense-in-depth issue, not a security vulnerability on its own.  
**Recommendation:** Add a `maxLength` attribute to the name `<Input>` and a client-side length check (e.g. `name.trim().length > 150`) before calling `saveName.mutate`. This prevents user confusion and reduces unnecessary round-trips.  
**Confidence:** 0.85

---

## Clean / No-Finding Items

| Check | Result |
|---|---|
| `dangerouslySetInnerHTML` anywhere in `features/roles` | **Clean** — zero occurrences in the entire `frontend/src` tree |
| Sensitive data written to `localStorage` / `sessionStorage` | **Clean** — zero occurrences anywhere in `frontend/src`; auth state is Zustand in-memory only |
| CSRF header on mutations | **Clean** — `apiFetch` in `client.ts` auto-attaches `X-CSRFToken` on POST/PUT/PATCH/DELETE; only the login endpoint uses `skipCsrf` intentionally (not present in roles feature) |
| Open redirects via `?next=` | **Clean** — `safeNext()` in `LoginPage.tsx` lines 29-33 enforces path-must-start-with-`/`-and-not-start-with-`//`; test coverage confirmed at line 127-138 |
| Server credentials / tokens in user-visible state | **Clean** — `pendingCredentials` is held in module scope (not Zustand, not localStorage) per `authStore.ts` lines 35-36 |
| XSS via `innerHTML` or unescaped interpolation | **Clean** — all user data (name, email, org name, roles) rendered via JSX text nodes |

---

## Gaps (forward-looking)

### G1 — Role/module enforcement on role-landing routes when Phase 1B activates

**Effort:** S  
**Blocking for Phase 1B:** YES  
**Current state:** No frontend role guard on `/o/:orgSlug/scoring`, `/o/:orgSlug/referee`, `/o/:orgSlug/team`. Any authenticated user can navigate there.  
**Missing:** A `<RoleGuard role="match_scorer">` (or module-based equivalent) wrapper, plus tests that assert an admin or foreign-org user sees a 403/redirect rather than the scoring UI.

### G2 — Cross-org membership check on role-landing pages

**Effort:** S  
**Blocking for Phase 1B:** YES  
**Current state:** `RoleLandingShell` reads `orgSlug` from URL params but never verifies the current user is actually a member of that org.  
**Missing:** A guard that checks `user.memberships.find(m => m.org_slug === orgSlug)` and renders an access-denied view if the lookup returns undefined. This is particularly important when Phase 1B adds real data to these pages.

### G3 — `?feedback=1` sink not covered for special-character slugs in test

**Effort:** S  
**Blocking:** NO  
**Current state:** `ScorerLandingPage.test.tsx` line 47 asserts the feedback link href but only for `acme` (no special chars).  
**Missing:** A test case asserting the href when `orgSlug` contains `&`, spaces, or Unicode, confirming `encodeURIComponent` in `routes.orgDashboard` fires correctly.

### G4 — Team landing page has no module gate (only role-string gate in nav)

**Effort:** M  
**Blocking:** NO  
**Current state:** `computeNavItems.ts` line 137 checks `roles.includes("team_manager")` as a fallback because no module key exists in Appendix A.2 for the team workspace. The route itself (`/o/:orgSlug/team`) has no corresponding guard at all.  
**Missing:** Add `tournament.team_manager_workspace` to the module catalog (PRD §A.2 extension), backfill the module into the nav guard and route guard, and add it to the permissions fixture.
