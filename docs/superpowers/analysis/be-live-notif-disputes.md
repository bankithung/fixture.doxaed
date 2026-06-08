# Subsystem analysis: Backend · live + notifications + disputes

> Scope: `backend/apps/live`, `backend/apps/notifications`, `backend/apps/disputes`, plus the
> coupling points in `backend/fixture/asgi.py`, `backend/fixture/settings/{base,prod}.py`, and
> `backend/apps/matches/services/events.py`. Read against tests for intended behaviour.
>
> **Headline ground-truth correction:** `CLAUDE.md`, several module docstrings, and `apps.live`'s
> `verbose_name` all claim **SSE** for one-way viewers and the notification bell. **No SSE
> (`StreamingHttpResponse` / `text/event-stream` / `EventSource`) exists anywhere in the
> backend or frontend.** The real "live" transport is (a) a polled REST snapshot and (b) a
> WebSocket room used only for match broadcasts. The frontend polls: `LiveViewerPage`
> `refetchInterval: 5000`, `NotificationBell` `refetchInterval: 30_000`. SSE is aspirational
> ("SSE upgrade later" in `fixture/urls.py`). Treat the SSE references as documentation debt.

## 1. Purpose

Three small, loosely related delivery/workflow apps sitting on top of the matches domain:

- **`live`** — the public, login-free viewer surface. One REST "snapshot" endpoint (score +
  rosters + last 30 visible events) plus the WebSocket `MatchConsumer` that scorer/referee/fan
  clients can join to receive post-commit match-event broadcasts.
- **`notifications`** — the in-app notification bell: durable per-user `Notification` rows, an
  idempotent dispatcher, and a list / mark-read / mark-all-read REST surface.
- **`disputes`** — protest/appeal lifecycle: an org-scoped `Dispute` model with an explicit,
  audited state machine (raise → review → resolve/reject/withdraw) and party notifications.

## 2. File-by-file roles

### apps/live
- `consumers.py` — `MatchConsumer(AsyncJsonWebsocketConsumer)`. `connect()` reads `match_id` from
  the URL route, joins group `match_<id>`, accepts unconditionally. `receive_json()` only echoes
  `{"type":"ping"}` → `{"type":"pong"}`. `match_event()` is the channel-layer handler that forwards
  `event["data"]` to the socket.
- `routing.py` — `websocket_urlpatterns = [path("ws/match/<uuid:match_id>/", MatchConsumer.as_asgi())]`.
- `views.py` — `LiveMatchSnapshotView(GenericAPIView, AllowAny)`; helpers `_name(person)`,
  `_team(t, include_players)`, constant `_ROSTER_VISIBLE`.
- `urls.py` — mounts `match/<uuid:match_id>/` at `/api/live/` → `live-match-snapshot`.
- `apps.py` — `LiveConfig` (label `live`, verbose name "Live delivery (SSE/WebSocket)").
- `tests/test_live.py` — public snapshot returns score; WS room receives a `group_send` broadcast.
- **No `models.py`, no migrations** — `live` is transport-only; it owns no tables.

### apps/notifications
- `models.py` — `Notification` model.
- `services/dispatch.py` — `create_notification`, `notify_many`, `mark_read`, `mark_all_read`,
  `_publish` (a stub).
- `views.py` — `NotificationListView`, `MarkReadView`, `MarkAllReadView` (all `IsAuthenticated`).
- `serializers.py` — `NotificationSerializer` (read-only projection).
- `urls.py` — `/api/notifications/` (`""`, `read-all/`, `<uuid>/read/`).
- `migrations/0001_initial.py`, `tests/test_notifications.py`.

### apps/disputes
- `models.py` — `DisputeStatus` (TextChoices) + `Dispute` model.
- `services/lifecycle.py` — `ALLOWED_TRANSITIONS`, `raise_dispute`, `transition_dispute`.
- `views.py` — `TournamentDisputeView` (list/raise), `_ManagerTransitionView` base,
  `ResolveDisputeView`, `RejectDisputeView`, `WithdrawDisputeView`; helpers
  `_accessible_tournament_or_404`, `_dispute_or_404`.
