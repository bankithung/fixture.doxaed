# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

**Built and running** (this line was previously "greenfield" — it is stale). A multi-tenant **sports fixture & tournament management platform** (Nagaland focus; v1 = **football** vertical slice over a sport-agnostic chassis).

- **Phase 1A** (user/account chassis: accounts, organizations, module-RBAC, audit, super-admin console) is production-grade and fully tested.
- **Phase 1B** is substantially built: tournaments + state, teams/players/registration, fixture generation (round-robin / knockout / groups→knockout), matches with an **event-sourced** scoring engine, live WebSocket/SSE delivery, brackets + standings, disputes, lineups, match-incident reports, notifications, and a data-driven **rules & constraints** backend.
- The **frontend** has a complete design system + redesign (see "Frontend design system").

Test status (keep green): **~710 backend** (pytest) + **~274 frontend** (vitest), tsc clean. **Caveat:** 13 `sadmin` tests fail on Python 3.14 — a pre-existing Django/env bug, *not* a regression; the green baseline is **710 passing**. Don't chase them.

**Canonical specs live in `docs/superpowers/specs/`:**
- `2026-04-30-fixture-platform-prd.md` (PRD, Draft v3) — vision, state machines (§5.2/§5.5), schema baseline, decisions log.
- `v1Users.md` — user/account model + module-RBAC; **supersedes PRD §3.2/§3.1/§7.5 and parts of §8** where they conflict.
- `2026-06-06-tournament-rules-constraints-design.md` — the data-driven rules/constraints feature (backend increments 1/2/5 done; generator-default, constraint scheduler, and the Settings UI remain).

## Git workflow — ALWAYS land work on `main` (owner rule, 2026-07-26)

**Finished work belongs on `main`, not on a side branch.** This is a standing owner instruction and it overrides any per-session "develop on branch `claude/…`" default the harness hands you.

- Build on whatever working branch you are given, then **merge it into `main` and push `main`**: `git fetch origin main && git checkout main && git merge --ff-only <branch>` (a real merge commit if `main` has moved on — never force-push `main`).
- Merge *properly*: `main` must be green first (`type-check` + the relevant test suite), and the merge must not drop commits. If `main` moved and the merge conflicts, resolve it — don't reset or force.
- Do **not** leave the deliverable sitting only on a feature branch, and don't open a PR unless the owner asks for one.
- `main` is what deploys (see "Deployment") — pushing there is the point, but it means the pre-flight checks are not optional.

## Commands

> **Interpreter path differs by box.** The commands below show the **Windows** venv (`backend/.venv/Scripts/python.exe`). On the **Linux deploy server** (and any POSIX box) use `backend/.venv/bin/python` instead — same arguments. Check which exists before running.

Backend (venv at `backend/.venv/`; the pytest config lives in `backend/pyproject.toml`, so always pass `-c`):

```bash
# all backend tests
backend/.venv/Scripts/python.exe -m pytest -c backend/pyproject.toml backend/apps -q
# one file / one test
backend/.venv/Scripts/python.exe -m pytest -c backend/pyproject.toml backend/apps/matches/tests/test_lineups.py -q
backend/.venv/Scripts/python.exe -m pytest -c backend/pyproject.toml "backend/apps/matches/tests/test_lineups.py::test_name" -q

backend/.venv/Scripts/python.exe backend/manage.py runserver 127.0.0.1:8000   # ASGI dev server
backend/.venv/Scripts/python.exe backend/manage.py makemigrations <app>
backend/.venv/Scripts/python.exe backend/manage.py migrate
backend/.venv/Scripts/python.exe -m ruff check backend/apps                    # lint
backend/.venv/Scripts/python.exe -m mypy backend/apps                          # typecheck (strict)
```
Settings module is `fixture.settings.dev` (pytest sets it automatically); `prod.py` exists for deploy.

Frontend (run from repo root with `--prefix`):

```bash
npm --prefix frontend run dev          # Vite dev server (prints its URL; falls back off 5173 if taken)
npm --prefix frontend run test         # vitest (all)
npm --prefix frontend run test -- src/features/matches/__tests__/MatchConsolePage.test.tsx   # one file
npm --prefix frontend run type-check   # tsc -b --noEmit
npm --prefix frontend run lint         # eslint
npm --prefix frontend run build        # tsc -b && vite build
npm --prefix frontend run test:e2e     # Playwright
npm --prefix frontend run gen:types    # regenerate src/types from backend/schema.yml (DRF spectacular)
```

