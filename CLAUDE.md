# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

**Greenfield, pre-implementation.** No source code exists yet. Two canonical specs:

1. **PRD** at `docs/superpowers/specs/2026-04-30-fixture-platform-prd.md` — vision, scope, state machines, schema baseline, 70 logged decisions.
2. **User-types spec** at `docs/superpowers/specs/v1Users.md` — refines and locks the user/account model, RBAC, module catalog, and ~20 additional decisions (#71–#90, to be folded into PRD §14). The user-types spec **supersedes PRD §3.2 (permission matrix), PRD §3.1 (role count), PRD §7.5 (RBAC layering), and parts of PRD §8 (data model)** where the two conflict. PRD remains canonical for state machines (§5.2, §5.5), live-update transport (§7.2), security baseline (§7.7), and phased delivery (§11).

Read both. The implementation plan (next phase) will translate them into ordered milestones via the `superpowers:writing-plans` skill.

## What is being built

A multi-tenant **sports fixture & tournament management platform** focused on Nagaland sports. v1 is a vertical slice for **football only**, designed to prove a chassis that v2+ extends to 9 more sports.

- **Backend:** Django 5.x + DRF + Channels + async views, Postgres 16, Redis 7, Python 3.13.
- **Frontend:** React 18 + TypeScript + Vite, TailwindCSS + shadcn/ui, TanStack Query, Zustand, dnd-kit, react-hook-form + zod, Playwright + vitest.
- **Live transport split:** SSE for public viewers (one-way, viral fan-out); WebSockets for scorer/referee (bidirectional, low volume).
- **Production:** single Ubuntu VPS (4 vCPU / 8 GB / 80 GB) — Postgres + Redis + Django ASGI + nginx + systemd + Caddy TLS + nightly `pg_dump` to S3-compatible storage.
- **Development:** local Windows machine; Docker Compose for Postgres + Redis; Django runs natively for fast reload; Vite dev server at `localhost:5173`.

## Architectural invariants (apply to every file)

These are decisions made up-front in the PRD that affect the shape of the codebase. Do not relitigate them; do not deviate without checking with the user.

1. **UUID v7 primary keys everywhere.** No sequential / auto-increment IDs. Public URLs use `(slug, UUID)` pairs.
2. **Multi-tenancy by `Organization`, day 1.** Every tenant-scoped model has an `organization` FK; default managers filter by accessible orgs; CI tests assert no cross-org leak via any DRF / SSE / WebSocket endpoint.
3. **Idempotent writes.** Every mutation endpoint accepts a client-generated `event_id` (UUID) with a unique DB constraint. Re-submitting returns the existing record (200, not 201). This is non-negotiable for the scorer flow but applies to *all* writes.
4. **DB-first event log.** `MatchEvent` rows in Postgres are the system of record. WebSocket and SSE are delivery only. Every state-changing action publishes to Redis pub/sub *after* the DB transaction commits (`transaction.on_commit`).
5. **Append-only audit at DB level.** `UPDATE` / `DELETE` on `AuditEvent` are denied by Postgres role permissions, not just application code. A migration that tries to mutate audit rows must fail.
6. **State machines, not boolean flags.** Tournament and Match status are explicit enums with audit-logged transitions (see PRD §5.2 and §5.5 for the canonical transition tables — every transition specifies trigger / preconditions / notifications / audit).
7. **Rule freeze at the right boundary.** Tournament structured rules are mutable in `draft` / `published`, frozen at `registration_open` (amend requires reason + 24h grace + notifications). Match rules are *additionally* frozen once the match enters `live_first_half`; no amend retroactively applies.
8. **Person ↔ Player split.** `Person` is the platform-scoped human identity; `Player` is a per-tournament registration referencing a `Person`. This is what makes cross-tournament career stats work without later migrations.
9. **Match dependencies as typed references.** `Match.home_source` and `Match.away_source` are JSONB typed pointers (`winner_of` / `loser_of` / `group_position` / `team` / `tbd`), not inferred from bracket structure. Advancement is a `transaction.on_commit` domain-event hook.
10. **Auto-generate everything; manual edit allowed; conflict warnings.** Every auto-generated artifact (bracket, schedule, prose rulebook, suspensions, etc.) stores `inputs_hash` + `last_manual_edit_at`. UI shows a "regenerate / keep manual / view diff" banner if inputs change after a manual edit.
11. **SSE for one-way, WebSockets for two-way.** Don't use WebSockets for the public viewer or notification bell — those are SSE on `user:<uuid>:notifications` and `match:<uuid>` channels. WebSockets are reserved for the scorer + referee collaborative-scoring rooms.
12. **Permission matrix is the canonical RBAC source of truth — but `v1Users.md §§2-7 + Appendix A` supersedes PRD §3.2 where they conflict.** v1Users.md introduces the **module-based RBAC layer** (Appendix A.2 catalog of 22 modules) and the **per-user override layer** (`MembershipModuleGrant`). The §3.2 row-level matrix governs fine-grained verbs; modules govern surface visibility. Tests parametrize over BOTH (`apps/permissions/tests/test_module_matrix.py` for modules; PRD §3.2 parametrized test for verbs).
13. **i18n + a11y from day 1.** Every user-visible string wrapped in `gettext` / `t()` even though only English ships v1. WCAG 2.1 AA on all non-scorer UIs.
14. **Time zones.** All `DateTimeField`s stored UTC (`USE_TZ = True`). Tournament TZ defaults to Org TZ; admin/scorer screens render in tournament TZ; public screens render in viewer TZ with a tournament-TZ tooltip. TZ change is blocked once tournament is `scheduled`.
15. **Session auth (no JWT) for the SPA on the same origin.** DRF + cookies + CSRF token in custom header.

## Repository layout (planned, not yet built)

```
fixture.doxaed.com/
├── backend/                  # Django project (to be created)
│   ├── manage.py
│   ├── pyproject.toml        # ruff, mypy, pytest config
│   └── apps/
│       ├── accounts/         # User, 2FA, signup/invite, password reset
│       ├── organizations/    # Org, OrgMembership, AdminInvitation, SlugRedirect
│       ├── permissions/      # Module catalog, MembershipModuleGrant, effective_modules() resolver
│       ├── audit/            # AuditEvent + Postgres role enforcement migration
│       ├── sadmin/           # Super-admin custom Django+HTMX console (sadmin.fixture.doxaed.com)
│       │                     # Feedback, UsageEvent, KPISnapshot live here
│       ├── tournaments/      # Tournament + state machine + rule freeze (Phase 1B sport module)
│       ├── teams/            # Person, Team, Player, registration (Phase 1B)
│       ├── fixtures/         # Bracket / schedule generation engine (Phase 1B)
│       ├── matches/          # Match + state machine + MatchEvent + Lineup (Phase 1B)
│       ├── live/             # WebSocket consumers + SSE endpoints + Redis pub/sub
│       ├── notifications/    # Notification + dispatcher + scheduled-notification cron
│       └── disputes/         # Dispute lifecycle + cascade engine (Phase 1B)
├── frontend/                 # React SPA (to be created)
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── api/              # DRF client + TanStack Query hooks
│       ├── features/         # feature-folders (tournament, scoring, viewer, etc.)
│       └── components/ui/    # shadcn/ui primitives
├── docker-compose.dev.yml    # Postgres + Redis for local dev
├── docs/
│   └── superpowers/
│       └── specs/            # PRD + future implementation plan
└── CLAUDE.md
```

When scaffolding, follow this layout unless the implementation plan adopts a different convention.

## Commands

No build / test / run commands exist yet — there is no code. Once scaffolding lands, this section will document:

- `make dev` / `npm run dev:all` — bring up Postgres + Redis (Docker Compose), Django ASGI, Vite all at once.
- Backend test runner (pytest) + how to run a single test.
- Frontend test runner (vitest) + how to run a single test.
- Lint (`ruff`, `eslint`), typecheck (`mypy`, `tsc`), format (`prettier`).
- E2E (Playwright).
- Migrations (`manage.py migrate`) — note: PRD §5 mandates that migrations are blocked while any tournament is in `live` state. Pre-flight check is part of the deploy script.

Until then, when asked to "run tests" or "build," check whether the relevant tooling has been added; if not, surface that explicitly rather than fabricating a command.

## Working with the PRD

- The PRD is **versioned in-document** (currently `Draft v3`). When making meaningful design changes, bump the draft number and update §14 "Decisions log" rather than silently editing.
- Section §13 "Open questions" is the deferred-decision list. When implementation forces one of these decisions, settle it, move it from §13 into §14, and reference the section/file where the decision now lives.
- The PRD's §5.2 and §5.5 transition tables are not optional flavour text — every implemented state transition must match them. New transitions = PRD edit first, code second.

## Workflow conventions

This project uses the `superpowers` skill workflow:

- **Brainstorming → writing-plans → executing-plans.** The PRD came out of `superpowers:brainstorming`. The implementation plan should come out of `superpowers:writing-plans`. Implementation tasks should come out of `superpowers:executing-plans` or `superpowers:subagent-driven-development`.
- **Specs live in `docs/superpowers/specs/` named `YYYY-MM-DD-<topic>-design.md` OR a stable topic name (e.g., `v1Users.md`, `v1Frontend.md`).** Plans live alongside.
- **User-types / RBAC decisions live in `v1Users.md`** as a second canonical-decisions doc. Lock decisions there first; fold stable ones into PRD §14 in batches.
- **Sport-coupled work is Phase 1B**, separate spec (`v1Sport.md` — to be written). User-types phase (Phase 1A) is sport-agnostic and ships independently. PRD §5 (football-specific) becomes part of Phase 1B's source.
- **Tests-first for non-trivial logic.** PRD calls out specific test layers including a "permission matrix" suite (parametrized over PRD §3.2) and a "state machine" suite (every transition + every blocked transition).
- **Multi-tenancy isolation tests are not optional.** Every endpoint must be covered by a test that asserts user A in Org X cannot access org Y data.

## Tooling notes

- The project uses the **`code-review-graph`** MCP tool (configured at the user level). Once code exists, prefer graph queries (`semantic_search_nodes`, `query_graph`, `get_impact_radius`, `detect_changes`) over Grep/Glob for navigation. The graph rebuilds incrementally on file changes via hooks.
- The user is on Windows (PowerShell available, but Git Bash is the default shell for Bash tool calls). Prefer forward slashes and Unix paths in shell commands; use the PowerShell tool when a command genuinely requires PowerShell.
