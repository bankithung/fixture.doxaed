# v1Live.md — Live Transport Design (SSE + WebSocket + Redis pub/sub)

**Status:** Design, implementation-ready. Phase 1B. Depends on `apps.matches` (MatchEvent + Match state machine), `apps.tournaments`, `apps.notifications`. Hard-blocked-on-existing-chassis only where noted.
**Canonical sources:** PRD §7.1–§7.3 (topology, transport split, event-log architecture), §5.14 (notifications), §6 (perf), §8 (data model), §11 (phasing); invariants #2, #3, #4, #11. `v1Users.md` §4.7/§5.7 (`TournamentMembership`, `MatchAssignment`), §5.14 (notification recipients). `v1Fixtures.md` line 142 (generation progress over SSE).
**Confidence legend:** [HIGH] grounded in code/spec with citation; [MED] inferred from spec + chassis convention; [LOW] judgement call, flagged for review.

---

## 0. Scope & non-goals

**In scope (this doc):**
- SSE endpoints: public match viewer (`match:<uuid>`), notification bell (`user:<uuid>:notifications`), and fixture-generation progress (`genrun:<uuid>`, reuse).
- WebSocket consumers: scorer + referee collaborative scoring room (`ws_match:<uuid>`).
- Redis pub/sub publishing, gated strictly inside `transaction.on_commit` (#4).
- ASGI `ProtocolTypeRouter`, `channels_redis` replacing `InMemoryChannelLayer`.
- Auth on both transports (session-cookie, no JWT, #15).
- Reconnection / backfill from the DB event log (`MatchEvent` + `Notification`).
- Tests, migration/build order, reused chassis.

**Out of scope (owned elsewhere, referenced only):**
- The `MatchEvent` model + Match state machine and the scorer DRF write endpoints — owned by `apps.matches` (Phase 1B). This doc consumes them and specifies the **publish contract** they must call. The exact field list for `MatchEvent` is fixed by PRD §8 line 955 and reproduced in §3.1 for reference.
- The `Notification` / `NotificationDispatcher` / `ScheduledNotification` models — owned by `apps.notifications`. This doc specifies the SSE delivery side and the publish contract.
- Email/WhatsApp/SMS channels (v2+, PRD §5.14).

---

## 1. Why this split (invariant #11, PRD §7.2)

PRD §7.2 table is canonical:

| Audience | Transport | Direction | Channel |
|----------|-----------|-----------|---------|
| Public viewers | SSE | S→C | `match:<uuid>` |
| Coordinator dashboards | SSE | S→C | `match:<uuid>` (+ filtered) |
| Team managers (own match) | SSE | S→C | `match:<uuid>` |
| Notification bell (all logged-in) | SSE | S→C | `user:<uuid>:notifications` |
| Fixture-generation progress | SSE | S→C | `genrun:<uuid>` |
| **Scorer + Referee** | **WebSocket** | **bidirectional** | `ws_match:<uuid>` |

Rationale (PRD §6 line 802, §10 decision 5): SSE is one-way HTTP, survives nginx/proxies trivially, fans out to ~5,000 conns/worker, and the public viewer is read-only. WebSockets are reserved for the **low-volume, high-interaction** scorer/referee room where the client also *sends* (clock control, event submit, lineup confirm, presence). **Do not** use WS for viewers or the bell (invariant #11, explicit).

> **Design rule (load-bearing):** WebSocket inbound messages are **not** a write path of record. Every state-changing scorer action a WS message represents MUST be persisted through the same idempotent DRF endpoint / service that an HTTP client would use, so the DB-first invariant (#4) and idempotency (#3) hold identically whether the action arrives by WS or HTTP. The WS consumer is a thin presence/relay + optimistic-echo layer over the same domain service. See §5.4.

---

## 2. Architecture overview

```
                         ┌──────────────────────────────────────────────┐
  scorer/referee  ──WS──►│  ASGI: ProtocolTypeRouter                     │
  (bidirectional)        │   ├─ "websocket" → AuthMiddlewareStack →      │
                         │   │     URLRouter → MatchScoringConsumer      │
  viewer / bell  ──HTTP─►│   └─ "http" → Django (DRF + async SSE views)  │
  (EventSource SSE)      └───────┬───────────────────────────┬──────────┘
                                 │                            │
              ┌──────────────────▼──────┐      ┌──────────────▼─────────────┐
              │ Channels group layer     │      │ Redis pub/sub (raw)         │
              │ (channels_redis)         │      │ channel: match:<uuid>,      │
              │ group: ws_match:<uuid>   │◄────►│ user:<uuid>:notifications,  │
              │ (WS fan-out only)        │      │ genrun:<uuid>               │
              └──────────────────────────┘      └──────────────┬─────────────┘
                                                               │ (async listener
                                                               │  inside SSE view)
   DB-first system of record:                                  │
   ┌──────────────────────────────────────────────────────────▼─────────────┐
   │ Postgres: MatchEvent (sequence_id), Notification, AuditEvent             │
   │  write → transaction commits → transaction.on_commit(publish())         │
   └──────────────────────────────────────────────────────────────────────────┘
```

Two distinct Redis usages, intentionally separated:
1. **Channels channel layer** (`channels_redis.core.RedisChannelLayer`) — used ONLY by the WebSocket consumers' group send/receive. This is the Django Channels abstraction.
2. **Raw Redis pub/sub** (`redis.asyncio`) — used by the SSE async views to subscribe to `match:*`, `user:*:notifications`, `genrun:*`. SSE views are plain async Django views (`StreamingHttpResponse`), NOT Channels consumers (PRD §7.1 line 820: "async views (SSE: viewers)"), so they subscribe to raw Redis pub/sub rather than the channel layer. [HIGH — PRD line 817-820 explicitly splits "Channels (WebSockets)" from "async views (SSE)".]

**Single publish helper feeds both.** `apps.live.publish.publish_match_event(...)` does two things inside one call: (a) `group_send` to the Channels group `ws_match:<uuid>` (reaches WS scorer/referee), and (b) `PUBLISH match:<uuid>` on raw Redis (reaches SSE viewers). One call, two fan-outs, so the DB-first ordering invariant has exactly one enforcement point. [MED — synthesises PRD §7.3 diagram lines 851-857 where one MatchEvent feeds both WS and SSE.]

---

## 3. New app: `apps.live`

Add to `LOCAL_APPS` in `backend/fixture/settings/base.py` line 48 (currently ends at `apps.sports`). Layout matches CLAUDE.md planned layout (`apps/live/`):

```
backend/apps/live/
├── __init__.py
├── apps.py                  # LiveConfig
├── routing.py               # websocket_urlpatterns (Channels URLRouter)
├── consumers.py             # MatchScoringConsumer (WS)
├── sse.py                   # async SSE views: match_stream, notification_stream, genrun_stream
├── publish.py               # publish_match_event / publish_notification / publish_genrun_progress
├── channels_auth.py         # SessionAuthMiddleware wiring + connect-time authz helpers
├── backfill.py              # event-log replay helpers (Last-Event-ID / ?after_seq=)
├── envelope.py              # versioned wire-envelope schema + serializers
├── heartbeat.py             # SSE keepalive + WS ping config
├── urls.py                  # http urlpatterns for the 3 SSE endpoints
├── constants.py             # channel-name builders, event-type registry, limits
├── migrations/
│   └── 0001_initial.py      # LiveConnectionAudit + WSPresence (see §3.2)
└── tests/
    ├── conftest.py
    ├── factories.py
    ├── test_sse_match.py
    ├── test_sse_notifications.py
    ├── test_ws_consumer.py
    ├── test_publish_on_commit.py
    ├── test_backfill.py
    ├── test_channel_auth.py
    └── test_isolation.py    # cross-org leak suite (#2, PRD §7.4 line 872)
```

`apps.live` owns **transport only**. It imports `MatchEvent`, `Notification`, `Match`, `MatchAssignment` read-side; it does not own those tables.

### 3.1 `MatchEvent` reference (owned by `apps.matches`, reproduced from PRD §8 line 955)

```python
# apps/matches/models.py  — NOT created by apps.live; contract reference only.
class MatchEvent(models.Model):
    id              = UUIDField(pk, default=uuid7)               # invariant #1
    organization    = FK(Organization)                          # denormalized for query/scope (#2; PRD §7.4 line 869)
    match           = FK(Match, related_name="events")
    sequence_id     = BigIntegerField()                         # monotonic per-match; gapless ordering + backfill cursor
    event_id        = UUIDField(unique=True)                    # client-supplied idempotency key (#3; PRD §7.6)
    type            = CharField()                               # sport-module taxonomy (goal, card, sub, period…)
    minute          = IntegerField(null=True)
    stoppage_time   = IntegerField(null=True)
    payload         = JSONField()                               # snapshot (PRD §3 line 354: jersey snapshots etc.)
    actor_user      = FK(User, SET_NULL, null=True)
    server_ts       = DateTimeField()                           # UTC (#14)
    event_status    = CharField()                               # active | voided | corrected
    voided_by_event_id     = UUIDField(null=True)
    corrected_from_event_id= UUIDField(null=True)

    class Meta:
        constraints = [UniqueConstraint(fields=["match", "sequence_id"],
                                        name="uniq_match_sequence")]
        indexes = [Index(fields=["match", "sequence_id"]),       # PRD §6 line 799
                   Index(fields=["match"], condition=Q(event_status="active"),
                         name="matchevent_active_partial")]      # PRD §6 line 799 partial idx
```

**`sequence_id` is the backbone of backfill** (§7). It is assigned by the `apps.matches` write service via `SELECT max(sequence_id)+1 ... FOR UPDATE` (or a per-match Postgres sequence) inside the same transaction as the INSERT, so it is gapless and monotonic. [MED — PRD §6 line 799 indexes on `(match_id, sequence_id)` and §8 lists `sequence_id`; the FOR UPDATE assignment is the standard gapless-per-tenant technique.]

### 3.2 New models OWNED by `apps.live`

Two small operational tables. Both UUIDv7 PK (#1), both carry `organization_id` where applicable (#2).

```python
# apps/live/models.py

class LiveConnectionAudit(models.Model):
    """One row per accepted/rejected live connection (WS + SSE). Ops + abuse forensics.
    NOT the append-only AuditEvent table — this is high-volume transport telemetry,
    so it lives in its own mutable table and is NOT subject to invariant #5.
    Retention: 30 days (cron prune). [LOW: retention value — confirm in review.]"""
    id            = UUIDField(pk, default=uuid7)
    transport     = CharField(choices=["sse", "ws"])
    channel_kind  = CharField(choices=["match", "notifications", "genrun", "ws_match"])
    target_id     = UUIDField(null=True)          # match_id / user_id / genrun_id
    organization_id = UUIDField(null=True, db_index=True)
    user          = FK(User, SET_NULL, null=True) # null for anon public viewer
    is_anonymous  = BooleanField(default=False)
    outcome       = CharField(choices=["accepted", "rejected_auth",
                                       "rejected_authz", "rejected_ratelimit"])
    ip_address    = GenericIPAddressField(null=True)
    user_agent    = CharField(max_length=255, blank=True)
    last_event_id = BigIntegerField(null=True)    # resume cursor at connect
    connected_at  = DateTimeField(auto_now_add=True)
    disconnected_at = DateTimeField(null=True)

class WSPresence(models.Model):
    """Who is currently in a scoring room. Drives the scorer-console presence
    roster + 'someone else is editing' conflict UX. Soft, best-effort
    (channel layer is source of truth; this is a queryable mirror).
    Cleared on disconnect; orphans pruned by heartbeat-timeout cron."""
    id           = UUIDField(pk, default=uuid7)
    match_id     = UUIDField(db_index=True)
    organization_id = UUIDField(db_index=True)    # #2 scope
    user         = FK(User, CASCADE)
    role         = CharField(choices=["match_scorer", "referee"])  # from MatchAssignment
    channel_name = CharField(max_length=128)       # Channels reply channel
    joined_at    = DateTimeField(auto_now_add=True)
    last_seen_at = DateTimeField(auto_now=True)

    class Meta:
        constraints = [UniqueConstraint(fields=["match_id", "user", "channel_name"],
                                        name="uniq_presence_conn")]
        indexes = [Index(fields=["match_id"]), Index(fields=["organization_id"])]
```

> [LOW] `WSPresence` could be Redis-only (TTL keys) to avoid DB chatter. Decision: **DB-mirrored** for v1 because (a) it's low volume (≤ ~4 officials/match), (b) it gives the dashboard a queryable roster without a Channels round-trip, (c) it survives a worker restart for reconciliation. Revisit if write volume bites. Flagged for review.

---

## 4. Wire envelope (versioned) — `envelope.py`

Every message on every transport uses one envelope so the SPA has a single parser and we can evolve without breaking clients. [MED — convention, not in spec; chosen for forward-compat + reconnection cursor.]

```jsonc
{
  "v": 1,                          // envelope version
  "kind": "match_event",           // see registry below
  "seq": 412,                      // MatchEvent.sequence_id (match streams) — backfill cursor
  "ts": "2026-06-04T12:00:00Z",    // UTC, ISO-8601 (#14)
  "match_id": "0190...uuid",       // present on match/ws_match streams
  "data": { /* kind-specific, snapshot-safe, NO PII beyond what viewer may see */ }
}
```

**`kind` registry (`constants.py`):**

| kind | transports | data shape |
|------|-----------|-----------|
| `match_event` | SSE match, WS | serialized active `MatchEvent` (type, minute, payload-public-subset, event_status) |
| `match_state` | SSE match, WS | `{from, to}` Match state transition (PRD §5.5) |
| `score_update` | SSE match, WS | derived running score (denormalized for cheap viewer render) |
| `clock` | SSE match, WS | `{running: bool, period, base_minute, server_ts}` (client extrapolates) |
| `event_voided` / `event_corrected` | SSE match, WS | `{event_id, voided_by_event_id}` |
| `presence` | WS only | `{users: [{user_id, name, role}], you}` |
| `lineup_confirmed` | WS, SSE match | `{team_id}` |
| `notification` | SSE notifications | serialized `Notification` (title, body, link, priority, group_key) |
| `notification_grouped` | SSE notifications | collapsed summary (PRD §5.14 grouping, line 716) |
| `genrun_progress` | SSE genrun | `{pct, stage, message}` (v1Fixtures.md line 142) |
| `genrun_done` / `genrun_failed` | SSE genrun | `{result_url}` / `{error}` |
| `heartbeat` | all | `{}` (SSE comment line / WS ping) |

**Public vs privileged payload split:** the match-event serializer takes an `audience` arg (`"public"` | `"official"`). Public strips anything not viewer-safe (e.g. internal notes, soft-deleted-actor PII). Officials (WS, authenticated coordinator SSE) get the full payload. This is the single point where over-sharing is prevented; the isolation test (§8) asserts the public serializer never leaks privileged keys. [MED — derived from PRD §7.4 + §7.7.]

---

## 5. WebSocket: `MatchScoringConsumer`

### 5.1 Routing — `apps/live/routing.py`

```python
from django.urls import re_path
from apps.live.consumers import MatchScoringConsumer

websocket_urlpatterns = [
    re_path(r"^ws/matches/(?P<match_id>[0-9a-f-]{36})/score/$", MatchScoringConsumer.as_asgi()),
]
```

### 5.2 ASGI wiring — `backend/fixture/asgi.py` (REPLACE current 17-line file)

Current file (verified) is a plain `get_asgi_application()` — no `ProtocolTypeRouter`. Replace with:

```python
import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "fixture.settings.dev")

from django.core.asgi import get_asgi_application
django_asgi_app = get_asgi_application()   # init Django BEFORE importing consumers/models

from channels.routing import ProtocolTypeRouter, URLRouter
from channels.security.websocket import OriginValidator
from apps.live.channels_auth import SessionAuthMiddlewareStack   # session-cookie auth (#15)
from apps.live.routing import websocket_urlpatterns
from django.conf import settings

application = ProtocolTypeRouter({
    "http": django_asgi_app,                       # DRF + async SSE views
    "websocket": OriginValidator(                  # same-origin only (PRD §7.7 CORS off in prod)
        SessionAuthMiddlewareStack(URLRouter(websocket_urlpatterns)),
        settings.WS_ALLOWED_ORIGINS,               # dev: localhost:5173; prod: same-origin
    ),
})
```

`SessionAuthMiddlewareStack` = `CookieMiddleware → SessionMiddleware → AuthMiddleware` (Channels' `AuthMiddlewareStack` does exactly this). We wrap it in our own name so we can later add a connection-rate-limit middleware. **No JWT** — the consumer reads `scope["user"]` populated from the Django session cookie (#15, matches frontend `apiFetch` `credentials:"include"`, `client.ts` line 69). [HIGH — #15 + chassis uses SessionAuthentication, base.py line 154.]

### 5.3 Connect-time auth & authz (`consumers.py`)

```python
class MatchScoringConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        self.match_id = self.scope["url_route"]["kwargs"]["match_id"]
        user = self.scope["user"]

        # 1. AuthN (#15): must be a logged-in user. Anonymous → reject 4401.
        if not user.is_authenticated:
            await self._audit("rejected_auth"); return await self.close(code=4401)

        # 2. AuthZ (#2 + #12 + v1Users §5.7 invariant): user must hold an ACTIVE
        #    MatchAssignment(match, user, role∈{match_scorer,referee}, status='assigned')
        #    AND the org-level membership. Resolved in one DB call (sync_to_async).
        self.role, self.org_id = await self._resolve_official(user, self.match_id)
        if self.role is None:
            await self._audit("rejected_authz"); return await self.close(code=4403)

        # 3. Match must be in a state that accepts a scoring room (lineup_* / live_*).
        #    Closed/cancelled matches → reject 4404 (read-only via SSE instead).
        if not await self._match_room_open(self.match_id):
            await self._audit("rejected_authz"); return await self.close(code=4404)

        self.group = match_ws_group(self.match_id)          # "ws_match.<uuid>"
        await self.channel_layer.group_add(self.group, self.channel_name)
        await self.accept()
        await self._presence_join(user)                      # write WSPresence, broadcast presence
        await self._send_backfill()                          # replay missed events (§7)
```

Authz helper enforces the **double-grant invariant** (`v1Users.md` §5.7 line 1198): both `OrganizationMembership(...role, status=active)` and `MatchAssignment(...status=assigned)` must exist. Reuse `MatchAssignment` (Phase 1B) + read `organization_id` off `Match.tournament.organization`. Cross-org users are rejected at step 2 because they hold no assignment in that org (#2). [HIGH — v1Users.md §5.7 lines 1198-1200 quoted.]

WS close codes (custom, documented for the SPA): `4401` unauthenticated, `4403` unauthorized, `4404` room closed, `4408` idle timeout, `4429` too many connections.

### 5.4 Inbound messages — relay over the idempotent write path

Inbound WS messages are validated then **dispatched to the same `apps.matches` service the DRF endpoint calls** (see §1 design rule). The consumer never writes `MatchEvent` directly.

| inbound `action` | handling |
|------------------|----------|
| `submit_event` | `await sync_to_async(matches.services.record_match_event)(match, user, event_id, type, payload)` — idempotent on `event_id` (#3). Service does INSERT + `transaction.on_commit(publish_match_event)`. WS gets the broadcast back (no separate echo path → no double-count). |
| `clock_control` | `record_match_event(type='clock_start'|'clock_stop'|...)` — same path. |
| `confirm_lineup` | `matches.services.confirm_lineup(...)`; publishes `lineup_confirmed`. |
| `void_event` / `correct_event` | service mutates `event_status`, writes a new corrective `MatchEvent` (append-only spirit), publishes. |
| `ping` | reply `pong`; refresh `WSPresence.last_seen_at`. |
| `cursor` | presence cursor / "I'm editing minute X" hint → broadcast `presence` only, no DB write. |

Inbound validation: every action carries a client `event_id` (UUID). Malformed → `{kind:"error", code:"bad_request"}` without closing. Re-auth on every privileged inbound (assignment could be revoked mid-match; `v1Users.md` line 1246: suspension blocks assignment access "even if the match is live"). Cache the assignment check for ~10s to avoid a DB hit per keystroke. [MED.]

### 5.5 Group receive (broadcast → client)
`publish_match_event` calls `channel_layer.group_send(group, {"type": "live.event", "envelope": {...}})`. Consumer handler `async def live_event(self, message)` → `await self.send_json(message["envelope"])`. Standard Channels group dispatch.

### 5.6 Disconnect
`group_discard`, delete `WSPresence` row for `(match, user, channel_name)`, broadcast updated `presence`, write `disconnected_at` on `LiveConnectionAudit`.

---

## 6. SSE endpoints (async Django views) — `sse.py` + `urls.py`

SSE views are **async function views returning `StreamingHttpResponse`** (PRD §7.1 line 820), served by the `"http"` ASGI branch. They subscribe to **raw Redis pub/sub** (`redis.asyncio.Redis().pubsub()`), not the channel layer.

### 6.1 Endpoints (`apps/live/urls.py`, mounted at project root in `fixture/urls.py`)

| Method/Path | Channel | Auth | Backfill param |
|-------------|---------|------|----------------|
| `GET /api/live/matches/<match_id>/stream/` | `match:<uuid>` | **public** (anon allowed; read-only) | `Last-Event-ID` header or `?after_seq=` |
| `GET /api/live/notifications/stream/` | `user:<request.user.id>:notifications` | **authenticated** (#15) | `?after_id=` (Notification cursor) |
| `GET /api/live/genruns/<genrun_id>/stream/` | `genrun:<uuid>` | authenticated + module `tournament.fixtures` | none (progress is ephemeral) |

The match stream is public per PRD §1 line 834 ("Public viewers (no login, read-only via SSE)"). The notification stream binds strictly to `request.user.id` — a user can **only** subscribe to their own channel; the channel name is derived server-side from the session, never from a client param (#2 — no way to request someone else's bell). [HIGH — PRD §5.14 line 675 + §7.4.]

### 6.2 SSE response shape

```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no          # disable nginx buffering (REQUIRED for SSE on the VPS)
Connection: keep-alive
```

Each event:
```
id: 412
event: match_event
data: {"v":1,"kind":"match_event","seq":412,...}

```
(`id:` = `sequence_id` so the browser's `EventSource` auto-sends `Last-Event-ID` on reconnect → free backfill cursor. [HIGH — standard EventSource semantics; PRD line 558 "auto-refresh on reconnect".])

### 6.3 Generator skeleton

```python
async def match_stream(request, match_id):
    # authz: public match? Validate match exists + is public-visible. Org-scope check
    # happens implicitly: a public match exposes ONLY public-audience envelopes (§4).
    after = _resume_cursor(request)                  # Last-Event-ID / ?after_seq
    async def gen():
        # 1. BACKFILL FIRST (DB), then live (Redis) — see §7.
        async for ev in backfill.replay_match(match_id, after_seq=after, audience="public"):
            yield sse_format(ev)
        # 2. Subscribe to raw Redis, stream live.
        pubsub = redis.pubsub(); await pubsub.subscribe(f"match:{match_id}")
        last_hb = time()
        async for msg in _iter_with_heartbeat(pubsub, request):
            if msg is HEARTBEAT: yield ": keep-alive\n\n"; continue
            env = _to_public_envelope(msg)           # strip privileged keys (§4)
            yield sse_format(env)
    resp = StreamingHttpResponse(gen(), content_type="text/event-stream")
    resp["X-Accel-Buffering"] = "no"; resp["Cache-Control"] = "no-cache"
    return resp
```

`_iter_with_heartbeat` emits a `: keep-alive\n\n` comment every 15s (PRD §6 latency target <1s, line 781; heartbeat keeps proxies + client alive). On client disconnect the async generator is GC'd; we `finally:` unsubscribe + close the pubsub + write `LiveConnectionAudit.disconnected_at`. [MED.]

### 6.4 Rate limiting & ceilings
- Public SSE: **100 conns/IP** (PRD §7.7 line 908). Enforced at connect via a Redis counter `sse_conn:{ip}` (INCR/EXPIRE), reject 429 over limit. [HIGH — PRD line 908.]
- SSE worker ceiling ~5,000 conns/worker (PRD §6 line 802) — operational, documented in deploy notes; horizontal-scale path is "add ASGI workers behind nginx" (PRD §10 line 1073).

---

## 7. Reconnection & backfill from the DB event log (#4)

**Principle:** Redis pub/sub is fire-and-forget; anything published while a client was disconnected is gone. The DB is the system of record (#4), so backfill **always** reads from Postgres, never from Redis.

### 7.1 Match stream backfill
1. Client reconnects with `Last-Event-ID: <seq>` (browser auto) or `?after_seq=<seq>`.
2. `backfill.replay_match(match_id, after_seq, audience)` =
   `MatchEvent.objects.filter(match_id=match_id, sequence_id__gt=after_seq, event_status='active').order_by('sequence_id')` → serialized to envelopes. Uses the `(match_id, sequence_id)` index (PRD §6 line 799). [HIGH.]
3. Stream all missed rows, THEN subscribe live. A small window of duplicate (a row published to Redis between the DB read and the subscribe) is de-duplicated client-side by `seq` (monotonic). [MED — standard replay-then-subscribe race handling.]
4. Cold connect (no cursor): replay a bounded tail (e.g. last full match state: current score + clock + last N=50 events) rather than the entire log, then go live. The "current state" is cheap because `score_update`/`clock` are derivable; full history is paginated via a separate REST endpoint, not the stream. [MED.]

### 7.2 Notification stream backfill
On connect, send unread + recent (PRD §5.14 line 673: "unread count + 10 most recent"): `Notification.objects.filter(user=request.user, archived_at__isnull=True).order_by('-created_at')[:N]` using index `Notification(user_id, read_at, created_at DESC)` (PRD §6 line 799). Then live. Cursor `?after_id` for finer resume. [HIGH — index + behavior cited.]

### 7.3 WS room backfill
`MatchScoringConsumer._send_backfill()` on `connect` replays `MatchEvent` since the client's last-seen `seq` (sent in the WS connect query string `?after_seq=` or first inbound `hello` message) — same DB read as §7.1 but `audience="official"`. Guarantees a scorer who dropped mid-match resyncs to exact state before sending new events. [HIGH — #4.]

### 7.4 Client reconnection policy (SPA)
- `EventSource` reconnects automatically (built-in exponential backoff); we only need correct `id:` lines.
- WS: SPA wraps native `WebSocket` with manual exponential backoff (1s→2s→4s→…→30s cap) + jitter; on reopen, send `{action:"hello", after_seq:<last>}`. Show a "Reconnecting…" indicator (PRD §4 line 558 "reconnect indicator"). [MED.]

---

## 8. The publish contract — `publish.py` (invariant #4, the crux)

**Nothing publishes outside `transaction.on_commit`.** The functions below assume they are called *as* the on_commit callback; they perform NO DB writes.

```python
# apps/live/publish.py
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
import redis  # sync client for the on_commit thread

_redis = redis.Redis.from_url(settings.REDIS_PUBSUB_URL)

def publish_match_event(*, match_id, organization_id, envelope_official, envelope_public):
    layer = get_channel_layer()
    # (a) WS officials via Channels group
    async_to_sync(layer.group_send)(match_ws_group(match_id),
        {"type": "live.event", "envelope": envelope_official})
    # (b) SSE viewers via raw Redis pub/sub (public-audience envelope)
    _redis.publish(f"match:{match_id}", json.dumps(envelope_public))

def publish_notification(*, user_id, envelope):
    _redis.publish(f"user:{user_id}:notifications", json.dumps(envelope))

def publish_genrun_progress(*, genrun_id, envelope):
    _redis.publish(f"genrun:{genrun_id}", json.dumps(envelope))
```

**Call sites (in the owning apps, NOT in apps.live):**

```python
# apps/matches/services.py  (Phase 1B) — illustrative
@transaction.atomic
def record_match_event(match, user, *, event_id, type, payload):
    existing = MatchEvent.objects.filter(event_id=event_id).first()
    if existing:
        return existing                       # idempotent (#3): 200 not 201, no re-publish
    seq = _next_sequence(match)               # FOR UPDATE, gapless
    ev = MatchEvent.objects.create(match=match, organization=match.tournament.organization,
                                   sequence_id=seq, event_id=event_id, type=type,
                                   payload=payload, actor_user=user, server_ts=now(),
                                   event_status="active")
    emit_audit(actor_user=user, actor_role=..., event_type="match_event_recorded",
               target_type="MatchEvent", target_id=ev.id, match_id=match.id,
               organization_id=match.tournament.organization_id,
               idempotency_key=event_id)      # reuse apps.audit.services.emit_audit (verified)
    pub, pubpub = serialize_envelope(ev, "official"), serialize_envelope(ev, "public")
    transaction.on_commit(lambda: publish_match_event(           # ← INVARIANT #4
        match_id=match.id, organization_id=ev.organization_id,
        envelope_official=pub, envelope_public=pubpub))
    return ev
```

Why this shape:
- **DB commit before any publish** (#4, PRD §7.3 line 853-854). If the transaction rolls back, `on_commit` never fires — no phantom event reaches clients. [HIGH.]
- **Idempotent re-submit does not re-publish** — early return on existing `event_id` (#3). Prevents duplicate goals on retry. [HIGH.]
- `emit_audit` reuses the **existing verified service** (`apps/audit/services.py` `emit_audit`, idempotent on `idempotency_key` line 45-48) — no new audit plumbing. [HIGH — file read.]
- The `_redis` publish in `on_commit` runs in the request thread (sync), which is correct: `on_commit` callbacks run synchronously after commit. `async_to_sync(group_send)` bridges to the channel layer. [MED — Channels-documented pattern.]

> **Anti-pattern guard (test-enforced, §9):** a test patches `transaction.on_commit` / forces rollback and asserts `_redis.publish` and `group_send` are NEVER called when the surrounding transaction rolls back. This is the executable proof of invariant #4.

---

## 9. Settings changes — `base.py` / `dev.py` / `prod.py`

### 9.1 Replace `InMemoryChannelLayer` with `channels_redis` (base.py lines 185-188)

Current (verified):
```python
CHANNEL_LAYERS = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
```
**Keep InMemory for tests only; Redis for dev+prod.** Put the real layer in `base.py`, override to InMemory in test settings:

```python
# base.py
REDIS_URL        = env("REDIS_URL", default="redis://localhost:6379/0")
REDIS_PUBSUB_URL = env("REDIS_PUBSUB_URL", default="redis://localhost:6379/1")  # separate DB from channel layer
WS_ALLOWED_ORIGINS = env.list("WS_ALLOWED_ORIGINS", default=["http://localhost:5173"])

CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {"hosts": [env("CHANNEL_REDIS_URL", default="redis://localhost:6379/2")],
                   "capacity": 1500, "expiry": 10},
    },
}
```
- Three Redis logical DBs: `/0` cache (prod cache also moves here — base.py line 191 currently locmem), `/1` raw pub/sub, `/2` channel layer. Keeps namespaces clean. [MED.]
- `pyproject.toml`: add `channels-redis`, `redis[hiredis]`. (`channels` already in `THIRD_PARTY_APPS`, base.py line 38, verified.) [HIGH.]

### 9.2 Test settings override
```python
# fixture/settings/test.py (or pytest fixture)
CHANNEL_LAYERS = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
# SSE pub/sub: use fakeredis or a real redis on CI service container.
```

### 9.3 Cache → Redis in prod (base.py line 191)
Move `CACHES["default"]` to `django_redis` in prod so `effective_modules` cache (resolver.py line 30) and the SSE conn-counter share Redis. This also unblocks the deferred cross-worker cache invalidation TODO in `resolver.py` lines 42-50 (the Redis pub/sub channel `effective_modules_invalidate` can now be implemented here — out of scope but enabled). [MED — resolver.py TODO read.]

---

## 10. Frontend (SPA) — reuse + new

**Reused chassis (verified):** `apiFetch`/`api` (`src/api/client.ts`, `credentials:"include"` line 69), `getCsrfToken` (`src/lib/csrf.ts`), `authStore` (`src/features/auth/authStore.ts`), `queryClient` (`src/api/queryClient.ts`), route registry (`src/lib/routes.ts`), `t()` i18n (`src/lib/t.ts`, #13), `ProtectedRoute` (`src/features/layout/ProtectedRoute.tsx`), existing `ScorerLandingPage`/`RefereeLandingPage` (will host the console).

### 10.1 New transport hooks — `src/lib/live/`
| File | Export | Purpose |
|------|--------|---------|
| `useEventSource.ts` | `useEventSource(url, {onEnvelope})` | wraps `EventSource`; same-origin so cookie rides automatically; parses envelope; tracks `lastEventId`. |
| `useMatchStream.ts` | `useMatchStream(matchId)` | public viewer + dashboard SSE; feeds TanStack Query cache keyed `["match",id,"live"]`; reducer applies `match_event`/`score_update`/`clock`. |
| `useNotificationStream.ts` | `useNotificationStream()` | bell SSE on `/api/live/notifications/stream/`; updates unread badge + list; only mounts when `authStore.user` present. |
| `useMatchSocket.ts` | `useMatchSocket(matchId)` | scorer/referee WS; manual reconnect+backoff (§7.4); `send(action)`; exposes `presence`, `connectionState`. |
| `liveEnvelope.ts` | types mirrored from `envelope.py` (added to `src/types/generated.ts` via drf-spectacular where possible). |

### 10.2 New pages / routes (add to `src/lib/routes.ts` + `App.tsx`)
| Route | Page | Transport | Module gate |
|-------|------|-----------|-------------|
| `/m/:slug/:matchId` (public) | `MatchViewerPage` (new `features/viewer/`) | SSE match | none (public) |
| `/notifications` | `NotificationsPage` (new `features/notifications/`) | SSE notifications | authenticated |
| `/orgs/:slug/scoring/:matchId` | `ScoringConsolePage` (new `features/scoring/`) | **WS** | `scoring.console` module (#12, `HasModule`) |
| `/orgs/:slug/referee/:matchId` | `RefereeReviewPage` | **WS** | `referee.review` module |
| existing `genrun` UI | progress toast | SSE genrun | `tournament.fixtures` |

Notification bell lives in `AppShell.tsx` (existing) — wire `useNotificationStream` there so it streams app-wide. The viewer/console pages render score + clock + event feed; console adds presence roster + "X is editing" banner (driven by `presence` kind) — reuse the existing conflict-banner pattern from `ConflictOfInterestBanner.tsx`. [MED.]

### 10.3 a11y / i18n (#13)
- SSE-driven score updates announced via `aria-live="polite"` region; clock as `role="timer"`. WCAG 2.1 AA on viewer/dashboard (PRD invariant #13; scorer console exempt from full a11y per CLAUDE.md "WCAG … on all non-scorer UIs").
- All strings via `t()`.

---

## 11. Tests to write

Backend (pytest + `channels.testing.WebsocketCommunicator` + httpx async SSE client; PRD §10 line 1016):

| File | Asserts |
|------|---------|
| `test_publish_on_commit.py` | **#4 proof:** publish/group_send NOT called on rollback; called exactly once after commit; idempotent re-submit (same `event_id`) does NOT re-publish (#3). |
| `test_ws_consumer.py` | connect accept for assigned scorer; reject 4401 anon, 4403 non-official, 4404 closed match; `submit_event` routes through `record_match_event` (idempotent); presence join/leave broadcast; backfill on connect replays `>after_seq`. |
| `test_sse_match.py` | public connect (no auth) ok; correct `Content-Type`/`X-Accel-Buffering`; `Last-Event-ID` backfill replays missed `MatchEvent`s in order; heartbeat emitted; public envelope strips privileged keys. |
| `test_sse_notifications.py` | requires auth (401 anon); streams only `request.user`'s channel; backfill = unread+recent; grouping collapse (PRD §5.14 line 716). |
| `test_channel_auth.py` | session cookie populates `scope["user"]`; expired/absent session → reject; OriginValidator rejects foreign origin. |
| `test_backfill.py` | gapless `sequence_id` replay; cold-connect bounded tail; dedupe race window (replay-then-subscribe). |
| `test_isolation.py` (**#2, mandatory per CLAUDE.md + PRD §7.4 line 872**) | user A (Org X) CANNOT: open WS to a Match in Org Y (4403); receive Org Y events on any SSE; subscribe to another user's notification channel; public match SSE never emits privileged-audience keys. |
| `test_ratelimit.py` | >100 SSE conns/IP → 429 (PRD line 908). |

Frontend (vitest + Playwright; PRD line 1016, 1018):
- `useEventSource`/`useMatchStream` reducer unit tests (envelope → score/clock state).
- `useMatchSocket` reconnect-backoff + `hello/after_seq` resume.
- Playwright E2E: two scorer tabs in one room see each other's events + presence; viewer tab receives score update <1s; drop+reconnect backfills.

Load (k6/Locust, PRD line 1025): 5,000 concurrent SSE viewers on one match (PRD §6 line 783, 802).

---

## 12. Build / migration order

1. **Deps:** add `channels-redis`, `redis[hiredis]`, `django-redis` to `backend/pyproject.toml`; `npm i` nothing new (native `EventSource`/`WebSocket`, PRD line 986).
2. **Settings:** `base.py` — add `apps.live` to `LOCAL_APPS` (line 48), swap `CHANNEL_LAYERS` to `channels_redis`, add `REDIS_PUBSUB_URL`/`CHANNEL_REDIS_URL`/`WS_ALLOWED_ORIGINS`; add `test.py` InMemory override.
3. **ASGI:** replace `fixture/asgi.py` with `ProtocolTypeRouter` (§5.2).
4. **`apps.live` skeleton:** `constants.py`, `envelope.py`, `publish.py`, `channels_auth.py` first (pure, testable without matches).
5. **Migration `live.0001`:** `LiveConnectionAudit`, `WSPresence` (#1 UUIDv7, #2 org scope, indexes).
6. **Consumer + routing + SSE views** — but they depend on `apps.matches` (`MatchEvent`, `MatchAssignment`, `Match` state machine). **Therefore `apps.matches` Phase 1B must land first or in parallel** with a stub `record_match_event` service. Recommended order within Phase 1B: `tournaments → teams → fixtures → matches → live → notifications → disputes` (matches CLAUDE.md app list + dependency direction).
7. **Wire publish call sites** into `apps.matches.services` and `apps.notifications.dispatcher` (those apps import `apps.live.publish`).
8. **Frontend:** `src/lib/live/` hooks → viewer page → notifications page → scoring/referee console.
9. **Deploy notes:** systemd `asgi-app` already planned (PRD line 830); nginx must set `proxy_buffering off` / pass `X-Accel-Buffering` for the SSE locations and `proxy_set_header Upgrade/Connection` for `/ws/`. Migration-while-live guard (CLAUDE.md Commands note: migrations blocked while any tournament `live`) applies — the deploy pre-flight already checks this.

---

## 13. Reused chassis (citation index)

| Reused | Where | Used for |
|--------|-------|----------|
| `emit_audit(...)` idempotent on `idempotency_key` | `apps/audit/services.py:24,45` | audit every recorded match event / state transition (#5, #6) without new plumbing |
| `uuid7()` | `apps/accounts/models.py:28` | UUIDv7 PKs on `LiveConnectionAudit`, `WSPresence` (#1) |
| `OrganizationMembership.objects.user_org_ids` / `ScopedQuerySetMixin` | `apps/organizations/models.py:87`, `apps/organizations/scope.py:36` | org-scope checks in WS authz + isolation tests (#2) |
| `effective_modules` / `has_module` / `HasModule(...)` | `apps/permissions/services/resolver.py:107`, `apps/permissions/permissions.py:30` | module-gate the scoring/referee console + genrun SSE (#12) |
| `MatchAssignment` (status=assigned) + double-grant invariant | `v1Users.md §5.7:1174,1198` | WS connect authz |
| `TournamentMembership` | `v1Users.md §4.7:960` | coordinator dashboard SSE scope |
| SessionAuthentication (no JWT) + cookie | `base.py:154`, `client.ts:69` | WS + SSE auth (#15) |
| `channels` app already installed | `base.py:38` | Channels routing |
| `apiFetch`/`api`, `getCsrfToken`, `authStore`, `routes.ts`, `t()`, `ProtectedRoute`, `AppShell`, `ScorerLandingPage`/`RefereeLandingPage` | `frontend/src/...` (verified §10) | SPA transport hooks + console host |
| `_phase-audit.json` / prior audit | `docs/superpowers/audit/` | continuity (this is the deeper live-design pass) |

---

## 14. Open items (flag for review)
- [LOW] `WSPresence` DB-vs-Redis (§3.2). Chosen DB; revisit on volume.
- [LOW] `LiveConnectionAudit` retention (30d?) and whether it belongs in `apps.live` vs `apps.sadmin` (UsageEvent lives in sadmin per CLAUDE.md).
- [MED] Cold-connect tail size N (events to replay before going live) — tune against the 5k-viewer load test.
- [MED] Whether coordinator/TM SSE needs a *privileged* match channel separate from `match:<uuid>` public, or can reuse it with an authenticated `audience="official"` variant. Current design: separate authenticated endpoint reusing the same Redis channel but applying the official serializer. Confirm no public/official cross-bleed in `test_isolation.py`.
- [MED] Genrun progress (`v1Fixtures.md:142`) — confirm the fixtures engine publishes via `publish_genrun_progress` from its background worker's `on_commit` (or per-step, since progress is intentionally not DB-of-record).
