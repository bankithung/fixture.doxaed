# Subsystem analysis — Frontend · tournaments / teams / matches / live

## Purpose

This subsystem is the **operator + public surface of the Phase 1B fixture engine**: the
React/TanStack-Query pages that let an organizer run a tournament end-to-end (create →
invite roster → collect team registrations → generate fixtures → score → view bracket &
standings → audit) plus the two **unauthenticated** public surfaces (school self-registration
via a shared link, and a read-only live match scoreboard). It is a thin presentation layer
over the Django/DRF backend; almost all domain logic (event-sourced scoring, advancement,
standings, rule freeze) lives server-side and is consumed here as REST. The frontend keeps
exactly one notable piece of duplicated domain logic — a client-side standings recompute in
the bracket view (see Smells).

## File-by-file roles

API clients (thin `api.get/post/patch` wrappers over `src/api/client.ts::apiFetch`):
- `src/api/tournaments.ts` — the **fat hub client**. `Tournament`, `TournamentMember`,
  `TeamRow`, `MatchRow`, `MiniTeam`, `StandingRow`, `StandingsGroup` interfaces + the
  `tournamentsApi` object (list/get/create/invite/members/updateMember/audit/teams/matches/
  standings/generateFixtures/createRegistrationLink/score). Note it owns `score()` which
  posts to `/api/matches/{id}/score/` — a *match* endpoint living in the *tournaments* client.
- `src/api/live.ts` — `liveApi`: `snapshot`, `recordEvent`, `exportUrl` (returns a string URL,
  not a fetch), `transition`. Types `LiveSnapshot`, `LiveTeam`, `MiniPlayer`, `LiveEvent`.
- `src/api/registration.ts` — `registrationApi`: `info`, `submit`, `createLink`. Note
  `createLink` **duplicates** `tournamentsApi.createRegistrationLink` (same endpoint).
- There is **no `src/api/matches.ts`** despite it being named in the task brief; match calls
  are split between `tournaments.ts` (`score`) and `live.ts` (events/transition/export).

Pages:
- `features/tournaments/TournamentsListPage.tsx` — post-login hub; cards + inline
  `InviteByEmail` subcomponent (its own `useMutation`, inline notice, 5 invite roles).
- `features/tournaments/CreateTournamentPage.tsx` — react-hook-form + zod single-field form.
- `features/tournaments/TournamentDetailPage.tsx` — the **center of gravity**: KPIs, onboarding
  strip, registration-link minting, fixture generation, an inline `ScoreRow` scoring widget,
  fixtures-by-group, standings tables, and a mounted `DisputesPanel`.
- `features/tournaments/BracketPage.tsx` + `BracketView.tsx` — visual fixture view; `BracketView`
  contains `KnockoutTree` (CSS-absolute connector geometry), `GroupTable`, and a client-side
  `computeStandings`.
- `features/tournaments/TournamentMembersPage.tsx` — roster table/cards, role `Select`, revoke
  dialog, `InvitePanel`. Manager-gated server-side; renders friendly states.
- `features/tournaments/TournamentAuditPage.tsx` — newest-first audit feed; namespace filter;
  403 → "managers only" empty state.
- `features/matches/MatchConsolePage.tsx` — scorer console: scoreboard, state-transition
  buttons, per-side event palette (goal/card/sub/etc.), event log, CSV export link.
- `features/live/LiveViewerPage.tsx` — public fan scoreboard + timeline; own chrome.
- `features/registration/RegistrationFormPage.tsx` + `PublicShell.tsx` — public school
  registration (multi-team, multi-player) with desktop `PlayerTable` / mobile `PlayerCard`.

## Data model (frontend view of the API contract)

- `Tournament`: `{id, slug, name, status, organization_slug, sport_code|null, time_zone, created_at}`.
  `status` is a free string the UI maps via `statusBadge()` (`draft|published|registration_open|
  scheduled|live*|completed|archived`).
