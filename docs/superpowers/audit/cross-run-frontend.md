# Cross-cutting audit: run-frontend (static + toolchain verification)

Date: 2026-06-04
Scope: `frontend/` only (node_modules and dist ignored as artifacts). Question: does the frontend build? Do tsc / vite / vitest / eslint pass? Do imports (`@/` alias), referenced files, types, and test setup cohere?

Method: read every config file + entry points, then actually ran the toolchains against the installed `node_modules` (node v22.21.0; resolved tools: typescript 6.0.3, vite 8.0.10, vitest 4.1.5, eslint 10.3.0, typescript-eslint 8.59.1, eslint-plugin-react-hooks 7.1.1, lucide-react 1.14.0).

## Headline result

- `tsc -b --noEmit` (the `type-check` script AND the type half of `build`): **PASS, exit 0**, no diagnostics.
- `vite build`: **PASS, exit 0** — 1935 modules transformed, emitted `dist/` (513 kB JS / 27 kB CSS).
- `vitest run`: **PASS, exit 0** — 27 test files, 162 tests, all green.
- `npm run build` = `tsc -b && vite build`: **builds successfully.** Lint is a separate script and does NOT gate the build.
- `eslint .` (the `lint` script): **FAIL, exit 1** — 14 problems (12 errors, 2 warnings).

Net: the app compiles, bundles, and tests pass. The only failing command is `npm run lint`. If CI runs `lint` as a required gate, the pipeline is red; if CI only runs `build` + `test`, it is green.

---

## Findings

### F1 — `npm run lint` fails: 12 ESLint errors, 2 warnings (high)
File: `frontend/eslint.config.js` (config) + 8 source files.
Evidence: `eslint .` exits 1 with `✖ 14 problems (12 errors, 2 warnings)`. The config enables `reactHooks.configs.flat.recommended` and `reactRefresh.configs.vite`; with the installed `eslint-plugin-react-hooks@7.1.1` and `typescript-eslint@8.59.1` these recommended sets are stricter than the code was written against. Breakdown below (F1a–F1h).
Why it matters: `lint` is a real, defined script (`package.json:15`). If it is wired into CI / pre-commit / the `dispatching-parallel-agents` gate, every push is blocked. It does not break `build` or `test`.
Recommendation: fix the underlying issues (F1a–F1h) rather than relaxing the config; all are quick, mechanical fixes.

#### F1a — `react-refresh/only-export-components` (error ×6)
Files/lines:
- `frontend/src/components/ui/Avatar.tsx:46` and `:78`
- `frontend/src/components/ui/RoleBadge.tsx:122` (`export const ROLE_KEYS = [...] as const;`)
- `frontend/src/components/ui/button.tsx:48`
- `frontend/src/components/ui/toast.tsx:105`
Evidence: `error  Fast refresh only works when a file only exports components. Use a new file to share constants or functions between components  react-refresh/only-export-components`. Example at `RoleBadge.tsx:122`: `export const ROLE_KEYS = [ "admin", "co_organizer", ... ] as const;` lives in the same file as the `RoleBadge` component.
Why it matters: each is a hard ESLint error. (Runtime fast-refresh still works for `cva` variant exports in practice, but the rule flags non-component named exports.)
Recommendation: move shared constants/variants (`ROLE_KEYS`, `buttonVariants`, `avatarVariants`, toast helpers) into sibling non-component modules (e.g. `roleKeys.ts`, `button.variants.ts`), or add per-line `// eslint-disable-next-line react-refresh/only-export-components` if the team accepts co-location.

#### F1b — `react-hooks/set-state-in-effect` (error ×5)
Files/lines:
- `frontend/src/features/layout/AppShell.tsx:49` — `setMenuOpen(false); setDrawerOpen(false);` inside `useEffect(..., [location.pathname])`.
- `frontend/src/features/layout/OrgDashboardPage.tsx:43` — `setFeedbackOpen(true);` inside a `useEffect` reading `searchParams`.
- `frontend/src/features/orgs/InviteAcceptPage.tsx:36` — `setState("error");` inside `useEffect(..., [token])`.
- `frontend/src/features/orgs/InviteCreateModal.tsx:90` — `setError(null);` inside `React.useEffect(..., [open])`.
- `frontend/src/features/roles/MyProfilePage.tsx:49` — `if (!editing) setName(user?.name ?? "");` inside `useEffect(..., [user?.name, editing])`.
Evidence: `error  Error: Calling setState synchronously within an effect can trigger cascading renders ... react-hooks/set-state-in-effect`.
Why it matters: this rule is new/promoted-to-error in `eslint-plugin-react-hooks@7`. Code authored against an older plugin now fails lint. Functionally these patterns work today but the rule treats them as errors.
Recommendation: where possible derive state during render or use event handlers instead of effects; otherwise disable the rule per-line with justification. These are the most numerous "code was fine, tooling moved" failures.

