# Audit: fe-orgs — Correctness

**Scope:** `frontend/src/features/orgs/` (all files)
**Lens:** hook deps/stale closures, wrong TanStack query keys/missing invalidation, races, broken route guards/redirects, form validation gaps, bad optimistic updates, unhandled rejections.
**Date:** 2026-06-04

---

## Findings

### F-01 · HIGH · OrgAuditLogPage — cursor pagination breaks query isolation (query key includes mutable cursor)

**File:** `OrgAuditLogPage.tsx:74`
**Evidence:**
```ts
queryKey: ["audit", slug, cursor],
queryFn: () => auditApi.list(slug, cursor ? { cursor, limit: 50 } : { limit: 50 }),
```
Including `cursor` directly in the key means every page-turn mounts a **new** cache entry; going back to `null` re-fires the first-page fetch even if it is already cached. This also means "Refresh" button (`query.refetch()`) only refreshes the **current** cursor window, not the data the user first saw. The bigger hazard: if the user clicks "Previous" while a "Next" fetch is still in-flight, two queries race for the same display slot because they share the same state variable but have different keys. Worse, `query.isFetching` shows `true` for the in-flight one but the *rendered* rows come from whichever key `cursor` currently resolves to — a timing-dependent display corruption.

**Recommendation:** Keep the query key as `["audit", slug]` and pass cursor as a query function argument only; or use a stable key `["audit", slug, "page"]` with `placeholderData: keepPreviousData` (TanStack v5) to avoid flash-of-empty while navigating.

---

### F-02 · HIGH · OrgSettingsPage — `useEffect` dependency is `orgQuery.data?.id` but `form.reset` is omitted from deps