- `TournamentMember`: `{id (membership PK — the PATCH target), user_id, email, full_name, role
  (6-role enum), status (active|suspended|revoked), assigned_at}`. `TournamentMemberUpdate` =
  `{role?, status?}` (PATCH).
- `TeamRow`: `{id, name, short_name, school, pool, status, player_count}`.
- `MatchRow`: `{id, stage (group|knockout), group_label, round_no, match_no, status, home_team:
  MiniTeam|null, away_team:MiniTeam|null, home_score|null, away_score|null, scheduled_at|null}`.
- `StandingsGroup`: `{group_label, rows: StandingRow[]}` with `StandingRow` = `{team_id, name,
  school, P,W,D,L,GF,GA,GD,Pts}`.
- `LiveSnapshot`: `{match:{id,status,current_period,home_team:LiveTeam|null,away_team,home_score,
  away_score}, events: LiveEvent[]}`. `LiveTeam` carries `players: MiniPlayer[]` (id, name,
  jersey_no|null, position). `LiveEvent`: `{sequence_no, type, team_id|null, player|null,
  minute|null, period}`.
- Registration payloads (`registration.ts`): `RegSubmission{school_name, teams:RegTeam[],
  event_id?}`, `RegTeam{name, short_name?, players:RegPlayer[]}`, `RegPlayer{full_name,
  jersey_no?, position?, dob_year?, is_goalkeeper?, captain?}`.
- `AuditEvent` is the generated type `components["schemas"]["AuditEvent"]` from `api/audit.ts`;
  the tournament audit response is the **bespoke** `{results: AuditEvent[]}` (no cursor), unlike
  the org audit which is paginated.

## Core algorithms / services (file:function, step-by-step)

- `api/client.ts::apiFetch` — the single transport seam. Sets `Accept: application/json`;
  JSON-serializes plain-object bodies; on unsafe verbs (POST/PUT/PATCH/DELETE) attaches
  `X-CSRFToken` from `lib/csrf.ts::getCsrfToken` (cookie `csrftoken`) unless `skipCsrf`; always
  `credentials:"include"` (Django session). 204 → `undefined`; non-2xx → throws
  `ApiError(status,payload)` (so TanStack treats it as failure); non-JSON 2xx → `undefined`.
- `tournaments.ts::tournamentsApi.get` — **no retrieve endpoint exists**; it fetches the full
  isolation-scoped list and `find()`s by id, returning `null` if absent. O(n) per detail load;
  relies on the list being small.
- `TournamentDetailPage.tsx::TournamentDetailPage` — four parallel queries (`tournament`,
  `t-teams`, `t-matches`, `t-standings`). `grouped` (useMemo) buckets matches by `group_label`.
  Derives `teamCount/matchCount/playerCount`, `hasKnockout/hasGroups`, `anyCompleted`,
  `setupDone`. The onboarding strip is a 3-step state machine: step 2 offers round_robin/knockout
  when `matchCount===0 && teamCount>=2`, then offers `knockout_from_groups` once
  `hasGroups && !hasKnockout`. `createLink` mutation sets a banner URL; `copyLink` uses
  `navigator.clipboard` with toast fallback.
- `TournamentDetailPage.tsx::ScoreRow` — local `home/away` string state; on Save posts
  `tournamentsApi.score(matchId,{home_score:Number,away_score:Number,event_id:newEventId()})`
  then invalidates `t-matches` + `t-standings`. Completed matches render read-only.
- `BracketView.tsx::BracketView` — `bands` (useMemo) groups by `group_label` (fallback
  `"Bracket"`), then by `round_no` into sorted `columns`; `isKnockout = ms.some(stage==="knockout")`.
  Knockout band → `KnockoutTree`; otherwise → `GroupTable`.