#### F1c — `no-useless-assignment` (error ×1)
File: `frontend/src/api/client.ts:7`.
Evidence: `let payload: ApiErrorPayload = {};` then immediately reassigned in the `try`/`catch` — `error  The value assigned to 'payload' is not used in subsequent statements  no-useless-assignment`.
Recommendation: declare `let payload: ApiErrorPayload;` (no initializer) — both branches assign it before use, so this is safe and silences the rule.

#### F1d — `no-useless-escape` (error ×1)
File: `frontend/src/components/ui/RoleBadge.tsx:112`.
Evidence: `.replace(/[_\-]+/g, " ")` — the `\-` inside the character class is an unnecessary escape: `error  Unnecessary escape character: \-  no-useless-escape`.
Recommendation: use `/[_-]+/g` (a hyphen at the end of a class is literal) — or move `-` to the start/end.

#### F1e — Stale `eslint-disable` directive (warning ×1)
File: `frontend/src/features/errors/ErrorBoundary.tsx:42`.
Evidence: `// eslint-disable-next-line no-console` above `console.error(...)`, but `warning  Unused eslint-disable directive (no problems were reported from 'no-console')`. The flat config does not enable `no-console`, so the suppression is dead.
Recommendation: remove the directive line.

#### F1f — `react-refresh` "Compilation Skipped: Use of incompatible library" (warning ×1)
File: `frontend/src/features/auth/SignupPage.tsx:64`.
Evidence: `warning  Compilation Skipped: Use of incompatible library`. The React-Compiler/react-refresh lint pass bails on this component (commonly triggered by a non-compiler-friendly library call).
Why it matters: warning only, does not fail lint by itself; informational about a component the compiler can't optimize.
Recommendation: low priority; investigate which call at/around line 64 is flagged if React Compiler optimization is desired later.

---

### F2 — `lint` is not part of the build/test pipeline; build green despite lint red (info)
File: `frontend/package.json:8,15,16`.
Evidence: `"build": "tsc -b && vite build"`, `"lint": "eslint ."`, `"type-check": "tsc -b --noEmit"`. `build` never invokes `eslint`. Verified: `vite build` and `vitest run` both exit 0 while `eslint .` exits 1.
Why it matters: a passing `npm run build` does NOT imply a clean lint. Anyone gating only on build will ship the F1 issues; anyone gating on lint will be blocked. The discrepancy should be a conscious decision.
Recommendation: decide whether lint is a required gate; if yes, fix F1 first or it will block all parallel-agent work.

---

### F3 — Three parallel type-definition files; coherent but easy to drift (low)
Files: `frontend/src/types/api.ts` (hand-written `ApiError`/`ApiErrorPayload`/`Paginated`), `frontend/src/types/api.generated.ts` (openapi-typescript output, 76 KB), `frontend/src/types/generated.ts` (ergonomic re-exports of `api.generated`), `frontend/src/types/user.ts` (hand-written domain types: `User`, `Role`, `OrgMembership`, etc.).
Evidence: all four are imported by real code (`api.generated` → `api/orgs.ts:3`, `api/audit.ts:2`; `generated` → `types/__tests__/generated-types.test.ts:20`; `user` → ~25 importers; `api` → ~15 importers). The `generated.ts` header (lines 7–15) documents the intentional split: hand-written `user.ts` is "richer" than the current `MeSerializer` exposes, so generated types are layered on top, not replacing the domain types yet. `gen:types` (`package.json:17`) targets `../backend/schema.yml` (confirmed present, 62 KB) and writes `src/types/api.generated.ts`. tsc resolves all of them cleanly (exit 0).
Why it matters: not a bug — it builds and is documented — but two hand-written + two generated type layers describing the same backend invites drift. The header itself flags that `user.ts` should eventually be replaced by generated types once `MeSerializer` is widened.
Recommendation: track the "fold hand-written `user.ts` into generated" cleanup; add a CI check that `gen:types` produces no diff (catches schema/type drift) once the backend schema stabilizes.

---

### F4 — `@/` path alias is consistent across tsc, Vite, and Vitest (info / positive)
Files: `frontend/tsconfig.app.json:17-19` (`"paths": { "@/*": ["./src/*"] }`), `frontend/vite.config.ts:9-13` (`alias: { "@": path.resolve(__dirname, "./src") }`).
Evidence: tsc build, vite build, and vitest all ran clean; `@/...` imports appear in nearly every file and all resolve. Vitest uses the same Vite config (`defineConfig` from `vitest/config`) so the alias is shared — no separate `test.alias` needed, and none is missing.
Why it matters: a common failure mode (alias works in tsc/vite but not vitest, or vice-versa) is absent here. No action.

---

