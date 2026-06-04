# Cross-cutting audit — Invariant 4 (DB-first event log; Redis publish only inside `transaction.on_commit`)

**Invariant 4 (verbatim):** `MatchEvent` rows in Postgres are the system of record. WebSocket and SSE are delivery only. Every state-changing action publishes to Redis pub/sub *after* the DB transaction commits (`transaction.on_commit`).

**Scope reviewed:** entire `backend/` (excluding `.venv`) and `frontend/src` (excluding `node_modules`).

**Headline:** The literal subject of invariant 4 — Redis pub/sub fan-out for live match events — does **not exist yet**. It belongs to Phase 1B apps (`live`, `notifications`, `matches`) that are not built. There are **zero** `get_channel_layer` / `group_send` / `async_to_sync` / `.publish()` / direct-Redis calls anywhere in app code (`backend/apps`). So there is no *direct* violation of "publish before commit" because there is nothing publishing at all.

However, Phase 1A **does** contain the analogous pattern the invariant exists to prevent — a non-DB side-effect (transactional email, the 1A stand-in for "Redis publish") fired **inside** `transaction.atomic()` rather than in `transaction.on_commit`. This is recorded as a real finding because (a) it is a present bug, and (b) it is the exact muscle-memory that, if copy-pasted into the Phase 1B scorer flow, becomes a hard invariant-4 violation. Plus several Phase-1A **prep gaps** that will block invariant 4 when Phase 1B lands (InMemoryChannelLayer, LocMemCache, plain `get_asgi_application()`, missing docker-compose, no prod settings).

---

## Findings

### F1 — `send_mail` fires INSIDE `transaction.atomic()` in the invitation verb (side-effect before commit)
- **Severity:** high
- **File:** `backend/apps/organizations/services/invitation.py:188-225`
- **Evidence:**
  ```python
  with transaction.atomic():                       # line 188
      inv = AdminInvitation.objects.create(...)    # line 189
      emit_audit(...)                              # line 196
      # Send token to the invitee. Console backend in dev.
      try:
          send_mail(                               # line 213 — STILL INSIDE the atomic block
              subject=f"You've been invited to {org.name}",
              ...
              fail_silently=True,
          )
      except Exception:
          pass
  ```
- **Why it matters:** `send_mail` is dispatched while the transaction is still open. If anything after `send_mail` (or in an enclosing transaction/`ATOMIC_REQUESTS`) rolls back, the invite email — carrying a one-time acceptance token — has already gone out for an `AdminInvitation` row that no longer exists. This is the identical failure mode invariant 4 forbids for Redis ("publish references a row that didn't commit"). The codebase already has the correct primitive (`emit_audit_on_commit` in `apps/audit/services.py:80`) and the sibling lifecycle module explicitly notes side-effects are deferred — this verb just didn't follow it.
- **Recommendation:** Move the `send_mail` out of the `with transaction.atomic():` block into `transaction.on_commit(lambda: send_mail(...))`. Capture `plaintext`, `email`, `org.name`, `inv.expires_at` into locals first (the lambda must not touch the unsaved instance). This makes the email a post-commit delivery, exactly mirroring the Redis pattern Phase 1B must use.

### F2 — `request_password_reset` sends email immediately after a bare `.create()` (no `on_commit`, no atomic wrapper)
- **Severity:** medium
- **File:** `backend/apps/accounts/services/password_reset.py:92-113`
- **Evidence:**
  ```python
  token = PasswordResetToken.objects.create(   # line 92 — no transaction.atomic, no on_commit
      user=user,
      token_hash=_hash_token(plaintext),
      ...
  )
  reset_link = f"/auth/reset?token={plaintext}"
  try:
      send_mail(                               # line 101 — fires regardless of commit outcome
          subject="Reset your Fixture Platform password",
          ...
      )
  ```
