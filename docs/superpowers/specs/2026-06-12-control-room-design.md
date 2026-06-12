# Control Room — Live-Operations Cockpit + Public Live Updates

**Status:** Design, implementation-ready. Date: 2026-06-12.
**Owner brief (binding):** "a full implemented complete end-to-end with live public fixture updates and match points and role-based access and control — like a real international-level software that handles the complex process completely online."
**Depends on:** `apps.matches` (event-sourced scoring, state machine), `apps.fixtures` (repair seam: reschedule/delay/swap/lock/shift-day, schedule-changes feed), `apps.live` (WS room + public snapshot), `apps.permissions` (module catalog + `effective_tournament_modules`), `apps.tournaments` (scope, stage payload).
**Canonical companions:** `v1Live.md` (SSE/WS/Redis transport design — this spec implements its SSE half, narrowed), PRD §5.2/§5.5, `2026-06-11-fixture-engine-redesign.md` (planning half; the control room is the execution half — memory `control-room-vision`).
**Invariants honored:** #3 idempotent writes, #4 DB-first event log + on-commit publish, #6 state machines, #11 SSE one-way / WS two-way, #12 two-layer RBAC, #13 i18n/a11y, #14 TZ rendering, #15 session auth (no new auth schemes).

---

## 0. One-paragraph summary

After a tournament's schedule is published (stage `ready` ⇒ status `scheduled`), the tournament opens into `/tournaments/:id/control` — a day-by-day, venue-laned live-ops cockpit. Managers run match day from it (call → live → score → complete, plus the existing repair verbs); scorers/referees jump into their consoles; everyone else watches read-only. The same post-commit publish path that already feeds the per-match WS room gains a `tournament_<id>` fan-out, exposed as **one public SSE stream** that pushes "tick" events to BOTH the control room and the public schedule page (which keeps its 60 s poll as fallback). The public schedule grows live points + a mini standings panel. **Almost everything exists** — the build is one tiny Match flag, one aggregate read endpoint, the SSE delivery layer v1Live already designed, two public read extensions, and the frontend.

---

## 1. The control room page — `/tournaments/:id/control`

### 1.1 Layout

- **Day selector** — chips/Select over the distinct match days (tournament TZ, invariant 14); defaults to "today" if today has matches, else the next day with matches.
- **Per-venue lanes** — one column (desktop) / stacked accordion section (mobile) per distinct `Match.venue` string (incl. scheduler sub-venues like "MP Hall · T1"; empty venue ⇒ "Unassigned" lane). Each lane shows a **NOW** slot (the match currently `live`/`half_time`, or the called match) and **NEXT** list ordered by `scheduled_at`. Match tiles: kick-off time (`font-tabular`), teams, state pill (`scheduled → called → live/half_time (live score) → completed/walkover`), pens/sets where present, lock badge, leaf label.
- **Queue rail** — cross-venue "next up" strip: the next N upcoming matches across all venues for the selected day, with delay visibility (tile shows "+25 min" when the slot moved today — derived from the schedule-changes feed) and called state.
- **Changes drawer** — reuses `ScheduleChangesPanel` (existing) for the audit-backed slot-change feed.
- **Inline actions** — per-tile action menu, gated per role (matrix in §4).

### 1.2 Match states shown

PRD §5.5 statuses unchanged: `scheduled, live, half_time, completed, cancelled, postponed, abandoned, walkover` (`apps/matches/models.py::MatchStatus`, transitions in `apps/matches/services/state.py::ALLOWED_TRANSITIONS`). "Called" is a **sub-state annotation of `scheduled`** (§2.b), not a new enum value.

### 1.3 Action → endpoint map (existing vs. missing)

