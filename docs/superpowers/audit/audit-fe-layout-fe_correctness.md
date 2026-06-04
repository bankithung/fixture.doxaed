# Audit: fe-layout — Frontend Correctness

**Lens:** hook deps/stale closures, wrong TanStack query keys/missing invalidation, races, broken route guards/redirects, form validation gaps, bad optimistic updates, unhandled rejections.

**Files audited:**
- `frontend/src/features/layout/ProtectedRoute.tsx`
- `frontend/src/features/layout/AppShell.tsx`
- `frontend/src/features/layout/OrgChooserPage.tsx`
- `frontend/src/features/layout/OrgDashboardPage.tsx`
- `frontend/src/features/layout/OrgComingSoonPage.tsx`
- `frontend/src/features/layout/computeNavItems.ts`
- `frontend/src/features/orgs/OrgSwitcherStore.ts` (referenced by AppShell)
- `frontend/src/features/orgs/OrgSwitcher.tsx` (mounted inside AppShell)
- `frontend/src/features/orgs/dashboardCards.ts`
- `frontend/src/features/auth/authStore.ts`
- `frontend/src/api/feedback.ts`
- `frontend/src/api/queryClient.ts`
- `frontend/src/lib/routes.ts`
- `frontend/src/App.tsx`
- `frontend/src/main.tsx`

---

## Findings

### F1 — Route guard 2FA redirect works with `user` in store (race with bootstrap)

**Severity:** medium  
**File:** `frontend/src/features/layout/ProtectedRoute.tsx:41-43`

**Evidence:**
```tsx
if (requires2FA && !user) {
  return <Navigate to={routes.twoFactorChallenge()} replace />;
}
```

**Why it matters:** The guard fires only when `requires2FA === true && !user`. However, the `requires2FA` flag is set in `authStore.login()` and cleared in `authStore.clear()`. If a global 401 fires (e.g., from a separate query) while the 2FA challenge page is being rendered, `AuthBusBridge` in `App.tsx` calls `clear()` which resets `requires2FA` to `false`. This races with the TOTP submit: the user is mid-challenge, a background query 401s, `requires2FA` goes `false`, and the user is instead routed to `/login?next=…` by the guard below it. The credentials stored in `pendingCredentials` (module scope in authStore) are NOT cleared by `clear()` — creating a minor inconsistency where a next login could potentially complete with stale pending credentials.

**Recommendation:** Have `clear()` also null out `pendingCredentials`. Add an integration test for the 401-during-2FA-challenge scenario.

---

### F2 — `OrgDashboardPage` `useEffect` re-fires on every `searchParams` object identity change (stale closure / redundant renders)

**Severity:** medium  
**File:** `frontend/src/features/layout/OrgDashboardPage.tsx:41-48`

**Evidence:**
```tsx
useEffect(() => {
  if (searchParams.get("feedback") === "1") {
    setFeedbackOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete("feedback");
    setSearchParams(next, { replace: true });
  }
}, [searchParams, setSearchParams]);
```

**Why it matters:** `searchParams` from `useSearchParams()` returns a new object on every render (react-router-dom v6 behaviour). The effect therefore runs on every render after mount. If any other state change triggers a re-render before the `replace: true` navigation has propagated (e.g. `setFeedbackOpen(true)` itself causing a re-render), the effect can fire twice in a single navigation: once to open the modal and strip `?feedback=1`, and a second time with the already-stripped params (harmless but wasteful). The real risk is if any upstream code ever sets `?feedback=1` again in the same session without a full page reload — the effect would re-open the modal unexpectedly.

**Recommendation:** Use a `useRef` flag to track whether the `?feedback=1` trigger has already been consumed in this mount, or check the condition with `useRef` rather than re-running the full effect on every `searchParams` identity change:
```tsx
const feedbackHandled = useRef(false);
useEffect(() => {
  if (!feedbackHandled.current && searchParams.get("feedback") === "1") {
    feedbackHandled.current = true;
    setFeedbackOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete("feedback");
    setSearchParams(next, { replace: true });
  }
}, [searchParams, setSearchParams]);
```

---

### F3 — `OrgDashboardPage.submitFeedback` swallows the `setFeedbackSubmitting(false)` path when `closeFeedback()` also resets state — not a real bug but an ordering concern

**Severity:** low  
**File:** `frontend/src/features/layout/OrgDashboardPage.tsx:67-110`

**Evidence:**
```tsx
const submitFeedback = async (): Promise<void> => {
  ...
  setFeedbackSubmitting(true);
  try {
    await feedbackApi.submit({ ... });
    ...
    closeFeedback();   // sets feedbackOpen=false, feedbackText=""
  } catch (e) {
    ...
  } finally {
    setFeedbackSubmitting(false);  // runs after closeFeedback() on success
  }
};
```

**Why it matters:** On success, `closeFeedback()` resets `feedbackText` and closes the dialog, then `finally` sets `feedbackSubmitting(false)`. This is harmless here because the dialog is unmounted/hidden. But if the dialog transitions (e.g. framer-motion exit animation) are added in the future, there will be a brief window where the now-closed dialog is still in the DOM with `disabled` buttons, then briefly re-enabled as `feedbackSubmitting` goes back to `false`. Not a current defect, but worth noting as a future fragility.