- **Why it matters:** Outside a request that runs under `ATOMIC_REQUESTS` this happens to auto-commit per statement, so the row is usually durable before the email. But under any wrapping transaction (test harness, future `ATOMIC_REQUESTS=True`, a caller that wraps the verb) the reset email — again carrying a one-time token — can be sent for a token row that gets rolled back. Same class of defect as F1, lower likelihood today. The service does not use `transaction.on_commit`.
- **Recommendation:** Wrap the `create()` in `transaction.atomic()` and dispatch the email via `transaction.on_commit`. Treat "token created → email" as a single post-commit delivery step, the canonical invariant-4 shape.

### F3 — Signup verification email: confirm it is post-commit (likely OK, verify)
- **Severity:** low
- **File:** `backend/apps/accounts/views.py:108-148`
- **Evidence:** The view calls `signup_svc.perform_signup(...)` (line 108) and only afterwards, in the view body (outside any visible `transaction.atomic()`), calls `send_mail(...)` (line 133). The email is sent after the service returns, so the token row is committed first — this is the *correct* ordering.
- **Why it matters:** This is the one place that already does the right thing (side-effect after the DB write returns). Logging it as the positive baseline. The only residual risk is if a future refactor moves this `send_mail` into `perform_signup`'s transaction — that would regress to the F1 pattern. Confidence that the service itself does not also send mail: the only `send_mail` grep hits are the three audited here, so the service does not double-send.
- **Recommendation:** No change required. When Phase 1B introduces a notification dispatcher, route this email through the same `on_commit` dispatcher rather than inline `send_mail`, for consistency.

### F4 — `transaction.on_commit` helper exists and is correct, but is unused in the side-effect paths that need it
- **Severity:** info
- **File:** `backend/apps/audit/services.py:80-87`
- **Evidence:**
  ```python
  def emit_audit_on_commit(**kwargs):
      """Defer audit emission until transaction commit. ..."""
      transaction.on_commit(lambda: emit_audit(**kwargs))   # line 87
  ```
- **Why it matters:** The project already ships the exact deferral primitive invariant 4 mandates, and the docstring shows the team understands the "persist before side-effect" rule. Audit rows are correctly emitted *inline* (they must share atomicity with the state change — that is intentional and correct per v1Users.md B.4). The gap is only that the **email** side-effects (F1, F2) don't reuse this same `on_commit` discipline. No live/Redis caller uses it yet because Phase 1B doesn't exist.
- **Recommendation:** Keep `emit_audit_on_commit` for audit-after-commit cases, and add an analogous `notify_on_commit` / publish helper in the future `apps/live` so every Redis publish is funnelled through one `transaction.on_commit` chokepoint that can be lint-enforced.

---

## Gaps (Phase 1B prerequisites for invariant 4 — none block, but all must land before live)

### G1 — `CHANNEL_LAYERS` uses `InMemoryChannelLayer` (cannot fan out across processes)
- **File:** `backend/fixture/settings/base.py:185-188`
- **Evidence:** `"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}` — comment self-documents: `# --- Channels (Phase 1A: in-memory; Phase 1B: Redis)`.
- **Missing for inv-4:** `channels_redis.core.RedisChannelLayer` pointing at Redis. In-memory cannot deliver a post-commit publish to SSE/WS subscribers in another worker/process. `channels-redis>=4.2` is already declared in `backend/pyproject.toml:14`, so only configuration is missing.
- **Blocking?** No (no consumers exist). Required before any live delivery. Effort: S.

### G2 — `CACHES` uses `LocMemCache` (per-process; rate-limit + health probe + any Redis-backed coordination won't share state)
- **File:** `backend/fixture/settings/base.py:190-196`
- **Evidence:** `"BACKEND": "django.core.cache.backends.locmem.LocMemCache"` — comment: `# --- Cache (dev: locmem; prod will be Redis)`.
- **Missing for inv-4:** A shared Redis cache. The sadmin health probe (`apps/sadmin/services/superadmin_verbs.py:445-452`) currently "pings Redis" by round-tripping through `django.core.cache`, which is LocMem — so `info["redis"]` reports the local-memory cache, not real Redis. Password-reset rate limiting (`apps/accounts/services/password_reset.py:71-83`) is also per-process under LocMem.
- **Blocking?** No. Effort: S.