**File:** `OrgSettingsPage.tsx:168–176`
**Evidence:**
```ts
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
`form.reset` is a stable ref from `react-hook-form` so the omission is harmless in this case — **but** the eslint-disable comment masks the real issue: `orgQuery.data` (the whole object) is not in the deps. If the org name or timezone changes on the server and TanStack Query delivers a fresh payload with the **same** `id` (which is the UUID — it never changes), the form will **never** re-hydrate to the new values. This is a stale-closure bug; the dep should be `orgQuery.data` or at minimum include both `orgQuery.data?.name` and `orgQuery.data?.time_zone`.

**Recommendation:** Change dep array to `[orgQuery.data]` and remove the eslint-disable comment.

---

### F-03 · HIGH · InviteCreateModal — `form.reset` omitted from `useEffect` deps (suppressed by eslint-disable)

**File:** `InviteCreateModal.tsx:88–95`
**Evidence:**
```ts
React.useEffect(() => {
  if (open) {
    setError(null);
    setSent(null);
    form.reset({ email: "", roles: ["admin"], message: "" });
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [open]);
```
Same pattern as F-02: `form.reset` is stable, but the explicit suppression of the exhaustive-deps rule hides the fact that if `open` closes and re-opens rapidly (double-click), the closure captures the `form` ref from mount. In React 18 strict-mode (double-invoke effects) this fires twice, running `form.reset` twice in the same render cycle — harmless but wasteful. More importantly: if `form` itself were ever unstable (e.g. a `useForm` placed inside a conditional), this would silently break. The pattern is a readability/maintenance trap.

**Recommendation:** Add `form` to the dep array (it is stable from react-hook-form), or explicitly comment why it is intentionally omitted, instead of blanketing the entire rule.

---

### F-04 · MEDIUM · OrgSwitcher — no auth-store invalidation after org switch

**File:** `OrgSwitcher.tsx:38–42`
**Evidence:**
```ts
const onPickOrg = (m: OrgMembership): void => {
  if (m.org_slug === current.org_slug) return;
  navigate(routes.orgDashboard(m.org_slug));
  persistLastActive.mutate(m.org_id);
};
```
After navigating to the new org dashboard, all org-scoped TanStack Query caches (members, invitations, audit, detail) remain stale because there is no `queryClient.invalidateQueries()` call. If the new org's dashboard page fetches the same query keys (e.g. `["org", orgSlug, "members"]`) the old results flash briefly before the new request resolves. The `persistLastActive` mutation also has no `onError` handler — a silent failure means the server-side last-active preference is silently unset with no feedback.

**Recommendation:** After successful navigation, call `qc.invalidateQueries({ queryKey: ["org"] })` to flush all org-scoped caches. Add an `onError` toast to `persistLastActive`.

---

### F-05 · MEDIUM · OrgAuditLogPage — `query.error.payload.detail` accessed without null guard

**File:** `OrgAuditLogPage.tsx:134`
**Evidence:**
```tsx
{query.error.payload.detail ?? t("Try refreshing the page.")}
```
`query.error` is typed as `ApiError` (via the generic parameter), but at runtime any `Error` subclass could reach this branch. If the backend returns a network-level failure (CORS/timeout before the response body is parsed), `ApiError` construction may not populate `payload`. Accessing `.payload.detail` without a guard throws a secondary TypeError in the error state, hiding the original error from the user.

**Recommendation:** Guard with `e instanceof ApiError ? e.payload?.detail : undefined` or widen to `(query.error as ApiError)?.payload?.detail`.

---

### F-06 · MEDIUM · MemberDirectoryPage — `removeMember` mutation captures `orgUuid` from closure; stale if membership loads late

**File:** `MemberDirectoryPage.tsx:285–300`
**Evidence:**
```ts
const orgUuid = membership?.org_id ?? "";
const removeMember = useMutation({
  mutationFn: (m: OrgMember) => {
    if (!orgUuid) {
      return Promise.reject(new Error("missing_org_uuid"));
    }
    return orgsApi.removeMember(orgUuid, m.id);
  },
```
`orgUuid` is captured at mutation definition time. If `user` from the auth store arrives asynchronously (e.g. bootstrapping from a refresh), `orgUuid` can be `""` when the mutation is created, and the closure never updates because `useMutation`'s `mutationFn` is not re-created on render (mutations are stable). In practice, the form is only shown after `canViewDirectory` is true, which requires `membership` to be non-null — so the window is narrow. But it is still technically a stale-closure; the `orgUuid` should be read inside `mutationFn` via a ref or passed as a variable argument.

**Recommendation:** Pass `orgUuid` as part of the mutation argument: `removeMember.mutate({ member: m, orgUuid })` or use a `useRef` that tracks the latest `orgUuid`.

---

### F-07 · MEDIUM · InvitationsListPanel — revoke button mis-checks `revoke.variables`; type is `string` but compared with `===` against `inv.id` which is also `string` — actually fine, but the panel shows loading state for ALL rows simultaneously

**File:** `InvitationsListPanel.tsx:89`
**Evidence:**
```tsx
isRevoking={revoke.isPending && revoke.variables === inv.id}
```
This per-row check is correct in isolation, but because `useMutation` is **shared** (single `revoke` mutation instance at the panel level), clicking "Revoke" on row A while another revoke for row B is in-flight would reset `revoke.variables` to row A's id, making row B's button appear non-loading even though the B request is still pending. TanStack Query v5 mutations are not concurrent — the second call replaces the pending state. This is a UX confusion bug: the B row's spinner disappears while its network request is still in-flight.

**Recommendation:** Either give each `InvitationRow` its own `useMutation` instance, or use separate `isPending` tracking per id (e.g. a `Set<string>` in local state).

---

### F-08 · MEDIUM · OwnershipTransferModal — local `toUserId` state not reset when `open` changes

**File:** `OwnershipTransferModal.tsx:50–53`
**Evidence:**
```ts
const [toUserId, setToUserId] = useState(targetUserId ?? "");
const [reason, setReason] = useState("");
const [conflictAck, setConflictAck] = useState(false);
const [error, setError] = useState<string | null>(null);
```
There is no `useEffect` that resets these on `open` changing back to `true`. If the modal is closed (after an error) and re-opened, `reason`, `error`, and `conflictAck` retain their previous values. `toUserId` retains the pre-filled `targetUserId` which is acceptable, but `error` and `reason` leaking across sessions is a correctness issue.

**Recommendation:** Add:
```ts
React.useEffect(() => {
  if (open) {
    setReason("");
    setConflictAck(false);
    setError(null);
  }
}, [open]);
```

---

### F-09 · MEDIUM · InviteAcceptPage — redirect to org dashboard happens only via button click, not automatically after `refreshMe`

**File:** `InviteAcceptPage.tsx:41–58`
**Evidence:**
```ts
const onAccept = async (): Promise<void> => {
  ...
  setState("ok");
};
```
After `setState("ok")`, the user sees a "Go to organization" button. There is no automatic redirect, which is fine UX-wise — but the `orgSlug` state is only set from `res.org_slug`. If `acceptInvitation` returns a shape where `org_slug` is missing or empty, `orgSlug` remains `null`, the "Go to organization" button is hidden (guarded by `state === "ok" && orgSlug`), and the user sees an empty success state with no next step. There is no fallback (e.g. redirect to `/orgs` chooser).

**Recommendation:** After `setState("ok")`, if `orgSlug` is falsy, navigate to `routes.orgChooser()` as a fallback instead of leaving the user stranded.

---

### F-10 · LOW · InviteAcceptPage — CSS class `text-grant` typo; likely meant `text-green-600`

**File:** `InviteAcceptPage.tsx:83`
**Evidence:**
```tsx
<p role="status" className="text-grant">
  {t("You're now a member.")}
</p>
```
`text-grant` is not a standard Tailwind class. The success paragraph will receive no color styling, rendering in default text color. Likely a typo for `text-green-600` or `text-emerald-600`.

**Recommendation:** Replace `text-grant` with `text-green-600` (or project's success token).

---

### F-11 · LOW · OrgAuditLogPage — back-navigation resets to page cursor=null but "Previous" button goes to `prevCursor`, not page 0

**File:** `OrgAuditLogPage.tsx:183–203`
**Evidence:**
```tsx
<Button ... onClick={() => setCursor(prevCursor ?? null)}>
  {t("Previous")}
</Button>
```
The "Previous" button passes `prevCursor` from the current page's response. If the user is on page 3 and clicks Previous, they jump to page 2. But if they are on page 2 and the server returns `previous_cursor: null`, clicking Previous does nothing (button is disabled). However, if the user navigates away and back (URL doesn't encode cursor), they land on page 1 — there is no cursor in URL state. This is expected for a v1 design, but worth noting as a gap.

**Recommendation:** (Low urgency) Encode `cursor` in the URL search params to support browser back-button navigation.

---

### F-12 · LOW · OrgSettingsPage / OrgBrandingPage — `OrgDetail` interface duplicated; can drift from each other

**Files:** `OrgSettingsPage.tsx:41–51`, `OrgBrandingPage.tsx:37–47`
**Evidence:** Both files define an identical local `interface OrgDetail { id, slug, name, status, time_zone?, created_at, archived_at, suspended_at, suspended_reason }`. If the backend adds or renames a field, both copies must be updated independently.

**Recommendation:** Extract `OrgDetail` into `@/api/orgs.ts` (or `@/types/org.ts`) and import it in both pages.

---

### F-13 · INFO · OrgSwitcher — `setSlugFromUrl` is never called inside the orgs feature; must be called externally by AppShell

**File:** `OrgSwitcherStore.ts:21`
**Evidence:**
```ts
setSlugFromUrl: (slug) => set({ currentSlug: slug }),
```
The comment in the store says "`setSlugFromUrl` is called from a router-aware effect inside `<AppShell>`." If `AppShell` misses any route case (e.g. `/accept?token=...` lands before the slug is set), `currentSlug` stays `null` and `OrgSwitcher` falls back to `memberships[0]` — a silent mismatch between displayed and navigated org. This is an integration correctness concern that cannot be fully audited within this feature folder alone.

**Recommendation:** Verify `AppShell` calls `setSlugFromUrl` on every route that nests an org context, including the audit log and branding pages.

---

## Gaps (forward-looking, not current bugs)

| # | Area | Current state | Missing | Effort | Blocking? |
|---|------|--------------|---------|--------|-----------|
| G-01 | OrgAuditLogPage | Cursor-based pagination is UI-only; URL not updated | Cursor should survive navigation (browser back/reload) | S | No |
| G-02 | MemberDirectoryPage | `window.confirm()` for remove confirmation | Should use a proper Dialog/AlertDialog (a11y gap, WCAG 2.1 AA requires visible focus management) | S | No |
| G-03 | OrgAuditLogPage | No filter controls (actor, event_type, date range) despite `auditApi.list()` supporting them | Wire filter params when Phase 1B audit surfaces land | M | No |
| G-04 | InvitationsListPanel | Panel re-renders (and shows no items) during revoke before `invalidateQueries` completes — no optimistic removal | Add optimistic update to remove revoked invite from list immediately | S | No |
| G-05 | OwnershipTransferModal | User ID field is a free-text input; no autocomplete from member directory | Needs member picker autocomplete (Phase 1B) | M | No |
| G-06 | OrgSwitcher | `persistLastActive` failure is silent (no `onError`) | Add error toast so the user knows server preference was not persisted | XS | No |
| G-07 | All pages | `membership?.effective_modules` checked client-side; server can return a more restrictive set post-permission-change without triggering re-bootstrap | Module grants should trigger a `/me` refresh on next navigation or on a focused-tab signal | M | No |
