# fe-core Map — frontend/src (excluding features/*)

**Date:** 2026-06-04
**Scope:** `frontend/src` plumbing layer: `api/`, `lib/`, `types/`, `components/ui/`, `App.tsx`, `main.tsx`, `index.css`, `test/setup.ts`, `vite.config.ts`, `tailwind.config.js`, `package.json`.  
Features sub-trees (`features/*`) are enumerated at the import/route boundary only — not descended.

---

## 1. Layer Overview

| Area | Files | Purpose |
|---|---|---|
| Entry points | `main.tsx`, `App.tsx` | Bootstrap auth → render root provider tree → route table |
| API plumbing | `api/client.ts`, `api/queryClient.ts`, `api/auth.ts`, `api/orgs.ts`, `api/permissions.ts`, `api/audit.ts`, `api/feedback.ts` | Typed fetch wrapper, query/mutation cache, domain-scoped call objects |
| Lib utilities | `lib/csrf.ts`, `lib/t.ts`, `lib/routes.ts`, `lib/tailwind.ts` | CSRF cookie reader, i18n stub, typed URL helpers, `cn()` |
| Types | `types/api.ts`, `types/user.ts`, `types/generated.ts`, `types/api.generated.ts` | Error class, domain models, OpenAPI codegen re-exports |
| UI primitives | `components/ui/` (8 files) | shadcn-style headless primitives + domain-specific display components |
| CSS / design tokens | `index.css`, `tailwind.config.js` | CSS custom properties, Tailwind theme extension |
| Test harness | `test/setup.ts` | vitest + @testing-library global setup |
| Build config | `vite.config.ts`, `package.json` | Vite+vitest config, proxy rules, dependency manifest |

---

## 2. File-by-File Map

### 2.1 `main.tsx`
- Calls `useAuthStore.getState().bootstrap()` before render (preloads `/api/accounts/me/` before React tree mounts).
- Wraps `<App />` in `<StrictMode>`.
- No issues found. Bootstrap called with `void` — correct fire-and-forget.

### 2.2 `App.tsx`
- **Provider order** (outer → inner): `QueryClientProvider` → `ToastProvider` → `ErrorBoundary` → `BrowserRouter` → route table.
- `AuthBusBridge` (inner function component) subscribes to `onAuthEvent` and calls `clear() + navigate(routes.login())` on `"unauthenticated"` events.
- `PasswordReauthModal` is rendered at top-level inside the router so it can overlay any route.
- **Route table** (30 routes total):
  - Public: `/`, `/about`, `/login`, `/signup`, `/verify-email`, `/password-reset`, `/password-reset/complete`, `/2fa/enroll`, `/2fa/challenge`, `/accept`
  - Protected (under `<ProtectedRoute><AppShell /></ProtectedRoute>`): `/orgs`, `/me`, `/me/notifications`, `/o/:orgSlug/dashboard`, `/o/:orgSlug/members`, `/o/:orgSlug/permissions`, `/o/:orgSlug/scoring`, `/o/:orgSlug/referee`, `/o/:orgSlug/team`, `/o/:orgSlug/audit`, `/o/:orgSlug/settings`, `/o/:orgSlug/branding`, `/o/:orgSlug/tournaments-coming-soon`
  - Catch-all: `*` → `<NotFoundPage />`
- **No Phase 1B routes exist** — tournaments, matches, fixtures, live, disputes are all absent.
- **Observation:** `orgScoring`, `orgReferee`, `orgTeam` routes are Phase 1A stubs — each page currently renders a `<PreviewTile>` grid.
- `t()` is used at one call site for the `"Tournaments"` feature label.

### 2.3 `api/client.ts`
- Thin fetch wrapper: `credentials: "include"`, CSRF header on unsafe verbs, JSON body serialisation, `ApiError` throw on non-2xx, `204 → undefined`.
- Exports `apiFetch<T>` and `api.{get, post, put, patch, delete}` convenience wrappers.
- `skipCsrf` option supports login (Django login sets the cookie, so login itself need not include it).
- Handles non-JSON responses (logout returns empty body): checks `Content-Type` before `res.json()`.

