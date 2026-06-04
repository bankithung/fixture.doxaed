# Cross-Cutting Audit — Invariant 11: SSE one-way vs WebSocket two-way separation

**Scope:** Whole backend + frontend (excluding `backend/.venv`, `frontend/node_modules`).
**Invariant under test (#11):** SSE for one-way fan-out (public viewer + notification bell on `user:<uuid>:notifications` and `match:<uuid>`); WebSockets reserved for the bidirectional scorer + referee collaborative-scoring rooms. Don't use WS for the viewer/notifications. Channels scaffold must be correct.
**Related invariants touched:** #4 (DB-first event log; Redis publish only in `transaction.on_commit`), #2 (no cross-org leak via SSE/WS endpoints).
**Date:** 2026-06-04. **Auditor model:** Opus 4.8.

## Summary

The entire live transport layer is **Phase 1B and unimplemented**. There is **no `apps/live/` app, no consumers, no SSE endpoints, no routing, and no client-side `EventSource`/`WebSocket` code anywhere.** Therefore there are **zero substantive violations of the SSE-vs-WS separation** today — you cannot misuse a transport that doesn't exist. The only "live" reference is a marketing label on the landing page.

The meaningful findings are **scaffold-correctness and prep-readiness gaps** that, if left as-is, would force Phase 1B to violate invariants #11 and #4:

1. The ASGI entrypoint is HTTP-only (`get_asgi_application()`), with **no `ProtocolTypeRouter`/`URLRouter`** — so WebSockets cannot be served at all until rewired.
2. `CHANNEL_LAYERS` uses `InMemoryChannelLayer` and the cache is `LocMemCache` — **single-process only**, which silently breaks cross-worker Redis pub/sub fan-out (invariant #4 and #11) the moment more than one ASGI worker runs.
3. `channels-redis` + `daphne` are declared deps but **nothing is wired to Redis** (no `REDIS_URL`, no docker-compose, no prod settings).

None of this **blocks** Phase 1B — the dependencies are present and the chassis is clean — but each is a required pre-flight before live transport lands.

---

## Findings

### F1 — ASGI is HTTP-only; no Channels ProtocolTypeRouter / WebSocket routing
**Severity:** medium (Phase 1B blocker if not fixed; not a 1A defect)
**File:** `backend/fixture/asgi.py:16`
**Evidence:**
```python
application = get_asgi_application()
```
There is no `ProtocolTypeRouter`, no `URLRouter`, no `AuthMiddlewareStack`/`SessionMiddlewareStack` anywhere in the repo (grep across `backend/**/*.py` returned nothing). `ASGI_APPLICATION = "fixture.asgi.application"` (`backend/fixture/settings/base.py:98`) points at this HTTP-only callable.
**Why it matters:** WebSockets (scorer/referee rooms, invariant #11) literally cannot be served until `asgi.py` is converted to a `ProtocolTypeRouter` that routes `"http"` to the Django app and `"websocket"` to an `AuthMiddlewareStack(URLRouter(...))`. Session auth (invariant #15) for WS requires the session middleware stack be added here.
**Recommendation:** When Phase 1B starts, rewrite `asgi.py`:
```python
application = ProtocolTypeRouter({
    "http": get_asgi_application(),
    "websocket": AllowedHostsOriginValidator(
        SessionMiddlewareStack(URLRouter(live.routing.websocket_urlpatterns))
    ),
})
```
Confirm SSE stays as plain DRF/Django `StreamingHttpResponse` (or `django-eventstream`) on the `"http"` branch — do not route the viewer/notification channels through the `"websocket"` branch.

### F2 — InMemoryChannelLayer cannot fan out across workers (breaks #11/#4 multi-worker SSE+WS)
**Severity:** high (for Phase 1B); info (for Phase 1A, intentional)
**File:** `backend/fixture/settings/base.py:185-188`
**Evidence:**
```python
# --- Channels (Phase 1A: in-memory; Phase 1B: Redis) ---------------------
CHANNEL_LAYERS = {
    "default": {"BACKEND": "channels.layers.InMemoryChannelLayer"},
}
```
**Why it matters:** Invariant #4 requires every state-changing action to publish to Redis pub/sub after `transaction.on_commit`, and invariant #11 requires viral SSE fan-out plus WS rooms. `InMemoryChannelLayer` is per-process: with the production target of a single ASGI server it may appear to work in dev, but any multi-worker / multi-process deployment (and the documented async-views + Channels prod stack) will drop cross-worker messages — a scorer's WS write would not reach SSE viewers attached to a different worker. The comment correctly flags this as a Phase-1B swap, so today it is an intentional 1A placeholder, not a bug.
**Recommendation:** Before live transport, switch to `channels_redis.core.RedisChannelLayer` with `CONFIG.hosts = [env("REDIS_URL")]`. Add a CI/runtime guard that **fails startup if `prod` uses `InMemoryChannelLayer`** so this placeholder can never reach production.

### F3 — Cache backend is LocMemCache; no Redis connection configured
**Severity:** medium (Phase 1B prep)
**File:** `backend/fixture/settings/base.py:190-196`
**Evidence:**
```python
# --- Cache (dev: locmem; prod will be Redis) -----------------------------
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "fixture-default-cache",
    },
}
```
**Why it matters:** The permissions resolver already has TODOs to publish `effective_modules_invalidate` to Redis pub/sub for cross-worker cache invalidation (`backend/apps/permissions/services/resolver.py:45-46`, `backend/apps/permissions/services/grants.py:110`). With `LocMemCache` and no Redis, those invalidations and the live pub/sub channel both have no shared backend. This compounds F2: the same missing Redis dependency blocks both the module-grant invalidation and the SSE/WS fan-out.
**Recommendation:** Stand up Redis (see G2/G3) and point `CACHES["default"]` at it (`django.core.cache.backends.redis.RedisCache` or `django-redis`) in the prod settings as part of Phase 1B prep.

### F4 — `channels-redis` / `daphne` declared but unused; no Redis wiring exists
**Severity:** low (info / prep)
**File:** `backend/pyproject.toml:12-15`
**Evidence:**
```toml
  # Async / live (scaffolded for Phase 1B; not used in 1A)
  "channels>=4.1",
  "channels-redis>=4.2",
  "daphne>=4.1",
```
No `REDIS_URL` appears in `backend/.env` or `backend/.env.example` (grep found none), and there is no Redis host in `CHANNEL_LAYERS` or `CACHES`. `redis`/`django-redis` are not direct deps (channels-redis pulls redis-py transitively).
**Why it matters:** Positive finding — the heavy lifting deps are already present and version-pinned, so invariant #11 is **not blocked** by dependency gaps. It is purely a configuration/wiring task. Documenting it so Phase 1B doesn't re-add deps.
**Recommendation:** No action now. In Phase 1B, add `REDIS_URL` to `.env(.example)` and wire `CHANNEL_LAYERS` + `CACHES`.

### F5 — Frontend "Live updates over SSE" is a marketing label only; no transport client exists
**Severity:** info
**File:** `frontend/src/features/landing/LandingPage.tsx:172`
**Evidence:**
```tsx
label={t("Live updates over SSE")}
```
A repo-wide grep of `frontend/src` for `WebSocket` and `EventSource` returns nothing. `frontend/src/api/` contains only REST clients (`auth.ts`, `client.ts`, `orgs.ts`, `permissions.ts`, `audit.ts`, `feedback.ts`, `queryClient.ts`) — no SSE/WS hook.
**Why it matters:** Confirms there is **no client-side violation** of #11 (e.g. no accidental viewer-over-WebSocket). The string correctly promises SSE (one-way) for viewers, matching the invariant. Nothing to fix; this is the spec-correct intent baked into copy ahead of implementation.
**Recommendation:** When building the viewer/notification clients, implement them with the browser `EventSource` API against `match:<uuid>` / `user:<uuid>:notifications` SSE endpoints; reserve `WebSocket` strictly for the scorer/referee feature folders.

### F6 — `transaction.on_commit` pattern is established and correct (supports #4 + #11)
**Severity:** info (positive)
**File:** `backend/apps/audit/services.py:80-87`
**Evidence:**
```python
def emit_audit_on_commit(**kwargs):
    transaction.on_commit(lambda: emit_audit(**kwargs))
```
**Why it matters:** Invariant #4 mandates Redis publish only inside `transaction.on_commit`. The audit layer already models the exact deferral pattern Phase 1B's live publishers must reuse, and `DATABASES["default"]["ATOMIC_REQUESTS"] = True` (`base.py:102`) means request-scoped transactions are in place. The resolver/grants TODOs (`resolver.py:45-46`, `grants.py:110`) name the future Redis publish points. So the architectural seam for "DB commit then publish" already exists — Phase 1B should hang the live pub/sub off `on_commit`, never inside the transaction.
**Recommendation:** None. Reuse this pattern for all `MatchEvent` → Redis publishes.

---

## Gaps (prep work required for invariant #11 in Phase 1B; none block it)

- **G1 — No `apps/live/` app.** Directory absent (`backend/apps/` has accounts, audit, organizations, permissions, sadmin, sports only). No `consumers.py`, no `routing.py`, no SSE endpoint module exist anywhere. *Needed for:* the scorer/referee WS rooms and viewer/notification SSE channels. *Effort:* L. *Blocking #11 implementation:* yes (it IS the implementation), but does not block 1A.
- **G2 — No docker-compose.** CLAUDE.md plans `docker-compose.dev.yml` for Postgres + Redis, but **no compose file exists in the repo** (searched depth 2). Dev has no Redis to point Channels/cache at. *Effort:* S.
- **G3 — No Redis URL anywhere.** Not in `.env`, `.env.example`, settings, or any compose. *Needed for:* `RedisChannelLayer` + Redis cache (F2/F3). *Effort:* S.
- **G4 — No prod settings module.** `backend/fixture/settings/` has only `base.py` + `dev.py`. The "Phase 1B: Redis" swaps (channel layer, cache) and the WS-capable ASGI need a `prod.py`. Without it there is no place to enforce "never `InMemoryChannelLayer` in prod." *Effort:* M.
- **G5 — ASGI rewire pending.** `asgi.py` must become a `ProtocolTypeRouter` with a `SessionMiddlewareStack`-wrapped `URLRouter` for the `"websocket"` scope (F1), keeping SSE on the plain `"http"` scope. *Effort:* M.
- **G6 — No cross-org isolation test harness for SSE/WS.** Invariant #2 requires every endpoint (incl. SSE/WS) prove no cross-org leak. No live endpoints means no such tests yet; the test scaffold (`apps/live/tests/`) must be created alongside G1 to assert (a) a viewer can only subscribe to `match:<uuid>` for accessible orgs, (b) a scorer WS room rejects users outside the match's org, (c) the viewer is never offered a WS transport. *Effort:* M.
- **G7 — Multi-worker fan-out validation.** Once Redis lands, add an integration test that a write on worker A reaches an SSE subscriber on worker B (guards against regressing to `InMemoryChannelLayer`). *Effort:* M.

## Verdict

Invariant #11 is **not violated** in the current (Phase 1A) codebase — the transport split simply isn't built. Phase 1A does **not block** Phase 1B: the deps are pinned, the `on_commit` seam exists, session auth is in place, and the channel-layer comment correctly anticipates the Redis swap. The work remaining is configuration/wiring (Redis, compose, prod settings, ASGI ProtocolTypeRouter) plus building `apps/live/` with the SSE/WS separation and the isolation tests, all tracked in G1-G7.