After **any** change, run the relevant test suite + `type-check` before committing. Commit per verified increment (the owner lost a long unsaved run once — save frequently).

## Architecture — the big picture (cross-file patterns)

These patterns span many files; understand them before editing the domain layer.

- **Event-sourced scores.** A match score is *derived*, not stored: `apps/matches/services/events.py::record_match_event` appends an immutable `MatchEvent` (gapless `sequence_no` via `select_for_update` + Max+1), then `recompute_score` derives home/away from the non-voided GOAL-type events. Corrections are `VOID` events (append-only), never edits. `transaction.on_commit` publishes to the Redis/channel-layer group `match_<id>` for live fan-out. `apps/matches/services/scoring.py` is the aggregate score path.
- **State machines + advancement.** `apps/matches/services/state.py` (`ALLOWED_TRANSITIONS` + guarded/audited `transition_match`) and the Tournament status enum. On match completion/walkover, `transaction.on_commit` fires `apps/fixtures/services/advance.py::advance_from_match`, which resolves **typed match-dependency pointers** (`Match.home_source`/`away_source` JSONB: `winner_of`/`loser_of`/`group_position`/`team`/`tbd`) to fill the next round.
- **Fixture generation** lives in `apps/fixtures/services/generate.py`: `generate_round_robin` (circle method, grouped), `generate_single_elimination` (power-of-2, winner_of pointers), `generate_knockout_from_groups` (top-N per group, cross-seeded). `GenerateFixturesView` (`apps/fixtures/views.py`) dispatches by `format`.
- **Multi-tenancy scope** is enforced through `apps/tournaments/scope.py::accessible_tournaments` + `apps/tournaments/permissions.py::can_manage_tournament`; every endpoint resolves via these (404 on no-access, no existence leak). Org is a *hidden personal workspace*; users see tournaments, and `TournamentMembership` carries the 6 tournament-scoped roles.
- **RBAC is two layers.** Module visibility (`apps/permissions/` — catalog + `MembershipModuleGrant` overrides + `effective_modules()` resolver) governs *surfaces*; the PRD §3.2 verb matrix governs *fine-grained verbs*. Tests parametrize over both.
- **Data-driven rules/constraints.** `Tournament.rules` + `.constraints` are JSONB interpreted at runtime (FET-style), never hardcoded. `apps/tournaments/services/rules.py` (`DEFAULT_RULES`, `merge_rules`, freeze gate, `update_settings`) + `apps/fixtures/services/constraints.py` (catalog + validation). `compute_standings` reads `rules.points`/`rules.tiebreakers`.
- **Live transport split.** SSE for one-way public viewers + the notification bell (`apps/live/`); WebSockets (`apps/live/consumers.py`, `routing.py`, `fixture/asgi.py` via `ProtocolTypeRouter`/`AuthMiddlewareStack`) only for the scorer/referee rooms.
- **Data-driven registration forms** (`apps/forms/`). A JSONB `schema` (sections → fields, with branching/visibility, repeatable groups, `data_source` live-bound options) is rendered by ONE engine on both sides: `frontend/src/features/forms/fieldRenderers.tsx` + `PublicFormPage.tsx` use the SAME `lib/formLogic` traversal the backend validator uses, so client/server always agree on which fields are reachable/required. Generators (`services/generation.py`) build the institution- and team-registration forms from the tournament's sports/category tree; they tag `settings` (`category_fields*`, `sports_field`, `bindings`, `inputs_hash`) so forms stay regenerable (invariant 10) and the public directory/admin tabs know which questions are competition chains. `services/mapping.py::map_response` turns a submission into domain rows — institution (Stage 1) or teams+players (Stage 2) via `register_school` — and is **idempotent** (early-returns if `mapped_entities` set). The public team form scopes its sport/category questions to the selected school's registered leaves at fetch time (no regeneration).
- **Team-registration access codes** (`apps/teams/services/access.py`). Opening the team form emails each institution's contact an 8-char code (Argon2id hash stored, never plaintext); `/team-access/` exchanges (institution, code) for a signed, expiring `django.core.signing` token under an IP throttle + per-institution lockout. The public submit endpoint requires that token (or a bound per-institution share link, or an authenticated manager) before accepting/editing a protected school's teams; a code-authorized resubmission **supersedes** (soft-deletes + replaces) the prior set. Admins bypass codes entirely. Team names are unique **per competition leaf**, not per tournament.