### 2.4 `api/queryClient.ts`
- `staleTime: 30_000`, `gcTime: 300_000`, `retry: 1` for queries; `retry: 0` for mutations.
- `QueryCache.onError` fires `"unauthenticated"` or `"password_reauth_required"` events via an internal `Set<Listener>` bus.
- **Finding (high):** `QueryCache.onError` fires only for **queries**, not mutations. A `useMutation` call that gets a 401/403-with-credentials-error will call its per-mutation `onError` callback but NOT the global bus. `authBus` is exported but never imported anywhere else in the codebase. Mutations that receive a session-expired 401/403 do not redirect the user to `/login`.
- `refetchOnWindowFocus: false` — deliberate choice to avoid spurious re-fetches.

### 2.5 `api/auth.ts`
Endpoints:
- `GET /api/accounts/me/` → `User`
- `POST /api/accounts/auth/login/` → `{ requires_2fa?, user? }`
- `POST /api/accounts/auth/logout/`
- `POST /api/accounts/auth/signup/` → `{ user: User }`
- `POST /api/accounts/auth/verify-email/`
- `POST /api/accounts/auth/password-reset-request/`
- `POST /api/accounts/auth/password-reset-complete/`
- `POST /api/accounts/auth/2fa/enroll/` → `TwoFAEnrollResponse`
- `POST /api/accounts/auth/2fa/confirm/` → `{ recovery_codes: string[] }`
- `POST /api/accounts/auth/reauth/`
- `PATCH /api/accounts/me/`

Note: The TOTP confirm payload uses `{ code }`, not `{ totp }` — matches the backend `TwoFAConfirmSerializer`.

### 2.6 `api/orgs.ts`
Endpoints:
- `GET /api/orgs/` → `Organization[]`
- `GET /api/orgs/{slug}/members/` → `MembersResponse` (array or paginated)
- `GET /api/orgs/{slug}/invitations/` → `InvitationsResponse`
- `POST /api/orgs/{slug}/invitations/` (create)
- `DELETE /api/orgs/{slug}/invitations/{id}/` (revoke)
- `POST /api/orgs/invitations/accept/` → `{ org_slug, membership }`
- `DELETE /api/orgs/{orgUuid}/members/{membershipId}/`
- `POST /api/orgs/{slug}/ownership/transfer/`
- `unwrapList<T>()` helper normalises `T[] | Paginated<T>` → `T[]`.

**Finding (medium):** `removeMember` takes `orgUuid` (not slug), while all other `orgsApi` methods use slug. This is intentional per the comment ("Backend has only the UUID-routed delete"), but it is an asymmetry that future callers must know about. No runtime guard or type-level distinction.

### 2.7 `api/permissions.ts`
Endpoints:
- `GET /api/permissions/modules/` → `ModuleDef[]`
- `GET /api/permissions/orgs/{slug}/me/modules/` → `{ modules: string[] }`
- `GET /api/permissions/orgs/{slug}/grants/matrix/` → `ModuleMatrixResponse`
- `PUT /api/permissions/orgs/{slug}/users/{userId}/grants/`

### 2.8 `api/audit.ts`
Endpoint: `GET /api/audit/orgs/{slug}/` with cursor, actor\_id, event\_type, from, to, limit params.

**Finding (low):** The `AuditEventListResponse` type is derived from `components["schemas"]["AuditEventListResponse"]` in the generated file, but looking at the generated schema the audit route is `/api/audit/orgs/{slug}/` (slug in path, not UUID). The call in `audit.ts` also uses slug. Consistent.

### 2.9 `api/feedback.ts`
Endpoint: `POST /api/feedback/submit/` → `{ id?, ok? }`.
Comment in file: "backend endpoint is being created in parallel." This is a stub API call targeting an endpoint that may not yet exist.

**Finding (medium):** `feedbackApi.submit()` will throw `ApiError` if the backend endpoint does not exist, and there is no caller visible in `frontend/src` (features are excluded from this scan). The `FeedbackSubmitResponse` has both fields optional (`id?`, `ok?`) — the response shape is underspecified.

### 2.10 `lib/csrf.ts`
- Reads `csrftoken` from `document.cookie` via regex.
- Handles URL-encoding via `decodeURIComponent`.
- Returns `null` in SSR/non-browser environments.
- Well-tested (5 unit tests covering edge cases including partial-name matches).

### 2.11 `lib/t.ts`
- Identity function `t = (s: string) => s` — i18n placeholder per invariant 13.
- Single entry point — when i18next/Lingui is adopted, only this file changes.
- **Finding (info):** No `t()` usage audit tooling exists. If a future developer adds a UI string without `t()`, no lint rule catches it. Worth adding an ESLint rule or comment convention.

