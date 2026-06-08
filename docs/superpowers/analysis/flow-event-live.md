# Flow: Event-sourcing + live delivery

End-to-end trace of how a live match event is recorded (DB-first, gapless,
idempotent), how the cached score is derived, how it is published post-commit to
the channel-layer room `match_<id>`, and how clients render the live state.
File:function citations throughout. This flow is the spine of invariants #3
(idempotency), #4 (DB-first event log), and #11 (SSE one-way / WS two-way).

## Diagram in prose

Scorer console (React) builds a payload + client `event_id` →
`POST /api/matches/{id}/events/` → DRF view authorizes and resolves player/team
→ `record_match_event` opens a transaction, locks the `Match` row, computes the
next `sequence_no`, inserts an immutable `MatchEvent`, calls `recompute_score`
(derive home/away from non-voided events), emits an audit row, and registers a
`transaction.on_commit` hook → **commit** → `publish_match_event` fans out to the
channel-layer group `match_<id>` → `MatchConsumer.match_event` pushes JSON to any
WebSocket client in that room. Separately (and today, *exclusively* on the
client), the React console and the public viewer poll
`GET /api/live/match/{id}/` every 5s via TanStack Query and re-render the
scoreboard + timeline from the snapshot.

## Ordered walkthrough

1. **Client generates an idempotency key.** `MatchConsolePage.tsx`
   (`frontend/src/features/matches/MatchConsolePage.tsx`) fires an event via the
   `ev` mutation, which calls `liveApi.recordEvent` (`frontend/src/api/live.ts`)
   with `event_id: newEventId()` (`frontend/src/lib/eventId.ts`, Web-Crypto
   `randomUUID` with a fallback). This is invariant #3 on the client side: a
   client-minted UUID so a retried POST is a safe replay.

2. **HTTP boundary.** `RecordMatchEventView.post` (`backend/apps/matches/views.py`)
   resolves the match with `_match_or_404` (multi-tenant scope via
   `accessible_tournaments`, 404-not-403 to avoid existence leaks), authorizes
   with `_can_score` (tournament manager / assigned scorer / active
   `MATCH_SCORER`), validates `RecordEventSerializer`, maps `side`→team, and
   resolves/validates `player_id` and `related_player_id` against the match's two
   teams. It then calls `record_match_event(...)`.

3. **Idempotency short-circuit.** `record_match_event`
   (`backend/apps/matches/services/events.py`) first checks
   `MatchEvent.objects.filter(event_id=event_id).first()`; if a row exists it
   returns it unchanged (no second insert, no second publish). Backed by the DB
   `unique=True` on `MatchEvent.event_id` (`backend/apps/matches/models.py`).
   Confirmed by `test_event_idempotent_on_event_id`
   (`backend/apps/matches/tests/test_events.py`): two calls with one `event_id`
   yield one GOAL and score 1.

4. **Gapless sequence under a row lock.** Inside `transaction.atomic()` it does
   `locked = Match.objects.select_for_update().get(pk=...)`, then
   `next_seq = Max(sequence_no)+1` scoped to that match. The `select_for_update`
   serializes concurrent scorers on the *same match*, so two simultaneous goals
   can't both read the same Max and collide. The compound
   `UniqueConstraint(fields=["match","sequence_no"])` (`models.py`,
   `unique_event_seq_per_match`) is the belt-and-suspenders guard. Gaplessness is
   asserted by `test_goal_events_derive_score_and_are_gapless` (sequences
   `[1,2,3]`).

5. **Append the immutable event.** `MatchEvent.objects.create(...)` copies
   `organization_id`/`tournament_id` from the locked match (tenant denormalized
   onto the event), stores `event_type`, `team`, `player`, `related_player`,
   `minute`, `period` (defaults to `locked.current_period`), `detail`, `voids`,
   `event_id`, `created_by`. Corrections never UPDATE: `void_match_event` appends
   a `VOID` event whose `voids` FK points at the original
   (`detail={"voids_seq": ...}`). This is the append-only half of invariant #4.

6. **Derive the score (the "event-sourced" core).** `recompute_score(locked)`
   rebuilds `home_score`/`away_score` from scratch: it collects voided target ids
   (`event_type=VOID` rows with a `voids_id`), then iterates all events,
   skipping voided ones and `VOID` rows themselves; `SCORING_EVENT_TYPES` count
   for the scoring team, `OWN_GOAL` counts for the **opponent**. It writes via
   `Match.objects.filter(pk=...).update(home_score=, away_score=)` and mirrors the
   values onto the in-memory instance. The score is a derived *cache*, never the
   source of truth. `test_void_reverses_score` proves a VOID drops the score back
   to 0; the own-goal direction is covered in the gapless test.

