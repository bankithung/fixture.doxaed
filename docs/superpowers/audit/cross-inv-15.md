# Cross-Cutting Audit — Invariant 15: Session Auth (no JWT)

**Invariant 15:** Session auth (no JWT) for the SPA on the same origin. DRF
`SessionAuthentication` + cookies + CSRF token in custom header (`X-CSRFToken`).
Secure/HttpOnly cookie flags. No token-based (JWT/Bearer/DRF-Token) auth anywhere.

**Scope:** entire backend + frontend, excluding `backend/.venv` and
`frontend/node_modules`.

**Date:** 2026-06-04
**Verdict:** Largely COMPLIANT. The auth model is genuinely session-cookie + CSRF
with **zero** JWT/token machinery anywhere in the tree. Two real CSRF-protection
regressions were found in the Super-admin JSON verbs (`@csrf_exempt`), and one
session-auth-adjacent client bug (DRF returns 403 not 401 for anonymous, and the
auth bootstrap mishandles it). Phase 1B live-transport (Channels/SSE) session
auth is not yet wired, but 1A does not block it.

---

## Findings

### F-01 — HIGH: `@csrf_exempt` on Super-admin `bulk_email_api` (CSRF protection removed on a cookie-authenticated mutation)

**File:** `backend/apps/sadmin/views/superadmin.py:45-48`

**Evidence:**
```python
@superadmin_required
@require_POST
@csrf_exempt
def bulk_email_api(request: HttpRequest) -> HttpResponse:
    """POST /sadmin/api/bulk-email/
```

**Why it matters:** Invariant 15 mandates session-cookie auth with the CSRF token
echoed in `X-CSRFToken`. This endpoint is authenticated purely by the Django
session cookie (via `@superadmin_required`, which reads `request.user`), yet
`@csrf_exempt` strips CSRF enforcement. That is the textbook CSRF setup: a
state-changing POST authenticated by an ambient cookie with no anti-CSRF token.
`SESSION_COOKIE_SAMESITE = "Lax"` (base.py:146) is partial mitigation only — Lax
does not cover all cross-site POST vectors (open-redirect / same-site subdomain
trickery). A successful forgery here triggers a platform-wide bulk-email blast
(highest-blast-radius Super-admin verb).

The exemption is also **unnecessary**: the entire HTMX console already injects
`X-CSRFToken` on every request via `_base.html` (the `htmx:configRequest`
listener at lines 14-17 and `hx-headers` at line 23), so this endpoint would
function correctly WITH CSRF protection. The exemption is a pure, gratuitous
security regression.

**Recommendation:** Delete the `@csrf_exempt` decorator. The HTMX caller already
sends `X-CSRFToken`; for any non-HTMX JSON caller, include the token from the
`csrftoken` cookie / `{% csrf_token %}`. No other change needed.

**Confidence:** High

---

### F-02 — HIGH: `@csrf_exempt` on Super-admin `archive_feedback_api` (same regression)

**File:** `backend/apps/sadmin/views/superadmin.py:95-100`

**Evidence:**
```python
@superadmin_required
@require_POST
@csrf_exempt
def archive_feedback_api(
    request: HttpRequest, feedback_id: uuid.UUID
) -> HttpResponse:
    """POST /sadmin/api/feedback/<uuid>:archive/
```

**Why it matters:** Identical to F-01. Cookie-authenticated, state-changing POST
(it mutates a `Feedback` row and writes an audit row) with CSRF disabled. Lower
blast radius than bulk-email but still a forgeable mutation that violates
invariant 15's CSRF requirement.

This is also internally **inconsistent**: the sibling HTML triage verb
`feedback_triage` (`backend/apps/sadmin/views/feedback.py:82-84`) is `@require_POST`
WITHOUT `@csrf_exempt` and works fine, as do `user_verb`
(`users.py:70-72`), `impersonate_stop` (`users.py:119-121`), and `sadmin_logout`
(`auth.py:57-58`). Only these two `/sadmin/api/` verbs are exempted, with no
justifying reason.

