# FE-Core Correctness Audit
**Lens:** hook deps / stale closures, wrong TanStack query keys / missing invalidation, races, broken route guards / redirects, form validation gaps, bad optimistic updates, unhandled rejections.  
**Scope:** `frontend/src/` — all `.ts` / `.tsx` files (Phase 1A implemented code only).  
**Date:** 2026-06-04

---

## Findings

---

### F-01 · HIGH — Stale closure in `resolveDestination` reads `useAuthStore.getState()` inside a render-phase function called from an async handler

**File:** `frontend/src/features/auth/LoginPage.tsx:70-75`

```tsx
const resolveDestination = (): string => {
  if (explicitNext) return explicitNext;
  const user = useAuthStore.getState().user;   // ← imperative getState inside function
  if (user) return pickLandingPathForUser(user);
  return routes.root();
};
```

**Why it matters:** The function is defined in the render closure and called inside the `onCredSubmit` / `onTotpSubmit` async handlers _after_ `await login(values)` resolves. Because `resolveDestination` itself is not listed as a dependency of anything (it's a plain `const` recomputed each render), it will always refer to the _latest_ render's `explicitNext` — that part is fine. However calling `useAuthStore.getState()` is correct for reading outside React (zustand's escape hatch), so this is actually the right pattern here. The real issue: `resolveDestination` is defined fresh each render but is called post-`await` from handlers that capture it at the time of the click. If the component unmounts between the `await` and the `navigate` call (e.g. StrictMode double-invoke, or user navigates away mid-inflight request), `navigate` will fire on the unmounted tree.  
**Recommendation:** Guard with an `isMounted` ref or use `useEffect`-based navigation. In strict mode this is benign because navigation is idempotent, but the pattern should be documented. Severity is medium-low in practice but worth fixing for correctness.

---

### F-02 · HIGH — `OrgAuditLogPage`: cursor pagination uses cursor value IN the query key, causing stale "Load more" state and missing `keepPreviousData`

**File:** `frontend/src/features/orgs/OrgAuditLogPage.tsx:70-77`

```tsx
const query = useQuery<...>({
  queryKey: ["audit", slug, cursor],          // cursor in key
  queryFn: () => auditApi.list(slug, cursor ? { cursor, limit: 50 } : { limit: 50 }),
  enabled: Boolean(slug && hasModule),
});
```

**Why it matters:**  
1. Every time the user clicks "Next" a brand-new query is started (different key). Without `placeholderData: keepPreviousData` (TanStack v5 API) or `keepPreviousData: true` (v4), the table flashes to an empty/loading state between pages, making the UI look broken.  
2. When the user clicks "Previous" the old query is still in cache (if `gcTime` hasn't elapsed) so it will re-use stale data — correct behaviour — but if the server has since mutated the log the user will silently see stale rows. For an append-only audit log this is acceptable, but the loading flash on "Next" is a real UX regression.  
3. `prevCursor` / `nextCursor` are only set from `query.data`, which is `undefined` while loading, so the pagination buttons disappear during transitions. This can confuse users into thinking there are no more pages.  
**Recommendation:** Add `placeholderData: (prev) => prev` (v5) or `keepPreviousData: true` (v4) to the query. Alternatively, convert to infinite query if the library version permits.

---

### F-03 · HIGH — `OrgBrandingPage` uses the same query key as `OrgSettingsPage` (`["org", orgSlug, "detail"]`) — cache sharing causes silent cross-contamination

**File:** `frontend/src/features/orgs/OrgBrandingPage.tsx:114-118`

```tsx
const orgQuery = useQuery({
  queryKey: ["org", orgSlug, "detail"],        // identical to OrgSettingsPage
  queryFn: () => api.get<OrgDetail>(`/api/orgs/${orgSlug}/`),
  ...
});
```

**File:** `frontend/src/features/orgs/OrgSettingsPage.tsx:156-160`

```tsx
const orgQuery = useQuery({
  queryKey: ["org", orgSlug, "detail"],        // same key
  queryFn: () => api.get<OrgDetail>(`/api/orgs/${orgSlug}/`),
  ...
});
```

**Why it matters:** Both pages fetch the same endpoint with the same query key, so their caches are shared. This is _intentional and correct_ for the read side — they show the same data. However `OrgSettingsPage.onSuccess` writes back via `qc.setQueryData(["org", orgSlug, "detail"], next)`. If the user saves settings on `OrgSettingsPage` and then navigates to `OrgBrandingPage` without a refetch, the branding page will display the mutated data object — this is fine in this specific case since both pages read the same fields. **However**, the type declared as `OrgDetail` is a local interface in _each_ file. If either file adds or removes fields independently, the other file will silently receive a misshapen object. The real fix is to share a single `OrgDetail` type from `@/api/orgs` or from the generated types.  
**Recommendation:** Extract `OrgDetail` to a shared location (e.g. `@/api/orgs`). Consider separate query keys if the pages ever diverge. Confidence: high.

---

### F-04 · MEDIUM — `InviteCreateModal`: `form` is missing from the `useEffect` dependency array (intentional suppression via `eslint-disable`)

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

**Why it matters:** `form` (from `useForm`) is intentionally excluded from the deps because react-hook-form's `useForm` returns a stable reference across renders (it uses `useRef` internally). The eslint disable comment is acceptable here, BUT if the project ever upgrades react-hook-form to a version that changes this guarantee, the reset will silently stop working when `open` changes. More importantly, the pattern also omits `setError` and `setSent` — which _are_ stable `setState` dispatchers from `useState`, so that part is safe. This is a low-risk false-negative suppression.  
**Recommendation:** Replace the blanket eslint disable with a specific ref extraction: `const resetForm = useCallback(() => form.reset(...), [form])` to make the dependency explicit, or add a comment explaining the react-hook-form stable-ref guarantee. Confidence: medium.

---

### F-05 · MEDIUM — `OrgSettingsPage`: `useEffect` hydrates the form using `orgQuery.data?.id` as dependency instead of the full data object, causing stale form state if name/tz changes without the id changing

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
}, [orgQuery.data?.id]);          // ← only reruns when ID changes
```

**Why it matters:** The effect only re-runs when `orgQuery.data?.id` changes. If the query re-fetches (e.g. after `invalidateQueries` on successful save, which does happen in `onSuccess`) and returns an org with a different `name` or `time_zone` but the same `id` (which is always the case for an update), the form will not re-hydrate with fresh values. Concretely:  
- User opens settings: form hydrates correctly.  
- User saves → `qc.setQueryData` puts new data in cache → React Query flags data as fresh → effect does NOT re-run (id unchanged) → form still shows the pre-save values.  
- If the user then reloads or navigates away and back, the form will show the updated values.  

In practice the `onSuccess` uses `qc.setQueryData` (not `invalidateQueries`), so the cache is updated but the effect still won't re-run because the eslint disable suppresses `orgQuery.data` from the dep array.  
**Recommendation:** Use `orgQuery.data` as the dependency (full object) or track a combination of `id + updatedAt`. At minimum remove the `eslint-disable` and let exhaustive-deps lint enforce correctness.

---

### F-06 · MEDIUM — `AuthBusBridge` effect in `App.tsx`: `navigate` and `clear` are listed as deps but they are created freshly from hooks each render — creating new listener registrations on every re-render

**File:** `frontend/src/App.tsx:52-62`

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

**Why it matters:** `navigate` from `useNavigate()` is stable across renders in React Router v6 (it is memoised). `clear` from `useAuthStore((s) => s.clear)` returns a stable reference (zustand actions are stable). So in practice the deps never change and only one listener is registered. **However** if either dependency ever changes identity (e.g. after a React Router internal refactor or a zustand upgrade), a new listener would be added without the old one being removed — the cleanup (`return () => listeners.delete(fn)`) does run but only for the _previous_ effect invocation, so the registration churn would be safe. The code is correct for current library versions. This is an info-level concern about future-proofing.  
**Recommendation:** No immediate fix needed. Add a comment explaining the stability guarantee.

---

### F-07 · MEDIUM — `PasswordReauthModal`: after a successful reauth, the pending operation that triggered the 403 is NOT retried — the user must manually re-trigger their action

**File:** `frontend/src/features/auth/PasswordReauthModal.tsx:41-57`

```tsx
const onSubmit = async (e: React.FormEvent): Promise<void> => {
  e.preventDefault();
  ...
  try {
    await authApi.reauth(password);
    setOpen(false);         // modal closes
    setPassword("");
    // ← no retry of the original failed mutation
  } catch (err) { ... }
};
```

**Why it matters:** The `password_reauth_required` signal is emitted by the `QueryCache.onError` handler. The originating query or mutation has already failed and its error state is set. After the user re-auths via this modal, the failed operation is not retried — it sits in the error state. The user sees the modal close but their save/transfer/delete still shows as "failed". They need to re-click the trigger button manually. This is a correctness gap vs the expected UX of "auth → retry → success."  
**Recommendation:** After a successful reauth, call `qc.invalidateQueries()` (for queries) or expose a retry callback from the originating mutation. The cleanest pattern is to store the last failed mutation's retry function in a ref/store and call it after successful reauth.

---

### F-08 · MEDIUM — `OwnershipTransferModal`: does not reset local form state (`toUserId`, `reason`, `conflictAck`, `error`) when the dialog re-opens with a new `targetUserId`

**File:** `frontend/src/features/orgs/OwnershipTransferModal.tsx:50-53`

```tsx
const [toUserId, setToUserId] = useState(targetUserId ?? "");
const [reason, setReason] = useState("");
const [conflictAck, setConflictAck] = useState(false);
const [error, setError] = useState<string | null>(null);
```

**Why it matters:** `toUserId` is initialised from `targetUserId` prop only at mount time (`useState(targetUserId ?? "")`). If the parent renders the modal a second time with a _different_ `targetUserId` prop (e.g. the user opens the dialog for member A, cancels, then opens for member B), the `toUserId` field will still hold member A's ID. The `open` prop change does not trigger a reset.  
**Recommendation:** Add a `useEffect` on `[open, targetUserId]` to reset all local state when the dialog opens. Pattern is: `if (open) { setToUserId(targetUserId ?? ""); setReason(""); setConflictAck(false); setError(null); }`.

---

### F-09 · MEDIUM — `MemberDirectoryPage`: `removeMember` mutation invalidates the members query but does NOT invalidate the invitations query; after a member removal the `InvitationsListPanel` could show stale data

**File:** `frontend/src/features/orgs/MemberDirectoryPage.tsx:293-299`

```tsx
onSuccess: () => {
  toast.push({ kind: "success", title: t("Member removed") });
  qc.invalidateQueries({ queryKey: ["org", orgSlug, "members"] });
  // ← missing: qc.invalidateQueries({ queryKey: ["org", orgSlug, "invitations"] })
},
```

**Why it matters:** Removing a member does not affect pending invitations, so this is not strictly wrong. However when an invitation is accepted (separate flow in `InviteAcceptPage`), it creates a new member. The accept flow calls `refreshMe()` but does NOT invalidate the members or invitations queries — so if the page is open during acceptance (e.g. admin on `MemberDirectoryPage` and invitee accepts in another tab), the panel remains stale. The missing invalidation in `InviteAcceptPage` is the more critical gap (see F-11). Confidence: medium.

---

### F-10 · MEDIUM — `ModuleMatrixPage`: saving a row while another row is _already_ pending is silently allowed — concurrent saves to different rows can race and the `saveRow.variables` check only tracks the most recent mutation

**File:** `frontend/src/features/permissions/ModuleMatrixPage.tsx:87-121`

```tsx
const saveRow = useMutation({ ... });
// In the table row:
disabled={
  saveRow.isPending &&
  saveRow.variables?.userId === row.user_id
}
```

**Why it matters:** `useMutation` in TanStack Query is single-instance. If user A and user B's rows both have pending edits and the admin clicks "Save row" for both in quick succession, the second mutation fires immediately (the first is still in-flight). `saveRow.variables` is overwritten to the second row's userId, so the first row's Save button is _re-enabled_ while it's still in-flight. This is not data-loss (both PUTs go to the server), but the UI incorrectly shows the first row as idle when it's actually being processed.  
**Recommendation:** Use a `Set<string>` of in-flight userIds in local state, or use separate `useMutation` instances per row (via a sub-component that owns its own mutation). Alternatively, use TanStack Query's mutation queue pattern.

---

### F-11 · MEDIUM — `InviteAcceptPage`: on successful accept, only `refreshMe()` is called; the members and invitations queries on `MemberDirectoryPage` are never invalidated, causing stale directory state

**File:** `frontend/src/features/orgs/InviteAcceptPage.tsx:44-50`

```tsx
const res = await orgsApi.acceptInvitation(token);
setOrgSlug(res.org_slug);
await refreshMe();    // updates auth store
setState("ok");
// ← no qc.invalidateQueries for members / invitations
```

**Why it matters:** If an admin has the `MemberDirectoryPage` open when an invite is accepted (e.g. in another tab, or after navigating back), the members list will not include the new member until a manual refresh or cache expiry (30 s staleTime). Similarly the pending invitations panel will still show the accepted invite as "pending". This is a known cache coherency gap; the `refreshMe()` call is correct for updating the auth store but the data queries are independent.  
**Recommendation:** After `refreshMe()`, also call `qc.invalidateQueries({ queryKey: ["org", res.org_slug, "members"] })` and `qc.invalidateQueries({ queryKey: ["org", res.org_slug, "invitations"] })`. These calls are safe even if the page rendering those queries is not mounted.

---

### F-12 · MEDIUM — `LoginPage`: `useEffect` resets both forms on mount with `eslint-disable-next-line react-hooks/exhaustive-deps` to suppress the deps warning; in React 18 Strict Mode this runs twice, causing a double-reset flicker

**File:** `frontend/src/features/auth/LoginPage.tsx:62-67`

```tsx
useEffect(() => {
  credForm.reset({ email: "", password: "" });
  totpForm.reset({ totp: "" });
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```

**Why it matters:** In StrictMode (which is used in `main.tsx`), effects run twice on mount. The double-reset is idempotent for `""` fields so there is no visible data loss, but the comment explaining the intent (`DEFECT-I`) notes this is to clear stale state from a previous user. The suppression hides the real issue: `credForm` and `totpForm` should be in the dep array (react-hook-form guarantees stable refs from `useForm`, so adding them causes no re-runs). The suppression is benign in practice.  
**Recommendation:** Remove the `eslint-disable` comment and add `credForm` and `totpForm` to the dependency array to be compliant. react-hook-form's `useForm` returns stable refs so there will be no behavioural change.

---

### F-13 · LOW — `TwoFactorChallengePage`: accessible as a standalone route (`/2fa/challenge`) without guard — if a user navigates there directly without a pending 2FA session, `completeTotp` throws `"no_pending_credentials"` but the page only shows the generic `error` from the store (which may be null if `completeTotp` was not called)

**File:** `frontend/src/features/auth/TwoFactorChallengePage.tsx:17-69`

```tsx
export function TwoFactorChallengePage(): React.ReactElement {
  const completeTotp = useAuthStore((s) => s.completeTotp);
  // ← no check for requires2FA flag; page renders submit form even with no pending session
```

**Why it matters:** The page renders the TOTP input form regardless of whether `pendingCredentials` is set in the authStore's module-scope variable. If a user navigates to `/2fa/challenge` directly (e.g. via browser back-button after completing 2FA), they see a functioning form. On submit, `completeTotp` throws `"no_pending_credentials"` and sets `error: "Session expired. Sign in again."` — so the error IS eventually shown. However the error only appears _after_ submitting, not on mount. The user sees a functional-looking form with no prompt to go back to login.  
**Recommendation:** On mount (or render), check `useAuthStore((s) => s.requires2FA)` and if false, redirect to `/login`. The `LoginPage` owns the 2FA challenge inline; this page is only reached via `ProtectedRoute`'s direct redirect (`requires2FA && !user → /2fa/challenge`). Add a guard.

---

### F-14 · LOW — `OrgDashboardPage`: `useEffect` for auto-opening feedback modal lists `searchParams` and `setSearchParams` as deps, but `searchParams` is an object that changes reference every render in React Router v6, causing the effect to re-run on every navigation (though `searchParams.get("feedback")` guard prevents repeated opens)

**File:** `frontend/src/features/layout/OrgDashboardPage.tsx:41-48`

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

**Why it matters:** In React Router v6, `useSearchParams()` returns a new `URLSearchParams` instance on every render, so the effect re-runs on every render. The guard `searchParams.get("feedback") === "1"` prevents repeated modal opens after `?feedback=1` is removed. However the effect unnecessarily re-runs on every route render, which can mask bugs in future effects that are added to the same component. The pattern is a known gotcha with React Router v6 `useSearchParams`.  
**Recommendation:** Extract a stable key from searchParams: use `const feedbackParam = searchParams.get("feedback")` outside the effect and list that string as the dependency, not the whole `searchParams` object.

---

### F-15 · LOW — `OwnershipTransferModal`: `conflict_acknowledged` is sent as `undefined` when `conflictDetected` is false, but the backend may reject an explicit `undefined` JSON field differently than omitting it

**File:** `frontend/src/features/orgs/OwnershipTransferModal.tsx:57-62`

```tsx
mutationFn: () =>
  orgsApi.transferOwnership(orgSlug, {
    new_owner_user_id: toUserId,
    reason,
    event_id: newEventId(),
    conflict_acknowledged: conflictDetected ? conflictAck : undefined,
  }),
```

**Why it matters:** When `conflictDetected` is false, `conflict_acknowledged: undefined` is passed to `JSON.stringify` which will omit the key (undefined values are dropped during serialisation). This is the intended behaviour. However the TypeScript type of the API payload includes `conflict_acknowledged?: boolean` which allows `undefined` — so TypeScript does not catch a case where `conflictDetected` is true but `conflictAck` is still false (the `blocked` guard handles this at the UI level). The logic is correct but relies on the client-side `blocked` check for safety rather than server-side enforcement.  
**Recommendation:** This is intentional and correct; add a brief comment confirming `undefined` → omitted field behaviour.

---

### F-16 · LOW — `OrgSettingsPage`: after a successful PATCH, `qc.setQueryData` is called directly (optimistic-style update) but `invalidateQueries` is NOT called — if the server applies transforms (e.g. slug normalisation, TZ canonical name), the local cache will be stale

**File:** `frontend/src/features/orgs/OrgSettingsPage.tsx:189-194`

```tsx
onSuccess: (next) => {
  toast.push({ kind: "success", title: t("Organization settings saved") });
  qc.setQueryData(["org", orgSlug, "detail"], next);
  // ← no qc.invalidateQueries — relies on PATCH response being canonical
},
```

**Why it matters:** `setQueryData` sets the cache to the PATCH response body, which _should_ be the canonical server state. If the backend applies any transformation to the PATCH response (e.g. normalises the time_zone to a canonical IANA string), the cache will reflect that. This is correct IF the PATCH response is complete. If the backend returns a 200 with only the changed fields (partial response), the cache object could be missing fields. The current `OrganizationUpdateSerializer` presumably returns the full `OrganizationSerializer` shape, so this is likely fine — but relying on the PATCH response being a full representation is a brittle assumption.  
**Recommendation:** Add `qc.invalidateQueries({ queryKey: ["org", orgSlug, "detail"] })` after `setQueryData` to ensure fresh data is fetched on next focus / navigation. This is a minor safety net.

---

### F-17 · INFO — `GrantCell` uses `role="switch"` with `aria-checked` cycling through three states, but ARIA spec defines `aria-checked` as boolean (true/false) for `role="switch"` — the "default" state is neither true nor false

**File:** `frontend/src/features/permissions/GrantCell.tsx:85`

```tsx
<button
  type="button"
  role="switch"
  aria-checked={state === "grant"}      // false for both "deny" and "default"
  ...
```

**Why it matters:** `role="switch"` maps `aria-checked=true` to "on" and `aria-checked=false` to "off". The three-state cell uses `aria-checked=false` for both "deny" and "default (not granted)" states, making them indistinguishable to screen readers. The comment mentions "WCAG 2.1 AA" compliance. The fix is to use `role="button"` instead (which is what it semantically is — a cycling button), or use `aria-pressed` with `aria-label` carrying the state text (which the code already does via the `ariaLabel` composition).  
**Recommendation:** Change `role="switch"` to `role="button"` (since it is a cycle button, not a binary toggle) and remove `aria-checked`. The existing `aria-label` already communicates the current state accessibly.

---

## Gaps (Forward-Looking)

| # | Item | Missing | Blocking for Phase 1B? | Effort |
|---|------|---------|------------------------|--------|
| G-01 | No query invalidation wiring for Phase 1B entities (tournaments, matches, players) | TanStack query key taxonomy and invalidation strategy | Yes | M |
| G-02 | No WebSocket / SSE connection lifecycle management | Reconnect logic, exponential back-off, stale indicator | Yes (live scoring) | L |
| G-03 | `queryClient` uses `InMemoryChannelLayer` equivalents on the frontend — no cache persistence across reloads | `persistQueryClient` + storage adapter or SSE-based cache warm-up | No | M |
| G-04 | Audit log pagination has no URL-sync — cursor is local state, so reloading loses page position | `useSearchParams` for cursor + page | No | S |
| G-05 | No optimistic updates on any mutation (add member, save settings, save permissions row) — all use server-confirmed updates | Optimistic update + rollback pattern (TanStack `onMutate` / `onError` rollback) | No | M |
| G-06 | No global error boundary / toast bridge for unhandled promise rejections outside TanStack Query (`window.onunhandledrejection`) | `window.addEventListener("unhandledrejection", ...)` handler | No | S |
| G-07 | `ModuleMatrixPage` concurrent saves (see F-10) — no per-row mutation isolation | Sub-component with own `useMutation`, or mutation queue | No (Phase 1A), Yes for admin UX | M |
| G-08 | No CSRF token refresh logic — if the Django session expires mid-SPA session, the CSRF cookie may rotate and all unsafe mutations will 403 without a clear error | Re-fetch CSRF token on 403, or piggyback on bootstrap | Yes | S |
| G-09 | `PasswordReauthModal` does not retry the originating failed operation (see F-07) | Retry callback store or `queryClient.refetchQueries` after reauth | No | M |
| G-10 | No loading indicator on the `ProtectedRoute` while `bootstrap()` races with the first render — currently shows a plain text "Loading..." without a spinner or skeleton | Proper skeleton / spinner component | No | S |
