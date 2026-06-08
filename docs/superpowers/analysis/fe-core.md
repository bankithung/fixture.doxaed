# Frontend · Core (routing / shell / state / api) — Deep Analysis

> Scope: the frontend "chassis" that every feature page mounts on top of:
> app composition + provider tree, the React Router route table + guards,
> the authenticated `AppShell` chrome + navigation computation, the Zustand
> auth store + bootstrap, the global 401/re-auth event bus, the `apiFetch`
> HTTP layer (session cookie + CSRF), the TanStack Query client, and the
> small `lib/` route/csrf/breakpoint/i18n/tailwind helpers.

## 1. Purpose

This subsystem is the spine of the SPA. It owns: (a) how the app is composed
(provider order in `App.tsx`), (b) which URLs exist and who may see them
(`Routes` + `ProtectedRoute`), (c) the persistent chrome around every
authenticated page (`AppShell` → `Sidebar` + topbar), (d) how server state is
fetched and how authentication failures fan out globally, and (e) the auth
identity lifecycle (bootstrap → login/2FA → logout/clear). Everything else in
the app is a leaf feature that plugs into these seams.

## 2. File-by-file roles

- **`main.tsx`** — entry point. Imports `index.css`, kicks off
  `useAuthStore.getState().bootstrap()` *before* `createRoot(...).render(<App/>)`
  so the `/me/` hydrate is in flight when `ProtectedRoute` first evaluates.
  Renders inside `<StrictMode>` (so effects/bootstrap can run twice in dev).
- **`App.tsx`** — top-level composition + the entire route table. Defines the
  provider nesting and the inline `AuthBusBridge` component.
- **`features/layout/ProtectedRoute.tsx`** — auth gate wrapping the
  `AppShell` layout route. Blocks until `bootstrapped`, then applies redirect
  rules.
- **`features/layout/AppShell.tsx`** — the authenticated shell: fixed
  `Sidebar` + sticky frosted topbar + mobile drawer + user menu + breadcrumb,
  with `<Outlet/>` for the routed page. Computes which nav (workspace vs
  tournament) to render and fetches tournament name + invite count.
- **`features/layout/Sidebar.tsx`** — pure desktop nav rail. Renders
  `NavGroup[]`, supports collapsed (icons-only) mode and a tournament-context
  header. No store/router reads beyond `NavLink`'s `isActive`.
- **`features/layout/computeNavItems.ts`** — *pure* nav builders
  `computeWorkspaceNav` and `computeTournamentNav` + the `NavItem`/`NavGroup`
  types and module-gating `resolveContext` helper.
- **`features/layout/OrgChooserPage.tsx`** — `/orgs` membership picker + the
  org-less empty state. **Note: violates the design system** (uses
  `mx-auto max-w-2xl` and hardcoded `emerald-700/800` instead of tokens).
- **`features/layout/OrgDashboardPage.tsx`** — `/o/:orgSlug/dashboard`. KPI
  strip + tournaments table (client filter/sort) + featured/live match rail +
  feedback dialog. Drives the whole page from one `tournamentsApi.list()` call
  plus one lazy `matches()` call.
- **`features/auth/authStore.ts`** — Zustand store: `user`, `isLoading`,
  `requires2FA`, `error`, `bootstrapped` + actions `bootstrap/login/
  completeTotp/logout/clear/refreshMe`.
- **`api/client.ts`** — `apiFetch<T>()` + the `api.{get,post,put,patch,delete}`
  convenience object. CSRF + credentials + JSON (de)serialisation + `ApiError`.
- **`api/queryClient.ts`** — the singleton `QueryClient` with global defaults +
  the `AuthEvent` bus (`onAuthEvent`, `authBus.emit`) wired through the
  `QueryCache.onError` callback.
- **`api/auth.ts`** — typed wrappers for every `/api/accounts/auth/*` + `/me/`
  endpoint and their request/response interfaces.
- **`lib/routes.ts`** — the typed URL builder object (`routes.*`), the single
  source of truth for URL construction.
- **`lib/csrf.ts`** — reads the `csrftoken` cookie.
- **`lib/useBreakpoint.ts`** — `useSyncExternalStore`-backed viewport detector.
- **`lib/t.ts`** — i18n passthrough (`t = (s) => s`).
- **`lib/tailwind.ts`** — `cn()` (clsx + tailwind-merge).
- **`lib/eventId.ts`** — `newEventId()` UUID for idempotent writes (not in the
  named list but part of the core write contract; invariant 3).

## 3. Data model (client-side)

