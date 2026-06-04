# Browser smoke - 7 roles - 2026-05-03

## Tested env
- Vite SPA: http://localhost:5175 (running, ports 5173/5174 in use; vite picked 5175)
- Django:   http://localhost:8000 (running)
- Seed:     `backend/scripts/seed_full_demo.py` (per `backend/scripts/CREDENTIALS.md`)
- Test runtime: ~12 min, all 7 roles + sadmin completed

## Screenshots
All saved in `test-screenshots/` (relative to `C:\Users\Asus\Desktop\fixture.doxaed.com\`).

---

## Per-role results

### Role: admin (admin@doxaed.test)
- [x] Login page renders
- [x] Login succeeded - redirected to `/o/doxaed/dashboard`
- [x] Console after login: only the pre-login `403 GET /api/accounts/me/` bootstrap error (expected pattern)
- Click "Members" -> `/o/doxaed/members` -> 200, table shows 6 members with role badges (Owner/Admin/Co-organizer/Game coordinator/Match scorer/Referee/Team manager). Search input and Invite button present. WORKS.
- Click "Permissions" -> `/o/doxaed/permissions` -> 200, "Module overrides" matrix renders with 6 members x 22 modules. Tabs/columns: Platform/Org/Tournament. WORKS.
- Click "Audit" -> `/o/doxaed/audit` -> renders "Audit log - coming soon" placeholder.  **DEFECT-A**
- Dashboard cards visited:
  - "Member directory" -> works (same as Members nav)
  - "Org settings" -> `/o/doxaed/settings` -> "Org settings - coming soon".  **DEFECT-B**
  - "Module overrides" -> permissions matrix.
  - "Audit log" card -> coming soon.
  - "Tournaments" (Phase 1B badge) -> `/o/doxaed/tournaments-coming-soon` (slug "tournaments-coming-soon" is awkward; should probably be `/tournaments` with a phase guard).  **DEFECT-S (minor)**
  - "Branding" -> "Branding - coming soon".  **DEFECT-B (same family)**
  - "My profile" -> `/me` works (see below).
  - "Notifications" -> `/me/notifications` -> "Coming in Phase 1B" (expected per spec).
  - "Send feedback" -> opens modal with textarea + Cancel/Send. WORKS.
- `/me` page: shows email, "Email not yet verified" warning despite seed setting `email_verified_at` (**DEFECT-D**). Full-name field is empty and header shows "(no name set)" though Members table shows "Admin User" elsewhere (**DEFECT-E**). Primary nav (Dashboard/Members/Permissions/Audit) is **not rendered** on `/me` - only the Fixture wordmark + org switcher + avatar (**DEFECT-F**).
- User menu: header line shows email twice (title and subtitle both = `admin@doxaed.test`). Should be name in title (**DEFECT-G**, related to DEFECT-E).
- Sign out -> `/login` (works).
- After sign-out the login page now shows the marketing sidebar; before login the same page did NOT render the sidebar - layout race on initial load (**DEFECT-H**).
- Email/password fields are pre-populated with previous user's credentials after sign-out (browser autofill not cleared, but the form state appears to retain them visually) (**DEFECT-I**).

### Role: co_organizer (coorg@doxaed.test)
- [x] Login -> `/o/doxaed/dashboard`
- Nav: Dashboard / Members / Audit (no Permissions in nav - correct visual)
- Cards filtered: no "Module overrides" card on dashboard (correct).
- Members -> works, same data as admin.
- Audit -> coming soon (same as admin).
- **CRITICAL** Direct navigation to `/o/doxaed/permissions` -> **renders the full Module overrides matrix with edit affordances** despite the module not being in nav and despite v1Users.md restricting module-overrides to admin tier. Reset button visible. (**DEFECT-J**)

### Role: game_coordinator (coord@doxaed.test)
- [x] Login -> `/o/doxaed/dashboard`
- Nav: Dashboard / Members / Audit
- Members -> works (read-only expected per spec).
- Direct navigation to `/o/doxaed/permissions` -> **same DEFECT-J - matrix is visible and editable**. game_coordinator should not have Module Override Matrix module by default.
- Audit nav -> coming soon (DEFECT-A).

### Role: match_scorer (scorer@doxaed.test)
- [x] Login -> `/o/doxaed/dashboard` (scorer-specific landing not yet implemented; spec lists this for Phase 1B).
- Nav: Dashboard / Scoring (Phase 1B badge).
- Cards filtered: only Tournaments / My profile / Notifications / Send feedback. No Members or Permissions cards (correct).
- "Scoring" link -> `/o/doxaed/scoring` -> nice "Welcome, Match scorer" landing with Phase 1B preview cards (Live scorebox / Set-piece logger / Substitution tracker / Timeline export). Expected/well-built.
- Direct nav to `/o/doxaed/permissions` -> "Access required" with helpful message. WORKS as expected.
- Direct nav to `/o/doxaed/members` -> "You don't have permission to view this organization's members". WORKS as expected.

### Role: referee (referee@doxaed.test)
- [x] Login -> `/o/doxaed/dashboard`
- Nav: Dashboard / Audit / Referee (Phase 1B badge).
- Cards: Audit log / Tournaments / My profile / Notifications / Send feedback.
- "Referee" -> `/o/doxaed/referee` -> "Welcome, Referee" with Phase 1B preview cards (Lineup confirmation / Match clock control / Card/foul logger / Match-incident reports). WORKS.
- Audit nav -> coming soon (DEFECT-A).
- **DEFECT-M**: Referee role has Audit module by default (visible in nav and as a dashboard card) but CREDENTIALS.md says only admin/co-organizer/game_coordinator should have audit access. Either the seed grants too many roles audit, or the role->module map for Referee is wrong.

### Role: team_manager (manager@doxaed.test)
- [x] Login -> `/o/doxaed/dashboard`
- Nav: Dashboard / Team (Phase 1B badge).
- Cards: Tournaments / My profile / Notifications / Send feedback.
- "Team" -> `/o/doxaed/team` -> "Welcome, Team manager" with Phase 1B preview cards (Roster management / Player registration / Lineup submission / Suspension tracking). WORKS.
- Direct nav to `/o/doxaed/permissions` -> "Access required" - correctly denied.
- **DEFECT-N**: Team-manager nav uses a Trophy icon for "Team" - this looks identical to the Trophy icon used for "Tournaments". Use a People/Shield/Whistle icon to differentiate.

### Role: super-admin (graceschooledu@gmail.com / DoxaEd33@)
- [x] `/sadmin/` -> 302 to `/sadmin/login/?next=/sadmin/` (correct).
- Login at `/sadmin/login/` -> redirects to `/sadmin/` (Dashboard) on success.
- Sidebar nav: Dashboard / Organizations / Users / Feedback / Audit log.
- Dashboard ("Platform overview") shows KPIs: **Total users: 1**, Active 7d: 0, **Active orgs: 0**, Open feedback: 0.
  - **DEFECT-Q (CRITICAL)**: Counters are wrong. The Users page shows 8 users; the Organizations page shows 1 active org (DoxaEd Sports). Either the dashboard query is filtering on `is_superuser=True` or it isn't joining/aggregating properly. KPI snapshot job appears broken.
  - "Recent feedback" / "Recent usage events" lists both empty (consistent with no telemetry fed).
- Organizations -> 1 row (DoxaEd Sports, slug=doxaed, active, 2026-05-02). Click row:
  - Org detail page: members list correctly populated with 6 member rows.
  - **DEFECT-R**: VERBS column only exposes a single "Suspend" button. CREDENTIALS.md mentions "all 13 SA verbs"; the org-level surface should have a fuller verb list (archive, restore, transfer ownership, set quota, etc.) per PRD.
- Users -> 8 rows (7 demo + 1 extra `kikonbankithung@gmail.com`). Each user clickable.
  - User detail page: rich verbs (Suspend / Force-logout / Force password reset / Unlock (clear axes) / Impersonate). Recent audit events listed. WORKS WELL.
- Feedback -> "Feedback inbox", filters render, "No feedback rows." (expected; nothing submitted yet).
- Audit log -> Densely populated (50+ events visible). Filters render. WORKS WELL. Confirms audit pipeline is alive on the backend - the SPA admin's `/o/doxaed/audit` placeholder is purely a missing UI, not missing data.
- Sign out -> redirects to `/sadmin/login/` (works).
- **DEFECT-O**: Sadmin pages load `https://cdn.tailwindcss.com/` for styling. cdn.tailwindcss.com is for prototyping only and warns in console. Should be installed via PostCSS / Tailwind CLI for prod.
- **DEFECT-P**: 404 for `/favicon.ico` on every sadmin page.

---

## Defect summary

### Critical (block merge or release)
| ID | Surface | Issue |
|---|---|---|
| **J** | SPA `/o/doxaed/permissions` | Co-organizer AND game_coordinator can fully access and (apparently) edit the Module Overrides matrix via direct URL. The role does NOT include MODULE_OVERRIDE_MATRIX in v1Users.md but the page renders the matrix with full controls and a Reset button. **Server-side guard is missing.** |
| **Q** | Sadmin `/sadmin/` Dashboard | KPI counters wrong: Total users=1 (should be ~8), Active orgs=0 (should be 1). Suggests broken aggregator or filter scoping `is_superuser=True`. |

### High
| ID | Surface | Issue |
|---|---|---|
| **A** | SPA `/o/doxaed/audit` | "Audit log - coming soon" placeholder despite admin/coorg/game_coordinator/referee role documents listing audit access AND backend audit data being live in sadmin. Need to wire SPA reader. |
| **B** | SPA `/o/doxaed/settings`, `/o/doxaed/branding` | Both render "coming soon" despite CREDENTIALS.md stating admin can edit "Full org settings" and modules ORG_SETTINGS / ORG_BRANDING are mapped to admin in the matrix. |
| **M** | Role-module mapping | Referee role gets ORG_AUDIT_LOG by default (Audit shown in nav and as dashboard card). Verify against v1Users.md Appendix A.2 - if intended, drop the spec's role assignment and update CREDENTIALS.md; if not, remove from default grants. |
| **R** | Sadmin org detail | Only "Suspend" verb exposed; PRD/spec says ~13 SA verbs (archive, restore, transfer-ownership, change-tier, set-quotas, etc.). |

### Medium
| ID | Surface | Issue |
|---|---|---|
| **D** | SPA `/me` | "Email not yet verified" shown for admin@doxaed.test even though seed sets `email_verified_at`. Either reading wrong field, or DB column not populated by seed. |
| **E** | SPA `/me`, user-menu | `(no name set)` shown despite Members table rendering "Admin User". Either `Person.full_name` not joined into the `me` payload, or the field is `display_name` somewhere else and the UI binds to the wrong key. |
| **F** | SPA `/me` | Primary nav bar (Dashboard/Members/Permissions/Audit) is missing on `/me` and `/me/notifications`. User loses context-switch ability and must use the Fixture wordmark or browser back. |
| **G** | SPA user menu | Title and subtitle of the "logged in as" panel both show the email. Title should be name (or fallback). |
| **H** | SPA `/login` | First load of `/login` (when not authenticated) is missing the marketing sidebar; after a logout, the same URL renders the sidebar. Looks like a layout that depends on the auth-bootstrap returning before mounting. |
| **I** | SPA `/login` | After logout, email/password fields show previous user's values. Should clear or be uncontrolled across navigation. |
| **C** | SPA top nav | The active-state highlight on the nav (e.g. "Audit") sticks on the wrong link after navigating to `/settings` or `/branding`. The active item is matched too broadly. |

### Minor / cosmetic
| ID | Surface | Issue |
|---|---|---|
| **N** | SPA team-manager nav | Trophy icon used for "Team" duplicates the Trophy used for "Tournaments". Pick a Whistle/Shield/Users icon. |
| **K** | SPA avatar bubble | Initials derived from email local-part collide for `coorg@` and `coord@` (both render "CO"). Consider falling back to first letters of first/last name once names are available. |
| **S** | SPA dashboard card | Tournaments card links to `/o/doxaed/tournaments-coming-soon` - the URL slug "tournaments-coming-soon" leaks the placeholder state into the URL. Better: `/o/doxaed/tournaments` with a phase guard rendering the placeholder. |
| **O** | Sadmin templates | Loaded from `cdn.tailwindcss.com` - dev-only CDN. Console warns. Replace with built CSS before deploy. |
| **P** | Sadmin pages | `/favicon.ico` 404 on every page. |

## Cross-cutting bugs (seen on multiple roles)
- **DEFECT-A** (audit placeholder) hits **admin / co_organizer / game_coordinator / referee** (every role with audit module).
- **DEFECT-J** (permissions matrix not server-guarded) reproduces with **co_organizer** and **game_coordinator** (and presumably any role with at least MEMBER_DIRECTORY but without MODULE_OVERRIDE_MATRIX). Scorer/team_manager are correctly blocked, suggesting the guard exists for "no member-directory access" users but breaks for the in-between roles.
- **DEFECT-D / E / F / G** all relate to Person/User name + verification fields not surfacing in the SPA `/me` payload. Likely one root cause (missing fields in `GET /api/accounts/me/`).

## Most-broken role (priority for fixes)
**co_organizer** and **game_coordinator** tied: both can view+edit the module override matrix despite no nav entry and no role grant for that module (DEFECT-J). This is a security regression; fix first.

Second priority: super-admin dashboard counters (DEFECT-Q) - the home screen is the first thing the platform owner sees and currently lies to them about platform usage.

Third priority: SPA `/me` payload (DEFECT-D/E/F/G) - cosmetic but affects every authenticated user on every visit.

## Roles tested vs skipped
All 7 SPA roles + 1 sadmin = 8 logins completed. None skipped.

## Console errors (collected across the session)
- Recurring: `Failed to load resource: 403 GET /api/accounts/me/` on `/login` page-load. Pre-login bootstrap call. Could be silenced by short-circuiting `/me` when no session cookie is present.
- Sadmin: `cdn.tailwindcss.com should not be used in production` (warn) + `404 /favicon.ico` (error).
- No JS exceptions or unhandled promise rejections observed in any role.

## Notes on hard constraints
- Read-only interaction: confirmed - no edits made; only navigation, clicks, and a feedback-modal cancel.
- Used Playwright MCP tools throughout (no curl).
- Did NOT fix any defects.