### G3 — `asgi.py` uses plain `get_asgi_application()` — no `ProtocolTypeRouter` / `URLRouter`
- **File:** `backend/fixture/asgi.py` (whole file) and `backend/fixture/settings/base.py:98` (`ASGI_APPLICATION = "fixture.asgi.application"`)
- **Evidence:** `application = get_asgi_application()` — HTTP only. `channels` is in `INSTALLED_APPS` (`base.py:38`) but nothing routes `websocket` scope.
- **Missing for inv-4:** A Channels `ProtocolTypeRouter({"http": ..., "websocket": ...})` plus per-app `routing.py`. Without it the WS scorer/referee rooms (and SSE endpoints) have no entry point, so the post-commit publish has no subscriber transport.
- **Blocking?** No (Phase 1B). Effort: M.

### G4 — No production settings module; InMemory/LocMem are the only configured backends in any environment
- **File:** `backend/fixture/settings/` — only `__init__.py` (empty), `base.py`, `dev.py`. `dev.py` does NOT override `CHANNEL_LAYERS` or `CACHES`.
- **Evidence:** `backend/fixture/settings/dev.py:1-49` overrides CORS/CSRF/email/logging only; `asgi.py` hardcodes `DJANGO_SETTINGS_MODULE = "fixture.settings.dev"`.
- **Missing for inv-4:** A `prod.py` (or env-driven) settings that wire `RedisChannelLayer` + Redis cache and select a real ASGI server (daphne/uvicorn). `daphne` is not in INSTALLED_APPS either.
- **Blocking?** No. Effort: M.

### G5 — Documented `docker-compose.dev.yml` (Postgres + Redis) does not exist
- **File:** repo root (expected `docker-compose.dev.yml`; CLAUDE.md repo-layout claims it).
- **Evidence:** No `docker-compose*` file exists anywhere in the repo (searched root + depth 2, excluding `.venv`/`node_modules`). Backend README has zero Redis/channels references.
- **Missing for inv-4:** A Redis 7 service for local dev so the Redis channel layer + cache can run. Without it, "publish after commit" cannot be exercised locally.
- **Blocking?** No. Effort: S.

### G6 — The literal invariant-4 subject is entirely unbuilt: `MatchEvent`, `apps/live`, `apps/notifications`, `apps/matches`
- **File:** `backend/apps/` — only `accounts`, `audit`, `organizations`, `permissions`, `sadmin`, `sports` exist.
- **Evidence:** `ls backend/apps` shows no `live`, `notifications`, `matches`, `fixtures`, `tournaments`, `teams`, `disputes`. No `MatchEvent` model, no SSE `StreamingHttpResponse`, no consumers. Frontend has no `EventSource`/`WebSocket` client code (`frontend/src` grep: no matches).
- **Missing for inv-4:** Everything the invariant governs (DB-first `MatchEvent` log + `transaction.on_commit` publish to Redis + SSE/WS delivery). This is correct — it is Phase 1B.
- **Blocking?** Phase 1A does NOT block it. The `on_commit` primitive (F4), idempotent `event_id` plumbing, and audit-after-commit discipline are already present to build on. Effort to implement inv-4 properly in 1B: XL.

---

## Summary

- **Direct invariant-4 violations:** none today (no Redis publisher exists).
- **Present analog defects (same failure class):** F1 (high — invite email inside `atomic()`), F2 (medium — reset email without `on_commit`).
- **Correct baselines to preserve:** F3 (signup email is post-return), F4 (`emit_audit_on_commit` helper + inline audit atomicity).
- **Prep gaps that must close before Phase 1B live transport:** G1–G6 (in-memory channel layer, locmem cache, plain ASGI, no prod settings, missing docker-compose, and the unbuilt live/match stack). Phase 1A does not architecturally block invariant 4; it leaves the right hooks in place but also leaves two copy-paste-able side-effect-before-commit patterns that should be fixed so they don't become the template for the scorer flow.