**Recommendation:** Restructure to call `closeFeedback()` after `setFeedbackSubmitting(false)`:
```tsx
} finally {
  setFeedbackSubmitting(false);
}
closeFeedback(); // only on success path, outside try/finally
```
Or keep as-is with a note that closeFeedback intentionally collapses the dialog before submitting completes, and rely on the `disabled` state of the textarea/buttons during submission.

---

### F4 — `AppShell.handleSignOut` does not invalidate TanStack Query cache before navigating

**Severity:** medium  
**File:** `frontend/src/features/layout/AppShell.tsx:86-90`

**Evidence:**
```tsx
const handleSignOut = async (): Promise<void> => {
  setMenuOpen(false);
  await logout();
  navigate(routes.login());
};
```

**Why it matters:** `logout()` clears the Zustand auth store but does not call `queryClient.clear()` or `queryClient.invalidateQueries()`. Any org-scoped data that was fetched and cached (member list, audit log, permissions) remains in the TanStack Query cache after logout. If a different user logs in on the same browser tab in the same session, they can observe stale data from the previous session until the 30 s `staleTime` expires and queries refetch. With `gcTime: 5 * 60_000`, data survives in memory for 5 minutes after a successful logout.

**Recommendation:** Clear the query client on logout:
```tsx
import { queryClient } from "@/api/queryClient";
...
const handleSignOut = async (): Promise<void> => {
  setMenuOpen(false);
  await logout();
  queryClient.clear();   // evict all cached data before the new session
  navigate(routes.login());
};
```
This is especially important given invariant #2 (no cross-org data leaks).

---

### F5 — `OrgSwitcher.persistLastActive` mutation errors are silently discarded with no error boundary or `onError` handler

**Severity:** low  
**File:** `frontend/src/features/orgs/OrgSwitcher.tsx:26-29`

**Evidence:**
```tsx
const persistLastActive = useMutation({
  mutationFn: (orgId: string) =>
    authApi.patchMe({ last_active_org_id: orgId }),
});
```

**Why it matters:** The mutation has no `onError` callback and the caller (`onPickOrg`) does not `.catch()` the returned promise from `persistLastActive.mutate()`. Unhandled API errors will silently bubble to `queryClient`'s mutation error handler (which has `retry: 0`). No toast is shown. The comment says "failures are non-blocking", which is an acceptable product decision, but since `mutationFn` can also throw on a 401, the auth bus `emit({ type: "unauthenticated" })` is NOT called here (the `QueryCache.onError` callback only covers queries, not mutations). A 401 from `PATCH /me/` will be silently dropped.

**Recommendation:** Add an `onError` handler that at least emits to the auth bus for 401/403 errors:
```tsx
const persistLastActive = useMutation({
  mutationFn: (orgId: string) => authApi.patchMe({ last_active_org_id: orgId }),
  onError: (e) => {
    if (e instanceof ApiError && e.isUnauthenticated) authBus.emit({ type: "unauthenticated" });
    // other errors: swallow per "best-effort" design decision
  },
});
```

---

### F6 — `ProtectedRoute` redirect loop risk: zero-membership superuser on `/orgs`

**Severity:** low  
**File:** `frontend/src/features/layout/ProtectedRoute.tsx:50-57`

**Evidence:**
```tsx
const memberships = user.memberships ?? [];
if (
  memberships.length === 0 &&
  !user.is_superuser &&
  location.pathname !== routes.orgChooser()
) {
  return <Navigate to={routes.orgChooser()} replace />;
}
```

**Why it matters:** The guard correctly exempts `is_superuser` from the zero-membership redirect. However, `routes.orgChooser()` returns `"/orgs"` and the guard only compares `location.pathname !== routes.orgChooser()`. If the user lands on `/orgs?foo=bar`, the pathname check passes and the user is NOT redirected (the check fires correctly). This edge case is actually fine. However, a non-superuser with zero memberships navigating to any other protected route (e.g. `/me`) will be redirected to `/orgs`, which renders `OrgChooserPage`. That page shows `user.memberships.map(...)` which will be an empty list and display the "You don't belong to any organizations yet" message. This is the intended UX. No defect here, but documented for completeness.

**Recommendation:** No immediate change required. Consider adding `/me` and `/me/notifications` to an allowed-without-membership set so users can still manage their profile even with zero memberships.

---

### F7 — `computeNavItems` module strings duplicated between `computeNavItems.ts` and `dashboardCards.ts`

**Severity:** low  
**File:** `frontend/src/features/layout/computeNavItems.ts:21-24`

**Evidence:**
```ts
const MODULE_ORG_MEMBER_DIRECTORY = "org.member_directory";
const MODULE_ORG_AUDIT_LOG = "org.audit_log";
const MODULE_MATCH_SCORING_CONSOLE = "match.scoring_console";
const MODULE_MATCH_REFEREE_CONSOLE = "match.referee_console";
```
Compare with `frontend/src/features/orgs/dashboardCards.ts:48-56` which exports `MODULES` with the same strings.