**Recommendation:** Delete `@csrf_exempt`. Same fix as F-01.

**Confidence:** High

---

### F-03 — MEDIUM: Auth bootstrap treats DRF's 403-for-anonymous as a hard error (premature error banner on `/login`)

**File:** `frontend/src/features/auth/authStore.ts:44-60`

**Evidence:**
```typescript
bootstrap: async () => {
  set({ isLoading: true, error: null });
  try {
    const me = await authApi.me();
    set({ user: me, isLoading: false, bootstrapped: true });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {       // <-- only 401
      set({ user: null, isLoading: false, bootstrapped: true });
      return;
    }
    set({
      user: null, isLoading: false, bootstrapped: true,
      error: e instanceof Error ? e.message : "Bootstrap failed",   // <-- 403 lands here
    });
  }
},
```

**Why it matters:** This is a direct consequence of invariant 15's transport
choice. DRF `SessionAuthentication` + `IsAuthenticated` returns **403, not 401**,
for an unauthenticated request (it sends no `WWW-Authenticate` header). This is
confirmed by the backend's own test:
`backend/apps/audit/tests/test_audit_list_view.py:240` —
`# IsAuthenticated → 403 with DRF SessionAuth + no creds.` and the assertion
`assert resp.status_code in (401, 403)`.

So a logged-out visitor's `GET /api/accounts/me/` bootstrap returns 403, which
this code does NOT recognise as "logged out" — it falls into the `else` branch
and sets `error`, surfacing an error banner on the login page for an entirely
normal anonymous state.

The correct predicate already exists and is unused here: `ApiError.isUnauthenticated`
(`frontend/src/types/api.ts:32-45`) handles both 401 and 403-with-auth-detail.
The query bus uses it correctly (`frontend/src/api/queryClient.ts:38`:
`if (error.isUnauthenticated) emit({ type: "unauthenticated" })`), so `bootstrap`
is the lone inconsistent caller.

**Recommendation:** In `bootstrap`'s catch, replace the
`e instanceof ApiError && e.status === 401` check with
`e instanceof ApiError && e.isUnauthenticated`. (Better long-term: make the
backend return 401 for anonymous via a custom `SessionAuthentication.authenticate_header`
or a small exception handler, so 401/403 semantics match HTTP norms — but the
client-side fix is the minimal correct change and aligns `bootstrap` with the rest
of the app.)

**Confidence:** High

---

### F-04 — INFO: Invariant wording says "custom header" but implementation uses Django/DRF default `X-CSRFToken` (no `CSRF_HEADER_NAME` set)

**Files:**
- `backend/fixture/settings/base.py:148-149` (CSRF cookie config; no `CSRF_HEADER_NAME`)
- `frontend/src/api/client.ts:59-61` (`headers.set("X-CSRFToken", csrf)`)
- `frontend/src/lib/csrf.ts:8-12` (reads `csrftoken` cookie)

**Evidence (base.py):**
```python
CSRF_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_HTTPONLY = False  # JS reads token for SPA + HTMX
```
No `CSRF_HEADER_NAME` override is present anywhere in settings.

**Why it matters:** The invariant text says "CSRF token in **custom** header."
The code uses `X-CSRFToken`, which is Django's *default* header name
(`CSRF_HEADER_NAME = "HTTP_X_CSRFTOKEN"` is the framework default). This is not a
defect — `X-CSRFToken` is correct and matched on both ends — but "custom" is a
misnomer. The intent of the invariant is plainly "no JWT/Bearer; use the standard
session+CSRF flow," which is satisfied. Flagging only so the wording isn't
misread as requiring a non-default header name.

**Recommendation:** No code change. Optionally clarify the invariant doc to say
"CSRF token in the `X-CSRFToken` header" (drop "custom"), or explicitly set
`CSRF_HEADER_NAME` if a non-default name is ever truly wanted. Low priority.

**Confidence:** High

---

### F-05 — INFO (positive verification): No JWT / token / Bearer / DRF-Token auth anywhere