### F5 — Test setup is coherent; jsdom env + setup file wired correctly (info / positive)
Files: `frontend/vite.config.ts:29-37`, `frontend/src/test/setup.ts`, `frontend/tsconfig.app.json:7`.
Evidence: `test: { globals: true, environment: "jsdom", setupFiles: ["./src/test/setup.ts"], css: false, exclude: [..., "e2e/**"] }`. tsconfig `types` includes `vitest/globals` and `@testing-library/jest-dom`. Setup imports `@testing-library/jest-dom/vitest`, runs `cleanup()` + `vi.restoreAllMocks()` in `afterEach`, wipes cookies, and pins `crypto.randomUUID`. The `e2e/**` exclude correctly keeps Playwright specs out of the jsdom run (verified: vitest ran 27 files, none from `e2e/`). `jsdom@29` is installed and resolves.
Why it matters: this is the configuration that makes 162 tests pass; it is internally consistent. No action.

---

### F6 — E2E (Playwright) toolchain is separate and not type-checked by `tsc -b` (low)
Files: `frontend/playwright.config.ts`, `frontend/e2e/fixtures.ts`, `frontend/e2e/role-smoke.spec.ts`, `frontend/tsconfig.app.json:27` (`"include": ["src"]`).
Evidence: `tsconfig.app.json` only includes `src`, so `e2e/` TS is NOT covered by `tsc -b`. Playwright type-checks its own specs at run time via `@playwright/test` (installed, ^1.59.1). `playwright.config.ts:22` sets `baseURL: "http://localhost:5174"` while the header comment says Vite runs on 5174 "(falls back to 5173)" and `vite.config.ts:15` pins `port: 5173`. There is no `webServer` block in the Playwright config, so E2E requires the dev servers (Django:8000 + Vite) to be started manually, and the baseURL (5174) does not match the Vite default port (5173).
Why it matters: E2E specs are not part of the static build/typecheck and were not run here (they need live servers + seeded demo accounts). The 5174-vs-5173 port mismatch means `npm run test:e2e` against a default `npm run dev` (5173) will hit the wrong port unless Vite is started on 5174. Not a build blocker.
Recommendation: either add a `webServer` block to `playwright.config.ts` (auto-start Vite on a known port) or align `baseURL` with the actual dev port. Optionally add `e2e` to a typecheck-only tsconfig so spec drift is caught without running browsers.

---

### F7 — Bundle is a single 513 kB chunk; no code-splitting (low)
File: build output (`dist/assets/index-*.js` 513.05 kB / gzip 151 kB).
Evidence: `vite build` warns: `Some chunks are larger than 500 kB after minification. Consider: Using dynamic import() to code-split ...`. The whole SPA (all routes in `App.tsx` are statically imported, lines 13-44) ships in one chunk.
Why it matters: not a build failure (warning only), but every route — auth, orgs, permissions, role landings — loads up front. Acceptable for Phase 1A; will worsen as Phase 1B (tournaments, fixtures, live scoring) lands.
Recommendation: lazy-load route elements with `React.lazy` + `Suspense` in `App.tsx` before Phase 1B grows the bundle.

---

### F8 — Hardcoded credentials committed in E2E fixtures (info / out of scope)
File: `frontend/e2e/fixtures.ts:13-22`.
Evidence: real-looking super-admin credentials are committed: `superAdmin: { email: "graceschooledu@gmail.com", password: "DoxaEd33@" }`, plus six `*@doxaed.test` demo passwords.
Why it matters: not a build/type/test issue, but the super-admin account here matches the project owner's email (per CLAUDE.md memory). A committed password for a real owner account is a secret-hygiene concern.
Recommendation: move credentials to env vars / a gitignored `.env.e2e`; rotate the super-admin password if `DoxaEd33@` is the live one. (Flagged for awareness; outside the run-frontend mandate.)

---

## Gaps (what could not be statically determined / is missing)

- **E2E not executed.** `e2e/role-smoke.spec.ts` requires a running Django backend (8000), a running Vite server (on 5174 per config), AND seeded demo accounts. None were available in this static pass, so E2E pass/fail is unknown. (Effort to verify: M — needs full dev stack up.)
- **`gen:types` not re-run.** I confirmed the source `backend/schema.yml` exists and `openapi-typescript` is installed, but did not regenerate to check whether the committed `api.generated.ts` is in sync with the current schema. Drift here would be invisible to `tsc` (it type-checks whatever is committed). (Effort: S.)
- **Phase 1B frontend surfaces absent.** Consistent with project status — no tournament/fixture/bracket/live-scoring UI exists; routes for those are `ComingSoonPage` placeholders (`App.tsx:171-174`). Not a defect, just the known scope boundary; flagged so the "does it build" answer is not mistaken for "is it feature-complete."
- **No `webServer` in Playwright config / port mismatch (F6).** Means E2E is not self-contained; can't be run by CI without extra orchestration.
- **Lint-vs-build gate undecided (F2).** Whether the 12 lint errors actually block the team depends on CI wiring, which is a backend/infra concern not visible in `frontend/`.