| Action | Endpoint | Exists? |
|---|---|---|
| Day-view aggregate (matches by venue+day) | `GET /api/tournaments/{id}/control-room/?day=` | **MISSING** (§2.a) — composable from `TournamentMatchListView` today, but N+1 on the client |
| Call match to venue / un-call | `POST` / `DELETE /api/matches/{id}/call/` | **MISSING** (§2.b) |
| Start / half-time / resume / complete / abandon / postpone | `POST /api/matches/{id}/transition/` (`TransitionMatchView`, guarded by `transition_match`) | exists |
| Walkover with winner | `POST /api/matches/{id}/transition/` body `{to_status:"walkover", winner_team_id}` (`_stamp_walkover`) | exists |
| Replay an abandoned match | `POST /api/matches/{id}/transition/` `{to_status:"scheduled", reason}` (`_reset_for_replay`, reason required) | exists |
| Record goal/card/sub/etc. | `POST /api/matches/{id}/events/` (`RecordMatchEventView` → `record_match_event`) | exists |
| Void/correct an event | same endpoint, `event_type:"void"` via `void_match_event` | exists |
| Aggregate score / set scores | `POST /api/matches/{id}/score/` (`RecordScoreView`) | exists |
| Penalty shootout | `POST /api/matches/{id}/shootout/` (`RecordShootoutView`, self-heals stalled brackets) | exists |
| Assign scorer | `POST /api/matches/{id}/scorer/` (`AssignScorerView`) | exists |
| Delay + cascade | `POST /api/matches/{id}/delay/` (`MatchDelayView`, 409 + violations unless `force`) | exists |
| Manual move (reslot) | `PATCH /api/matches/{id}/schedule/` (`MatchScheduleView`) | exists |
| Swap two slots | `POST /api/tournaments/{id}/fixtures/swap-slots/` (`SwapFixtureSlotsView`) | exists |
| Lock / unlock slot | `POST` / `DELETE /api/matches/{id}/lock/` (`MatchLockView`) | exists |
| Rain-day shift | `POST /api/tournaments/{id}/fixtures/shift-day/` (`ShiftFixturesDayView`) | exists |
| Slot-change feed | `GET /api/tournaments/{id}/schedule-changes/?since=` (`TournamentScheduleChangesView`, any member) | exists |
| Standings | `GET /api/tournaments/{id}/standings/` (`TournamentStandingsView`) | exists |
| Lineups view/confirm | `GET/POST /api/matches/{id}/lineups/`, `/lineups/confirm/` | exists |
| Incidents | `POST /api/matches/{id}/incidents/` | exists |
| Event timeline CSV | `GET /api/matches/{id}/events/export/` | exists |
| Open scorer console | FE route `routes.matchConsole(tid, mid)` → `MatchConsolePage` | exists |
| Live snapshot (console/public viewer) | `GET /api/live/match/{id}/` (`LiveMatchSnapshotView`, AllowAny) | exists |
| Public schedule | `GET /api/public/tournaments/{slug}/{id}/schedule/` (`PublicTournamentScheduleView`) | exists (extend, §2.d) |
| Per-team iCal | `GET /api/public/teams/{team_id}/calendar.ics?token=` (`PublicTeamCalendarView`) | exists |
| Push updates (SSE) | `GET /api/public/tournaments/{slug}/{id}/stream/` | **MISSING** (§2.c) |
| Public standings | `GET /api/public/tournaments/{slug}/{id}/standings/` | **MISSING** (§2.d) |

All mutations above already take a client `event_id` (invariant 3) and emit audit rows; replays answer from the audit log. Nothing about that changes.

---

## 2. Missing backend (kept minimal)

### 2.a Control-room day-view aggregate

`GET /api/tournaments/{id}/control-room/?day=YYYY-MM-DD` — new view in `backend/apps/fixtures/views.py` (it is an *execution-surface read over the schedule*, peer of `TournamentScheduleChangesView`), routed in `backend/apps/tournaments/urls.py`.

- **Gate:** `IsAuthenticated` + `accessible_tournaments(request.user).filter(id=...).exists()` → 404 idiom (no existence leak). Any active member may read; writes stay gated per action (§4).
- **One query:** `Match.objects.filter(tournament=t, deleted_at__isnull=True).select_related("home_team","away_team","tournament","scorer")`, grouped in Python by tournament-TZ day then venue.
- **Payload:**
  ```json
  {
    "tournament": {"id","name","slug","status","time_zone"},
    "days": [{"date":"2026-06-14","counts":{"total":12,"completed":4,"live":1}}],
    "day": "2026-06-14",
    "venues": [{"venue":"Kohima Ground · P1",
                "matches":[ MatchSerializer row + {"called_at","leaf_label","scorer":{"id","name"}|null} ]}],
    "queue": [<next 10 not-finished match rows for the day, cross-venue, scheduled_at asc>]
  }
  ```
  Reuses `MatchSerializer` (already carries `status, home/away_score, home/away_pens, set_scores, scoring, locked_at, current_period, venue, leaf_key`) + `leaf_label` via `apps.tournaments.services.sports.leaf_label`. Delay visibility stays client-side from `schedule-changes` (no duplication).