**Evidence:**
- `backend/fixture/settings/base.py:152-155` — DRF `DEFAULT_AUTHENTICATION_CLASSES`
  is exactly `["rest_framework.authentication.SessionAuthentication"]`. No
  `TokenAuthentication`, `BasicAuthentication`, or JWT class.
- `backend/pyproject.toml:6-41` — dependency list has **no** `djangorestframework-simplejwt`,
  `django-rest-knox`, `pyjwt`, or `rest_framework.authtoken`. `rest_framework.authtoken`
  is also absent from `INSTALLED_APPS` (base.py:35-55).
- The only `JWT` strings in the backend are a PII-scrubber regex:
  `backend/apps/sadmin/services/feedback.py:22` (`re.compile(r"\beyJ...")  # JWTs`)
  and its docstring at `:29` — these *strip* JWT-shaped strings from feedback
  bodies; they are not auth code.
- Frontend: grep for `localStorage|sessionStorage|access_token|refresh_token|Bearer|Authorization`
  across `frontend/src` returns **no matches**. Auth state lives only in the
  Django session cookie + the in-memory Zustand store; nothing is persisted to web
  storage. `pendingCredentials` is module-scoped and deliberately kept out of
  Zustand/devtools (`authStore.ts:30-35`).

**Why it matters:** Confirms the core of invariant 15 ("no JWT") holds with no
exceptions.

**Confidence:** High

---

### F-06 — INFO (positive verification): Same-origin SPA flow, CSRF header on unsafe verbs, secure cookie flags

**Evidence:**
- Cookie flags (`backend/fixture/settings/base.py:144-149`):
  `SESSION_COOKIE_SECURE = not DEBUG`, `SESSION_COOKIE_HTTPONLY = True`,
  `SESSION_COOKIE_SAMESITE = "Lax"`, `CSRF_COOKIE_SECURE = not DEBUG`,
  `CSRF_COOKIE_HTTPONLY = False` (intentional — SPA/HTMX JS must read the token).
  Flags are correct: session cookie is HttpOnly + Secure-in-prod; CSRF cookie is
  Secure-in-prod and readable by JS by design.
- `MIDDLEWARE` includes `django.middleware.csrf.CsrfViewMiddleware` (base.py:65)
  and `SessionMiddleware` (base.py:63) — CSRF enforcement is globally active.
- Client attaches CSRF on exactly the unsafe verbs:
  `frontend/src/api/client.ts:4` (`UNSAFE_METHODS = POST/PUT/PATCH/DELETE`) and
  `:59-61` (set `X-CSRFToken` when not skipped). Tests assert GET omits it and
  POST/PATCH/PUT/DELETE attach it (`frontend/src/api/__tests__/apiFetch.test.ts:32-72`).
- `credentials: "include"` is sent on every request (`client.ts:69`) so the
  session cookie travels.
- Same-origin is preserved in dev via the Vite proxy
  (`frontend/vite.config.ts:14-28`: `/api` and `/sadmin` → `http://localhost:8000`),
  satisfying invariant 15's "same origin" clause without CORS credential leakage.
  `CORS_ALLOW_CREDENTIALS = True` is scoped to explicit localhost origins only
  (`dev.py:11-16`), and `CSRF_TRUSTED_ORIGINS` mirrors them (`dev.py:21`).
- HTMX console attaches CSRF globally: `backend/apps/sadmin/templates/sadmin/_base.html:14-17`
  (`htmx:configRequest` listener) and `:23` (`hx-headers`); every HTML form uses
  `{% csrf_token %}`.
- `login` is correctly NOT skipping CSRF (`frontend/src/api/auth.ts:52-53` calls
  `api.post` with no `skipCsrf`); DRF `SessionAuthentication` enforces CSRF on
  unsafe verbs even under `@permission_classes([AllowAny])`, so login must carry
  the token — and it does.

**Why it matters:** Confirms the session+CSRF half of invariant 15 is implemented
correctly across both ends.

**Confidence:** High

---

## Gaps (Phase 1B prep — not violations; 1A does not block them)