- `BracketView.tsx::KnockoutTree` — **pure CSS positioning**, no SVG. Constants `CARD_H=56`,
  `BASE_GAP=28`, `SLOT=84`, `STUB=16`. Per column index `ci`: `gap = 2^ci*SLOT - CARD_H`,
  `firstTop = (2^ci-1)*SLOT/2`; draws horizontal stub + (on even match index) a vertical
  connector of height `gap+CARD_H` plus a join stub. Assumes a **clean power-of-2, fully-seeded
  bracket**; byes / odd counts / non-binary merges will visually misalign.
- `BracketView.tsx::computeStandings` — **re-implements league standings client-side**:
  hardcoded 3/1/0 points, P/W/D/L/GF/GA derived from completed matches, GD computed, sorted by
  `Pts, GD, GF, name`. `GroupTable` marks the top `advance=2` as advancing (▲ + accent row).
- `MatchConsolePage.tsx::MatchConsolePage` — `useQuery(["live",matchId], refetchInterval:5000)`.
  `STATE_ACTIONS` maps status→allowed transitions (scheduled→live; live→half_time/completed;
  half_time→live/completed) — a **client mirror of the backend match state machine**. Event
  palette `EVENT_BUTTONS` fires `liveApi.recordEvent({event_type, side, player_id:sel[side],
  minute, event_id})`; substitution sends `related_player_id`. All mutations `onSuccess: refresh`
  (invalidate the live query). Player `<Select>` options prefix jersey numbers.
- `LiveViewerPage.tsx::LiveViewerPage` — same 5s `useQuery(["live",matchId])`, read-only;
  `statusMeta` maps status→label/badge with a "Full time" alias for completed.
- `RegistrationFormPage.tsx` — local nested `TeamRow[]`/`PlayerRow[]` state with add/remove
  helpers (`setTeam/addTeam/removeTeam/setPlayer/addPlayer/removePlayer`, each keeping ≥1).
  On submit it **trims and filters empties**, coerces `jersey_no`/`dob_year` to numbers only
  when present, attaches `event_id`, and shows a terminal success/invalid state.

## API / endpoint surface consumed

- `GET /api/tournaments/` (list + the synthetic `get`); `POST /api/tournaments/` (create).
- `POST /api/tournaments/{id}/invitations/`; `GET`/`PATCH /api/tournaments/{id}/members/[{membershipId}/]`.
- `GET /api/tournaments/{id}/audit/` (manager-only, non-paginated `{results}`).
- `GET /api/tournaments/{id}/teams|matches|standings/`.
- `POST /api/tournaments/{id}/generate-fixtures/` (body `{group_size, format}`; default
  group_size 5 / round_robin).
- `POST /api/tournaments/{id}/registration-link/`.
- `POST /api/matches/{id}/score/`; `POST /api/matches/{id}/events/`; `POST /api/matches/{id}/transition/`;
  `GET /api/matches/{id}/events/export/` (CSV, plain anchor href).
- `GET /api/live/match/{id}/` (public snapshot, polled).
- `GET`/`POST /api/register/{token}/` (public info + submit).
- Disputes (via `DisputesPanel`): `GET`/`POST /api/tournaments/{id}/disputes/` + resolve/reject/
  withdraw on `/api/disputes/{id}/…`.
- Exported React surface: the nine page components mounted in `App.tsx` (`/tournaments`,
  `/tournaments/new`, `/tournaments/:id[/bracket|/members|/audit|/matches/:matchId]`,
  `/m/:matchId`, `/register/:token`) plus `tournamentsApi`/`liveApi`/`registrationApi` clients
  and reusable `BracketView`/`PublicShell`/`Centered`.

## Invariants that must be preserved

1. **Idempotent writes (invariant 3).** Every mutation sends a client `event_id` via
   `lib/eventId.ts::newEventId` (create, invite, score, recordEvent, registration submit). Tests
   assert `event_id` is truthy. Any rewrite must keep generating one per mutation.
2. **CSRF + session.** All unsafe verbs must carry `X-CSRFToken` and `credentials:"include"`.
   `transition` and `score`/`recordEvent` rely on this; public registration submit is same-origin.
