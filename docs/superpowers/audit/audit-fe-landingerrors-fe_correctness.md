# Audit: fe-landingerrors — Frontend Correctness
**Lens:** hook deps / stale closures, TanStack query key / invalidation bugs, races, broken route guards / redirects, form validation gaps, bad optimistic updates, unhandled rejections.
**Date:** 2026-06-04
**Scope:** `frontend/src/features/**` plus `frontend/src/api/`, `frontend/src/App.tsx`, `frontend/src/main.tsx`

---

## Findings

### F-01 · HIGH — LoginPage: `resolveDestination` captures stale `explicitNext` via closure but calls `useAuthStore.getState()` inside a non-hook function

**File:** `frontend/src/features/auth/LoginPage.tsx:70-75`
```tsx
const resolveDestination = (): string => {
  if (explicitNext) return explicitNext;
  const user = useAuthStore.getState().user;   // ← direct store access inside helper
  if (user) return pickLandingPathForUser(user);
  return routes.root();
};
```
**Why it matters:** `resolveDestination` is defined inside the render function and closes over `explicitNext` (fine — that's a stable const from `useSearchParams`). However calling `useAuthStore.getState()` inside a plain function defined inside the component body is technically fine *here* (it reads a Zustand store snapshot outside a hook context), but the function is recreated every render without being stable. More critically, `onTotpSubmit` calls `navigate(resolveDestination())` **after** `await completeTotp(values.totp)`. By the time the `await` resolves, the component may have been suspended or unmounted due to `requires2FA → false` state flip, creating a no-op navigation at best and a `Cannot update a component… while rendering` warning at worst. The function is not memoized, so every render allocates a new closure—but the real issue is the race between the store state flip and the `navigate()` call.

**Recommendation:** Either derive the destination before the await, or simply always navigate to `routes.root()` and let `ProtectedRoute` + `pickLandingPathForUser` handle the final redirect (which they already do via the `RootRedirect` pattern). At minimum, move `resolveDestination` outside the component or memoize it with `useCallback`.

---

### F-02 · HIGH — `TwoFactorChallengePage` always redirects to `routes.root()`, ignoring the original `?next=` parameter

**File:** `frontend/src/features/auth/TwoFactorChallengePage.tsx:27-29`
```tsx
const onSubmit = async (e: React.FormEvent): Promise<void> => {
  e.preventDefault();
  try {
    await completeTotp(totp);
    navigate(routes.root());           // ← hard-coded; no ?next= awareness
```
**Why it matters:** The 2FA challenge page is reached via `ProtectedRoute`'s redirect (`Navigate to={routes.twoFactorChallenge()}`) after a user tried to reach a protected URL. That protected URL is encoded in the URL's `?next=` parameter on the `/login` page, but `TwoFactorChallengePage` never reads `useSearchParams()`, so post-TOTP the user always lands at `/` rather than the original target. LoginPage correctly uses `explicitNext`; the challenge page does not.

**Recommendation:** Read `useSearchParams()` in `TwoFactorChallengePage` and apply the same `safeNext()` guard used by `LoginPage`, then navigate to the resolved destination.

---

### F-03 · HIGH — `OrgAuditLogPage`: paginating cursor resets are broken — "Previous" re-fetches the wrong page

**File:** `frontend/src/features/orgs/OrgAuditLogPage.tsx:68-76`
```tsx
const [cursor, setCursor] = React.useState<string | null>(null);

const query = useQuery({
  queryKey: ["audit", slug, cursor],
  queryFn: () => auditApi.list(slug, cursor ? { cursor, limit: 50 } : { limit: 50 }),
  enabled: Boolean(slug && hasModule),
});
```
And at line 189-191:
```tsx
<Button … onClick={() => setCursor(prevCursor ?? null)}>
  {t("Previous")}
```
**Why it matters:** `prevCursor` from `query.data?.previous_cursor` refers to the cursor value returned by the *current page*. Setting `cursor` to `prevCursor` issues a new query keyed `["audit", slug, prevCursor]`—which is correct *if* the API uses opaque cursors. However there is no "stack" or history of cursor values, so pressing "Previous" then "Next" doesn't round-trip correctly—it would show the page *before* the *current* page, not the page from which you came. The real issue is that when the user navigates away and comes back, `cursor` resets to `null` (initial state), so TanStack can refetch the first page but the cache for intermediate pages silently ages out with no UX indication. This is low-severity functionally but the Previous/Next logic assumes cursor-based APIs work bi-directionally with `previous_cursor`, which may not match the Django cursor pagination implementation.

**Recommendation:** Track a cursor stack (`useState<string[]>`) and push/pop on Next/Previous to enable accurate bidirectional navigation. At minimum verify `previous_cursor` is actually returned by the backend.

---

### F-04 · HIGH — `OrgSettingsPage`: `useEffect` dep array uses `orgQuery.data?.id` but `form.reset` calls are missing from the deps, causing lint-suppressed staleness

**File:** `frontend/src/features/orgs/OrgSettingsPage.tsx:168-176`
```tsx
React.useEffect(() => {
  if (orgQuery.data) {
    form.reset({
      name: orgQuery.data.name,
      time_zone: orgQuery.data.time_zone ?? "Asia/Kolkata",
    });
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [orgQuery.data?.id]);
```
**Why it matters:** The `eslint-disable-next-line` suppresses the warning that `form.reset` and `orgQuery.data` itself should be in deps. `form` is a stable `useForm` result, so this is low risk in practice. The bigger issue: when `orgQuery.data?.id` remains the same (same org, data refetched after a successful mutation) but `name` or `time_zone` has changed on the server (e.g. changed via another session), the form will **not** re-hydrate because the `id` dep hasn't changed. This also means that after a successful save, the form does NOT reflect the server response—only the local edit state. The `onSuccess` handler at line 189-194 does `qc.setQueryData(["org", orgSlug, "detail"], next)` which updates the cache, but since the id doesn't change, the effect doesn't fire again.

**Recommendation:** Change the dep to `[orgQuery.data]` (the whole object reference changes on each new response). Since `useForm` is stable, the suppression is not needed. If key-stability is a concern, use `JSON.stringify` of the relevant fields.

---

### F-05 · MEDIUM — `AuthBusBridge` in `App.tsx`: unauthenticated event clears state and navigates but no `?next=` is preserved

**File:** `frontend/src/App.tsx:52-62`
```tsx
useEffect(
  () =>
    onAuthEvent((e) => {
      if (e.type === "unauthenticated") {
        clear();
        navigate(routes.login());   // ← drops the user's current location
      }
    }),
  [navigate, clear],
);
```
**Why it matters:** When a query fires a 401 mid-session and the bus emits `unauthenticated`, the user is redirected to `/login` with no `?next=` hint. If they were mid-workflow (e.g. on `/o/acme/members`), they will be deposited on the post-login default landing page rather than returned to where they were. The `ProtectedRoute` redirect correctly encodes the `?next=` param, but the bus bridge bypasses it.

**Recommendation:** Capture `window.location.pathname + window.location.search` at the point of the auth event and append as `?next=` when navigating to login.

---

### F-06 · MEDIUM — `InvitationsListPanel`: `revoke.isPending && revoke.variables === inv.id` race — multiple rows can show "Revoking" simultaneously and the wrong row locks

**File:** `frontend/src/features/orgs/InvitationsListPanel.tsx:88-90`
```tsx
isRevoking={revoke.isPending && revoke.variables === inv.id}
```
**Why it matters:** `useMutation` in TanStack Query v5 maintains only a single in-flight mutation state. If a user rapidly clicks revoke on two different invitations before the first resolves, the second `mutate` call wins: `revoke.variables` becomes the second `id`, so `isRevoking` is `false` for the first row even while its request is still in flight. Both requests proceed to the server (TanStack doesn't cancel the first by default), but only one row shows the spinner—the first row's button is re-enabled while the delete is still pending, allowing a double-click race.

**Recommendation:** Track a `Set<string>` of in-flight IDs in a `useState`, add the id on click, remove on mutation settle. Or disable all Revoke buttons while any revoke is pending (`revoke.isPending` alone, without the variable check).

---

### F-07 · MEDIUM — `OrgDashboardPage`: feedback modal `onOpenChange` handler has inverted open logic

**File:** `frontend/src/features/layout/OrgDashboardPage.tsx:182-185`
```tsx
onOpenChange={(open): void => {
  if (!open) closeFeedback();
  else setFeedbackOpen(true);   // ← redundant; Dialog already got `open=true`
}}
```
**Why it matters:** When the Dialog tries to close itself (e.g. Escape key, outside click), it calls `onOpenChange(false)`, which correctly calls `closeFeedback()`. When it calls `onOpenChange(true)` (e.g. programmatic open), it calls `setFeedbackOpen(true)` which is fine but redundant. The `feedbackText` is NOT reset in the `else` branch—only `closeFeedback()` resets it. This means if a user opens the dialog, types something, closes via Escape, then re-opens via a card click, `feedbackText` is already reset (because `closeFeedback` ran). That part is fine. But if the Dialog fires `onOpenChange(true)` internally (which current shadcn/ui dialogs may not do), the text would NOT be reset. The real bug is that `setFeedbackOpen(true)` without resetting state is inconsistent with the intent of `closeFeedback()`.

**Recommendation:** Replace the `else setFeedbackOpen(true)` branch with nothing (or remove the `else` clause entirely since the Dialog's `open` prop is already controlled). The `onOpenChange` should only need: `if (!open) closeFeedback()`.

---

### F-08 · MEDIUM — `OwnershipTransferModal`: `toUserId` state not reset when modal is re-opened

**File:** `frontend/src/features/orgs/OwnershipTransferModal.tsx:50`
```tsx
const [toUserId, setToUserId] = useState(targetUserId ?? "");
const [reason, setReason] = useState("");
const [conflictAck, setConflictAck] = useState(false);
```
**Why it matters:** There is no `useEffect` to reset `toUserId`, `reason`, `conflictAck`, or `error` when `open` changes to `true`. If the modal is closed and then reopened with a *different* `targetUserId` prop value, the stale previous `toUserId` from `useState` initial value is displayed (React does not re-run `useState` initializers on re-render). Additionally, a failed transfer leaves `error` set, so re-opening the modal shows the previous error.

**Recommendation:** Add a `useEffect` watching `open`:
```tsx
useEffect(() => {
  if (open) {
    setToUserId(targetUserId ?? "");
    setReason("");
    setConflictAck(false);
    setError(null);
  }
}, [open, targetUserId]);
```

---

### F-09 · MEDIUM — `ModuleMatrixPage`: per-row save sends full merged cell map but only the row's local edits should need to be sent; stale closure in `onSaveRow`

**File:** `frontend/src/features/permissions/ModuleMatrixPage.tsx:147-152`
```tsx
const onSaveRow = (row: ModuleMatrixRow): void => {
  const rowEdits = edits[row.user_id];
  if (!rowEdits) return;
  const cells: Record<string, GrantState> = { ...row.cells, ...rowEdits };
  saveRow.mutate({ userId: row.user_id, cells });
};
```
**Why it matters:** `row` is the snapshot from the latest query result (`matrixQ.data?.members`). If `matrixQ` refetches between when the user makes an edit and when they click Save, `row.cells` may be an updated server snapshot but `rowEdits` still contains deltas against the *old* snapshot. The merge `{ ...row.cells, ...rowEdits }` could produce an incorrect combined state (user's intent vs. server's latest). This is a classic stale-props-in-closure issue: `onSaveRow` is defined fresh each render with the latest `row`, but the user's edits in `edits` state are deltas against the row state at the time the user clicked the cell.

**Recommendation:** Store edits as absolute (desired) `GrantState` values rather than as deltas against the snapshot. Then the PUT body is exactly what the user explicitly set, regardless of server refetches.

---

### F-10 · MEDIUM — `LoginPage` `useEffect` missing `credForm` and `totpForm` in deps; intentional but fragile

**File:** `frontend/src/features/auth/LoginPage.tsx:62-67`
```tsx
useEffect(() => {
  credForm.reset({ email: "", password: "" });
  totpForm.reset({ totp: "" });
  // Run once on mount; resetting after every render would fight typing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```
**Why it matters:** The comment explains the intentional suppression. `credForm` and `totpForm` are stable references from `useForm` so this won't actually cause a bug in practice. However the lint suppression masks any future deps that get added to the effect body. More concretely: if the page is kept mounted (e.g. React Router `keepAlive`, or strict-mode double-invoke in development), the double reset on mount may cause a flicker or clear a pre-filled email in development. The suppression is only necessary to avoid the lint warning, not for correctness.

**Recommendation:** The reset is fine. Remove the `eslint-disable` comment and instead structure as `useEffect(() => { void credForm.reset(...); void totpForm.reset(...); }, [credForm, totpForm])` — since `useForm` returns stable refs this is effectively a no-op dep array change with zero behavioral difference, and it's lint-clean.

---

### F-11 · MEDIUM — `PasswordResetCompletePage`: `setTimeout` navigation not cancelled on unmount

**File:** `frontend/src/features/auth/PasswordResetCompletePage.tsx:42-43`
```tsx
setDone(true);
// Auto-redirect after a brief moment so the success card is visible.
setTimeout(() => navigate(routes.login()), 1500);
```
**Why it matters:** If the user navigates away from the page manually (e.g. clicking Back) before the 1500 ms elapses, `navigate()` fires on an unmounted component. In React 18 with concurrent rendering this won't cause a visible error (unlike React 17), but it *will* navigate the user unexpectedly back to `/login` after 1.5 seconds, overriding their intended destination. It also fires a React state-update-on-unmounted-component warning in dev mode.

**Recommendation:** Store the timer ref and cancel it on cleanup:
```tsx
useEffect(() => {
  if (!done) return;
  const id = setTimeout(() => navigate(routes.login()), 1500);
  return () => clearTimeout(id);
}, [done, navigate]);
```

---

### F-12 · MEDIUM — `MemberDirectoryPage`: member remove confirmation uses `window.confirm` which blocks the event loop and is untestable

**File:** `frontend/src/features/orgs/MemberDirectoryPage.tsx:318-326`
```tsx
if (
  typeof window !== "undefined" &&
  !window.confirm(t(`Remove ${displayName} from this organization?`))
) {
  return;
}
removeMember.mutate(m);
```
**Why it matters:** `window.confirm` is a blocking modal that prevents any React state updates, timer ticks, or network completions from processing while it is open. It also cannot be tested with Vitest/Playwright without mocking the global. The existing test for this page (`MemberDirectoryPage.test.tsx`) needs to mock `window.confirm` to exercise the confirmation path. The issue is also that this pattern is inconsistent with the rest of the app which uses the custom `Dialog` component for confirmations.

**Recommendation:** Replace with an inline confirmation dialog (reuse the `Dialog` component pattern used in `OrgDashboardPage`'s feedback modal). Track a `pendingRemoveMember: OrgMember | null` state and confirm inside a real React modal.

---

### F-13 · LOW — `TwoFactorEnrollPage`: `navigate(routes.root())` after 2FA enrollment takes user to `/` which triggers `RootRedirect` → picks landing path for user, but `refreshMe` updates the store asynchronously

**File:** `frontend/src/features/auth/TwoFactorEnrollPage.tsx:94`
```tsx
<Button onClick={() => navigate(routes.root())}>
  {t("Done")}
</Button>
```
**Why it matters:** The "Done" button fires synchronously. The preceding `await refreshMe()` (line 58) already updated `has_2fa_enrolled` in the store, but `navigate` is called from the button click — not from `refreshMe`'s resolution. This means the user clicks "Done" and navigates. The potential race: if `refreshMe` is still in flight when the user clicks Done (impossible here since it's inside `try`), the user could land on a page that reads stale `has_2fa_enrolled = false`. Since `refreshMe` completes before `setRecovery` renders the "Done" button, this is benign in normal flow, but the gap between "2FA enrolled" and UI showing the recovery codes leaves a window where navigating away via another tab would lose the recovery codes.

**Recommendation:** Low priority. The current flow is correct for normal use. Consider disabling navigation until the user has had the opportunity to copy recovery codes (e.g. a "I've saved these" checkbox).

---

### F-14 · LOW — `InviteCreateModal`: `useEffect` to reset state on dialog re-open suppresses `form` dep

**File:** `frontend/src/features/orgs/InviteCreateModal.tsx:88-95`
```tsx
React.useEffect(() => {
  if (open) {
    setError(null);
    setSent(null);
    form.reset({ email: "", roles: ["admin"], message: "" });
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [open]);
```
**Why it matters:** `form` from `useForm` is a stable reference, so the dep suppression is harmless here. Same pattern as F-10. The suppressions create a maintenance debt — any future change adding a captured closure variable won't trigger a lint warning.

**Recommendation:** Add `form` to the dep array (it's stable, so no behavior change) and remove the suppression comment.

---

### F-15 · LOW — `OrgBrandingPage` and `OrgSettingsPage` share the identical `["org", orgSlug, "detail"]` query key but fetch from the same endpoint independently

**File:** `frontend/src/features/orgs/OrgBrandingPage.tsx:114-118` and `frontend/src/features/orgs/OrgSettingsPage.tsx:156-159`
```tsx
// OrgBrandingPage:
queryKey: ["org", orgSlug, "detail"],
queryFn: () => api.get<OrgDetail>(`/api/orgs/${orgSlug}/`),

// OrgSettingsPage:
queryKey: ["org", orgSlug, "detail"],
queryFn: () => api.get<OrgDetail>(`/api/orgs/${orgSlug}/`),
```
**Why it matters:** The shared cache key means the cache is shared correctly — a fetch in one page populates the other's cache. However `OrgSettingsPage`'s `onSuccess` handler calls `qc.setQueryData(["org", orgSlug, "detail"], next)` with the PATCH response. If the PATCH response has a different shape than the GET response (e.g. a wrapping envelope), this sets incorrect cache data for both pages. Currently the `OrgDetail` interface is identical, but this is a fragile coupling that will silently break when the API schema diverges.

**Recommendation:** Define and export the `OrgDetail` interface centrally (e.g. in `@/api/orgs.ts`) so both pages use the same type contract. Consider using a `select` transform in `useQuery` if shapes could diverge.

---

### F-16 · LOW — `AuthBusBridge`: `navigate` is captured in `useEffect` dep array but `onAuthEvent` callback fires after navigation has already occurred in some cases (double navigation risk)

**File:** `frontend/src/App.tsx:52-63`
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
**Why it matters:** The `QueryCache.onError` emits `unauthenticated` for every failing query that returns 401. If multiple queries are in-flight simultaneously (e.g. `OrgDashboardPage` fetching members + the module matrix), multiple `unauthenticated` events fire in rapid succession. Each fires `navigate(routes.login())`, causing multiple redundant navigations. React Router's `navigate` is idempotent for the same route, so this is benign from a UX standpoint, but `clear()` is called multiple times (also idempotent). Consider the mutation bus: `onError` in `QueryCache` fires per-query, not de-duplicated.

**Recommendation:** Guard with a flag in the closure or throttle: `let redirected = false; onAuthEvent((e) => { if (e.type === "unauthenticated" && !redirected) { redirected = true; clear(); navigate(...); } })`. Reset `redirected` after the page mounts.

---

### F-17 · INFO — `OrgChooserPage` silently hides no-org users from the empty state when `ProtectedRoute` redirects them here but shows nothing

**File:** `frontend/src/features/layout/OrgChooserPage.tsx:14-15`
```tsx
const user = useAuthStore((s) => s.user);
if (!user) return <div />;
```
**Why it matters:** `ProtectedRoute` redirects users with zero memberships to `/orgs`. The `OrgChooserPage` then renders an empty `<div />` if `user` is null — but `ProtectedRoute` guarantees user is non-null before rendering children. The check is defensive but misleading. More importantly, the page renders the "no orgs" message correctly (lines 40-46), but the empty `<div />` escape hatch can flash briefly if the store update lags behind navigation (unlikely but possible during HMR).

**Recommendation:** Replace `if (!user) return <div />;` with a proper loading skeleton consistent with other pages, or verify that `ProtectedRoute` truly guarantees non-null user before this can render.

---

### F-18 · INFO — `PasswordReauthModal`: unhandled rejection from `reauth()` is caught but error state is not cleared when the modal is closed and reopened

**File:** `frontend/src/features/auth/PasswordReauthModal.tsx:26-37`
```tsx
const [open, setOpen] = useState(false);
const [password, setPassword] = useState("");
const [error, setError] = useState<string | null>(null);

useEffect(
  () =>
    onAuthEvent((e) => {
      if (e.type === "password_reauth_required") {
        setError(null);     // ← reset on new event
        setPassword("");
        setOpen(true);
      }
    }),
  [],
);
```
**Why it matters:** If the user closes the modal (via Cancel or Escape, which calls `setOpen(false)`) without successfully reauthenticating, and then triggers another reauth-required action, the `onAuthEvent` handler correctly resets `error` and `password`. So this is actually fine. However if the dialog is dismissed via clicking outside the modal (`onOpenChange(false)` fires), the state is not reset until the next `password_reauth_required` event — so a user who dismisses and immediately reopens via another action sees a clean form. This is the correct behavior, but worth noting.

**Recommendation:** No action required. Current behavior is correct.

---

## Summary of Severity Counts

| Severity | Count |
|----------|-------|
| HIGH     | 4 (F-01, F-02, F-03, F-04) |
| MEDIUM   | 8 (F-05 through F-12) |
| LOW      | 4 (F-13 through F-16) |
| INFO     | 2 (F-17, F-18) |

---

## Gaps (Forward-Looking)

| Gap | Area | Missing | Blocking | Effort |
|-----|------|---------|----------|--------|
| No TanStack Query invalidation after `refreshMe()` in `MyProfilePage.saveName` | MyProfilePage.tsx | After PATCH /me/ succeeds, `qc.invalidateQueries(["me"])` is never called — only `refreshMe()` which updates authStore. Any TanStack-cached query that contains user data (e.g. org-member-directory rows with `full_name`) stays stale. | No | S |
| No loading state on `OrgChooserPage` | OrgChooserPage.tsx | The page reads from authStore directly (not a query), so there's no loading skeleton while the store hydrates. `ProtectedRoute` blocks with a spinner but once bootstrapped the chooser renders immediately — fine. Gap is that if org data is stale in the store, the user sees stale org names/slugs. No mechanism to refresh the membership list from the chooser. | No | S |
| `OrgSwitcher` does not reset `activeRole` when switching orgs | OrgSwitcherStore.ts + OrgSwitcher.tsx | `setActiveRole` is never called when `onPickOrg` fires. The new org may have completely different roles but `activeRole` retains the previous org's role name. Any component reading `activeRole` from the store without cross-checking against the current org's membership gets a stale role. | No | S |
| No `mutationCache.onError` handler for mutations returning 401/403 | queryClient.ts | Only `queryCache.onError` is hooked. Mutations (e.g. `createInvitation`, `removeMember`) that return 401 or `password_reauth_required` do NOT emit through the bus — the error is surfaced only via the `onError` callback in each individual mutation. This means a session expiry during a mutation silently fails rather than redirecting to login. | No | M |
| No idempotency `event_id` on `OrgSettingsPage` PATCH | OrgSettingsPage.tsx | The settings PATCH at line 184 sends no `event_id`. Invariant #3 requires all mutation endpoints accept a client-generated `event_id`. If the request times out and the user retries, the server has no idempotency guard and may apply the update twice. | Yes (violates invariant #3) | S |
| `AuthBusBridge` uses `navigate` from `useNavigate` which requires a Router context, but `PasswordReauthModal` also uses auth events with no Router dependency — inconsistent pattern | App.tsx | If the app ever mounts `AuthBusBridge` outside a `BrowserRouter`, it silently does nothing (navigate would throw). The pattern is fragile; a dedicated hook or a listener that is router-agnostic would be safer. | No | M |
| No protection against the `?next=` open-redirect surviving deep link traversal | LoginPage.tsx safeNext | `safeNext` correctly blocks `//` and non-`/` prefixes. It does NOT block URLs like `/\example.com` (backslash bypass) or paths that redirect to other origins via the app's own route table. The current guard is sufficient for modern browsers but worth validating. | No | S |