### 2.12 `lib/routes.ts`
- 20 typed route helper functions.
- All slug values are `encodeURIComponent`-wrapped.
- Phase 1B routes that exist as stubs: `orgTournamentsComingSoon`, `orgScoring`, `orgReferee`, `orgTeam`.
- No Phase 1B routes for tournaments, matches, fixtures, live, or disputes exist yet.
- `notFound: () => "/404"` — **Finding (low):** The `App.tsx` catch-all is `path="*"` rendering `<NotFoundPage />`, but `routes.notFound()` returns `/404` which is NOT a registered route. Any `<Link to={routes.notFound()}>` would match the catch-all, rendering correctly, but the URL becomes `/404` rather than a friendly slug. Low severity.

### 2.13 `lib/tailwind.ts`
- Standard `cn(...inputs)` using `clsx` + `tailwind-merge`. No issues.

---

## 3. Types Layer

### 3.1 `types/api.ts`
- `ApiError` class with `status`, `payload`, `isPasswordReauthRequired`, `isUnauthenticated` getters.
- **Finding (high — known):** `isUnauthenticated` treats `status === 403` as unauthenticated when `detail` includes `"authentication credentials"` or `"not authenticated"`. Django REST Framework's default `IsAuthenticated` permission returns HTTP 403 (not 401) for unauthenticated requests. This means the bootstrap catch at `authStore.ts:50` (`if (e instanceof ApiError && e.status === 401)`) will MISS a DRF 403-unauthenticated response and fall into the generic error branch — setting `error: "HTTP 403"` in state. On the login page, `authStore.error` may be rendered, producing a spurious error banner for a freshly-loaded `/login` URL. The `isUnauthenticated` getter correctly handles 403 text checks, but `authStore.bootstrap()` does not use it — it checks only `e.status === 401`.
- `Paginated<T>` generic wrapper interface.

### 3.2 `types/user.ts`
- `Role` = `Schemas["RoleEnum"]` (backend-generated).
- `ModuleScope`, `ModuleDef`, `OrgMembership`, `User`, `GrantState`, `MembershipModuleGrant`, `ModuleMatrixRow`, `ModuleMatrixResponse`, `OrgInvitation`.
- `OrgMembership.active_role?: Role` is client-only (not in serializer). Clear comment.
- **Finding (medium):** `MembershipModuleGrant.state: Exclude<GrantState, "default">` — reason field is optional. However, `permissionsApi.setGrants` also has `reason?: string`. The backend spec (v1Users.md Appendix B.16) requires a `reason` for explicit overrides. Neither the API layer nor the type enforces it as required at the TypeScript level.

### 3.3 `types/generated.ts`
- Ergonomic re-exports of `api.generated.ts` schemas.
- Covers auth, orgs, memberships, modules/RBAC, invitations, lifecycle ops.
- Comment documents the gap: hand-written `User` in `user.ts` is richer than `ApiUser` (generated `Me`) because `MeSerializer` does not yet surface all fields.

### 3.4 `types/api.generated.ts`
- Auto-generated by `openapi-typescript` from `../backend/schema.yml`.
- Regenerate via `npm run gen:types`.
- **Finding (medium — known):** The generated file includes BOTH hyphen and underscore variants of password-reset and verify-email routes (e.g., `/api/accounts/auth/password-reset-complete/` AND `/api/accounts/auth/password_reset_complete/`). This is the known drf-spectacular operationId collision. The FE `auth.ts` uses only the hyphen variants — correct — but the generated types carry dead `_create_2` operation aliases that are noise.

---

## 4. `components/ui/` Primitives

