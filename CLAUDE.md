# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

**Built and running** (this line was previously "greenfield" — it is stale). A multi-tenant **sports fixture & tournament management platform** (Nagaland focus; v1 = **football** vertical slice over a sport-agnostic chassis).

- **Phase 1A** (user/account chassis: accounts, organizations, module-RBAC, audit, super-admin console) is production-grade and fully tested.
- **Phase 1B** is substantially built: tournaments + state, teams/players/registration, fixture generation (round-robin / knockout / groups→knockout), matches with an **event-sourced** scoring engine, live WebSocket/SSE delivery, brackets + standings, disputes, lineups, match-incident reports, notifications, and a data-driven **rules & constraints** backend.
- The **frontend** has a complete design system + redesign (see "Frontend design system").

Test status (keep green): **~448 backend** (pytest) + **~193 frontend** (vitest), tsc clean.

**Canonical specs live in `docs/superpowers/specs/`:**
- `2026-04-30-fixture-platform-prd.md` (PRD, Draft v3) — vision, state machines (§5.2/§5.5), schema baseline, decisions log.
- `v1Users.md` — user/account model + module-RBAC; **supersedes PRD §3.2/§3.1/§7.5 and parts of §8** where they conflict.
- `2026-06-06-tournament-rules-constraints-design.md` — the data-driven rules/constraints feature (backend increments 1/2/5 done; generator-default, constraint scheduler, and the Settings UI remain).

## Commands

Backend (Windows venv at `backend/.venv/`; the pytest config lives in `backend/pyproject.toml`, so always pass `-c`):

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

- **Shell:** `features/layout/AppShell.tsx` = fixed left `Sidebar.tsx` + sticky frosted topbar; mobile → hamburger drawer. Pages render inside `<main>` and **fill width** — use `flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8`, **never** `mx-auto max-w-*` centered columns (dead margins).
- **Tokens only** (light+dark CSS vars): `bg-card`, `border-border`, `text-muted-foreground`, `bg-primary`/`text-primary-foreground`/`hover:bg-primary-hover`, `bg-accent`, `bg-secondary`, `bg-muted`, `text-destructive`. No hardcoded hex / `emerald-700`.
- **Inter** font globally; `font-tabular` for all numbers.
- **No native dropdowns or alerts.** Use `components/ui/Select.tsx` (custom accessible listbox) instead of `<select>`; use `components/ui/toast` (`useToast`) / `components/ui/dialog` instead of `window.alert/confirm/prompt`.
- **Global screen detector:** `lib/useBreakpoint.ts` (`useSyncExternalStore`-backed) for JS-level responsive decisions; Tailwind responsive utilities otherwise. Tables → stacked cards on mobile via `useBreakpoint().isMobile`.
- Cards/panels: `rounded-xl border border-border bg-card shadow-sm`. State as TanStack Query (server) + Zustand (client). `cn()` is `lib/tailwind`; routes via `lib/routes.ts` helpers.

## Working with the PRD & specs

- PRD is **versioned in-document** (Draft v3): on meaningful design changes, bump the draft + update §14 "Decisions log" rather than silently editing. §13 "Open questions" is the deferred list — when implementation forces a decision, move it §13→§14.
- §5.2/§5.5 transition tables are binding: a new state transition = PRD edit first, code second.
- New feature work goes through `superpowers:brainstorming` → `superpowers:writing-plans` → execute; specs are saved to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`.
- **Tests-first for non-trivial logic.** Mandatory suites: the permission matrix (modules + verbs) and the state-machine suite (every transition + every blocked transition). Multi-tenancy isolation tests are not optional.

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
