# FE Area Map: landing/ + errors/

**Area:** `frontend/src/features/landing/` and `frontend/src/features/errors/`
**Audit date:** 2026-06-04
**Auditor:** Claude Code (map task)

---

## 1. File Inventory

### landing/

| File | Purpose |
|------|---------|
| `LandingPage.tsx` | Public hero at `/`; redirects authenticated users via `pickLandingPathForUser`; renders hero, roadmap strip, footer for visitors |
| `AboutPage.tsx` | Stub `/about` page; placeholder for mission/team/terms content |
| `__tests__/LandingPage.test.tsx` | 3 tests: unauthenticated render, redirect to dashboard (last-active slug), redirect to /orgs (no memberships) |

### errors/

| File | Purpose |
|------|---------|
| `ErrorBoundary.tsx` | React class component boundary; wraps app in `App.tsx`; delegates to `ErrorPage` or optional `fallback` render-prop |
| `ErrorPage.tsx` | Generic "Something went wrong" card; `role="alert"`; collapsible `<details>` for stack trace; retry = page reload or `onRetry` callback |
| `NotFoundPage.tsx` | Catch-all `*` route; 404 card with "Back home" + "Sign in instead" links |
| `ComingSoonPage.tsx` | Reusable Phase 1B placeholder; reads `last_active_org_slug` from authStore to build dashboard href; accepts `feature` + `description` props |
| `__tests__/ErrorBoundary.test.tsx` | 4 tests: happy path, ErrorPage fallback, custom fallback prop, console.error logging |
| `__tests__/NotFoundPage.test.tsx` | 2 tests: heading + "Back home" href, "Sign in instead" href |

### Related/consumed-by

| File | Role |
|------|------|
| `frontend/src/App.tsx` | Wires all routes; `ErrorBoundary` wraps `BrowserRouter`; `ComingSoonPage` used inline for `/o/:orgSlug/tournaments-coming-soon` |
| `frontend/src/lib/routes.ts` | Centralised typed route helpers used by all landing/error pages |
| `frontend/src/lib/t.ts` | i18n stub: `(s) => s`; wraps all user-visible strings per invariant #13 |
| `frontend/src/features/roles/redirectByRole.ts` | `pickLandingPathForUser` consumed by LandingPage |
| `frontend/src/features/auth/authStore.ts` | `useAuthStore` consumed by LandingPage and ComingSoonPage |
| `frontend/src/features/layout/OrgComingSoonPage.tsx` | Separate (older?) coming-soon surface at org scope; NOT the same as `ComingSoonPage` |

---

## 2. Models / Types

- **User** (`frontend/src/types/user.ts`): `id`, `email`, `name`, `is_superuser`, `has_2fa_enrolled`, `twofa_enrolled_at`, `email_verified_at`, `last_active_org_id`, `last_active_org_slug`, `memberships[]`, `deleted_at`
- **OrgMembership** (`frontend/src/types/user.ts`): `org_id`, `org_slug`, `org_name`, `roles[]`, `is_org_owner`, `effective_modules[]`, optional `active_role`
- No dedicated types for landing/errors components; all typed inline via `RoadmapCardProps`, `ComingSoonPageProps`, `ErrorPageProps`, `ErrorBoundaryProps`, `ErrorBoundaryState`

---

## 3. Endpoints / Routes consumed

- `GET /api/accounts/me/` (via `authApi.me()` in `authStore.bootstrap`) — LandingPage reads its result from `useAuthStore`; no direct fetch in these files
- No other API calls in landing/ or errors/

---

## 4. Route registration (App.tsx)

| Path | Component |
|------|-----------|
| `/` | `LandingPage` |
| `/about` | `AboutPage` |
| `/o/:orgSlug/tournaments-coming-soon` | `ComingSoonPage` (inline, feature="Tournaments") |
| `*` | `NotFoundPage` |
| _(ErrorBoundary wraps entire app, not a route)_ | `ErrorBoundary` |

---

## 5. Findings

### F-01 — AboutPage is a permanent stub with no content roadmap
**Severity:** medium
**File:line:** `frontend/src/features/landing/AboutPage.tsx:5-9`
```tsx
/**
 * Stub /about page. Real content (mission, team, contact, terms) is
 * out-of-scope for the auth-polish slice; this exists so the footer + the
 * signup terms link have a destination instead of 404'ing.
 */
```
**Why it matters:** The signup flow links to `/about` (via `routes.about()`) for terms. A stub with "Detailed terms and a public roadmap are coming soon" means there are no actual terms of service, privacy policy, or contact info. If the platform acquires real users this is a legal and trust gap.
**Recommendation:** Before any public launch, replace with real Terms of Service, Privacy Policy, and contact info. A minimal "terms pending" banner is acceptable for internal/beta use but must be resolved pre-launch.

---

### F-02 — No tests for AboutPage, ErrorPage, or ComingSoonPage
**Severity:** medium
**Files:**
- `frontend/src/features/landing/AboutPage.tsx` — no test file
- `frontend/src/features/errors/ErrorPage.tsx` — no test file
- `frontend/src/features/errors/ComingSoonPage.tsx` — no test file

