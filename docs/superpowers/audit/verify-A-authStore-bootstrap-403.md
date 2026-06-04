# Adversarial Verify A — authStore.bootstrap() 401-only short-circuit

**Finding:** `bootstrap()` only short-circuits 401; DRF returns 403 for unauthenticated — sets error banner on /login
**File:** `frontend/src/features/auth/authStore.ts:49`
**Claimed severity:** high
**Verdict:** REAL — severity downgraded to **medium**
**Confidence:** high

## What the code actually shows

`frontend/src/features/auth/authStore.ts:44-60` — bootstrap:

```ts
bootstrap: async () => {
  set({ isLoading: true, error: null });
  try {
    const me = await authApi.me();
    set({ user: me, isLoading: false, bootstrapped: true });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {   // line 50
      set({ user: null, isLoading: false, bootstrapped: true });
      return;
    }
    set({                                              // lines 54-59 — fallthrough
      user: null,
      isLoading: false,
      bootstrapped: true,
      error: e instanceof Error ? e.message : "Bootstrap failed",
    });
  }
},
```

The short-circuit branch tests ONLY `e.status === 401`. Any other status (including 403)
falls through and sets `error`.

`authApi.me()` calls `GET /api/accounts/me/` (`frontend/src/api/auth.ts:51`).
`frontend/src/api/client.ts:76-77` throws `ApiError(res.status, payload)` on any non-2xx,
so the thrown error carries the raw HTTP status.

## Backend confirms 403, not 401, for unauthenticated

`backend/fixture/settings/base.py:153-157`:
```py
"DEFAULT_AUTHENTICATION_CLASSES": [
    "rest_framework.authentication.SessionAuthentication",
],
"DEFAULT_PERMISSION_CLASSES": [
    "rest_framework.permissions.IsAuthenticated",
],
```

`backend/apps/accounts/views.py:416-418` — the `/me/` endpoint:
```py
@api_view(["GET", "PATCH"])
@permission_classes([IsAuthenticated])
def me_view(request: Request) -> Response:
```

DRF rule: with `SessionAuthentication` (which does not implement `authenticate_header()`,
so emits no `WWW-Authenticate`), a failed `IsAuthenticated` check yields **403 Forbidden**,
not 401. The codebase itself documents this in two places:

- `backend/apps/audit/tests/test_audit_list_view.py:239-241`
  ```py
  resp = client.get(url)
  # IsAuthenticated → 403 with DRF SessionAuth + no creds.
  assert resp.status_code in (401, 403)
  ```
- `backend/apps/sadmin/tests/test_feedback_submit.py:83-84`
  ```py
  # IsAuthenticated → 403 with DRF SessionAuth + no creds.
  assert resp.status_code in (401, 403)
  ```

So the realistic unauthenticated bootstrap path returns 403, the 401 branch is skipped,
and `error` gets set on the normal "not logged in" path — exactly as the finding states.

## Severity assessment

Downgraded high → medium. Justification:
- It IS a real defect on the hottest path (every fresh/logged-out visitor hits bootstrap).
- BUT it is purely cosmetic/UX: lines 55-57 still set `user: null` and `bootstrapped: true`,
  so route-guarding and redirect-to-login still work correctly. The only leakage is a
  spurious `error` string (e.g. a 403 "detail" message) populating the auth error banner.
- No auth bypass, no data exposure, no broken gating. Blast radius = one stray error banner.

A medium-severity, easy fix: broaden the short-circuit to `e.status === 401 || e.status === 403`.
