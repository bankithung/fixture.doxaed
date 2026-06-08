# Deep flow — Event-sourced scoring + live delivery

`record → recompute → on_commit → channel → WS/SSE → client`

This is the spine of invariants **#3** (idempotent writes), **#4** (DB-first event
log; WS/SSE are delivery only; publish on `transaction.on_commit`), **#6** (state
machine), and **#11** (SSE one-way / WS two-way). Every claim below is cited to
`file:symbol` + line range and verified against source on 2026-06-08.

> **Ground-truth correction up front.** The spec/CLAUDE.md describe a richer live
> story than the code implements today. Verified gaps (details in §"Reality vs.
> spec"):
> 1. **No browser WS/SSE client exists.** `grep -rE "WebSocket|EventSource|ws://"`
>    over `frontend/src` returns **zero** non-test hits. Both the scorer console
>    and the public viewer reach live state **exclusively by 5 s REST polling**.
>    The server-side WS fan-out (`publish_match_event` → `MatchConsumer`) has no
>    consumer in the SPA — it is wired, tested, but dark.
> 2. **No SSE endpoint exists.** No `StreamingHttpResponse` / `text/event-stream`
>    anywhere in `apps/live` or `apps/notifications`. The
>    `apps/notifications/models.py:1-3` docstring ("Delivery to the SPA is via SSE
>    on `user:<uuid>:notifications` (apps.live)") is aspirational; the bell polls
>    REST (`frontend/src/api/notifications.ts:20`).
> 3. **Only event recording publishes.** `record_score`
>    (`services/scoring.py:102`) and `transition_match` (`services/state.py:69`)
>    register `on_commit(_fire_advancement)` — **not** `publish_match_event`. So a
>    "match went live / half-time / final whistle" reaches clients only via the
>    poll, never via the WS room.

---

## Sequence diagram

```mermaid
sequenceDiagram
    autonumber
    actor Scorer as Scorer (browser)
    participant Console as MatchConsolePage.tsx
    participant ApiC as api/client.ts apiFetch
    participant View as RecordMatchEventView.post<br/>(matches/views.py)
    participant Svc as record_match_event<br/>(services/events.py)
    participant DB as Postgres (MatchEvent / Match)
    participant Audit as emit_audit (apps/audit)
    participant Pub as publish_match_event<br/>(services/events.py)
    participant Layer as channel layer<br/>(InMemory dev / Redis prod)
    participant WS as MatchConsumer<br/>(live/consumers.py)
    participant Snap as LiveMatchSnapshotView<br/>(live/views.py)
    actor Viewer as Public viewer (browser)

    Note over Scorer,Console: Scorer taps "Goal" while match is LIVE
    Console->>Console: newEventId() (lib/eventId.ts) — client UUID (inv #3)
    Console->>ApiC: liveApi.recordEvent(matchId,{event_type,side,player_id,minute,event_id})
    ApiC->>View: POST /api/matches/{id}/events/ (cookie + X-CSRFToken)

    View->>DB: _match_or_404 — scope via accessible_tournaments (404, no leak)
    View->>DB: _can_score — manager / assigned scorer / active MATCH_SCORER
    View->>View: RecordEventSerializer.is_valid; side→team; resolve+validate player_id/related_player_id
    View->>Svc: record_match_event(match, event_type, team, player, minute, by, event_id, request)

    Svc->>DB: MatchEvent.objects.filter(event_id=...).first()  [idempotency probe — OUTSIDE txn]
    alt event_id already seen
        DB-->>Svc: prior row
        Svc-->>View: return prior (NO insert, NO publish)
    else new event_id
        rect rgb(235,245,255)
        Note over Svc,Audit: transaction.atomic() BEGINS
        Svc->>DB: Match.objects.select_for_update().get(pk) — row lock (serialises scorers)
        Svc->>DB: aggregate Max(sequence_no)+1 — gapless next_seq
        Svc->>DB: MatchEvent.objects.create(...)  (tenant denormalized from locked match)
        Svc->>DB: recompute_score(locked) — derive home/away from non-voided log; Match.update(...)
        Svc->>Audit: emit_audit("match_event_recorded", idempotency_key=event_id)
        Svc->>Svc: transaction.on_commit(lambda: publish_match_event(mid, eid))  [closes over IDs]
        Note over Svc,Audit: COMMIT
        end
        DB-->>Pub: on_commit fires AFTER durable commit (inv #4)
        Pub->>Layer: async_to_sync(group_send)("match_<id>", {type:"match.event", data:{match_id,event_id}})
        Note right of Pub: wrapped in try/except — delivery failure never breaks the write
        Layer-->>WS: MatchConsumer.match_event(event)
        WS-->>Scorer: send_json({match_id,event_id}) (thin ping — IF a socket were open)
    end

    Svc-->>View: MatchEvent
    View->>DB: match.refresh_from_db()
    View-->>ApiC: 201 + MatchSerializer(match) (derived score)
    ApiC-->>Console: mutation success
    Console->>Console: onSuccess → invalidateQueries(["live", matchId])

    Note over Console,Snap: ACTUAL live update today = polling, not the WS push
    loop every 5000ms (refetchInterval) — scorer AND viewer share key ["live", id]
        Console->>Snap: GET /api/live/match/{id}/
        Snap->>DB: events ordered by sequence_no; drop VOID + voided; reverse; [:30]
        Snap-->>Console: {match:{status,current_period,scores,teams}, events:[...]}
        Console->>Console: re-render scoreboard + timeline
    end
    loop every 5000ms (public, AllowAny, no auth)
        Viewer->>Snap: GET /api/live/match/{id}/
        Snap-->>Viewer: same snapshot (rosters only if LIVE/HALF_TIME/COMPLETED)
    end
```

---

## Ordered walkthrough (cited)

### Write path (scorer → DB)

1. **Client mints an idempotency key.** `MatchConsolePage` builds the goal via the
   `ev` mutation (`frontend/src/features/matches/MatchConsolePage.tsx:85-98`):
   `mutationFn` calls `liveApi.recordEvent(matchId, {...p, minute, event_id: newEventId()})`.
   `newEventId()` (`frontend/src/lib/eventId.ts:6-11`) returns `crypto.randomUUID()`
   with a non-crypto fallback. This is invariant **#3** on the client: a retried
   POST carries the same UUID and is a safe replay. `EVENT_BUTTONS`
   (`MatchConsolePage.tsx:28-42`) is the client event vocabulary; only `goal`
   among them scores server-side.

2. **HTTP wrapper.** `liveApi.recordEvent` (`frontend/src/api/live.ts:44-54`) →
   `api.post` → `apiFetch` (`frontend/src/api/client.ts:31-86`). It sends
   `credentials:"include"` (Django session cookie) and, because POST is unsafe,
   attaches `X-CSRFToken` from `getCsrfToken()` (`client.ts:59-62`). This is the
   **session-auth + CSRF-header** contract (invariant **#15**). Non-2xx throws
   `ApiError`, which TanStack Query treats as a failed mutation.

3. **HTTP boundary + authorization.** `RecordMatchEventView.post`
   (`backend/apps/matches/views.py:169-221`):
   - `_match_or_404` (`views.py:58-68`) loads the non-deleted match and 404s if
     `accessible_tournaments(user)` doesn't include `match.tournament_id` —
     **404-not-403** so non-members can't probe existence (invariant **#2**).
   - `_can_score` (`views.py:71-83`) authorizes: tournament manager
     (`can_manage_tournament`), the per-match assigned `match.scorer_id`, or any
     active `TournamentMembershipRole.MATCH_SCORER`.
   - `RecordEventSerializer` (`serializers.py:47-53`) validates `event_type`
     (∈ `MatchEventType.values`), optional `side` (`home`/`away`), `player_id`,
     `related_player_id`, `minute`, `event_id`.
   - `side → team` (`views.py:175-180`); `player_id`/`related_player_id` are
     resolved against `match.tournament`, must be non-deleted, and must belong to
     one of the two teams — else `400` (`views.py:181-208`). If a player is given
     without a side, the player's team is adopted (`views.py:195-196`).
   - Calls `record_match_event(...)` (`views.py:209-219`).

4. **Idempotency short-circuit (outside the transaction).** `record_match_event`
   (`backend/apps/matches/services/events.py:77-128`) first does
   `MatchEvent.objects.filter(event_id=event_id).first()` (`events.py:83-86`); if a
   row exists it returns it **unchanged** — no second insert, no second audit, no
   second `on_commit`/publish. Backed by `MatchEvent.event_id` `unique=True`
   (`backend/apps/matches/models.py:284`). **Idempotency point #1.**

5. **Transaction BEGINS + gapless sequence under a row lock.** `with
   transaction.atomic()` (`events.py:88`) opens the boundary. Inside:
   `locked = Match.objects.select_for_update().get(pk=...)` (`events.py:89`)
   takes a row lock that serializes concurrent scorers on the *same* match;
   `next_seq = Max(sequence_no)+1` scoped to that match (`events.py:90-93`). The
   lock prevents two simultaneous goals from reading the same `Max`. Belt-and-
   suspenders: `UniqueConstraint(fields=["match","sequence_no"])`
   (`models.py:294-298`, `unique_event_seq_per_match`). **Idempotency point #2 /
   concurrency guard.**

6. **Append the immutable event.** `MatchEvent.objects.create(...)`
   (`events.py:94-109`) copies `organization_id`/`tournament_id` from the locked
   match (tenant denormalized onto the event — invariant **#2**), stamps
   `event_type`, `team`, `player`, `related_player`, `minute`,
   `period = period or locked.current_period` (`events.py:104`), `detail`,
   `voids`, `event_id`, `created_by=by`. Corrections never UPDATE: `void_match_event`
   (`events.py:131-142`) appends a `VOID` event whose `voids` FK points at the
   original (`detail={"voids_seq": ...}`). Append-only half of invariant **#4**.

7. **Derive the score (event-sourced core).** `recompute_score(locked)`
   (`events.py:49-74`) rebuilds `home_score`/`away_score` from scratch:
   collect voided target ids (`event_type=VOID` rows with `voids_id`,
   `events.py:51-55`), then iterate **all** events skipping voided ones and `VOID`
   rows (`events.py:60-61`); `SCORING_EVENT_TYPES` (`= {GOAL, PENALTY_SCORED}`,
   `models.py:47-49`) count for the scoring team; `OWN_GOAL` counts for the
   **opponent** (`events.py:67-72`). Writes via
   `Match.objects.filter(pk=...).update(home_score=, away_score=)` and mirrors
   onto the in-memory instance (`events.py:73-74`). The score is a derived
   **cache**, never the source of truth — invariant **#4**. Cost is **O(events)
   per write** (full re-scan).

8. **Audit (append-only) + post-commit registration.** `emit_audit(...)`
   (`events.py:111-125`) writes a `match_event_recorded` row with
   `idempotency_key=event_id` (invariant **#5**, append-only). Then — still
   **inside** the atomic block but scheduled to fire **after** commit —
   `eid, mid = ev.id, locked.id; transaction.on_commit(lambda: publish_match_event(mid, eid))`
   (`events.py:126-127`). **The lambda closes over plain UUIDs, not ORM
   objects**, so it is post-commit-safe (no stale session). This is the *only*
   `on_commit` publish in the whole flow.

9. **COMMIT.** Leaving the `with` block (`events.py:128 return ev`) commits. Only
   now do the on_commit callbacks run. If the transaction had rolled back,
   `publish_match_event` would **never** fire — clients can never be told to fetch
   a snapshot of a write that didn't durably land (invariant **#4**; this is the
   single correctness lever — see §Failure modes).

### Delivery path (DB commit → channel → socket)

10. **Post-commit fan-out.** `publish_match_event(match_id, event_id)`
    (`events.py:27-46`) logs, gets the channel layer
    (`channels.layers.get_channel_layer`), and
    `async_to_sync(layer.group_send)("match_<id>", {"type":"match.event",
    "data":{"match_id","event_id"}})` (`events.py:36-44`). The whole body is in a
    bare `try/except` that **only logs** (`events.py:45-46`) — *delivery failure
    must never affect the committed write*. The payload is intentionally **thin**
    (ids only): a "something changed, re-fetch" signal, not the new state.

11. **Channel layer.** Dev/test: `InMemoryChannelLayer`
    (`backend/fixture/settings/base.py:196-198`). Prod: `RedisChannelLayer` over
    `REDIS_URL` (`backend/fixture/settings/prod.py:51-56`). **Cross-process
    fan-out only works in prod with Redis** — in dev/test with multiple workers a
    goal recorded on worker A never reaches a socket on worker B.

12. **WebSocket consumer.** `MatchConsumer` (`backend/apps/live/consumers.py:9-29`),
    routed `ws/match/<uuid:match_id>/` (`backend/apps/live/routing.py:8`), mounted
    via `ProtocolTypeRouter → AllowedHostsOriginValidator → AuthMiddlewareStack →
    URLRouter` (`backend/fixture/asgi.py:21-28`). `connect` joins group
    `match_<id>` and accepts (`consumers.py:12-16`); `disconnect` discards
    (`consumers.py:18-20`); `receive_json` echoes `ping→pong`
    (`consumers.py:22-25`); `match_event(event)` forwards `event["data"]` to the
    socket (`consumers.py:27-29`). Verified by `test_ws_match_room_receives_broadcast`
    (`backend/apps/live/tests/test_live.py:50-68`): a `group_send` reaches a
    connected `WebsocketCommunicator`. **No browser opens this socket today.**

### Read path (snapshot — the *actual* live update mechanism today)

13. **Public snapshot (REST read model).** `LiveMatchSnapshotView`
    (`backend/apps/live/views.py:47-103`, `permission_classes=[AllowAny]`, mounted
    `/api/live/match/<id>/` via `apps/live/urls.py:9` and
    `fixture/urls.py:74`). It loads the non-deleted match (404 if missing,
    `views.py:50-57`), fetches all events ordered by `sequence_no`, computes
    `voided_ids`, drops `VOID` + voided events, **reverses** and slices to the
    latest **30** (`views.py:61-76`), and returns
    `{match:{id,status,current_period,home_team,away_team,home_score,away_score},
    events:[{sequence_no,type,team_id,player,minute,period}]}` (`views.py:78-102`).
    Rosters are included only when `m.status ∈ {LIVE, HALF_TIME, COMPLETED}`
    (`_ROSTER_VISIBLE`, `views.py:13`, `views.py:59`); names go through `_name`
    (display name, e.g. "M. Kikon", `views.py:16-20`). Verified public +
    score-reflecting by `test_live_snapshot_is_public_and_shows_score`
    (`test_live.py:29-47`).

14. **Frontend live render (polling).** Both consumers use the **same** TanStack
    Query key `["live", matchId]` with `refetchInterval: 5000` against
    `liveApi.snapshot`:
    - Scorer: `MatchConsolePage.tsx:74-79`. On every successful mutation it also
      `invalidateQueries(["live", matchId])` (`MatchConsolePage.tsx:79, 97, 102`)
      for an immediate refresh. Scoreboard from `match.home_score/away_score`
      (`:184-188`); timeline from `events` (`:339-359`); state-machine buttons
      from `STATE_ACTIONS` (`:14-24, 197-211`); CSV export via
      `liveApi.exportUrl` (`api/live.ts:56`, `MatchConsolePage.tsx:327-333`).
    - Public viewer: `LiveViewerPage.tsx:26-32` (no auth, no AppShell). Scoreboard
      `:87-95`, timeline `:108-126`, "Updates automatically every few seconds"
      `:129-131`.

---

## Transaction boundaries & `on_commit` points (explicit)

| Location | Boundary | What runs after commit |
|---|---|---|
| `record_match_event` `services/events.py:88` | `transaction.atomic()` begins (lock, seq, create, recompute, audit) | `events.py:127` `on_commit(publish_match_event(mid, eid))` — **the only WS publish in the system** |
| `record_score` `services/scoring.py:71` | `transaction.atomic()` (guard `scheduled/live→completed`, before-image, save, audit) | `scoring.py:102` `on_commit(_fire_advancement(mid))` — **no WS publish** |
| `transition_match` `services/state.py:41` | `transaction.atomic()` (guard `ALLOWED_TRANSITIONS`, set `current_period`, save, audit) | `state.py:69` `on_commit(_fire_advancement(mid))` only for `COMPLETED`/`WALKOVER` — **no WS publish** |
| `record_match_event` idempotency probe `events.py:83-86` | **outside** any transaction | n/a (returns prior row before opening a txn) |

`_fire_advancement` (`state.py:73-80`) calls
`apps/fixtures/services/advance.py::advance_from_match`, swallowing exceptions so
a post-commit hook never crashes the request. (Adjacent flow — invariant **#9**,
typed `home_source`/`away_source` pointers — not the live-delivery path, but it
shares the `on_commit` discipline.)

`current_period` coupling: `transition_match` sets `current_period="first_half"`
on `→LIVE` and `"half_time"` on `→HALF_TIME` (`state.py:48-52`); that value then
becomes the default `period` stamped onto subsequent events (`events.py:104`).

## Idempotency points (explicit)

1. **Client UUID** — `newEventId()` (`lib/eventId.ts:6-11`) attached to every
   `recordEvent` (`MatchConsolePage.tsx:96`). Invariant **#3** client side.
2. **Event replay probe** — `MatchEvent.objects.filter(event_id=...).first()`
   (`events.py:83-86`), backed by `unique=True` (`models.py:284`). Returns the
   existing row, no duplicate insert/publish. Test:
   `test_event_idempotent_on_event_id` (two calls, one `event_id` → one GOAL,
   score 1 — `backend/apps/matches/tests/test_events.py`).
3. **Gapless sequence** — `select_for_update` + `Max+1` + the `(match,
   sequence_no)` unique constraint (`events.py:89-93`, `models.py:294-298`). Test:
   `test_goal_events_derive_score_and_are_gapless` (sequences `[1,2,3]`).
4. **Score replay (sibling path)** — `record_score` keys on
   `AuditEvent.idempotency_key + event_type="match_scored"`
   (`scoring.py:64-69`), not a unique row on Match.
5. **At-most-once publish** — because the replay probe returns before opening the
   txn, a replayed event never schedules a second `on_commit` publish.

---

## Client ↔ server contracts this flow depends on

| Contract | Client side | Server side | Risk |
|---|---|---|---|
| **Record-event request** | `liveApi.recordEvent` body `{event_type, side?, player_id?, related_player_id?, minute?, event_id}` (`api/live.ts:44-54`) | `RecordEventSerializer` (`serializers.py:47-53`) | Hand-mirrored; `event_id` is **required** on the client (`api/live.ts:52`) but `required=False` server-side. |
| **Transition request** | `liveApi.transition(matchId, to_status)` (`api/live.ts:58-59`); `STATE_ACTIONS` (`MatchConsolePage.tsx:14-24`) | `TransitionSerializer.to_status` validated against `ALLOWED_TRANSITIONS` (`serializers.py:56-58`, `state.py:22-37`) — illegal `to_status` ⇒ 400. | Console must stay within the allowed graph. |
| **Snapshot response shape** | `LiveSnapshot` / `LiveEvent` / `LiveTeam` / `MiniPlayer` interfaces (`api/live.ts:3-37`) | `LiveMatchSnapshotView` response (`views.py:78-102`) | **Hand-duplicated** — score nullability, `status`/`current_period` vocab, event `type` strings all mirrored manually. No `gen:types` coverage here. |
| **Event-type vocabulary** | `EVENT_BUTTONS` (`MatchConsolePage.tsx:28-42`) + free-text render `e.type.replace(/_/g," ")` | `MatchEventType` (`models.py:27-43`); only `SCORING_EVENT_TYPES`+`OWN_GOAL` affect score (`models.py:47-49`, `events.py:62-72`) | Console sends `goal`/`penalty_awarded`/cards/etc.; only `goal` scores (console never sends `penalty_scored`/`own_goal`). |
| **WS envelope** (latent) | *none today* (no `WebSocket` in `frontend/src`) | `MatchConsumer.match_event` forwards `{match_id, event_id}` (`consumers.py:27-29`); `ping→pong` (`consumers.py:22-25`) | The push contract has no consumer. A future client must treat it as a "re-fetch" ping, not state. |
| **Auth/CSRF** | `credentials:"include"` + `X-CSRFToken` on POST (`client.ts:59-69`) | session auth + DRF CSRF; WS via `AuthMiddlewareStack`/`AllowedHostsOriginValidator` (`asgi.py:21-28`) | Invariant **#15**. |
| **Public read** | `liveApi.snapshot` no auth (`api/live.ts:41-42`) | `AllowAny` (`views.py:48`), rosters gated by status (`views.py:13,59`) | Invariant **#11** (SSE/one-way intent; today plain REST GET). |

---

## Reality vs. spec (verified deviations)

- **CLAUDE.md "Live transport split" (SSE for public viewers + bell; WS for
  scorer rooms)** is *not* what the code does. Verified: (a) no `EventSource`/
  `WebSocket` in `frontend/src` (grep, non-test); (b) no `StreamingHttpResponse`/
  `text/event-stream` in `apps/live`/`apps/notifications`; (c) public viewer +
  bell both poll REST (`LiveViewerPage.tsx:28-32`, `api/notifications.ts:20`); (d)
  the only real push transport is the WS `match_<id>` room, which has **no browser
  consumer**.
- **"publish on every match mutation"** is *not* implemented — only
  `record_match_event` publishes (table above). Status changes and final-result
  recording are invisible to the WS room.

## Failure modes (verified)

- **Dev/test fan-out is single-process.** `InMemoryChannelLayer`
  (`settings/base.py:197`) doesn't cross processes; prod needs `REDIS_URL` or WS
  delivery silently degrades (`settings/prod.py:43,51-56`).
- **`on_commit` is the only correctness lever.** Moving `publish_match_event` out
  of `on_commit` (`events.py:127`) would let a client be told to re-fetch a
  snapshot the txn later rolls back — phantom scores. The thin payload limits the
  blast radius (client must re-fetch).
- **Two score writers, unreconciled.** `home_score`/`away_score` are written by
  both `recompute_score` (event path, `events.py:73`) and `record_score`
  (final-result path, `scoring.py:82-85`). A late event appended after
  `record_score` makes `recompute_score` overwrite the recorded final from the
  log; conversely `record_score` can overwrite the derived cache. These two are
  not reconciled.
- **`recompute_score` is O(events) per write** (`events.py:57-72`) — full re-scan
  on every append.
- **Delivery is best-effort** — `publish_match_event` swallows all exceptions
  (`events.py:45-46`); a dead channel layer is invisible to the scorer.

## Restructuring seams

1. **Wire a real live client.** Add `useMatchLive(matchId)` that opens
   `ws/match/<id>/` (or a new SSE endpoint) and, on a `match.event` envelope,
   `invalidateQueries(["live", id])` — reusing the existing snapshot read model
   (`LiveMatchSnapshotView`). Polling becomes the fallback. This is the single
   biggest gap: the entire fan-out is dark.
2. **Unify the two score writers** so `recompute_score` is the sole authority (or
   `record_score` routes through the event log), killing the divergence above.
3. **Publish all match mutations.** Extract one `publish_match(mid)` helper called
   by `record_match_event`, `transition_match`, and `record_score` so
   status/score changes also fan out (today only events do).
4. **Versioned typed snapshot delta** instead of an id-only ping, generated via
   DRF-spectacular `gen:types` to retire the hand-mirrored `LiveSnapshot`.
5. **Incremental aggregation** for `recompute_score` (apply/reverse a single
   event delta) to drop the per-write full-log scan; keep periodic full recompute
   as a consistency check.

## Subsystems crossed

- **Frontend matches/live** — `features/matches/MatchConsolePage.tsx`,
  `features/live/LiveViewerPage.tsx`, `api/live.ts`, `api/client.ts`,
  `lib/eventId.ts`.
- **Matches domain** — `apps/matches/{views,serializers,models}.py`,
  `services/{events,scoring,state}.py`.
- **Live transport** — `apps/live/{consumers,routing,urls,views}.py` + ASGI
  (`fixture/asgi.py`) + channel layer (`settings/base.py`, `settings/prod.py`).
- **Audit** — `apps/audit/services.py::emit_audit` (every event audited with the
  idempotency key).
- **Tenancy/RBAC** — `apps/tournaments/scope.py::accessible_tournaments`,
  `permissions.py::can_manage_tournament`, `_can_score` (`matches/views.py:71`).
- **Fixtures advancement** — `apps/fixtures/services/advance.py::advance_from_match`
  (the terminal `on_commit` sibling, not the live path).