## Architectural invariants (apply to every file)

Up-front PRD decisions that shape the codebase. Do not relitigate; do not deviate without checking with the user.

1. **UUID v7 PKs everywhere** (`apps.accounts.models.uuid7`). No auto-increment. Public URLs are `(slug, UUID)` pairs.
2. **Multi-tenancy by `Organization`, day 1.** Every tenant-scoped model has an `organization` FK; every endpoint is covered by a cross-org isolation test (user A in org X cannot reach org Y data).
3. **Idempotent writes.** Every mutation endpoint takes a client `event_id` (UUID) with a unique constraint; replay returns the existing record (200, not 201).
4. **DB-first event log.** `MatchEvent` rows are the system of record; WS/SSE are delivery only; publish on `transaction.on_commit`.
5. **Append-only audit at the DB level.** `UPDATE`/`DELETE` on `AuditEvent` denied by Postgres role perms (a mutating migration must fail).
6. **State machines, not booleans.** Tournament + Match status are enums with audit-logged transitions matching PRD §5.2/§5.5.
7. **Rule freeze at the boundary.** Tournament structured rules mutable in `draft`/`published`, frozen at `registration_open` (amend = reason + 24h grace + notify); match rules additionally frozen once a match goes live.
8. **Person ↔ Player split.** `Person` = platform identity; `Player` = per-tournament registration referencing a Person (cross-tournament stats without migrations).
9. **Match dependencies as typed references** (`home_source`/`away_source` JSONB), not inferred from bracket shape; advancement is an `on_commit` hook.
10. **Auto-generate; manual edit allowed; conflict warnings.** Generated artifacts store `inputs_hash` + `last_manual_edit_at`; UI shows regenerate/keep/diff when inputs change after a manual edit.
11. **SSE one-way, WebSockets two-way** (see live transport split above).
12. **Module RBAC + verb matrix are both canonical** (`v1Users.md §§2-7 + Appendix A` supersedes PRD §3.2 on modules). Tests parametrize over both.
13. **i18n + a11y from day 1.** Every user-visible string wrapped in `gettext`/`t()`; WCAG 2.1 AA on non-scorer UIs.
14. **UTC storage** (`USE_TZ = True`); render in tournament TZ (admin/scorer) or viewer TZ (public); TZ change blocked once `scheduled`.
15. **Session auth (no JWT)**, same-origin SPA: DRF + cookies + CSRF token in a custom header.

## Frontend design system (established; match it)