- **`User`** (`types/user.ts`, mirror of backend `MeSerializer`): `id`, `email`,
  `name`, `is_superuser`, `has_2fa_enrolled`, `twofa_enrolled_at`,
  `email_verified_at`, `last_active_org_id`, `last_active_org_slug`,
  `memberships: OrgMembership[]`, `deleted_at`.
- **`OrgMembership`**: `org_id`, `org_slug`, `org_name`, `roles: Role[]`,
  `is_org_owner`, `effective_modules: string[]`, optional client-only
  `active_role`. Backend aggregates multiple membership rows per org into one
  entry (`roles` deduped, `is_org_owner` OR'd).
- **`AuthState`** (Zustand): `{ user, isLoading, requires2FA, error,
  bootstrapped }` + actions. `pendingCredentials` (`{email,password}`) lives in
  **module scope, not store state**, deliberately so it never leaks to devtools
  or persisted state.
- **`AuthEvent`** (`queryClient.ts`): discriminated union
  `{type:"unauthenticated"} | {type:"password_reauth_required"}`.
- **`ApiError`** (`types/api.ts`): `status`, `payload: ApiErrorPayload` +
  derived getters `isUnauthenticated` / `isPasswordReauthRequired`.
- **`NavItem`/`NavGroup`** (`computeNavItems.ts`): `{key,label,href,icon,badge?}`
  grouped under `{key,label,items}`.
- **`OrgSwitcherState`** (`features/orgs/OrgSwitcherStore.ts`, coupled):
  denormalised `currentSlug`/`activeRole` mirror of the URL slug.

## 4. Core algorithms / services (file:function, step-by-step)

### 4.1 App composition — `App.tsx:App`
Provider order is load-bearing (documented in the file's docstring):
`ThemeProvider → QueryClientProvider(queryClient) → ToastProvider →
ErrorBoundary → BrowserRouter → {AuthBusBridge, PasswordReauthModal, Routes}`.
The `ErrorBoundary` sits inside Toast but *outside* the router so render-phase
throws in any route fall to the friendly error page; router-level handlers
(`useRouteError`) bypass it by design.

### 4.2 Global 401 bus bridge — `App.tsx:AuthBusBridge`
A pathless `null`-rendering component inside the router. On mount it subscribes
via `onAuthEvent`; on an `"unauthenticated"` event it calls `authStore.clear()`
then `navigate(routes.login())`. It only handles the unauthenticated event —
`password_reauth_required` is handled separately by `PasswordReauthModal`.

### 4.3 Auth bootstrap — `authStore.ts:bootstrap`
1. set `{isLoading:true, error:null}`.
2. `await authApi.me()` → on success `{user, isLoading:false, bootstrapped:true}`.
3. On `ApiError` 401 → `{user:null, bootstrapped:true}` (the expected
   logged-out path, **not** an error).
4. On any other error → `{user:null, bootstrapped:true, error}`.
The crucial invariant: `bootstrapped` becomes `true` on *every* terminal path,
so `ProtectedRoute` never hangs.

### 4.4 Login + 2FA — `authStore.ts:login` / `completeTotp`
`login`: calls `authApi.login(payload)`. If `requires_2fa`, stash
`pendingCredentials` (module scope), clear `user`, set `requires2FA:true`,
return `{requires_2fa:true}`. Otherwise set `user` (from `res.user` or a
fallback `authApi.me()`), clear `pendingCredentials`, return
`{requires_2fa:false}`. Errors set `error` from `ApiError.payload.detail` and
rethrow. `completeTotp(totp)`: requires `pendingCredentials` (else
"Session expired" error), re-calls `authApi.login({email,password,totp_code})`
— **there is no separate `/challenge` endpoint; 2FA is folded into `/login/`**.
`logout` always clears local state even if the server call throws. `clear` is
the synchronous force-clear used by the 401 bus.

### 4.5 ProtectedRoute guard — `ProtectedRoute.tsx:ProtectedRoute`
Reads `user`, `bootstrapped`, `requires2FA` from the store. Redirect ladder:
1. `!bootstrapped` → render a `role="status"` loading placeholder (blocks).
2. `requires2FA && !user` → `<Navigate to=/2fa/challenge replace/>`.
3. `!user` → `<Navigate to=/login?next=<encoded pathname+search> replace/>`.
4. `user` with **zero memberships AND not `is_superuser`** AND current path not
   in `ORG_OPTIONAL_PATHS` → `<Navigate to=/orgs replace/>`. The allowlist
   (`/orgs`, `/tournaments`, `/tournaments/new`, `/invites`, `/me`) exists
   specifically to break the new-user redirect loop (chooser → "Start a
   tournament" → `/tournaments/new` would otherwise bounce back to `/orgs`).
5. Otherwise render `children` (the `AppShell`).

### 4.6 apiFetch — `client.ts:apiFetch`
1. Destructure `{body, skipCsrf, headers, ...rest}`; resolve method (default GET).
2. Build `Headers`; default `Accept: application/json`.
3. Body serialisation: `null`/`undefined` pass through; `string`/`FormData`/
   `Blob`/`ArrayBuffer`/`URLSearchParams` pass through unchanged; any other
   object → `JSON.stringify` + set `Content-Type: application/json` if unset.
4. **CSRF:** if `!skipCsrf` and method ∈ `{POST,PUT,PATCH,DELETE}`, read
   `getCsrfToken()` from the `csrftoken` cookie and set `X-CSRFToken` (omitted
   when no cookie present).
5. `fetch(path, {...rest, method, headers, body, credentials:"include"})` —
   the session cookie always rides along.
6. `204` → `undefined`. Non-2xx → `throw await parseApiError(res)` (parses JSON,
   falls back to `{detail: statusText}`). Non-JSON 2xx → `undefined`. JSON 2xx →
   parsed body.
The `api` object just curries method + body into `apiFetch`.

### 4.7 QueryClient + error bus — `queryClient.ts`
Defaults: queries `staleTime 30s`, `gcTime 5m`, `retry 1`,
`refetchOnWindowFocus:false`; mutations `retry 0`. The `QueryCache.onError`
inspects thrown `ApiError`s: `isUnauthenticated` → `emit({unauthenticated})`;
`isPasswordReauthRequired` → `emit({password_reauth_required})`. The bus
(`listeners: Set<Listener>`, `onAuthEvent`, `emit`) decouples queryClient from
authStore to avoid an import cycle. `authBus = {emit}` is exported for
mutations to fire manually — **currently unused** (no call sites; only
query-path errors reach the bus today).

### 4.8 AppShell orchestration — `AppShell.tsx:AppShell`
- Recovers context with `useMatch("/o/:orgSlug/*")` and
  `useMatch("/tournaments/:id/*")` because AppShell is a *pathless* layout route
  (params aren't in its own `useParams`). `"/tournaments/new"` is explicitly
  excluded from being a tournament context.
- `navSlug` fallback chain: URL `orgSlug` → `user.last_active_org_slug` →
  `user.memberships[0].org_slug` → `null` (DEFECT-F: keeps nav usable on
  `/me` and tournament routes that lack a slug).
- Mirrors `orgSlug` into `OrgSwitcherStore.setSlugFromUrl` via effect (B.20:
  URL is source of truth).
- `useQuery(["t-nav", tournamentId])` → `tournamentsApi.get` for the rail
  header name (enabled only in tournament context, 60s stale).
- `useQuery(["my-invitations"])` → `invitationsApi.myInvitations` for the
  Invites badge count (30s stale).
- Picks nav: `inTournamentContext ? computeTournamentNav(...) :
  decorateInvitesBadge(computeWorkspaceNav(...), pendingInviteCount)`.
- Local UI state: `menuOpen`, `drawerOpen`, `collapsed` (persisted to
  `localStorage["sidebar:collapsed"]`). Effects: close menu/drawer on route
  change; auto-close drawer when `useBreakpoint().isDesktop`; click-outside +
  Escape to dismiss the user menu. `handleSignOut` → `logout()` →
  `navigate(routes.login())`.

### 4.9 Nav builders — `computeNavItems.ts`
- `resolveContext(user, slug)` → finds the matching membership and returns a
  `hasModule(key)` closure over `effective_modules`.
- `computeWorkspaceNav(user, slug)`: returns `[]` when no user; otherwise a
  single `"workspace"` group: Dashboard (→ `orgDashboard(slug)` or `/orgs`),
  Tournaments (global), Invites. The former org-level Admin group is gone from
  primary nav (those surfaces remain URL-reachable).
- `computeTournamentNav(tournamentId, {user, slug})`: a single `"manage"`
  group: Overview, Registration forms (**only if** `hasModule("forms")`),
  Fixtures & bracket, Members, Audit. Members/Audit are always shown; the
  pages themselves enforce manager-only (403 → friendly state).
- `decorateInvitesBadge` (in `AppShell.tsx`) clones only the matched `invites`
  item to attach a count badge; returns groups unchanged when count ≤ 0.

### 4.10 useBreakpoint — `useBreakpoint.ts`
`useScreenWidth()` via `useSyncExternalStore(subscribe, currentWidth,
()=>SSR_WIDTH=1280)` with one shared resize/orientationchange listener.
`useBreakpoint()` derives `breakpoint`, `isMobile (<768)`, `isTablet
(768–1023)`, `isDesktop (>=1024)`, `up(bp)`. Breakpoints mirror Tailwind so JS
and CSS agree.

## 5. API / endpoint surface (touched by this subsystem)

- `GET /api/accounts/me/` — `authApi.me` (bootstrap + refreshMe + login fallback).
- `POST /api/accounts/auth/login/` — `authApi.login` (also the 2FA second leg).
- `POST /api/accounts/auth/logout/` — `authApi.logout`.
- `POST /api/accounts/auth/signup/`, `verify-email/`, `resend-verification/`,
  `password-reset-request/`, `password-reset-complete/` — `authApi.*`.
- `POST /api/accounts/auth/2fa/enroll/` + `2fa/confirm/` — `authApi.totpEnroll*`
  (confirm reads `code`, not `totp`).
- `POST /api/accounts/auth/reauth/` — `authApi.reauth` (PasswordReauthModal).
- `PATCH /api/accounts/me/` — `authApi.patchMe` (only `name`,
  `last_active_org_id` writeable).
- `GET /api/tournaments/` — `tournamentsApi.list`/`.get` (AppShell rail header,
  OrgDashboard). **`get(id)` has no retrieve endpoint — it lists then filters
  client-side.**
- `GET /api/tournaments/{id}/matches/` — featured-match rail.
- `invitationsApi.myInvitations` — Invites badge.

Exported client API surface: `apiFetch<T>`, `api.{get,post,put,patch,delete}`,
`queryClient`, `onAuthEvent`, `authBus`, `routes`, `useAuthStore`, `t`, `cn`,
`useBreakpoint`/`useScreenWidth`, `getCsrfToken`, `newEventId`,
`computeWorkspaceNav`/`computeTournamentNav`, `ProtectedRoute`, `AppShell`.

## 6. Invariants that MUST be preserved

1. **Session auth, no JWT** (invariant 15): all requests `credentials:"include"`;
   `X-CSRFToken` echoed on unsafe verbs from the `csrftoken` cookie. Same-origin
   (Vite proxies `/api` + `/sadmin` → `:8000` in dev).
2. **`bootstrapped` always reaches `true`** on every bootstrap terminal path —
   else `ProtectedRoute` hangs forever.
3. **Bootstrap runs before render** (`main.tsx`) so the gate can resolve.
4. **401 → clear + redirect to /login** via the bus; render must not crash on a
   null user. The `next` param round-trips the original location.
5. **`ORG_OPTIONAL_PATHS` allowlist** must stay in sync with the new-user flow
   or zero-membership users get trapped in a redirect loop.
6. **Provider order** in `App.tsx` (ErrorBoundary inside Toast, outside Router).
7. **URL slug is the source of truth** for active org (B.20); `OrgSwitcherStore`
   is a read-only mirror written only by AppShell's effect.
8. **`pendingCredentials` never enters store state** (security).
9. **Every URL is built via `routes.*`** with `encodeURIComponent` on dynamic
   segments — keeps the slug invariant honest and avoids injection.
10. **`/tournaments/new` is not a tournament context** (no `tournamentsApi.get`).
11. **Idempotent writes** carry an `event_id` (invariant 3) — produced by
    `newEventId()` / `crypto.randomUUID`.
12. **Forms nav item is module-gated** on `effective_modules` containing
    `"forms"` (must match `apps/permissions/fixtures/modules.json`).
13. **Every user-visible string wrapped in `t()`** (invariant 13).

## 7. Dependencies / coupling

**Outgoing (this subsystem → others):**
- `api/auth.ts` → backend `/api/accounts/*`. `api/tournaments.ts`,
  `api/invitations.ts` → backend tournaments/invitations.
- AppShell → `features/orgs/{OrgSwitcher,OrgSwitcherStore}`,
  `features/theme/{ThemeProvider,ThemeToggle}`, `features/notifications/
  NotificationBell`, `components/ui/{Avatar,button}`.
- App.tsx imports ~30 feature page components (the whole app's leaf surface).
- Everything → `lib/t`, most → `lib/routes`, `lib/tailwind`, `types/api`.

**Incoming (others → this subsystem), measured by importers:**
- `lib/t` — 72 files. `lib/routes` — 39. `lib/tailwind` (`cn`) — 37.
- `authStore` — 24. `api/client` — 17. `useBreakpoint` — 12.
- `onAuthEvent`/`authBus` — only `App.tsx` + `PasswordReauthModal.tsx`.

These import counts make `lib/t`, `lib/routes`, `lib/tailwind`, `authStore`,
and `api/client` the highest-blast-radius modules in the entire frontend.

## 8. Tech debt / smells / duplication

- **`OrgChooserPage.tsx` violates the design system**: `mx-auto max-w-2xl`
  centered column (forbidden by CLAUDE.md) and hardcoded `emerald-700/800` +
  `emerald-300/50` instead of tokens. The most concrete cleanup target here.
- **`tournamentsApi.get(id)` fetches the full list and filters client-side** —
  no retrieve endpoint. O(n) per nav header render; cached but wasteful and
  silently returns `null` for inaccessible/large datasets.
- **Module-code duplication**: `MODULE_FORMS = "forms"` in `computeNavItems.ts`
  is duplicated from `features/orgs/dashboardCards.ts` and must stay in sync
  with `apps/permissions/fixtures/modules.json` (no shared constant).
- **`authBus.emit` is dead today** — mutations don't fire it; only query-path
  errors reach the bus. A mutation hitting a 401/403-reauth will NOT trigger
  the global redirect/modal unless it's wrapped to emit.
- **`isUnauthenticated` is heuristic** for 403 — it string-matches
  `payload.detail` (`"authentication credentials"`, `"not authenticated"`),
  which is fragile against backend/i18n wording changes.
- **Nav-rendering duplication**: AppShell's `drawerNavLink` and Sidebar's
  `railNavLink` are near-identical NavLink renderers (badge, active styling)
  living in two files.
- **AppShell is large (~475 lines)** and mixes concerns: context recovery,
  two queries, three effects, user menu, breadcrumb, drawer markup, sign-out.
  Hard to test in isolation (its test stubs a full router + QueryClient).
- **`refreshMe` swallows errors** intentionally ("bus will fire on 401"), but
  also swallows non-401 failures silently.
- **Provider order is documented only in a comment**, not enforced by types.
- **No retry/backoff or offline handling** beyond TanStack's `retry:1`.

## 9. Restructuring seams & risks

**Clean seams (low risk to lean on):**
- **The auth event bus** (`onAuthEvent`/`authBus`) is the intended decoupling
  point between transport errors and UI reactions — extend it (new event
  types) rather than importing the store into the client.
- **`computeWorkspaceNav`/`computeTournamentNav` are pure** and well unit-tested
  — safe to re-shape nav (groups/permissions) by editing only these + tests.
- **`routes.ts`** centralises URLs — a route-table rewrite should update this
  one object; all 39 callers follow automatically.
- **`apiFetch`** is the single choke point for transport policy (CSRF,
  credentials, base URL, error shape) — add interceptors/base-path/retry here.
- **`authStore`** is the single identity owner — any auth-model change funnels
  through `bootstrap/login/completeTotp`.

**Risks during restructuring:**
- Touching the **`ProtectedRoute` redirect ladder** or `ORG_OPTIONAL_PATHS`
  risks new-user loops and lost-`next` regressions — keep the AppShell + redirect
  tests green.
- Splitting **AppShell** must preserve the `useMatch` context recovery and the
  `/tournaments/new` exclusion, or the rail will fire a spurious tournament
  fetch and switch to Manage mode on the create page.
- Changing **`bootstrap`'s terminal-state contract** (always set
  `bootstrapped`) would hang the gate.
- Moving CSRF/credentials off `apiFetch` (e.g. to per-call config) would break
  the session-auth invariant across 17 importers.
- If a future restructuring routes more failures through **mutations**, the
  currently-dead `authBus.emit` path must be wired in or 401s on writes will go
  unhandled.
- `tournamentsApi.get` should become a real retrieve endpoint before the
  dataset grows; today the AppShell header and OrgDashboard both lean on the
  full-list fetch.

## 10. Ambiguities / things to confirm

- Whether `authBus.emit` is intended to be called by future mutation wrappers
  (it's exported "for mutations to call directly") — currently no call sites.
- `OrgComingSoonPage.tsx` exists in `features/layout/` but `App.tsx` wires the
  `errors/ComingSoonPage` instead; the layout one appears unused/legacy.
- The `active_role` field on `OrgMembership` and `activeRole` in
  `OrgSwitcherStore` are client-only (B.20 multi-role view) but not yet read by
  any core file here — likely a partially-built feature seam.