### 2.b "Called" sub-state — decision

**Decision: a tiny nullable `Match.called_at` timestamp, NOT a new status and NOT `current_period` reuse.**

- A new `MatchStatus.CALLED` would ripple through `ALLOWED_TRANSITIONS`, the repair seam's movability checks (`repair._movable_statuses`), standings filters, advancement, every status pill, and PRD §5.5 — disproportionate for an operational flag.
- Reusing `current_period="called"` collides with `transition_match` (it only stamps `first_half` when `current_period` is falsy) — a silent bug seam.
- `called_at` is presentation-only operational metadata: UI renders "Called" when `status=="scheduled" && called_at != null`. The state machine is untouched (invariant 6 intact: this is not a lifecycle state, and PRD gets a §5.5 *note* + decisions-log entry saying exactly that).

Endpoint: `POST` / `DELETE /api/matches/{id}/call/` in `backend/apps/matches/views.py` + `urls.py` (mirrors `MatchLockView`: idempotent no-op repeat, audit `match_called` / `match_call_cleared`, gate `tournament.schedule_editor` via `can_access_module`). Only legal while `status=="scheduled"`; 409 otherwise. Publishes a `called` tick (§2.c).

### 2.c Tournament-wide SSE topic + stream (the only new transport)

Today the only delivery is the per-match WS room (`match_<id>` group, published in `apps/matches/services/events.py::publish_match_event` via `transaction.on_commit`); the v1Live SSE layer was designed but **never built** (the bell's `_publish` is a logger stub; no `text/event-stream` anywhere). We build the narrow slice the control room + public page need:

1. **Publish helper** — new `backend/apps/live/publish.py::publish_tournament_tick(tournament_id, match_id, kind)`; `kind ∈ {"state","score","event","schedule","called"}`. Thin tick, **no payload data beyond ids** (clients refetch — same contract the WS room already uses: "the client refetches the snapshot either way"). Fan-out = `channel_layer.group_send(f"tournament_{tournament_id}", {"type":"tournament.tick","data":{...}})`, best-effort, post-commit only.
2. **Call sites** (all already have an on-commit seam):
   - `apps/matches/services/events.py::publish_match_event` — extend to dual fan-out (`match_<id>` + `tournament_<id>`); covers `record_match_event` and set-scoring (which calls `publish_match_event(mid, None)`).
   - `apps/matches/services/state.py::transition_match` — add `on_commit` tick (`state`). **Gap today: transitions never publish; the console polls at 5 s.**
   - `apps/matches/services/scoring.py::record_score` — add tick (`score`; currently publishes nothing).
   - `RecordShootoutView` — tick (`score`).
   - Repair verbs (`apps/fixtures/services/repair.py` reschedule/delay/swap/shift + `MatchLockView`) — tick (`schedule`) per affected match (cap: one batch tick with `match_id=null` for cascades > 10).
   - Call endpoint (§2.b) — tick (`called`).
3. **SSE view** — new `backend/apps/live/sse.py`: an **async Django view** (`StreamingHttpResponse`, `content_type="text/event-stream"`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`), mounted at `GET /api/public/tournaments/{slug}/{id}/stream/` (root `fixture/urls.py`, beside the public schedule). AllowAny; resolves the (slug, UUID) pair and answers **only** for the public statuses (`registration_open/scheduled/live/completed`) — identical gating to `PublicTournamentScheduleView`. Subscribes via `channel_layer.new_channel()` + `group_add("tournament_<id>")`, loops `await layer.receive(...)` with a 25 s timeout emitting `: keep-alive\n\n` heartbeats; emits `event: tick` frames. SSE stays strictly one-way (invariant 11); the WS surface is untouched.
   - **Deviation from v1Live §2 [MED]:** v1Live proposed raw Redis pub/sub for SSE views. We subscribe to the **channel layer** instead — one publish path, works in dev (InMemory layer, single process) and prod (`channels_redis`, multi-worker gunicorn) without a second Redis client. Topic naming follows the existing `match_<id>` convention (`tournament_<id>`), not v1Live's `match:<uuid>` — consistency with shipped code wins.
   - **Auth note:** the stream is public by design (ticks carry only UUIDs — no PII). The control room consumes the *same* stream; member-only data flows through the authed aggregate refetch. No new auth scheme (invariant 15).
   - **Deploy note:** `deploy/nginx-fixture.conf` needs `proxy_buffering off;` (or relies on `X-Accel-Buffering: no`) + a long `proxy_read_timeout` for this path.

### 2.d Public live extensions (read-only, no PII)

- **Extend** `PublicTournamentScheduleView` match rows with `home_pens, away_pens, sport, set_scores, current_period` (live points for set sports + shootout results; team/school names only — same PII posture as today).
- **New** `GET /api/public/tournaments/{slug}/{id}/standings/` — same view file, same slug+status gating; body = `TournamentStandingsView`'s `{groups:[{group_label, rows}]}` reusing `apps/matches/services/standings.py::compute_standings` verbatim (rows are team aggregates — public-safe).

### 2.e Verb tightening (small, flagged for owner — §6)

- `_can_score` (`apps/matches/views.py`) ignores the **referee** role today: extend the transition/void paths to also accept an active `referee` membership or the `match.referee_console` module (catalog says referees do "real-time event review, correction, post-match approval").
- `walkover` and `abandoned→scheduled` (replay) are currently reachable by any scorer via `TransitionMatchView`; per the brief these become **manager-only** (`can_manage_tournament`) — a two-line guard in the view keyed on `to_status`.

---

## 3. Frontend

### 3.1 Control room (new `frontend/src/features/control/`)

| File | Responsibility |
|---|---|
| `ControlRoomPage.tsx` | Route shell: day selector (`components/ui/Select` on mobile, chip row on desktop), TanStack query on the aggregate, SSE subscription → `invalidateQueries`; full-width per design system (`flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8`, **no** `mx-auto max-w-*` — registered as a sibling of `TournamentWorkspace` in `App.tsx`, like `MatchConsolePage`, to escape the workspace's `max-w-5xl` wrapper) |
| `VenueLane.tsx` | One venue's NOW/NEXT lane; card = `rounded-xl border border-border bg-card shadow-sm` |
| `MatchTile.tsx` | Time, teams, state pill (reuse `MatchConsolePage`'s `statusMeta` token mapping + live-pulse dot), `font-tabular` score, lock/called badges |
| `MatchActionsMenu.tsx` | Role-gated action menu: wraps the existing `features/fixtures/MatchRepairControls.tsx::MatchRepairMenu` (move/delay/swap/lock — incl. 409-violations + force flow via `RepairViolationsList`/`ConflictsBlock`) and adds Call, Open console (link), Walkover (dialog w/ winner pick), Shootout, Replay (reason dialog), Assign scorer |
| `QueueRail.tsx` | Cross-venue next-up strip; delay chips from `tournamentsApi.scheduleChanges` |
| `useControlRoom.ts` | Query + tick-driven invalidation (debounced 500 ms; also invalidates `["public-schedule"]`-equivalent keys via `invalidateTournament`) |
| `frontend/src/lib/useEventStream.ts` | Shared `EventSource` hook: connect, parse `tick`, auto-reconnect (browser-native + capped backoff), `degraded` flag when erroring |

Conventions: tokens only, Inter + `font-tabular` numbers, `useToast`/`dialog` (no native alerts), every string through `t()`, WCAG AA (this is an admin/ops UI but it ships AA anyway — it's not a scorer-speed surface). **Mobile** (`lib/useBreakpoint.ts::useBreakpoint().isMobile`): lanes stack as accordion sections (current venue open), queue rail becomes a horizontal scroll strip under the day selector, action menus become bottom-sheet dialogs.

API: extend `frontend/src/api/tournaments.ts` with `controlRoom(id, day?)`, `publicStandings(slug, id)`; extend `api/live.ts` with `callMatch`/`uncallMatch` + `streamUrl(slug, id)`. Routes: add `routes.tournamentControl(id)` → `/tournaments/:id/control` in `frontend/src/lib/routes.ts`.

### 3.2 Nav + handoff

- **`features/layout/computeNavItems.ts::computeTournamentNav`** — new item `{key:"control", label:t("Control room"), icon:Radio, href:routes.tournamentControl(id), ...gate("ready")}`, wrapped in `allowed("match.center_admin_view")` (all six roles by default ⇒ visible to every member post-publish; per-member module revocation hides it).
- **Publish → control room handoff:** `features/fixtures/DryRunPreviewPage.tsx` `accept.onSuccess` currently toasts + navigates to the fixtures hub. Change: when the stage payload says `ready` (or the accept response covers the last leaf), navigate to the control room and toast "Schedule published — you're in the control room"; otherwise keep today's behavior. Belt-and-braces: `FixtureSetupHub.tsx` shows a primary "Open control room" CTA in its header once `stage === "ready"` and matches exist.

### 3.3 PublicSchedulePage upgrade (`frontend/src/features/fixtures/PublicSchedulePage.tsx`)

- Subscribe `useEventStream(streamUrl)`; on any tick, invalidate `["public-schedule", slug, id]` (debounced). **Keep `refetchInterval: 60_000` unconditionally** — it *is* the graceful fallback (SSE down ⇒ behavior is exactly today's). When the stream is healthy, the header line upgrades from "updates automatically" to a live indicator.
- Live match points: `MatchCard` already renders score for live/final; add pens (`(4–3 pens)`) and set scores for set sports from the §2.d fields.
- Mini standings: collapsible "Standings" section (per group, top rows, `font-tabular`) fetching the public standings endpoint; refetches on `score`/`state` ticks. Mobile-first, `print:hidden` (the print sheet stays an order-of-play).
- `MatchConsolePage` keeps its 5 s poll (already near-real-time; WS room upgrade is out of scope here).

---

## 4. Role matrix (6 roles × control-room actions)

Roles = `TournamentMembershipRole`: `admin, co_organizer, game_coordinator, match_scorer, referee, team_manager`. Module codes are exact strings from `backend/apps/permissions/fixtures/modules.json`; resolution is `apps/tournaments/permissions.py::can_access_module` (manager escape-hatch → `effective_tournament_modules` = role defaults ± `TournamentModuleGrant`). Org-workspace admins count as managers (`can_manage_tournament`).

| Action | Gate (code) | admin | co_org | game_coord | match_scorer | referee | team_mgr | public |
|---|---|---|---|---|---|---|---|---|
| View control room (read-only) | member of tournament (404 idiom); nav shown via `match.center_admin_view` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | — |
| Call / un-call match | `tournament.schedule_editor` | ✔ | ✔ | ✔ | — | — | — | — |
| Delay + cascade | `tournament.schedule_editor` | ✔ | ✔ | ✔ | — | — | — | — |
| Move (reslot) | `tournament.schedule_editor` | ✔ | ✔ | ✔ | — | — | — | — |
| Swap slots | `tournament.schedule_editor` | ✔ | ✔ | ✔ | — | — | — | — |
| Lock / unlock | `tournament.schedule_editor` | ✔ | ✔ | ✔ | — | — | — | — |
| Shift day (rain day) | `tournament.schedule_editor` | ✔ | ✔ | ✔ | — | — | — | — |
| Start / HT / resume / complete | `_can_score`: manager ∨ assigned `Match.scorer` ∨ `match_scorer` role ∨ `match.scoring_console`; +referee per §2.e | ✔ | ✔ | ✔ | ✔ | ✔* | — | — |
| Record events / score | same scoring gate | ✔ | ✔ | ✔ | ✔ | — | — | — |
| Void / correct event | scoring gate; +`match.referee_console` per §2.e | ✔ | ✔ | ✔ | ✔ | ✔* | — | — |
| Shootout | scoring gate | ✔ | ✔ | ✔ | ✔ | — | — | — |
| Walkover w/ winner | `can_manage_tournament` (tightened §2.e) | ✔ | ✔ | — | — | — | — | — |
| Replay (abandoned→scheduled, reason) | `can_manage_tournament` (tightened §2.e) | ✔ | ✔ | — | — | — | — | — |
| Assign scorer | `can_manage_tournament` | ✔ | ✔ | — | — | — | — | — |
| Schedule-changes feed | any member | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | — |
| Open scorer console ("their" matches) | `match.scoring_console` defaults: admin/co_org/game_coord/match_scorer; assigned scorer always | ✔ | ✔ | ✔ | ✔ | view | view | — |
| Public schedule / standings / SSE stream / iCal / `/m/` viewer | AllowAny (no PII) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |

\* = after the §2.e referee extension; today referees are read-only. "their matches" = assigned via `Match.scorer` or role-allowed across the tournament (current `_can_score` semantics — unchanged). The FE menu gates on the stage payload's `modules` + `can_manage` (`build_stage_payload` already ships both); the backend remains the enforcement point.

---

## 5. Build order — 8 TDD increments (backend first, each shippable)

Tests-first per CLAUDE.md: permission-matrix and state-machine suites are mandatory; cross-org isolation tests on every new endpoint. Keep ~710 backend (1055 - 13 sadmin/Py3.14) + ~374 frontend green; `tsc` clean.

1. **`called` flag** — `Match.called_at` (+migration, blocked-while-live preflight applies); `POST/DELETE /api/matches/{id}/call/`; audit `match_called`/`match_call_cleared`; idempotent; 409 unless `scheduled`. PRD §5.5 note + §14 decisions-log entry. Files: `backend/apps/matches/{models,views,urls,serializers}.py`, `backend/apps/matches/tests/test_call.py`.
2. **Aggregate read** — `GET /api/tournaments/{id}/control-room/?day=`; member-gated, one query, venue/day grouping, queue. Files: `backend/apps/fixtures/views.py` (`ControlRoomDayView`), `backend/apps/tournaments/urls.py`, `backend/apps/fixtures/tests/test_control_room.py` (incl. org-isolation + member-visibility parametrization).
3. **Tournament tick fan-out + public SSE** — `backend/apps/live/publish.py`; dual fan-out in `publish_match_event`; on-commit ticks in `transition_match`, `record_score`, shootout, repair verbs, lock, call; `backend/apps/live/sse.py` async stream view + root URL; heartbeats; public-status gating. Tests: channel-layer capture on each mutation; async streaming test. Files also: `backend/fixture/urls.py`, `deploy/nginx-fixture.conf` note.
4. **Public live data** — extend `PublicTournamentScheduleView` (pens/sport/set_scores/current_period) + new `PublicTournamentStandingsView` reusing `compute_standings`. Files: `backend/apps/fixtures/views.py`, `backend/fixture/urls.py`, tests beside the existing public-schedule suite.
5. **Verb tightening** — referee transitions/voids; walkover + replay manager-only (`TransitionMatchView`). Parametrized permission-matrix tests over all 6 roles × {transition kinds, events, shootout, call, repair}. Files: `backend/apps/matches/views.py`, tests.
6. **Control room FE** — `features/control/*` (§3.1), `routes.tournamentControl`, `App.tsx` route, nav item in `computeNavItems.ts`, `api/tournaments.ts`/`api/live.ts` additions, `lib/useEventStream.ts`. Vitest: page render states, role-gated menus (stage-payload fixtures), day grouping, queue, SSE-tick invalidation (mock EventSource). Reuse `MatchRepairMenu`, `ShiftDayDialog`, `ScheduleChangesPanel`.
7. **Public page upgrade + handoff** — `PublicSchedulePage` SSE + pens/sets + mini standings; `DryRunPreviewPage` / `FixtureSetupHub` "Open control room" CTA. Vitest: fallback-to-poll when stream errors, standings panel, CTA gating on stage `ready`.
8. **End-to-end + docs** — Playwright: publish → control room → call → start → goal → complete → public page reflects via SSE (and via poll with SSE disabled); regenerate `schema.yml` + `npm run gen:types`; PRD decisions log; deploy checklist (nginx SSE, `systemctl restart fixture`).

Cut lines: 1–5 ship a fully usable backend; 6 ships the cockpit on polling alone if 3 slips (the aggregate works without SSE); 7–8 polish. No new auth, no new models beyond one nullable column, no WS changes (invariant 11 preserved).

---

## 6. Owner decisions needed

1. **Walkover/replay manager-only** (§2.e): brief implies yes; today any scorer can. Confirm tightening (affects live tournaments' scorers).
2. **Shootout stays scorer-recordable?** Brief lists it under admin/co-organizer; the venue reality is the scorer records it. Spec keeps the existing scorer gate — confirm.
3. **Referee write access** (§2.e): granting referees state transitions + event voids matches the module catalog's promise but widens current behavior — confirm.
4. **Public SSE topic is unauthenticated** (ticks = UUIDs only, schedule data already public). Confirm comfort, or we add a signed-token variant later.
5. **`called_at` survives into live** (kept as historical timestamp, UI ignores it post-kickoff) — confirm no separate "un-call on start" requirement.