- **Shell:** `features/layout/AppShell.tsx` = fixed left `Sidebar.tsx` + sticky frosted topbar; mobile → hamburger drawer. Pages render inside `<main>` and **fill width** — use `flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8`, **never** `mx-auto max-w-*` centered columns (dead margins). *One sanctioned exception:* the match console is `mx-auto w-full … lg:w-[90%] lg:px-0` (owner 2026-07-26, PRD decision 78) — 90% of the shell with the gutters replacing page padding. Don't "fix" it back to full width.
- **Set-sport console** (`features/matches/console/`): `Scoreboard.tsx` owns the shared instrument-panel primitives — `ConsoleStrip` (the board's own `<h1>` heading + label/value telemetry cells), `ScorePad` (two colour-coded cards + `rule` slot + per-side `footers`), `TargetRule`, `GameHistory` (all periods incl. still-to-play; table → stacked cards via `useBreakpoint`), `ConsoleActionBar`, `ScoreEditor` (grid on a desk, per-period cards on a phone), `SyncBadge`. TT/sepak/generic consoles compose these; the chassis passes `clock`, `back`, `title` + `titleActions` into the module. Home side = `primary`, away side = `info`.
- **One door per job on the console** (owner 2026-07-26): the match context is the board's heading *inside* the panel (never a muted line floating above it); corrections open from **exactly one** control (`Edit scores` on the period history) — there is no second `Adjust …` button and no right-hand state rail, because its readings only duplicated the strip. Every remaining control governs the thing it sits next to (Per-tap under the pads, First serve beside the serve indicator, Amend result in the action bar).
- **Tokens only** (light+dark CSS vars): `bg-card`, `border-border`, `text-muted-foreground`, `bg-primary`/`text-primary-foreground`/`hover:bg-primary-hover`, `bg-accent`, `bg-secondary`, `bg-muted`, `text-destructive`. No hardcoded hex / `emerald-700`.
- **Inter** font globally; `font-tabular` for all numbers.
- **No native dropdowns or alerts.** Use `components/ui/Select.tsx` (custom accessible listbox) instead of `<select>`; use `components/ui/toast` (`useToast`) / `components/ui/dialog` instead of `window.alert/confirm/prompt`.
- **Global screen detector:** `lib/useBreakpoint.ts` (`useSyncExternalStore`-backed) for JS-level responsive decisions; Tailwind responsive utilities otherwise. Tables → stacked cards on mobile via `useBreakpoint().isMobile`.
- Cards/panels: `rounded-xl border border-border bg-card shadow-sm`. State as TanStack Query (server) + Zustand (client). `cn()` is `lib/tailwind`; routes via `lib/routes.ts` helpers.

## Public album (Guest Lens)

`features/lens/PublicAlbumPage.tsx` is ONE view: `InfiniteWall`, an endless wall of photographs that drifts upward on its own and wraps forever (owner 2026-08-13). It replaced `features/lens/universe/` — a CSS-3D sphere of school "planets" (DomeGallery + orbit + `geometry.ts`), deleted in full — because it answered "whose photos are these?" when a visitor asks "show me the photos". A first attempt read "infinite scroll" as lazy pagination; it is not, it is the React Bits **InfiniteScroll** effect, re-cut token-native and **dependency-free** (no GSAP, no `@use-gesture`) exactly as `DomeGallery` and `StarBorder` were.

- **Drift never touches React state.** One rAF loop writes `translate3d` onto each column div; state here would re-render the album 60×/s.
- **The loop is two copies of each column**, wrapping modulo the measured height of copy one. The second copy is `aria-hidden` + `tabIndex={-1}` — scenery, not a second album — so AT and keyboard walk each photo once. Tests assert exactly this (3 real buttons, 6 including hidden).
- **It stops for everyone who needs it to:** `prefers-reduced-motion`, hover, focus-within, an open lightbox, or the Pause button. `data-running` on the wall is the readable truth.
- **A drag is not a click** — pointer drag scrubs; the tile opens only under `DRAG_SLOP` (6px) of travel.
- Category is readable without grouping: chips carry counts and every tile names the category it was filed under. Chips match a photo by its **upload** category *or* its award.

## Tournament scope: between schools vs within one school (2026-08-16)

`Tournament.scope` (`inter_school` | `intra_school`) is set at creation and decides who competes. Spec: `docs/superpowers/specs/2026-08-16-tournament-scope-and-court-categories-design.md`.

- **Stage two has two identities, and the funnel keeps five steps either way.** An intra-school event does NOT skip institution registration — it replaces it with `house_setup`. `_STAGE_STATUS` makes that stage the ONLY producer of the `published` lifecycle status, so skipping it would silently strip `published` from every sports day. `state.py::flow_order(tournament)` is the one list; the stage payload's `order` comes from it, so screen, prompt and server cannot drift.
- **The competitor is a house, but the host school is still a real `Institution` row.** ~40 readers key on `Team.institution` / the `Team.school` text mirror (standings, keep-apart, emails, records, the album), several through `PROTECT`ed FKs. An intra-school tournament auto-creates ONE already-registered institution at creation and the house rides on the existing `Team.group`. Do not "fix" this by nulling the institution — nothing writes null and nothing is ready for it.
- **Houses are season-scoped, not tournament-scoped** (`teams.TeamGroup` + `TournamentHouse`), because a year's events sum into one house table. `TeamGroupMembership` is the first per-competitor scope in the system: before it, a `team_manager` could edit ANY institution's teams.
- **Three things break the moment every team shares one institution**, all fixed and all pinned by tests: Person dedupe matched by name within the institution (two same-named students in different houses became one person); a blank team name defaulted to the institution (every house fought over "<School>" and became "School 2"); and `_separate_institutions` buckets every team together.
- Names are always free text, and the noun follows `Tournament.group_kind` (house / class / form / department) — nothing user-visible hardcodes "house".

## Courts are reserved per COMPETITION, not per sport (2026-08-16)

`Court.competitions` is a list of leaf-key **prefixes**, matched segment-aligned by `sports.leaf_allowed_by`: `table_tennis` = the whole sport (exactly what `Venue.sports` already said), `table_tennis.u14` = both genders, `table_tennis.u14.boys` = one competition. `table_tennis.u1` matches nothing; an empty list takes anything, which is why no existing venue needed migrating.

- It lives on `Court`, not `Venue`, because the case is two courts in ONE hall. `Venue.sports` stays as the coarse filter and a match must pass both.
- **The rule binds at generation**, not only afterwards: `schedule_matches.feasible` AND `optimizer._single_match_ok` gate on it (keep them in lockstep — the optimizer must not undo what the greedy pass respected), plus the `relaxed_venue_type_sports` probe.
- `validate_schedule` now reports `venue_sport_mismatch` and `court_competition_mismatch`. Before this it checked NO resource binding, so every repair verb could hand-move a match past even the sport allow-list.
- **Courts are materialised eagerly** (`services/courts.py::materialise_courts`, called on venue create/update) — they used to appear only when a match first landed on one, so an admin could not address "court 2" before the draw, which is exactly when a reservation must be set. Shrinking `count` retires rows rather than deleting them.
- `readiness._courts_for_leaf` buckets supply per competition once any court is reserved; bucketing by sport alone was blind to the halved supply and would emit an unplayable day.
- `ScheduleConfig.court_competitions` is keyed by the EXPANDED court name ("Hall · T2"); every other `venue_*` map is keyed by the base name.

## Identity is DECLARED, not typed — participants-first (2026-08-17)

`Tournament.roster_mode` (`inline` | `roster_first`) decides how players come into existence. Spec: `docs/superpowers/specs/2026-08-17-participants-first-registration-design.md`.

- **The layer exists because a player's identity used to be a guess.** `register_school` reused a `Person` by `full_name__iexact` within the institution, so one child typed two ways became two people — and the scheduler's "these teams share a player, never overlap them" rule silently stopped protecting them. Under `roster_first` a school declares everyone ONCE (`RosterMember`), and the team form PICKS, so "is this student in two sports?" has an exact answer.
- **A pick that does not resolve is refused, never guessed.** `register_school._resolve_members` scopes every `member_id`/`staff` id to the submitting institution and raises `participant_not_in_roster` for anything else. Falling back to the typed name would restore exactly the guess this removes.
- **`roster_first` inserts ONE stage at slot 2** (`state.py::_order_for`); `flow_order(t)` stays the single list, so stepper, nav rail and server guards cannot drift. Everything is opt-in: an `inline` tournament has the identical funnel, forms and dedupe it always had.
- **A roll of children never reaches the public schema.** Schema resolution happens before anyone proves who they are, so the `roster_students`/`roster_teachers` pickers ship empty and are filled from the `/team-access/` response (already code-verified, already institution-scoped). `COMPETITOR_PURPOSES` puts the participants sheet behind the same submit gate as the team list, and submit+map now share ONE transaction so an unmappable submission leaves nothing behind.
- **The teacher rule is keyed on the teacher** (`TeamStaff`, many per team), not the school — which is exactly why a school that sends two teachers keeps both its courts. It, the shared-player rule and the blunt same-school rule are each their own constraint record, off unless authored.
- Nobody is removed by omission: a re-submitted sheet updates in place (roll number, else name, *within one school*), and withdrawing a fielded participant is refused.
- **The switch MIGRATES, it does not lock** (`services/roster_mode.py`, owner 2026-08-18). Refusing it once teams existed left an organizer who had cloned last year's event with no way in at all — which is precisely who wants the layer. Turning it on declares every already-registered player (idempotent, keyed on (institution, person)) and rebuilds the GENERATED team form so it picks instead of types; a hand-built form is flagged (`team_form_kept`), never overwritten. The one remaining refusal is switching *off* while parked on the roster stage. Nothing is deleted in either direction.

## Operations pages (frontend)

- **`MatchRow`** (`features/controlroom/MatchRow.tsx`) is the shared dense match row: it is a **desktop table row** and overflows below `md`, so any page that lists matches on a phone needs its own card layout (see `MyTasksPage`'s `MyTaskCard`). It takes an optional `badges` slot for caller-owned chips. Finished matches carry `data-done` + a `success-muted` tint.
- **`features/controlroom/format.ts`** owns the list helpers shared by every match list — `tzDate`, `statusBucket`, `leafLabelOf`, `humanizeLeaf`, `fmtDayLabel`, `IN_PLAY`/`FINAL`. Import them; don't re-declare them per page.
- **"Assigned to me" means EITHER seat**: `Match.scorer` (one per match) *or* a `MatchOfficial` row (many per match, one role each). Filtering on `scorer` alone silently hides every official's work — that was the bug `MyTasksPage` was created to fix, and the board's own "My matches" toggle had it too.
- **`MyTasksPage`** (`/tournaments/:id/my-tasks`) is self-scoped, so its nav item is ungated — every member sees it, and it can only ever show their own matches. **Its mobile layout is a native-app shell**, not the desktop one shrunk: horizontal stat chip rail, edge-to-edge cards, removable active-filter chips, and every filter control behind a **sticky bottom bar → bottom drawer** (`Dialog variant="sheet"`, which already brings focus trap + Escape + backdrop dismiss). Desktop keeps the inline filter bar. The controls are authored once and rendered into either surface.
- **`Dialog variant="sheet"`** (`components/ui/dialog.tsx`) is the house bottom-drawer — reach for it before writing a new sheet. Note the panel is not a positioning context, so `absolute` children escape to the overlay (a grab handle must be a normal flex child).

## Working with the PRD & specs

- PRD is **versioned in-document** (Draft v3): on meaningful design changes, bump the draft + update §14 "Decisions log" rather than silently editing. §13 "Open questions" is the deferred list — when implementation forces a decision, move it §13→§14.
- §5.2/§5.5 transition tables are binding: a new state transition = PRD edit first, code second.
- New feature work goes through `superpowers:brainstorming` → `superpowers:writing-plans` → execute; specs are saved to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`.
- **Tests-first for non-trivial logic.** Mandatory suites: the permission matrix (modules + verbs) and the state-machine suite (every transition + every blocked transition). Multi-tenancy isolation tests are not optional.

## Deployment (this is a LIVE app)

The platform runs in production at **fixture.doxaed.com**. Config + scripts live in `deploy/` (`README.md`, `gunicorn.conf.py`, `fixture.service`, `nginx-fixture.conf`; prod creds in `CREDENTIALS-PROD.md`).

- **Topology:** nginx terminates TLS and serves the built SPA from `frontend/dist`; it reverse-proxies `^/(api|sadmin)/` and `/ws/` to the `fixture.service` systemd unit (gunicorn + uvicorn ASGI worker). `index.html` is served `no-cache` (so deploys land immediately); hashed `/assets/` are cached 1y immutable.
- **Deploy a change:** `npm --prefix frontend run build` (updates `dist`) and/or `sudo systemctl restart fixture` for backend code. Verify the served bundle hash changed: `curl -sk https://127.0.0.1/ -H "Host: fixture.doxaed.com" | grep -o 'index-[^"]*\.js'`.
- **Migrations run as the OWNER role**, not the app role (the app role is intentionally non-owner, e.g. it can't alter constraints): `DATABASE_URL="postgres://fixture_owner:<pw>@127.0.0.1:5432/fixturedb" .venv/bin/python manage.py migrate` (owner pw in `CREDENTIALS-PROD.md`). A migrate as `fixture_app` fails with `must be owner of table …`.
- **Prod email is real** (SMTP configured) — `send_mail` actually delivers; dev uses the console backend.

## Dev gotchas (learned, easy to trip on)

- **Restart the backend after backend code changes if you launched it with `--noreload`** (stale process returns 404 for new routes). Plain `runserver` autoreloads.
- **Vite port:** dev server prints its URL; it can fall back off `5173` when that port is occupied by another app — use the printed port, don't assume 5173.
- **Migrations are blocked while any tournament is `live`** (PRD §5) — a deploy pre-flight check. `makemigrations <app>` writes the file; run `migrate` to apply to the dev DB.
- **Windows console is cp1252** — don't print/emit non-ASCII (`→`, `§`) in one-off scripts; write files as UTF-8 explicitly. Git Bash is the default Bash shell; prefer forward-slash paths, use the PowerShell tool only when genuinely needed.
- The **dev DB has seeded demo tournaments** (e.g. "Nagaland Schools Cup", "Knockout Cup") used for browser verification.
- You must `Read` a file in the current context before `Edit`/`Write` (read-state resets across compaction).

## Tooling notes

- **`code-review-graph`** MCP is configured: prefer graph queries (`semantic_search_nodes`, `query_graph`, `get_impact_radius`, `detect_changes`, `get_review_context`) over Grep/Glob for navigation; it rebuilds incrementally via hooks.
- A user-level **`design-taste-frontend`** skill (`.agents/skills/`) and the built-in `frontend-design` skill inform UI work.