**Why it matters:** The comment in `computeNavItems.ts` acknowledges the duplication ("Duplicated here...the two should stay in sync"). If the module codes change (e.g., `match.scoring_console` becomes `match.scorer_console`), both files must be updated independently, and a missed update will produce a silent RBAC mismatch: the nav item hides or shows incorrectly. The comment acknowledges `dashboardCards.ts` is the source of truth, but `computeNavItems.ts` does not import from it.

**Recommendation:** Import the `MODULES` constant from `dashboardCards.ts` into `computeNavItems.ts` and derive the local constants from it, eliminating the duplication.

---

### F8 — `AppShell` `useEffect` for closing menu/drawer on route change runs on EVERY pathname change, including hash-only or search-only changes

**Severity:** info  
**File:** `frontend/src/features/layout/AppShell.tsx:47-51`

**Evidence:**
```tsx
useEffect(() => {
  setMenuOpen(false);
  setDrawerOpen(false);
}, [location.pathname]);
```

**Why it matters:** Using only `location.pathname` as a dependency means menu/drawer close on pathname changes. Hash-only changes (e.g., anchor navigation within the same page) and search-param changes do NOT close the menu. This is the correct behaviour for anchor links but could be surprising if a future feature uses hash routing for tabs within org pages. Currently harmless.

**Recommendation:** No immediate change. Document the intent explicitly in a comment.

---

### F9 — `OrgChooserPage` renders `<div />` instead of a redirect when `user` is null

**Severity:** low  
**File:** `frontend/src/features/layout/OrgChooserPage.tsx:14-15`

**Evidence:**
```tsx
const user = useAuthStore((s) => s.user);
if (!user) return <div />;
```

**Why it matters:** `OrgChooserPage` is mounted inside `<ProtectedRoute>`, which guarantees `user` is non-null before rendering children. The `if (!user) return <div />` guard is therefore unreachable in the normal flow. However, in tests where the page is rendered directly without `ProtectedRoute` and the store has `user: null`, this silently renders an empty div rather than surfacing a useful error. More importantly, if `authStore.clear()` is called while the chooser is mounted (e.g., by the auth bus), the component renders `<div />` instead of re-routing to `/login`, potentially leaving the user on a blank page until the next render cycle where `ProtectedRoute` catches the null user.

**Recommendation:** Replace `return <div />` with a redirect or throw, since this path should never be reached in production. Alternatively, let `ProtectedRoute` exclusively own the null-user guard and remove the defensive check from the page component.

---

### F10 — `AuthBusBridge` in `App.tsx` has stable `navigate` and `clear` deps but is inside `BrowserRouter` — correct; no stale-closure risk

**Severity:** info  
**File:** `frontend/src/App.tsx:52-62`

**Evidence:**
```tsx
useEffect(
  () =>
    onAuthEvent((e) => {
      if (e.type === "unauthenticated") {
        clear();
        navigate(routes.login());
      }
    }),
  [navigate, clear],
);
```

**Why it matters:** `navigate` from `useNavigate()` is stable across renders. `clear` from `useAuthStore((s) => s.clear)` is a stable function reference (defined once in the store factory). The `onAuthEvent` subscription is correctly returned as the cleanup. No stale-closure risk here.

**Recommendation:** None.

---

## Gaps (Forward-looking, not current defects)

| # | Area | Missing | Needed for | Effort |
|---|------|---------|-----------|--------|
| G1 | `AppShell.handleSignOut` | TanStack Query cache clear on logout | Security invariant #2 (no cross-user cache bleed) | S |
| G2 | `authStore.clear()` | Clear `pendingCredentials` module-scope variable | 2FA race on global 401 | S |
| G3 | `computeNavItems.ts` | Import `MODULES` from `dashboardCards.ts` instead of duplicating strings | Maintainability; single source of truth for module codes | S |
| G4 | `ProtectedRoute` | Allow `/me` and `/me/notifications` without membership | UX for org-less users who need profile access | M |
| G5 | `OrgSwitcher.persistLastActive` | `onError` handler that routes 401 to auth bus | Auth correctness; 401 from mutation is currently swallowed | S |
| G6 | `OrgDashboardPage` | No TanStack Query usage at all — dashboard data comes purely from `authStore` | Phase 1B will need live org stats/counts; query key design needed | L |
| G7 | `OrgChooserPage` | No empty-state CTA to create a first org | Locked product decision: tournament auto-provisions personal workspace; need a "Create tournament" shortcut on the chooser | M |
| G8 | Layout area | No TanStack Query invalidation of `/me/` after org-slug PATCH in `OrgSwitcher` | If memberships change server-side between renders, the auth store holds stale data | M |
| G9 | `ProtectedRoute` | `requires2FA` + active 2FA challenge persists across tabs (module-scope `pendingCredentials`) | If user opens a new tab, `pendingCredentials` is null there, but `requires2FA` is set in Zustand — new tab shows `/2fa/challenge` but `completeTotp` will throw `no_pending_credentials` | M |