### G-01 — Live transport (Channels/SSE) session auth is not wired yet
- **Current state:** `backend/fixture/asgi.py:16` is a bare
  `application = get_asgi_application()` — no `ProtocolTypeRouter`, no
  `AuthMiddlewareStack`, no WebSocket URL routing. There is **no** `apps/live/`
  package on disk (glob `backend/apps/live/**/*.py` → no files), so no WS
  consumers or SSE endpoints exist.
- **Missing:** For invariant 15 to extend to the scorer/referee WebSocket rooms
  and the public SSE channels (invariants 11/4), ASGI must wrap WS routing in
  Channels' `AuthMiddlewareStack` (or `SessionMiddlewareStack`) so the same
  Django session cookie authenticates the socket — and SSE endpoints (served as
  DRF/async views) must reuse `SessionAuthentication`. No JWT/query-token auth
  should be introduced for sockets.
- **Needed for:** Phase 1B live scoring + public viewer.
- **Blocking 1A?** No. 1A ships no live transport. The dependency
  `channels-redis>=4.2` is already declared (`pyproject.toml:14`) but the dev
  `CHANNEL_LAYERS` is still `InMemoryChannelLayer` (base.py:186-188) — fine for
  1A; must move to channels-redis before 1B live work (separate invariant 4/11
  concern, noted here for completeness).
- **Effort:** M

### G-02 — DRF returns 403 (not 401) for anonymous; only client-side worked around
- **Current state:** The 403-for-anonymous behavior is intrinsic to
  `SessionAuthentication` (confirmed by `test_audit_list_view.py:240`). F-03 fixes
  the one mishandling caller, but the backend still emits 403 platform-wide for
  unauthenticated requests.
- **Missing:** Optional but cleaner: a custom auth class / DRF exception handler
  that returns 401 for unauthenticated and reserves 403 for authenticated-but-
  forbidden, matching HTTP semantics. This would make future API consumers
  (Phase 1B mobile/SSE clients) behave correctly without each re-implementing the
  401-or-403 heuristic.
- **Needed for:** Cleaner API contract; reduces risk of repeating the F-03 bug.
- **Blocking 1A?** No.
- **Effort:** S

### G-03 — No `prod.py` settings module yet; cookie `Secure` flags depend on `DEBUG`
- **Current state:** Only `base.py` and `dev.py` exist
  (glob `backend/fixture/settings/prod*.py` → none).
  `SESSION_COOKIE_SECURE`/`CSRF_COOKIE_SECURE = not DEBUG` (base.py:144,148) mean
  the flags are correct as long as prod sets `DEBUG=False`. There is no prod
  settings file to assert `DEBUG=False`, `SESSION_COOKIE_DOMAIN`, and HTTPS
  hardening (`SECURE_SSL_REDIRECT`, `SESSION_COOKIE_SAMESITE` revisit for the
  `sadmin.` subdomain split).
- **Missing:** `prod.py` that locks `DEBUG=False`, sets cookie domain/HSTS, and
  CI assertion that prod cookies are Secure + HttpOnly.
- **Needed for:** Production deploy.
- **Blocking 1A?** No (dev runs fine; PRD says VPS deploy is later).
- **Effort:** S

---

## Summary

Invariant 15's foundation is solid: pure Django session-cookie auth, DRF
`SessionAuthentication` only, no JWT/token/Bearer anywhere, CSRF token echoed in
`X-CSRFToken` on unsafe verbs with correct Secure/HttpOnly flags, and same-origin
preserved via the Vite proxy. Two HIGH findings (F-01, F-02) are unnecessary
`@csrf_exempt` decorators on Super-admin JSON mutations that re-open CSRF on
cookie-authenticated writes — both are trivially removable since the HTMX shell
already supplies the token. One MEDIUM (F-03) is the well-known DRF
403-not-401-for-anonymous behavior mishandled only in `authStore.bootstrap`,
causing the premature error banner on `/login`; the fix is to use the existing
`ApiError.isUnauthenticated` getter. Remaining items are Phase 1B prep gaps
(Channels session auth, 401/403 contract, prod settings) that 1A does not block.