| File | Export | Notes |
|---|---|---|
| `button.tsx` | `Button`, `buttonVariants` | CVA variants: default/destructive/outline/secondary/ghost/link; sizes default/sm/lg/icon |
| `card.tsx` | `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter` | Simple div wrappers with `forwardRef` |
| `dialog.tsx` | `Dialog`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`, `DialogCloseButton` | **Hand-rolled** modal (no Radix). Comment says "replace with @radix-ui/dialog when shadcn primitives are formally adopted." Escape key handling via `window.addEventListener` — no focus-trap. |
| `input.tsx` | `Input` | Basic styled input, `forwardRef` |
| `label.tsx` | `Label` | Styled `<label>`, `forwardRef` |
| `toast.tsx` | `ToastProvider`, `useToast`, `ToastMessage`, `ToastKind` | Context-based toast queue. Auto-dismiss (default 5 s). `crypto.randomUUID` fallback for jsdom. |
| `Avatar.tsx` | `Avatar`, `colourForEmail`, `initialsFor` | Deterministic initials + djb2 colour hash. No image upload (v1 scope note). |
| `DashboardCard.tsx` | `DashboardCard` | Three render modes: `<Link>`, `<button>`, or `<div aria-disabled>` depending on props |
| `PreviewTile.tsx` | `PreviewTile` | Non-interactive Phase 1A card with "Phase 1B" badge for coming-soon features |
| `RoleBadge.tsx` | `RoleBadge`, `ROLE_KEYS`, `SelectableRoleKey` | 7-role palette + neutral fallback. `owner` gets Crown icon. Unknown roles prettified. |

**Finding (high):** `dialog.tsx` has no focus-trap. When the dialog opens, focus is not moved into it; keyboard users can Tab through content behind the overlay. WCAG 2.1 AA requires focus to be trapped in modal dialogs (SC 2.1.2). Replace with `@radix-ui/react-dialog` for ARIA compliance.

**Finding (low):** `toast.tsx` dismiss button renders `x` as text content (`>x<`), not an icon or SVG. The `aria-label="Dismiss notification"` covers screen readers but the `x` character is visually inconsistent with the shadcn design system. Replace with `<X className="h-4 w-4" />` from lucide-react.

**Finding (low):** `dialog.tsx` `DialogCloseButton` renders `x` text content similarly.

---

## 5. Design Tokens (`index.css`, `tailwind.config.js`)

- CSS custom properties for shadcn-standard semantic tokens: `--background`, `--foreground`, `--card`, `--primary`, `--secondary`, `--destructive`, `--border`, `--input`, `--ring`, `--radius`.
- Dark mode defined under `.dark` selector — class-based (`darkMode: ["class"]`).
- Brand tokens: `--brand` (emerald 160°/84%/30%), `--brand-fg`, `--brand-muted`, `--brand-ink`.
- **Custom Tailwind colors:** `grant` (green), `deny` (red), `warn` (amber), `brand` — all used in `GrantCell`, `toast.tsx`, `MyProfilePage`.
- `warn` color is defined in `tailwind.config.js` but no usage found in `frontend/src` (features excluded). Likely used in features.
- WCAG 2.1 AA: `:focus-visible` global ring applied. Body uses `system-ui` font stack.

---

## 6. Build & Test Configuration

### `vite.config.ts`
- Vite proxy: `/api` and `/sadmin` → `http://localhost:8000`.
- Vitest: jsdom, globals, `setupFiles: ["./src/test/setup.ts"]`, `css: false`.
- E2E (`e2e/**`) excluded from vitest run.
- `@` alias → `./src`.

### `package.json`
- **React 19.2.5** (CLAUDE.md says "React 18" — the actual installed version is React 19).
- **Finding (medium):** `dnd-kit` is listed as a planned dependency in CLAUDE.md ("dnd-kit") but is absent from `package.json`. Phase 1B bracket drag-and-drop will need it added.
- **Finding (medium):** `framer-motion` is described as wanted in the system prompt ("shadcn/ui + lucide + framer-motion + cohesive colors/dark mode") but absent from `package.json`. No animation library is installed.
- **Finding (info):** `@radix-ui/*` is absent — all primitives (Dialog, Select, Dropdown, Tooltip, etc.) are hand-rolled. This is expected for Phase 1A but will need to be addressed for Phase 1B Pro SaaS UI overhaul.
- `gen:types` script: `openapi-typescript ../backend/schema.yml -o src/types/api.generated.ts` — schema path is relative to the `frontend/` dir; correct.

### `test/setup.ts`
- Registers `@testing-library/jest-dom` matchers.
- Clears cookies between tests (deterministic CSRF state).
- Polyfills `crypto.randomUUID` for jsdom environments that lack it.

---

## 7. Findings Summary