**Why it matters:** ErrorBoundary delegates to ErrorPage as its default fallback; if ErrorPage regresses (e.g., the `<details>` toggle breaks, the `role="alert"` is removed), no test catches it. ComingSoonPage uses `authStore` to derive the dashboard href — a wrong href sends users to a broken route. AboutPage is the terms destination.
**Recommendation:** Add vitest unit tests for all three. For ErrorPage: assert `role="alert"`, collapse/expand of `<details>`, default reload behaviour. For ComingSoonPage: assert href builds correctly with and without `last_active_org_slug`. For AboutPage: assert heading and back-home link.

---

### F-03 — Two parallel "coming soon" components with overlapping scope
**Severity:** medium
**Files:**
- `frontend/src/features/errors/ComingSoonPage.tsx` — full-screen, uses authStore for href, has `feature` + `description` props, fills `min-h-[calc(100vh-3.5rem)]`
- `frontend/src/features/layout/OrgComingSoonPage.tsx` — org-scoped card, reads `orgSlug` from `useParams`, simpler, no authStore dependency

**Evidence (OrgComingSoonPage.tsx:1-40):**
```tsx
export function OrgComingSoonPage(): React.ReactElement {
  const { orgSlug = "" } = useParams<{ orgSlug: string }>();
  ...
  <Link to={routes.orgDashboard(orgSlug)}>Back to dashboard</Link>
```
**Why it matters:** Two components that serve the same conceptual purpose ("this feature isn't ready yet") will diverge over time. App.tsx only uses `ComingSoonPage` (errors/); `OrgComingSoonPage` appears unreferenced in App.tsx — it may be dead code or an accidentally leftover precursor.
**Recommendation:** Check if `OrgComingSoonPage` is referenced anywhere other than its own file. If unreferenced, delete it. If used in a sub-router or lazy import, unify both into one component (parametrize orgSlug vs authStore lookup via prop).

---

### F-04 — `OrgComingSoonPage` appears unreferenced in the route table (possible dead code)
**Severity:** low
**File:line:** `frontend/src/features/layout/OrgComingSoonPage.tsx:1`
**Why it matters:** `App.tsx` imports and uses only `ComingSoonPage` from `errors/`. A global search shows `OrgComingSoonPage` is defined but there is no import of it in `App.tsx` or any test file in the audit scope. If not used via a lazy import elsewhere, it is dead code.
**Recommendation:** Verify with a project-wide grep for `OrgComingSoonPage`. If unused, remove. Confidence: medium (the glob shows no test for it either; full project search needed to confirm).

---

### F-05 — LandingPage does not render a loading state during bootstrap
**Severity:** low
**File:line:** `frontend/src/features/landing/LandingPage.tsx:34-37`
```tsx
// Authenticated → bounce into the app via role-aware helper.
if (bootstrapped && user) {
  return <Navigate to={pickLandingPathForUser(user)} replace />;
}
```
**Why it matters:** When `bootstrapped = false` (i.e., the `/me/` hydration is still in flight), the landing page renders the full public hero. For authenticated users on a slow connection, this means they see the public hero briefly before being redirected. The comment (`// The pre-bootstrap render is identical to the unauthenticated render so there is no "Loading..." flash for cold visitors.`) calls this intentional, but it means authenticated users who refresh `/` always see a flash of the hero. This is documented as a deliberate trade-off.
**Recommendation:** Acceptable for v1. For a polished SaaS UX (per the Pro SaaS overhaul goal), consider adding a subtle skeleton/spinner state when `!bootstrapped && localStorage` signals a prior session (a common pattern with session-cookie hydration). Not a bug; flagged as a UX improvement opportunity.

---

### F-06 — ErrorBoundary is outside the BrowserRouter, so the ErrorPage has no router context
**Severity:** high
**File:line:** `frontend/src/App.tsx:83-87`
```tsx
<ErrorBoundary>
  <BrowserRouter>
    ...
  </BrowserRouter>
</ErrorBoundary>
```
**Why it matters:** If a render-phase error is thrown *inside* `BrowserRouter` (which is the intended use case — any route component crashing), `ErrorPage` renders as the fallback. `ErrorPage` itself does not use any router hooks (no `Link`, no `useNavigate`), so this is currently safe. However, if `ErrorPage` or `ErrorBoundary`'s `fallback` prop is ever updated to include a `<Link>` or `useNavigate()` call, it will throw `Error: useNavigate() may be used only in the context of a <Router> component` because the boundary renders *outside* the router.
**Recommendation:** Document this constraint explicitly with a comment in `App.tsx`. Alternatively, move `ErrorBoundary` inside `BrowserRouter` (between `BrowserRouter` and `Routes`) — the toast provider does not require being outside the router. This is a latent fragility, not a current bug.

---

