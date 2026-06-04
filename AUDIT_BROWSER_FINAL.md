# Browser smoke FINAL — 7 roles — 2026-05-03 (post-Wave-3 fixes)

## Tested env
- Vite SPA: http://localhost:5175 (running)
- Django:   http://localhost:8000 (running)
- Seed:     `backend/scripts/seed_full_demo.py`
- Test runtime: ~12 min, all 7 roles + sadmin completed (read-only; only mutating call was 4× POST `/api/feedback/submit/` to verify the Send button)

## Defect status table

| Original defect | Surface | Original symptom | Now? | Evidence |
|---|---|---|---|---|
| **DEFECT-J (CRITICAL)** | SPA `/o/doxaed/permissions` | co_organizer + game_coordinator could open matrix via direct URL with full edit affordances | **FIXED** | All three of co_organizer / game_coordinator / match_scorer / team_manager now get HTTP **403** from `/api/permissions/orgs/doxaed/grants/matrix/` and the page renders an "Access required — You don't have access to the module override matrix in this organisation." card with no matrix grid. Verified in screenshots 11 (coorg) and 14 (coord). |
| **DEFECT-Q (CRITICAL)** | Sadmin dashboard | `Total users: 1, Active orgs: 0` | **FIXED** | KPI cards now show **Total users 8 / Active 7d 8 / Active orgs 1 / Open feedback 4**. Recent feedback list now populates with the entries I submitted. Screenshot 18. |
| **DEFECT-A** | SPA `/o/doxaed/audit` | Coming-soon placeholder | **PARTIALLY** — API wired (status 200, valid `{results, next_cursor, previous_cursor}` shape, returns 200 for admin/coorg/etc. via cookie auth). UI page itself **still renders "Audit log — coming soon"** placeholder per the task's note that Wave 3F UI may not be built yet. The endpoint returns `{"results": []}` for `/api/audit/orgs/doxaed/` even though sadmin shows 50+ rows globally — likely the org-scoped filter excludes platform-level events; not a wiring bug, but worth confirming row population for org-scoped events. Screenshot 5. |
| **DEFECT-B (settings)** | SPA `/o/doxaed/settings` | Coming-soon | **FIXED** | Real form: Organization name (DoxaEd Sports), URL slug (doxaed, immutable), Time zone (Asia/Kolkata + 15 alt zones), Save button (correctly disabled until dirty). Screenshot 3. |
| **DEFECT-B (branding)** | SPA `/o/doxaed/branding` | Coming-soon | **FIXED** | "Identity preview" card with org name + slug + emerald palette icon. "Brand assets" card with disabled `Primary color` (#10b981) + `Logo URL` inputs and an explanatory banner: "Branding fields coming with Phase 1B. The Organization model does not yet store color or logo, so saves are disabled until that migration ships." Screenshot 4. |
| **DEFECT-D** | `/me` email-verified | "Email not yet verified" for admin | **FIXED** | Page now shows "Email verified." for admin, coorg, manager (every role sampled). Screenshots 6, 12. |
| **DEFECT-E** | `/me` full-name | Showed "(no name set)" while Members table showed "Admin User" | **FIXED** | Page H1 = "Admin User" / "Co-organizer User" / "Team-manager User"; Full name field disabled-but-populated with same. Screenshots 6, 12. |
| **DEFECT-F** | `/me` primary nav | Primary nav missing on /me | **NOT FIXED** | The `<navigation aria-label="Primary">` element exists on `/me` but renders empty (no children). Header keeps Fixture wordmark + org switcher + avatar; user must use logo or back button to reach the dashboard. Screenshot 6 confirms — top bar has only Fixture / org / avatar. Severity: still P2. |
| **DEFECT-G** | User-menu title/subtitle | Both showed email | **FIXED** | User-menu now shows person name as title and email as subtitle (e.g., "Admin User" / "admin@doxaed.test"). Avatar bubble shows correct initials too. |
| **DEFECT-H** | `/login` first render | Marketing sidebar missing on first load | **FIXED** | First navigation to `/login` (clean session) now renders the emerald gradient sidebar with "Sports fixtures, made in Nagaland." headline immediately. Screenshot 1. |
| **DEFECT-I** | `/login` retains creds | Email/password retained after logout | **FIXED at app level** | After logout, React component state for both inputs is `defaultValue=""`. The values that *appear* are browser autofill (`:-webkit-autofill` matches), which is normal and not under app control. Verified by reading React fiber state after logout. |
| **DEFECT-K** | Avatar collisions | coord/coorg both rendered "C" | **FIXED** | Initials now derived from `Person.full_name` (first+last initial), not email local-part. Coorg = "CU", coord = "GU", scorer = "MU", referee = "RU", manager = "TU", admin = "AU" — every role distinct. Note: task expected "CD" / "CG" but actual seed puts last_name="User" so initials follow the seed; collision goal achieved either way. |
| **DEFECT-N** | Team icon collision | Trophy used for both Team and Tournaments | **FIXED** | Team-manager nav now uses `lucide-users-round` (UsersRound — two-people heads), visually distinct from the Trophy used for Tournaments. Screenshot 17. |
| **DEFECT-P** | `/favicon.ico` 404 | 404 on every page | **FIXED for SPA** (still 404 on sadmin) | SPA `index.html` references `/favicon.svg` which now serves 200 image/svg+xml (the emerald "F"). The browser's default `/favicon.ico` probe still 404s on both servers, but the actual rendered tab icon is the SVG. |
| **DEFECT-M** | Referee + Audit | Was flagged as bug; spec says intentional | **CONFIRMED INTENTIONAL** | Referee nav has Audit link visible; per spec referee holds `org.audit_log` for own matches. No defect. Screenshot 16. |
| **Wave 3B: role-aware login redirect** | SPA login flow | Match-scorer landed on /dashboard instead of /scoring | **FIXED** | match_scorer → `/o/doxaed/scoring` ✓; referee → `/o/doxaed/referee` ✓; team_manager → `/o/doxaed/team` ✓; admin → `/o/doxaed/dashboard` ✓; coorg → `/o/doxaed/dashboard` ✓; coord → `/o/doxaed/dashboard` ✓. |
| **Wave 3B: module-gated nav** | SPA top nav | Admin missing Scoring/Referee links | **FIXED** | Admin top nav now includes Dashboard / Members / Permissions / Audit / **Scoring (Phase 1B)** / **Referee (Phase 1B)**. Match-scorer top nav: Dashboard / Scoring only — no Permissions link. Verified across all 6 SPA roles. |
| **Wave 3B+3D: Feedback Send** | SPA Feedback modal | Send silently closed | **FIXED** | Clicking Send POSTs to `/api/feedback/submit/` (status **201 Created**), closes modal, and shows a success toast: `"Feedback sent — Thanks, the platform team will read this."` (`role="status"`, `border-grant bg-grant-muted`). Captured via MutationObserver. Submitted 4 entries that all show up in sadmin Recent feedback. |

## Known still-deferred (per task — not flagged as new defects)
- **DEFECT-O** sadmin Tailwind CDN: still loaded from `cdn.tailwindcss.com`; warning visible in console on every sadmin page. Deferred per task.
- **DEFECT-R** sadmin SA-only verbs page: backend verbs added at `/sadmin/api/...` per task notes; org detail view still surfaces only "Suspend" verb in the HTML. Deferred per task.
- **DEFECT-S** Tournaments link slug `/o/doxaed/tournaments-coming-soon`: still present, dashboard "Tournaments" card still points to that ugly URL.
- **DEFECT-C** active-nav highlight wrong: not re-verified in this pass; not addressed.
- **DEFECT-F** `/me` missing primary nav: still missing — the `Primary` nav element renders without children on `/me`. Worth picking up in Wave 3F.

## Per-role results

### Role: admin (admin@doxaed.test)
- Login → `/o/doxaed/dashboard` ✓ (matches expectation)
- Console clean (only the expected pre-login `/api/accounts/me/` 403 bootstrap)
- Avatar **AU**, "You are: admin"
- Nav: Dashboard / Members / Permissions / Audit / Scoring(1B) / Referee(1B) — module-gated nav working
- Settings (`/o/doxaed/settings`): real form (DEFECT-B FIXED)
- Branding (`/o/doxaed/branding`): real preview + disabled Phase-1B fieldset (DEFECT-B FIXED)
- Audit (`/o/doxaed/audit`): UI still ComingSoon, but `/api/audit/orgs/doxaed/` returns 200 with valid empty-result shape
- `/me`: H1 "Admin User", "Email verified." (DEFECT-D/E FIXED). Primary nav missing here (DEFECT-F open).
- Feedback modal Send → 201 + success toast (Wave 3B+3D FIXED)
- Sign out → `/login` clean, app-level form state empty (DEFECT-I FIXED at app)

### Role: co_organizer (coorg@doxaed.test)
- Login → `/o/doxaed/dashboard` ✓
- Console clean
- Avatar **CU**, "You are: co_organizer"
- Nav same as admin (Dashboard / Members / Permissions / Audit / Scoring / Referee). Note: nav now shows Permissions even though coorg can't open it — UI module gate not strictly enforced on top nav, but **server-side guard at the API works** which is what the J fix required.
- Direct nav `/o/doxaed/permissions` → **HTTP 403 from API + "Access required" UI** (DEFECT-J FIXED)
- `/me` good (DEFECT-D/E/G FIXED)

### Role: game_coordinator (coord@doxaed.test)
- Login → `/o/doxaed/dashboard` ✓
- Console clean
- Avatar **GU** (was "C" colliding with coorg) — DEFECT-K FIXED
- Nav same as coorg
- Direct nav `/o/doxaed/permissions` → **HTTP 403 + "Access required"** (DEFECT-J FIXED)
- Dashboard cards include Module overrides — appears as a card but route 403s. Dashboard-card visibility filter is more lenient than the route guard; cosmetic.

### Role: match_scorer (scorer@doxaed.test)
- Login → **`/o/doxaed/scoring`** ✓ (Wave 3B redirect FIXED — was `/dashboard`)
- Console clean
- Avatar **MU**
- Nav: **Dashboard / Scoring (Phase 1B) only** — no Permissions, no Members, no Audit, no Referee. Module-gated nav working perfectly.
- Direct nav to `/permissions` → 403 + Access required (was already correct, still correct)
- Welcome page renders all 4 Phase-1B preview tiles (Live scorebox / Set-piece logger / Substitution tracker / Timeline export)

### Role: referee (referee@doxaed.test)
- Login → **`/o/doxaed/referee`** ✓ (Wave 3B redirect FIXED)
- Console clean
- Avatar **RU**
- Nav: Dashboard / Audit / Referee (Phase 1B) — Audit visible (DEFECT-M intentional per spec, confirmed)
- Welcome page Phase-1B tiles: Lineup confirmation / Match clock control / Card&foul logger / Match-incident reports

### Role: team_manager (manager@doxaed.test)
- Login → **`/o/doxaed/team`** ✓ (Wave 3B redirect FIXED)
- Console clean
- Avatar **TU**
- Nav: Dashboard / **Team (Phase 1B with `lucide-users-round` icon)** — DEFECT-N icon collision FIXED
- Direct nav to `/permissions` → 403 + Access required
- `/me` shows H1 "Team-manager User", Email verified ✓

### Role: super-admin (graceschooledu@gmail.com / DoxaEd33@)
- Login at `/sadmin/login/` → `/sadmin/`
- Sidebar nav: Dashboard / Organizations / Users / Feedback / Audit log
- **KPIs: 8 / 8 / 1 / 4** — DEFECT-Q FIXED
- Recent feedback list shows the 4 entries I submitted during this audit (proves feedback POST→sadmin readout pipeline is alive)
- Recent usage events: still empty ("No telemetry yet.") — telemetry plumbing still pending, but expected
- Users page: 8 users with last-login timestamps matching my session activity ✓
- Sadmin still loads `cdn.tailwindcss.com` (DEFECT-O deferred) and 404s `/favicon.ico` (DEFECT-P sadmin deferred)

## NEW defects discovered (none critical)

- **NEW-A (P3)**: On the role-specific welcome pages (Scoring, Referee, Team), the inline "Send feedback" item under "What you can do today" is a `<button disabled>` — user cannot trigger the feedback modal from these pages, only from the Dashboard. The dashboard route is reachable from the same nav so it's not a hard block, but inconsistent vs admin dashboard's working Send Feedback card. Trivial.
- **NEW-B (P3)**: co_organizer top nav still includes a "Permissions" link even though the page server-403s for that role. The link click still navigates to `/o/doxaed/permissions` and the user sees "Access required". For a cleaner UX, hide the link from nav for users without `module_overrides` module. Server guard is correct, this is purely visual nav noise.
- **NEW-C (P3)**: game_coordinator dashboard renders a "Module overrides" card despite the user not having that module (clicking it 403s). Same family as NEW-B — dashboard card filter is laxer than the route guard. Cosmetic.
- **NEW-D (P3)**: SPA browser still emits a 404 for `/favicon.ico` (Chrome's default request when no `<link rel=icon>` of type ICO exists). The actual tab icon is `/favicon.svg` and renders fine; a `favicon.ico` (16/32 px PNG-ICO) could be added to silence the noise but is harmless.

## Screenshots
Saved to `C:\Users\Asus\Desktop\fixture.doxaed.com\test-screenshots-final\`:
- `01-login-initial.png` — first /login load (sidebar present immediately, DEFECT-H proof)
- `02-admin-dashboard.png` — admin landing, full nav (Scoring/Referee visible)
- `03-admin-settings.png` — real Org settings form (DEFECT-B FIXED)
- `04-admin-branding.png` — real Branding page with Identity preview + disabled Phase-1B fieldset
- `05-admin-audit.png` — Audit page (still ComingSoon UI; API works)
- `06-admin-me.png` — /me with Admin User name + Email verified
- `07-admin-feedback-after-send.png` — modal closed after Send (toast already auto-dismissed)
- `08-feedback-toast.png` — captured separately via DOM mutation observer (Send works)
- `09-login-after-logout.png` — autofill re-populates fields visually but app state is empty
- `10-coorg-dashboard.png` — coorg dashboard, avatar "CU"
- `11-coorg-permissions-direct.png` — co_organizer direct-nav to /permissions → "Access required" (DEFECT-J FIXED)
- `12-coorg-me.png` — coorg /me with verified email
- `13-coord-dashboard.png` — coord dashboard, avatar "GU" (no collision with coorg)
- `14-coord-permissions-direct.png` — game_coordinator direct-nav → "Access required" (DEFECT-J FIXED)
- `15-scorer-scoring.png` — match-scorer landed on /scoring (role-aware redirect)
- `16-referee-landing.png` — referee landed on /referee, Audit link present in nav
- `17-team-landing.png` — team-manager landed on /team with `users-round` icon (DEFECT-N FIXED)
- `18-sadmin-dashboard.png` — KPIs 8/8/1/4 (DEFECT-Q FIXED)
- `19-sadmin-users.png` — 8 active users with current-session login timestamps

## Conclusion: production-ready? **N — but very close for Phase 1A**

Both critical regressions from the prior audit are gone:
- DEFECT-J server-side permission guard now correctly returns 403 for co_organizer / game_coordinator / match_scorer / team_manager.
- DEFECT-Q sadmin KPIs now reflect reality.

Phase 1A surface is functionally honest: Settings is a real form, Branding is a real preview, /me shows real data, the feedback pipeline submits and surfaces in sadmin. Module-gated nav and role-aware login redirects work. Avatars no longer collide. Team icon no longer duplicates Tournaments.

What still blocks a "production-ready" call:
1. **DEFECT-A audit UI** is still a placeholder. Even though the API is wired, an admin clicking the Audit nav item lands on Coming-Soon — that is misleading because the data is real and visible to super-admin. Either ship the Wave 3F reader or stop showing Audit in the nav until 1B.
2. **DEFECT-F /me primary nav** missing — minor UX trap (lose context on profile page).
3. **NEW-B / NEW-C** dashboard/nav showing modules the user can't access. Server-side correct, but UI lies. Easy fix.
4. **DEFECT-O / DEFECT-P (sadmin)** still cosmetic noise but should be cleaned before any external eyes.

For Phase 1A scope (auth + orgs + members + module overrides + audit-readout + feedback) the platform is **functionally honest and secure**. Recommend resolving DEFECT-A audit UI + the four NEW-* / open-items in a small follow-up wave (3F-cleanup) before declaring 1A done.

## Spot-check round 2 — 2026-05-03

- **DEFECT-A (Audit page real)**: ✓ FIXED — `/o/doxaed/audit` now renders H1 "Audit log", subtitle "Append-only record of state-changing actions in this organization.", a Refresh button, and the empty-state "No audit events yet for this organization." card. No Coming-Soon placeholder.
- **DEFECT-F (/me primary nav)**: ✓ FIXED — `/me` top primary nav populated with Dashboard / Members / Permissions / Audit / Scoring / Referee links (admin role; falls back from `last_active_org_slug`).
- **Permissions narrowed to admin-only**: ✓ FIXED — co_organizer sees nav `[Dashboard, Members, Audit, Scoring, Referee]` and dashboard cards `[Member directory, Org settings, Audit log, Tournaments, Branding, My profile, Notifications, Send feedback]` — no Permissions link, no "Module overrides" card. game_coordinator nav `[Dashboard, Members, Audit, Scoring, Referee]` and cards `[Member directory, Audit log, Tournaments, My profile, Notifications, Send feedback]` — same: no Permissions, no Module overrides.
- **Welcome-page Send Feedback link**: ✓ FIXED — match_scorer lands at `/o/doxaed/scoring`; "What you can do today" → "Send feedback" is a real link (`href=/o/doxaed/dashboard?feedback=1`, not disabled). Click navigates to `/o/doxaed/dashboard` and the `dialog "Send feedback"` modal opens automatically with textarea + Cancel/Send buttons.

**Production-ready: Y for Phase 1A scope**