7. **Audit + post-commit registration.** `emit_audit(...)` writes a
   `match_event_recorded` row (append-only audit, invariant #5) carrying
   `idempotency_key=event_id`. Then — critically **inside** the atomic block but
   firing **after** commit — `transaction.on_commit(lambda: publish_match_event(mid, eid))`.
   The lambda closes over plain ids (`eid, mid`), not ORM objects, so it is safe
   to call post-commit.

8. **Post-commit fan-out.** `publish_match_event`
   (`backend/apps/matches/services/events.py`) gets the channel layer
   (`channels.layers.get_channel_layer`) and `async_to_sync(layer.group_send)`s a
   `{"type": "match.event", "data": {"match_id", "event_id"}}` envelope to group
   `match_<id>`. It is wrapped in a bare `try/except` that only logs — **delivery
   failure must never affect the committed write** (invariant #4: WS/SSE are
   delivery, not the system of record). The payload is intentionally *thin* (just
   ids), signalling clients to re-fetch the snapshot rather than trusting the
   pushed body.

9. **WebSocket consumer.** `MatchConsumer` (`backend/apps/live/consumers.py`,
   routed at `ws/match/<uuid:match_id>/` in `routing.py`, mounted via
   `ProtocolTypeRouter`→`AllowedHostsOriginValidator`→`AuthMiddlewareStack`→
   `URLRouter` in `backend/fixture/asgi.py`) joins the group on `connect`,
   discards on `disconnect`, echoes `ping`→`pong`, and `match_event(event)`
   forwards `event["data"]` to the socket. The channel layer is
   `InMemoryChannelLayer` in dev/test (`settings/base.py`) and
   `RedisChannelLayer` in prod (`settings/prod.py`) — so cross-process fan-out
   only works in prod with Redis. `test_ws_match_room_receives_broadcast`
   (`backend/apps/live/tests/test_live.py`) proves a `group_send` reaches a
   connected `WebsocketCommunicator`.

10. **Public snapshot (REST).** `LiveMatchSnapshotView`
    (`backend/apps/live/views.py`, `AllowAny`, mounted `/api/live/match/<id>/`)
    is the read model: it filters non-deleted events, computes `voided_ids`,
    drops VOID + voided events, reverses + slices to the latest 30, and returns
    `{match: {status, current_period, scores, teams}, events: [...]}`. Rosters
    are only included once the match is LIVE/HALF_TIME/COMPLETED
    (`_ROSTER_VISIBLE`), and player names go through `_name` (public-safe display
    name). `test_live_snapshot_is_public_and_shows_score` confirms it is
    unauthenticated and reflects the derived score.

11. **Frontend live render.** Both `LiveViewerPage.tsx` (public, no auth) and
    `MatchConsolePage.tsx` (scorer) use the **same** TanStack Query key
    `["live", matchId]` with `refetchInterval: 5000` against `liveApi.snapshot`.
    The console additionally `invalidateQueries(["live", matchId])` on every
    successful mutation for an immediate optimistic-ish refresh. They render the
    scoreboard from `match.home_score/away_score` and the timeline from `events`.

## State-machine + advancement coupling (adjacent flows on the same rails)

The same `on_commit` discipline drives two siblings: `record_score`
(`backend/apps/matches/services/scoring.py`) and `transition_match`
(`backend/apps/matches/services/state.py`). Both `select_for_update` the match,
guard the transition (`ALLOWED_TRANSITIONS`), audit it, and on a terminal result
(`COMPLETED`/`WALKOVER`) register `transaction.on_commit(_fire_advancement)` →
`apps/fixtures/services/advance.py::advance_from_match` (invariant #9, typed
`home_source`/`away_source` pointers). `transition_match` also sets
`current_period` (`first_half`/`half_time`), which then becomes the default
`period` stamped onto subsequent `MatchEvent`s. Note: status transitions do
**not** currently publish to the `match_<id>` room — only event recording does —
so a "match went live / half-time" change reaches clients only via the 5s poll.

## Subsystems crossed

- **Frontend matches/live** (`features/matches`, `features/live`, `api/live.ts`,
  `lib/eventId.ts`) — scorer console + public viewer + idempotency key.
- **Matches domain** (`apps/matches`: views, serializers, services/events,
  services/scoring, services/state, models) — write path + derived score + state.
- **Live transport** (`apps/live`: consumers, routing, urls, views) + ASGI stack
  (`fixture/asgi.py`) + channel layer (`settings/base.py`/`prod.py`).
- **Audit** (`apps/audit`) — every event/score/transition is audited with the
  idempotency key.
- **Tenancy/RBAC** (`apps/tournaments/scope.py`, `permissions.py`) — 404-scoped
  access + `_can_score`.
- **Fixtures advancement** (`apps/fixtures/services/advance.py`) — the terminal
  on_commit sibling.

## Invariants this flow depends on

- **DB-first (#4):** `MatchEvent` rows are the system of record; score is derived
  by `recompute_score`; publish happens strictly on `transaction.on_commit`.
- **Idempotency (#3):** client `event_id` + unique DB constraint; replay returns
  the existing row, never a duplicate insert or duplicate publish.
- **Gapless sequence:** `select_for_update` + `Max+1` + the
  `(match, sequence_no)` unique constraint.
- **Append-only corrections:** VOID events, never UPDATE/DELETE.
- **Delivery is best-effort:** fan-out exceptions are swallowed and logged.
- **Tenant denormalization:** `organization_id`/`tournament_id` copied onto each
  event from the locked match.

## Failure modes

- **Dev/test fan-out is single-process only.** `InMemoryChannelLayer` does not
  cross processes; with multiple gunicorn/uvicorn workers and no Redis, a goal
  recorded on worker A never reaches a socket on worker B. Prod must have
  `REDIS_URL` set or WS delivery silently degrades.
- **`on_commit` is the only correctness lever.** If `publish_match_event` were
  ever moved out of `on_commit`, clients could be told to fetch a snapshot that
  the transaction later rolls back — phantom scores.
- **The thin-payload contract.** The WS payload carries only ids; a client that
  trusted a pushed body instead of re-fetching could render stale/voided state.
- **`recompute_score` is O(events) per write.** Fine for football, but a long
  match or chatty event types makes every append re-scan the full log.
- **Score-cache divergence risk.** `home_score`/`away_score` are written by both
  `recompute_score` (event path) and `record_score` (final-result path). If a
  late event is appended after `record_score`, the cache can diverge from the
  final recorded result — these two writers are not reconciled.

## Where client and server must stay in sync (flag)

- **The snapshot shape** (`LiveSnapshot` in `api/live.ts` vs `LiveMatchSnapshotView`
  response) — event `type` strings, `status`/`current_period` vocab, and the
  score field nullability are duplicated by hand on both sides.
- **Event-type vocabulary** — `EVENT_BUTTONS` in `MatchConsolePage.tsx` must
  match `MatchEventType`/`SCORING_EVENT_TYPES` on the server (e.g. only `goal`
  and own-goal affect the score; the console sends `goal`).
- **State-machine labels** — `STATE_ACTIONS` in the console must stay within
  `ALLOWED_TRANSITIONS` (`services/state.py`); an illegal `to_status` is a 400.

## Restructuring seams

1. **No live client for the WS/SSE path.** The whole server-side fan-out
   (`publish_match_event` → `MatchConsumer`) currently has **no React consumer**
   — there is no `WebSocket`/`EventSource` anywhere in `frontend/src` (the bell
   also polls, 30s). "SSE viewers" in the spec is aspirational: no
   `text/event-stream`/`StreamingHttpResponse` exists in `apps/live`. Clean seam:
   add a `useMatchLive(matchId)` hook that opens `ws/match/<id>/` (or an SSE
   endpoint) and, on a `match.event` envelope, `invalidateQueries(["live", id])`
   — reusing the existing snapshot read model. Polling becomes the fallback.
2. **Unify the two score writers.** Make `record_score` either forbid post-final
   events or route through the event log so `recompute_score` is the single
   authority; remove the divergence in failure mode above.
3. **Publish all match mutations, not just events.** Move the `on_commit` publish
   into a single helper invoked by `record_match_event`, `transition_match`, and
   `record_score`, so status/score changes also fan out (today only events do).
4. **Push a versioned, typed snapshot delta** instead of an id-only ping, with a
   shared generated type (DRF-spectacular → `gen:types`) to kill the hand-mirrored
   `LiveSnapshot` interface.
5. **Move `recompute_score` to incremental aggregation** (apply/reverse a single
   event delta) to drop the per-write full-log scan, keeping a periodic full
   recompute as a consistency check.