### F-07 — ErrorPage exposes full stack trace in production builds
**Severity:** medium
**File:line:** `frontend/src/features/errors/ErrorPage.tsx:69-71`
```tsx
<pre className="mt-2 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed">
  {error.message}
  {error.stack ? `\n\n${error.stack}` : ""}
</pre>
```
**Why it matters:** The stack trace (including internal file paths from the Vite bundle) is rendered inside a collapsible `<details>` element. In development this is helpful for debugging. In production builds, even minified stack traces can leak internal bundle structure and module paths to end users. There is no environment gate (`import.meta.env.DEV`).
**Recommendation:** Gate the `<details>` block on `import.meta.env.DEV`. In production: either omit the details block entirely, or replace stack content with a correlation ID / error code that can be looked up in server logs.

---

### F-08 — `t()` is a no-op stub; strings in template literals inside `t()` will NOT be extractable
**Severity:** low
**File:line:** `frontend/src/features/errors/ComingSoonPage.tsx:53`
```tsx
<CardTitle>{t(`${feature} — coming soon`)}</CardTitle>
```
**Why it matters:** The `t()` function is `(s) => s`. When i18n (i18next/Lingui) is introduced later, string extraction tools look for static string literals inside `t()`. Template literals with interpolated variables (`\`${feature} — coming soon\``) are not statically extractable — every distinct `feature` value creates a unique key. This is a common i18n trap.
**Recommendation:** Restructure to use a static key with interpolation: `t("{{feature}} — coming soon", { feature })` (i18next style) or a separate component that wraps the feature name outside the `t()` call. Low urgency while `t = (s) => s` but should be fixed before the real i18n library lands.

---

### F-09 — `routes.notFound()` helper defined but never used; NotFoundPage renders directly
**Severity:** info
**File:line:** `frontend/src/lib/routes.ts:10`
```ts
notFound: () => "/404",
```
**Why it matters:** The catch-all `*` route renders `NotFoundPage` (App.tsx line 178). The `routes.notFound()` helper would navigate to the literal path `/404`, which would itself match the `*` catch-all and show `NotFoundPage` again — a technically functional but misleading double-route. No code in the audit scope references `routes.notFound()`.
**Recommendation:** Either remove `routes.notFound()` from the routes table (it is unused and semantically wrong — the 404 page is served by `*`, not `/404`), or if `/404` is intentionally a named path, register it explicitly in App.tsx.

---

### F-10 — LandingPage roadmap cards are hardcoded; no link to a real roadmap
**Severity:** info
**File:line:** `frontend/src/features/landing/LandingPage.tsx:131-157`
```tsx
<RoadmapCard phase={t("Phase 1A — shipping")} ...tone="active" />
<RoadmapCard phase={t("Phase 1B — football")} ...tone="next" />
<RoadmapCard phase={t("v2 — beyond football")} ...tone="future" />
```
**Why it matters:** "Phase 1A — shipping" is accurate now (Phase 1A is complete), but users cannot navigate from these cards to changelog/roadmap detail. The copy will become stale as phases advance. There is no link from the roadmap strip to any detail page.
**Recommendation:** When Phase 1B ships, update `tone` for Phase 1B card to `"active"` and add a "What's new" link. Consider extracting roadmap content to a data file to make updates easier. Low urgency for pre-launch.

---

## 6. Gaps (missing coverage / missing tests)

| Gap | Severity |
|-----|---------|
| No test for `AboutPage` | medium |
| No test for `ErrorPage` standalone (only via ErrorBoundary) | medium |
| No test for `ComingSoonPage` | medium |
| `OrgComingSoonPage` has no test and may be dead code | low |
| ErrorPage stack trace not gated on `import.meta.env.DEV` | medium |
| `routes.notFound()` unused and semantically incorrect | info |
| No Playwright/E2E test for LandingPage redirect flows | info |

---

## 7. Summary table

| ID | Severity | File | Short description |
|----|----------|------|-------------------|
| F-01 | medium | `landing/AboutPage.tsx:5` | Permanent stub; no terms/privacy/contact |
| F-02 | medium | `errors/ErrorPage.tsx`, `errors/ComingSoonPage.tsx`, `landing/AboutPage.tsx` | No unit tests for three files |
| F-03 | medium | `errors/ComingSoonPage.tsx`, `layout/OrgComingSoonPage.tsx` | Two parallel coming-soon components |
| F-04 | low | `layout/OrgComingSoonPage.tsx:1` | Likely dead code (no route import found) |
| F-05 | low | `landing/LandingPage.tsx:34` | Hero flash on bootstrap for authenticated users (intentional trade-off) |
| F-06 | high | `App.tsx:83` | ErrorBoundary outside BrowserRouter; latent fragility if ErrorPage gains Links |
| F-07 | medium | `errors/ErrorPage.tsx:69` | Stack trace exposed in production builds |
| F-08 | low | `errors/ComingSoonPage.tsx:53` | Template literal inside t() breaks future i18n extraction |
| F-09 | info | `lib/routes.ts:10` | `routes.notFound()` unused and semantically wrong |
| F-10 | info | `landing/LandingPage.tsx:131` | Hardcoded roadmap cards will become stale |