3. **Membership PATCH addresses `member.id` (membership PK), not `user_id`.** `updateMember(id,
   membershipId, body)`. The `last_admin` 400 must surface as a friendly error (asserted in tests).
4. **Score is derived, never sent as ground truth beyond the score endpoint.** The console never
   PATCHes a score field; it appends events and relies on server recompute. The aggregate
   `score()` path (`/score/`) coexists with the event path — both must remain.
5. **State transitions go through the backend.** `STATE_ACTIONS` is only a UI affordance map; the
   real guard is server-side. Tests assert `transition("m1","live")`. Keep the allowed set in
   sync with backend `ALLOWED_TRANSITIONS`.
6. **Public surfaces stay outside the AppShell / auth.** `/m/:matchId` and `/register/:token`
   render their own chrome (`LiveViewerPage`, `PublicShell`) and must not require login.
7. **i18n + a11y.** Every visible string wrapped in `lib/t.ts::t`; inputs carry `aria-label`s;
   tables collapse to cards on `useBreakpoint().isMobile`. Must be preserved per invariant 13.
8. **Stable TanStack query keys.** `["tournament",id]`, `["t-teams|t-matches|t-standings",id]`,
   `["live",matchId]`, `["tournament",id,"members"|"audit"]`. Cross-component invalidation (score
   → matches+standings) depends on these exact keys.

## Dependencies / coupling

Outgoing: `api/client.ts` → `lib/csrf`, `types/api` (ApiError). All pages → TanStack Query,
react-router (`useParams`), `lib/routes`, `lib/t`, `lib/tailwind` (`cn`), design-system primitives
(`Button`, `Input`, `Label`, `Select`, `Dialog`, `toast`, `Avatar`, `RoleBadge.ROLE_KEYS`),
`lib/useBreakpoint`. `TournamentDetailPage` → `features/disputes/DisputesPanel`. `RegistrationFormPage`
→ `PublicShell`. `LiveViewerPage` → `features/theme/ThemeToggle`.

Incoming: `App.tsx` mounts all nine pages and is the only external referencer of the page
components. `routes.ts` is the URL source of truth (e.g. `matchConsole`, `liveViewer`,
`tournamentDetail`). `ROLE_KEYS` from `components/ui/RoleBadge` drives the Members role options.

Backend coupling: the entire DRF surface above; the live snapshot is the **only** live channel
(no WS/SSE client — see smells); CSV export is a same-origin cookie-authenticated GET.

## Tech debt / smells / duplication

- **No live transport client.** CLAUDE.md invariant 11 + the "live transport split" describe
  **SSE for public viewers and WebSockets for scorer rooms**. The frontend implements *neither*:
  both `LiveViewerPage` and `MatchConsolePage` use 5s `refetchInterval` polling of
  `/api/live/match/{id}/`. `grep` finds zero `EventSource`/`new WebSocket` usages. This is the
  single largest divergence and a restructuring focal point.
- **Duplicated standings logic.** `BracketView.tsx::computeStandings` hardcodes 3/1/0 and a fixed
  tiebreak order, ignoring the data-driven `rules.points`/`rules.tiebreakers` the backend
  `compute_standings` honors (invariant 7 / rules engine). The same screen can show different
  standings than `TournamentDetailPage` (which uses server `standings`). The `StandRow` interface
  also duplicates `StandingRow` minus `school`.
- **Duplicated client objects/endpoints.** `registrationApi.createLink` and
  `tournamentsApi.createRegistrationLink` hit the same endpoint with different signatures.
  `statusBadge` is copy-pasted in `TournamentsListPage` and `TournamentDetailPage`; `statusMeta`
  exists in three flavors (members, console, viewer). `computeStandings`-style logic and the
  P/W/D/L column list are repeated.
- **Misplaced API methods.** `tournamentsApi.score` is a match endpoint; match event/transition/
  export live in `live.ts`. There is no cohesive `matchesApi`.