- `serializers.py` — `DisputeSerializer`, `RaiseDisputeSerializer`, `ResolveDisputeSerializer`.
- `urls.py` — `/api/disputes/<uuid>/{resolve,reject,withdraw}/`. **Note:** the list/raise route
  is NOT here — it is mounted by `apps.tournaments.urls` at
  `/api/tournaments/<uuid:tournament_id>/disputes/` (imports `TournamentDisputeView` directly).
- `migrations/0001_initial.py`, `tests/test_disputes.py`.

## 3. Data model

**`Notification`** (`notifications_notification`): `id` (uuid7 PK), `user` (FK→User, CASCADE),
`tournament` (FK, nullable, SET_NULL), `kind` (CharField 64, free-text e.g. `"team_registered"`,
`"dispute_raised"`, `"dispute_resolved"`), `title`, `body`, `url`, `read_at` (nullable, indexed),
`event_id` (UUID, **unique**, nullable — idempotency #3), `created_at`. Ordering `-created_at`;
composite index `(user, read_at)`. No `organization` FK — scoped purely by `user`.

**`Dispute`** (`disputes_dispute`): `id` (uuid7 PK), `organization` (FK, CASCADE), `tournament`
(FK, CASCADE), `match` (FK, nullable, SET_NULL), `raised_by` (FK→User, nullable, SET_NULL),
`kind` (CharField 64, free-text `"score"`/`"eligibility"`/`"conduct"`), `description` (required),
`status` (`DisputeStatus`, default `open`, indexed), `resolution`, `reviewed_by`/`reviewed_at`,
`event_id` (unique, nullable — idempotency), `created_at`/`updated_at`. Index `(tournament, status)`.

`DisputeStatus`: `open`, `under_review`, `resolved` (= "upheld"), `rejected`, `withdrawn`.

The `live` app has **no model** — it reads `matches.Match`, `matches.MatchEvent`,
`teams.Team`/`teams.Player`, `accounts.Person` (via `player.person`).

## 4. Core algorithms / services (file:function, step-by-step)

### Live snapshot — `apps/live/views.py::LiveMatchSnapshotView.get`
1. Fetch non-deleted `Match` by id with `select_related("home_team","away_team")`; `404` if none.
2. `include_players = m.status in _ROSTER_VISIBLE` where `_ROSTER_VISIBLE = (LIVE, HALF_TIME, COMPLETED)`
   — rosters are hidden pre-kickoff/cancelled (privacy gate, matches the docstring).
3. Load all `MatchEvent`s ordered by `sequence_no`; build `voided_ids` = `{e.voids_id}` for VOID
   events; `visible` excludes VOID rows **and** events they void; reverse and slice `[:30]`
   (newest-30, descending).
4. Respond with `match` block (status, current_period, both teams via `_team`, cached
   `home_score`/`away_score`) and a list of `events` with public-safe player names via `_name`
   (`person.display_name or person.full_name`).

> This re-derives the visible set with logic that **parallels but does not reuse**
> `matches.services.events.recompute_score`'s void-handling — duplicated VOID semantics (smell).

### WebSocket broadcast path — `MatchConsumer` + `matches/services/events.py::publish_match_event`
- Authoritative writes go through `record_match_event` (REST/service layer), which under
  `transaction.atomic()` + `select_for_update()` appends a gapless `MatchEvent`, recomputes the
  score, emits audit, then `transaction.on_commit(lambda: publish_match_event(mid, eid))`.
- `publish_match_event(match_id, event_id)` lazily imports `get_channel_layer` / `async_to_sync`
  and does `group_send("match_<id>", {"type":"match.event","data":{...match_id,event_id...}})`.
  Wrapped in try/except — **best-effort; delivery failure never affects the commit** (invariant #4).
- `MatchConsumer.match_event` receives that and pushes `event["data"]` to the socket. The payload
  is just `{match_id, event_id}` (a "something changed" ping) — clients must re-fetch the snapshot
  for actual data. So even the WS path is effectively notify-then-poll.

### Notification dispatch — `apps/notifications/services/dispatch.py`
- `create_notification(*, user, kind, title, body="", url="", tournament=None, event_id=None)`:
  if `event_id` set and a row exists, **return the prior row** (idempotent replay); else create
  (title truncated `[:200]`, url `[:300]`), then `transaction.on_commit(lambda: _publish(uid, nid))`.
  `_publish` only logs — the "SSE fan-out" it documents does not exist.
- `notify_many` — list-comprehension fan-out over users (no `event_id`, so **not idempotent** for
  bulk; each call always creates).
- `mark_read` — ownership-guarded (`notification.user_id != user.id` → `False`), sets `read_at`
  if unset. `mark_all_read` — bulk `.update(read_at=now())`, returns count.

### Dispute lifecycle — `apps/disputes/services/lifecycle.py`
- `ALLOWED_TRANSITIONS`: `open → {under_review, resolved, rejected, withdrawn}`,
  `under_review → {resolved, rejected}`; terminal states have empty sets. (Note: you can jump
  `open → resolved` directly, skipping review.)
- `raise_dispute(...)`: idempotent on `event_id`; inside `transaction.atomic()` creates the
  `Dispute` (status `open`, org from `tournament.organization`), `emit_audit("dispute_raised")`,
  and if `tournament.created_by_id` set, notifies the creator (`kind="dispute_raised"`).
- `transition_dispute(*, dispute, to_status, by=None, resolution="", request=None)`:
  `select_for_update().get(pk=...)`; raise `ValidationError` if transition illegal; require a
  `resolution` of `>=5` non-space chars for `resolved`/`rejected`; set status (+ resolution if
  given) and stamp `reviewed_by`/`reviewed_at` for `under_review`/`resolved`/`rejected`; save
  only the changed fields; `emit_audit("dispute_status_changed")` (reason=resolution); and on
  `resolved`/`rejected` notify the raiser (`kind="dispute_resolved"`).

### Dispute views — authorization model
- `_accessible_tournament_or_404` / `_dispute_or_404` gate everything through
  `apps.tournaments.scope.accessible_tournaments(user)` (404 on no access, no existence leak —
  invariant #2). `TournamentDisputeView.get` returns all disputes to managers
  (`can_manage_tournament`) but only `raised_by=self` to non-managers. `_ManagerTransitionView`
  requires `can_manage_tournament` (else `PermissionDenied`). `WithdrawDisputeView` requires the
  caller be the raiser (`d.raised_by_id == request.user.id`). Django `ValidationError` from the
  service is translated to DRF `ValidationError` (`{"detail": ...}` → HTTP 400).

## 5. API / endpoint surface

WebSocket: `ws/match/<uuid:match_id>/` (via `fixture/asgi.py`).

REST (all under `/api/`):
- `GET  /api/live/match/<uuid>/` — public snapshot (`AllowAny`).
- `GET  /api/notifications/` — `{results:[…≤50], unread_count}` (own only).
- `POST /api/notifications/read-all/`
- `POST /api/notifications/<uuid>/read/`
- `GET  /api/tournaments/<uuid>/disputes/` — list (manager: all; member: own).
- `POST /api/tournaments/<uuid>/disputes/` — raise (201; replay returns prior via `event_id`).
- `POST /api/disputes/<uuid>/resolve/` — manager; body `{resolution}`.
- `POST /api/disputes/<uuid>/reject/` — manager; body `{resolution}`.
- `POST /api/disputes/<uuid>/withdraw/` — raiser only.

## 6. Invariants that must be preserved

1. **DB-first, publish-after-commit (#4/#11).** Match/notification/dispute writes are the system
   of record; the WS `group_send` and `_publish` fire only inside `transaction.on_commit`, and WS
   fan-out is best-effort (must never roll back or block the write).
2. **Idempotency on `event_id` (#3).** `Notification.event_id` and `Dispute.event_id` are unique;
   `create_notification` and `raise_dispute` return the existing row on replay (200/echo, not a dup).
3. **Dispute state machine (#6).** Only `ALLOWED_TRANSITIONS` are legal; terminal states are
   terminal; transitions are `select_for_update`-locked and `emit_audit`-logged. Resolve/reject
   require a `>=5`-char resolution note (tested).
4. **Multi-tenant isolation (#2).** Disputes resolve via `accessible_tournaments` (404, no leak);
   non-managers see only their own; outsiders get 404 (tested `test_outsider_cannot_raise`).
   Notifications are strictly per-user (cross-user read returns 404, tested).
5. **Public-viewer minimisation.** Snapshot drops VOID events and the events they void, hides
   rosters unless `status ∈ {live, half_time, completed}`, and emits public-safe names only.
6. **WebSockets two-way, viewers polled (#11 intent).** Authoritative scoring is REST; the WS is
   delivery/notify only — `receive_json` must not perform writes.
7. **Append-only audit (#5).** Every dispute mutation emits an `AuditEvent` via `emit_audit`.

## 7. Dependencies / coupling

**Outgoing (these apps depend on):**
- `live` → `matches.models` (Match, MatchEvent, MatchEventType, MatchStatus), `teams` (Player via
  reverse `t.players`), `accounts.Person` (via `player.person.display_name/full_name`), Channels
  (`channel_layer`), DRF.
- `notifications` → `accounts.uuid7`, `tournaments.Tournament` (FK), `settings.AUTH_USER_MODEL`.
  Pure model + dispatcher; no app imports it at module top level (callers use **lazy imports**).
- `disputes` → `organizations.Organization`, `tournaments.Tournament` + `tournaments.scope`
  + `tournaments.permissions`, `matches.Match`, `audit` (`emit_audit`, `ActorRole`),
  `notifications.services.dispatch` (lazy import), `accounts.uuid7`.

**Incoming (who depends on these):**
- `matches.services.events.publish_match_event` is the **only** producer for the `match_<id>`
  channel group consumed by `MatchConsumer` — the WS is useless without the matches service.
- `notifications.create_notification` is called by `disputes.services.lifecycle` (twice) and
  `matches.services.incidents` (line 60). `notify_many` has **no production callers** (dead-ish).
- `disputes.views.TournamentDisputeView` is imported by `tournaments/urls.py` (cross-app URL
  ownership — a coupling worth flagging).
- `fixture/asgi.py` imports `apps.live.routing.websocket_urlpatterns` and wraps it in
  `AllowedHostsOriginValidator(AuthMiddlewareStack(URLRouter(...)))`.
- Frontend: `src/api/live.ts` + `LiveViewerPage` (poll 5s), `src/api/notifications.ts` +
  `NotificationBell` (poll 30s). No frontend WebSocket/EventSource client exists today.

**Infra config:** `CHANNEL_LAYERS` = `InMemoryChannelLayer` in `base.py`/dev (single-process only,
no cross-worker fan-out, lost on restart); `RedisChannelLayer` in `prod.py` (`channels_redis`,
`hosts=[REDIS_URL]`). `ASGI_APPLICATION = "fixture.asgi.application"`. `ATOMIC_REQUESTS=True`.

## 8. Tech debt / smells / duplication

- **SSE is documented but unimplemented.** `apps.live` verbose name, `notifications.models`/
  `dispatch.py` docstrings, `_publish`, and `CLAUDE.md` (#11, "Live transport split") all claim
  SSE for viewers + bell. Reality = HTTP polling + a thin WS notify. This is the single biggest
  divergence between docs and code; any restructuring spec must reconcile it.
- **`MatchConsumer.connect()` performs no authorization or existence check.** It accepts ANY
  `match_<uuid>` join from any origin-allowed client (the snapshot is public anyway, so this is
  defensible for read-only fan-out, but means there is no scoping for would-be scorer rooms — the
  "scorer/referee rooms" framing in CLAUDE.md is not actually distinguished at the consumer level;
  it is one undifferentiated public room). `AuthMiddlewareStack` populates `scope["user"]` but the
  consumer never reads it.
- **`_publish` is a no-op stub** that logs but the docstring promises SSE fan-out — misleading.
- **VOID-filtering logic duplicated.** `live/views.py` re-implements "drop voids + voided events"
  that already lives in `matches/services/events.recompute_score` (different code, same rule) —
  drift risk (e.g. snapshot does not special-case `OWN_GOAL` for display, score does).
- **Free-text `kind` fields** on both `Notification.kind` and `Dispute.kind` (no enum/choices) —
  typos silently create new categories; no validation; frontend must hardcode magic strings.
- **`notify_many` is not idempotent** (no `event_id`) and currently unused — latent footgun.
- **Cross-app URL ownership:** dispute list/raise lives under `tournaments/urls.py`, transition
  verbs under `disputes/urls.py`. Discovering the full dispute surface requires reading two apps.
- **`NotificationListView` ignores DRF pagination** and hardcodes `[:50]`; `unread_count` is a
  second query (fine, but the slice silently caps the bell).
- **Dispute `description`/`resolution` truncated to `[:200]` only in the notification body**, not
  validated at the model — long bodies stored fully but notifications silently clipped.
- **`open → resolved` is legal** (skips `under_review`); intentional per the table but means the
  "review" state is optional, which may surprise a reviewer-workflow restructuring.
- **`Match.home_score`/`away_score` are cached** (nullable) and the snapshot trusts them; correct
  only if `recompute_score` always ran — couples the public surface to the write path's discipline.
- The disputes model docstring notes the **cross-result cascade engine (re-advancement on an
  upheld score dispute) is unbuilt** — resolving a `score` dispute does NOT re-trigger
  `fixtures.services.advance`. Disputes are currently advisory/workflow only.

## 9. Restructuring seams & risks

**Seams (clean cut points):**
- **Transport is already isolated.** `publish_match_event` is the only fan-out producer and is
  a single function behind `transaction.on_commit`; swapping the channel layer for real SSE, or
  enriching the WS payload from `{match_id,event_id}` to a full event, is a one-function change
  plus a consumer handler. The notification `_publish` stub is the symmetric seam for a real bell
  push (SSE/WS on `user:<uuid>:notifications`).
- **`create_notification` is the single dispatch entry point** (all callers lazy-import it) — a
  natural place to add channels/preferences/batching without touching call sites.
- **Dispute lifecycle is service-centralised** (`raise_dispute`/`transition_dispute`); views are
  thin. The state machine + audit + notify can be lifted wholesale; adding the score-dispute
  re-advancement cascade is a localized `on_commit` hook in `transition_dispute` (mirroring
  `fixtures.services.advance.advance_from_match`).
- **`live.views` snapshot serialization** is hand-rolled dicts — replaceable with serializers,
  and the VOID/visibility logic is extractable into a shared `matches` selector reused by both
  the snapshot and `recompute_score`.

**Risks:**
- **In-memory channel layer in dev/test** means WS fan-out only works in one process; tests use
  `WebsocketCommunicator` + a manual `group_send`. A restructuring that assumes cross-process
  delivery will pass tests but fail without Redis configured (prod only).
- **Removing the SSE claims** (or implementing them) is a doc + invariant edit (#11) — must update
  `CLAUDE.md` and PRD, not just code, to avoid re-introducing the divergence.
- **Consumer has no auth/scope** — if "scorer rooms" are introduced for real (write-capable or
  private data), the current `connect()` (accept-all) is a hole; harden before adding any
  non-public payload to the WS.
- **`event_id` uniqueness is global** on both tables (not per-tenant); fine today but constrains
  any sharding/partitioning restructuring.
- **`tournaments` ↔ `disputes` circular-ish coupling** (tournaments imports a disputes view;
  disputes imports tournaments scope/permissions) — relocating the list/raise route into
  `disputes/urls.py` (mounted under a tournament-id prefix) would break the cycle.
- Snapshot/score relies on `recompute_score` having run on every write; any new write path that
  forgets it will silently desync the public scoreboard.

## 10. Ambiguities flagged

- "SSE one-way viewers + notification bell" (task framing + CLAUDE.md) describes **intended**, not
  **current**, behaviour. Current = polling. Stated explicitly so the restructuring plan starts
  from truth.
- "scorer/referee rooms via AllowedHostsOriginValidator+AuthMiddlewareStack": the middleware
  stack is wired in `asgi.py`, but `MatchConsumer` does not differentiate scorer vs referee vs fan
  and does not read `scope["user"]`/`scope["session"]`. There is exactly one public room per match.