| # | Severity | Area | File:line | Issue |
|---|---|---|---|---|
| F1 | high | Auth plumbing | `types/api.ts:32–44`, `features/auth/authStore.ts:50` | `bootstrap()` only catches `status === 401` but DRF returns 403 for unauthenticated requests. When `/api/accounts/me/` returns 403 on a logged-out user, bootstrap sets `error: "HTTP 403"` instead of silently treating as unauthenticated. Can cause a spurious error banner on the login page. Fix: change `authStore.bootstrap` to use `e instanceof ApiError && e.isUnauthenticated` instead of `e.status === 401`. |
| F2 | high | API / auth bus | `api/queryClient.ts:47` | `authBus.emit` is exported but never imported. Mutations that receive a 401/403 session expiry will NOT trigger the global `AuthBusBridge` redirect to `/login`. Only queries benefit from the `QueryCache.onError` handler. Fix: add a `MutationCache` with the same `onError` logic, or import `authBus` in mutation `onError` handlers. |
| F3 | high | Accessibility | `components/ui/dialog.tsx` (entire file) | No focus-trap in the hand-rolled `<Dialog>`. WCAG 2.1 AA SC 2.1.2 requires keyboard focus stays within a modal. The Escape key listener is correct but focus can leave the dialog via Tab. Fix: replace with `@radix-ui/react-dialog` (standard shadcn primitive). |
| F4 | medium | API shape | `types/user.ts:103–105` | `MembershipModuleGrant.reason` is optional and `permissionsApi.setGrants` `reason` is optional. v1Users.md B.16 implies reason should be required for non-default override states. Fix: consider requiring `reason` at the TypeScript level or at least enforcing it in the UI. |
| F5 | medium | API asymmetry | `api/orgs.ts:92–94` | `orgsApi.removeMember(orgUuid, membershipId)` takes a UUID, while all other `orgsApi` methods take a slug. No type-level guard. Future callers may pass a slug by mistake (both are `string`). Fix: wrap in a branded type `OrgUuid` or add a JSDoc warning. |
| F6 | medium | Missing deps | `package.json` | `dnd-kit` and `framer-motion` absent. Both are called out as required for Phase 1B bracket UI and the Pro SaaS overhaul. Fix: add before Phase 1B scaffold. |
| F7 | medium | OpenAPI noise | `types/api.generated.ts:135–165, 230–245` | Duplicate `_create_2` operations for password-reset and verify-email hyphen/underscore variants. Dead aliases. Fix: clean up backend URL patterns to eliminate duplicates (tracked as known issue). |
| F8 | low | Route mismatch | `lib/routes.ts:10` | `routes.notFound()` returns `"/404"` but the App.tsx catch-all is `path="*"`. `/404` resolves via the catch-all accidentally. Any hardcoded `routes.notFound()` link navigates to `/404` which then renders `<NotFoundPage>` — correct result but unexpected URL. Fix: either register an explicit `/404` route or rename to `routes.notFound: () => "/*"`. |
| F9 | low | UX polish | `components/ui/toast.tsx:93`, `components/ui/dialog.tsx:112` | Dismiss/close buttons render literal `x` text instead of a lucide icon. Visually inconsistent with the rest of the UI. Fix: `<X className="h-4 w-4" />` from lucide-react. |
| F10 | info | i18n | `lib/t.ts` | No ESLint rule enforces that all user-visible strings go through `t()`. Fix: add `eslint-plugin-i18n` or a custom rule before Phase 1B. |
| F11 | info | React version drift | `package.json:25`, `CLAUDE.md` | CLAUDE.md says "React 18" but `package.json` has `react: ^19.2.5`. React 19 has breaking changes (removal of legacy context, updated `act`, etc.). CLAUDE.md should be updated to reflect React 19. |
| F12 | info | Radix UI | `package.json` | `@radix-ui/*` not installed. All interactive widgets (Dialog, Dropdown, Select, Tooltip, Combobox) are hand-rolled. This is Phase 1A scope but Phase 1B Pro SaaS overhaul will need them. Note for Phase 1B kickoff. |

---

## 8. Gaps (Phase 1B)

- No routes, API clients, or types for: **tournaments**, **teams/players**, **fixtures/bracket**, **matches**, **live (SSE/WS)**, **notifications**, **disputes**.
- No `TournamentMembership` type or API.
- No `Person` ↔ `Player` split in types.
- No JSONB typed match-dependency types.
- No SSE `EventSource` client.
- No WebSocket consumer hooks.
- `routes.ts` has no Phase 1B entries.
- `dnd-kit` (bracket drag-and-drop) and `framer-motion` (animated UI) are absent from `package.json`.
- `feedbackApi.submit()` targets a backend endpoint described as "being created in parallel" — verify backend `/api/feedback/submit/` exists and is not a 404.