- **`get()` does an O(n) list scan** for every detail page because no retrieve endpoint exists;
  scales poorly and re-fetches the whole list.
- **Design-system violations.** `CreateTournamentPage` uses `mx-auto max-w-xl` and `BracketPage`
  uses `mx-auto max-w-6xl` — explicitly forbidden by the design system ("never `mx-auto max-w-*`
  centered columns"). `BracketView`/`KnockoutTree`/`GroupTable` use raw `border`/`bg-card`
  utilities and a `text-overline`/`text-card-foreground` class not in the documented token set.
- **`BracketView` geometry is brittle**: hardcoded pixel constants tied to card height; assumes
  power-of-2 fully-seeded knockouts; no handling for byes, odd rounds, double-elimination, or
  third-place matches. `advance=2` is hardcoded (ignores group→knockout top-N config).
- **Client state machine drift risk.** `STATE_ACTIONS` and `statusBadge`/`statusMeta` maps must
  be hand-kept in sync with backend enums; new statuses fall through to `replace(/_/g," ")`.
- **Audit page assumes one-shot feed** (`{results}`, `retry:false`, no pager) — diverges from the
  cursor-paginated org audit (`api/audit.ts`), so the two audit UIs can't share a client.
- **Free-string `role`/`status`/`status` typing** (`string`, not unions) across API types pushes
  validation to the UI; mismatches are silent.

## Restructuring seams & risks

- **Seam: a real-time transport module.** Introduce `lib/liveTransport` (EventSource for viewers,
  authenticated WebSocket for the console) behind a hook (`useLiveMatch(matchId)`) that returns the
  same `LiveSnapshot` shape. Both pages already consume `query.data` as `{match,events}`, so a hook
  swap is low-blast-radius; keep polling as a documented fallback. Risk: auth for the WS scorer
  room (session cookie vs. token) and reconciling optimistic event appends with the gapless
  `sequence_no`.
- **Seam: consolidate a `matchesApi`.** Move `score` out of `tournaments.ts` and merge with
  `live.ts` event/transition/export into one client; unify `createRegistrationLink`. Pure
  refactor; tests mock `tournamentsApi.score`/`liveApi.*` so update mocks accordingly.
- **Seam: single standings source.** Delete `BracketView.computeStandings`; have `BracketView`
  accept server `StandingsGroup[]` (already fetched by `TournamentDetailPage`) so the rules engine
  is the only authority. Risk: `BracketPage` currently fetches only matches — it would also need
  standings, or the group band would need a parent-provided prop.
- **Seam: shared status/role presentation.** Extract `statusBadge`/`statusMeta` and the P/W/D/L
  column set into `components/ui` helpers keyed by a typed status union generated from the schema.
- **Seam: bracket renderer.** The connector geometry is isolated in `KnockoutTree`; it can be
  replaced (e.g. data-driven from `home_source`/`away_source` pointers + SVG) without touching
  data fetching. Risk: tests only assert text presence ("Round 1/2", team names), so visual
  regressions are uncaught — add visual/structural tests before reworking.
- **Risk: query-key contract.** Any move/rename must preserve the cross-invalidation keys
  (score → `t-matches`+`t-standings`; console mutations → `live`), or live updates silently break.
- **Risk: idempotency + CSRF.** A transport/client refactor must keep `event_id` generation and
  `X-CSRFToken`/`credentials:"include"`; these are asserted by tests and enforced server-side.
- **Ambiguity flagged:** the task brief names `features/matches/*`, `features/live/*`, and an
  `api/matches.ts`; the live page lives under `features/live` and **no `api/matches.ts` exists** —
  match calls are split across `tournaments.ts` and `live.ts`. The brief's "fixtures generation UI"
  is a few buttons inside `TournamentDetailPage`, not a dedicated page. The "transport client"
  implied by the brief is **absent** (polling only).
