# Audit: accounts — FE↔BE contract
**Date:** 2026-06-04  
**Scope:** `backend/apps/accounts/` serializer output shapes, required-field validation, error bodies, auth/permission classes, endpoint coverage.

---

## Findings

### F-01 — HIGH: `/api/accounts/me/` returns 403, not 401, when unauthenticated → premature error banner on /login

**File/line:** `backend/apps/accounts/views.py:416` (`@permission_classes([IsAuthenticated])`) + `frontend/src/types/api.ts:32-44`

**Evidence:**  
Backend: `@permission_classes([IsAuthenticated])` on `me_view`. Django REST Framework's `IsAuthenticated` returns **403 Forbidden** (not 401) for unauthenticated requests when `SessionAuthentication` is the active class — because DRF only emits 401 when `WWW-Authenticate` is in play, which session auth does not supply.

Frontend `ApiError.isUnauthenticated`:
```typescript
get isUnauthenticated(): boolean {
  if (this.status === 401) return true;
  if (this.status === 403) {
    const detail = ... detail.toLowerCase();
    return detail.includes("authentication credentials") || detail.includes("not authenticated");
  }
  return false;
}
```
The DRF 403 body for `IsAuthenticated` is `{"detail": "Authentication credentials were not provided."}`. The `includes("authentication credentials")` branch DOES catch it, so the bus signal fires correctly. **However**, the `bootstrap()` call in `authStore.ts:49-52` only catches `e.status === 401`:
```typescript
if (e instanceof ApiError && e.status === 401) {
  set({ user: null, isLoading: false, bootstrapped: true }); return;
}
```
A 403 from `/me/` falls through to the `else` branch which sets `error: "Bootstrap failed"` — causing an error banner on the `/login` page rather than a clean unauthenticated state.

**Recommendation:** In `authStore.bootstrap()` change the guard to also accept 403 whose body matches the "not provided" pattern:
```typescript
if (e instanceof ApiError && (e.status === 401 || e.isUnauthenticated)) {
  set({ user: null, isLoading: false, bootstrapped: true }); return;
}
```
Separately, add `SessionAuthentication` explicitly to the view and consider `BasicAuthentication` removal from DRF defaults so 401 can be emitted cleanly (requires `WWW-Authenticate` header alignment). Confidence: **high**.

---

### F-02 — HIGH: Signup response shape mismatch — FE expects `{ user: User }`, BE sends `{ status: "pending_verification" }`

**File/line:** `frontend/src/api/auth.ts:55-56` vs `backend/apps/accounts/views.py:148`

**Frontend declares:**
```typescript
signup: (payload: SignupPayload) =>
  api.post<{ user: User }>("/api/accounts/auth/signup/", payload),
```

**Backend sends (all paths):**
```python
return Response({"status": "pending_verification"}, status=status.HTTP_201_CREATED)
```
There is no `user` key in any of the three code paths (fresh, replay, duplicate-email). The frontend type annotation `{ user: User }` is wrong — the actual response is `{ status: string }`.

**Impact:** `SignupPage.tsx` never destructures `user` from the response (it ignores the return value), so the page doesn't crash today. But the declared type is misleading, and any code that tries to access `.user` from `authApi.signup()` will get `undefined` at runtime with no TypeScript error. Also, the OpenAPI spec (`accounts_auth_signup_create`) declares the 201 response as `content?: never` (no body), which does not match the real `{ status: "pending_verification" }` body either.

**Recommendation:** Change `auth.ts:55` to `api.post<{ status: string }>(...)`. Update the `@extend_schema` for `signup` to declare the 201 body as `{"status": "pending_verification"}`. Confidence: **high**.

---

### F-03 — HIGH: Login response body undeclared — OpenAPI schema says `content?: never`; FE depends on `requires_2fa` and `status` fields

**File/line:** `frontend/src/types/api.generated.ts:1395-1399` vs `backend/apps/accounts/views.py:227-253`

**OpenAPI operation** `accounts_auth_login_create` declares:
```typescript
/** @description No response body */
200: { content?: never; }
```

**Backend sends three distinct bodies:**
- `{"requires_2fa": true}` (200) — 2FA gate
- `{"status": "ok"}` (200) — success
- `{"detail": "invalid_credentials"}` (400) — failure
- `{"detail": "account_inactive"}` (403) — inactive
- `{"detail": "invalid_2fa"}` (400) — bad TOTP

**Frontend depends on:**
```typescript
export interface LoginResponse {
  requires_2fa?: boolean;
  user?: User;
}
```
The `authStore` correctly reads `res.requires_2fa` but only because the `apiFetch` client returns the raw JSON regardless of the schema declaration. The OpenAPI spec is lying.

**Recommendation:** Add proper `@extend_schema(responses={...})` to `login_view` covering the 2FA intermediate (`requires_2fa`) and success (`status`) shapes. Fix the generated types accordingly. Confidence: **high**.

---

### F-04 — MEDIUM: `name` field nullability mismatch — BE sends empty string, FE types `name: string` (no null) but `MeSerializer` Meta has `name` writable with no explicit default

**File/line:** `backend/apps/accounts/serializers.py:108-120` / `frontend/src/types/user.ts:84`

Backend `User.name` field: `models.CharField(blank=True)` — default is `""` (empty string, never null). The serializer exposes it. The OpenAPI generated schema (`api.generated.ts:999-1000`) declares `name?: string` (optional, not null). The hand-written `User` type says `name: string` (required, not optional).

When a user creates an account without a `name`, the backend returns `"name": ""`. The FE types cope since `""` satisfies `string`. **However**, `PATCH /me/` with `{ name: "" }` will set an empty string on the model — which is valid by the serializer — but the OpenAPI `PatchedMe` has `name?: string` (optional). The form in `MyProfilePage.tsx:170` calls `saveName.mutate(name.trim())` which can send `""` to the PATCH endpoint; the backend accepts it silently. This is intentional (clearing a name), but there is no length validation lower-bound (empty name is ok but shouldn't it require at least a display label?).

**More pressing:** The `MeSerializer` lists `name` in writable fields (not in `read_only_fields`), but `email` is read-only — this is correct. No bug, but note that `last_active_org_id` is also writable, and the FE `PatchMePayload` correctly allows it.

**Recommendation:** Minor — add `allow_blank=True` explicitly to `MeSerializer` name field for clarity, and note that empty-string name is a valid UX state. No code change required unless product decides to require a non-empty name. Confidence: **medium**.

---

### F-05 — MEDIUM: `verify_email` success response body `{ status: "verified" }` declared as `content?: never` in OpenAPI; FE expects `{ ok: true }`

**File/line:** `backend/apps/accounts/views.py:186` vs `frontend/src/api/auth.ts:57-58`

**Backend sends:** `Response({"status": "verified"})` (200)

**Frontend calls:**
```typescript
verifyEmail: (token: string) =>
  api.post<{ ok: true }>("/api/accounts/auth/verify-email/", { token }),
```
The declared return type `{ ok: true }` is wrong — the real response is `{ status: "verified" }`. `VerifyEmailPage.tsx` ignores the return value entirely (just `await authApi.verifyEmail(token)`) so no runtime crash today. But the type is misleading and the OpenAPI spec says no body.

**Recommendation:** Change `auth.ts:58` return type to `{ status: string }`. Update `@extend_schema` for `verify_email` to include the 200 body. Confidence: **high** (the body mismatch is definite, severity is medium because nothing currently reads the value).

---

### F-06 — MEDIUM: `reauth` and `password_reset_request` success response declared `{ ok: true }` in FE but BE sends `{ status: "ok" }`

**File/line:** `frontend/src/api/auth.ts:59-66, 88`

```typescript
passwordResetRequest: (email: string) =>
  api.post<{ ok: true }>("/api/accounts/auth/password-reset-request/", { email }),
...
reauth: (password: string) =>
  api.post<{ ok: true }>("/api/accounts/auth/reauth/", { password }),
```

Backend `reauth_view` returns `Response({"status": "ok"})` and `password_reset_request_view` also returns `Response({"status": "ok"})`. The declared type `{ ok: true }` does not match `{ status: "ok" }`. Neither page reads the response object so no runtime issue, but the declared type creates silent misleading documentation.

**Recommendation:** Change declared return types to `{ status: string }` for both calls. Confidence: **high** (body mismatch confirmed).

---

### F-07 — MEDIUM: `me_view` PATCH — `last_active_org_id` is writable but NOT validated as UUID or FK against existing Org

**File/line:** `backend/apps/accounts/views.py:423-426` + `backend/apps/accounts/serializers.py:107-132`

`MeSerializer` does not declare `last_active_org_id` as a `UUIDField` explicitly — it inherits from `ModelSerializer` using `Meta.fields`. The model field is `UUIDField(null=True, blank=True)` which DRF will coerce. But there is **no FK constraint and no validation** that the supplied UUID corresponds to an org the user is actually a member of. An attacker could write any UUID to their `last_active_org_id` pointing to another org without error.

The backend audits the change (`payload_before`/`payload_after` in `me_view:425-430`), but never checks org membership. The SPA uses this field to drive the org switcher.

**Recommendation:** Add validation in `MeSerializer.validate_last_active_org_id` (or in `me_view`) that the supplied UUID either is null or belongs to an org where `OrganizationMembership.objects.filter(user=user, organization_id=value, is_active=True).exists()`. Confidence: **high**.

---

### F-08 — MEDIUM: `user_soft_delete_view` uses `@permission_classes([IsAuthenticated])` + manual superuser check instead of DRF's `IsAdminUser`

**File/line:** `backend/apps/accounts/views.py:451-455`

```python
@permission_classes([IsAuthenticated])
def user_soft_delete_view(request, user_id):
    actor = request.user
    if not actor.is_superuser:
        return Response({"detail": "forbidden"}, status=status.HTTP_403_FORBIDDEN)
```

The manual check is correct, but returning `{"detail": "forbidden"}` (403) for a non-superuser differs from the standard DRF error shape that the FE's `ApiError.isPasswordReauthRequired` and `isUnauthenticated` both test against. The FE's `ApiError` reads `payload.detail` so it would render "forbidden" as-is. No functional bug, but inconsistent with DRF conventions. Also, a non-superuser who is authenticated gets 403 with `"forbidden"` rather than 404 (which would be more appropriate to not confirm the user_id exists). This is an IDOR/enumeration risk.

**Recommendation:** Use a DRF custom permission class (`IsSuperUser`) to keep permission logic out of the view body. Return 404 not 403 to non-superusers to avoid confirming the target user exists. Confidence: **medium**.

---

### F-09 — LOW: `SignupPayload` in FE is missing `org_name` and `event_id` fields

**File/line:** `frontend/src/api/auth.ts:31-36`

```typescript
export interface SignupPayload {
  email: string;
  password: string;
  /** Optional. Backend serializer field is `name`. */
  name: string;
}
```

Backend `SignupSerializer` supports: `email`, `password`, `name` (optional), `org_name` (optional), `event_id` (optional UUID).

Frontend `SignupPayload` does not expose `org_name` (the org display name) or `event_id` (the idempotency key). The `SignupPage.tsx` sends `name` but never sends `org_name`, so the org will always be named after the email local-part. This is a product gap, not a crash risk, but means the signup form cannot let users name their organization, which the backend fully supports.

**Recommendation:** Add `org_name?: string` and `event_id?: string` to `SignupPayload`. Wire `org_name` into the signup form if the product requires it. Confidence: **high** (the field omission is certain; severity is low because the form works without it).

---

### F-10 — LOW: Duplicate URL aliases (`verify_email` / `verify-email`, `password_reset_request` / `password-reset-request`) produce duplicate OpenAPI operationIds, confusing drf-spectacular codegen

**File/line:** `backend/apps/accounts/urls.py:17, 26-32`

```python
path("auth/verify_email/", views.verify_email, name="verify_email"),
path("auth/verify-email/", views.verify_email),  # SPA hyphen alias
path("auth/password_reset_request/", ..., name="password_reset_request"),
path("auth/password-reset-request/", views.password_reset_request_view),
path("auth/password_reset_complete/", ..., name="password_reset_complete"),
path("auth/password-reset-complete/", views.password_reset_complete_view),
```

The generated `api.generated.ts` confirms the collision: both `accounts_auth_verify_email_create` and `accounts_auth_verify_email_create_2` appear. The FE correctly calls the hyphen form in all cases. The underscore forms are dead from the FE perspective but remain in the OpenAPI schema as `_2` suffixed operations.

**Recommendation:** Either (a) remove the underscore aliases entirely and update any non-SPA consumers, or (b) annotate the underscore aliases with `@extend_schema(exclude=True)` so they don't appear in the generated schema. Option (b) is safer without checking non-SPA consumers. Confidence: **high**.

---

### F-11 — INFO: `2fa/recovery_codes:regenerate/` URL uses AIP-136 colon syntax — this is a non-standard URL pattern that may confuse some reverse-proxy / WAF configurations and openapi-typescript

**File/line:** `backend/apps/accounts/urls.py:38-41`

```python
path("auth/2fa/recovery_codes:regenerate/", views.twofa_recovery_regenerate_view, name="twofa_recovery_regenerate"),
```

The generated `api.generated.ts` ends up with an operation key `"accounts_auth_2fa_recovery_codes:regenerate_create"` which includes a literal colon. Some TypeScript tooling and bundlers may not handle colons in object property names without quoting. The current generated type wraps it: `"accounts_auth_2fa_recovery_codes:regenerate_create"`. The FE does not directly use the generated operation key here — it calls the URL string directly — so no runtime issue.

**Recommendation:** No immediate action needed. Log as tech-debt if WAF rules are tightened. Confidence: **low**.

---

### F-12 — INFO: `login_view` 403 for `account_inactive` is consumed by `ApiError.isUnauthenticated` on the FE bus — triggers the "session expired" redirect instead of a user-facing "account inactive" error

**File/line:** `backend/apps/accounts/views.py:222-223` vs `frontend/src/types/api.ts:32-44`

```python
if not user.is_active or user.deleted_at is not None:
    return Response({"detail": "account_inactive"}, status=status.HTTP_403_FORBIDDEN)
```

`isUnauthenticated` checks `detail.includes("authentication credentials")` OR `detail.includes("not authenticated")`. "account_inactive" does NOT match either string, so this 403 does NOT trigger the unauthenticated bus event. Good — the error surfaces via `authStore.error`. However, the LoginPage renders `error` as a raw string: `e.payload.detail ?? "Login failed"`, so the user sees the raw machine string `"account_inactive"` rather than a human-readable message.

**Recommendation:** Map known `detail` codes to translated messages in `authStore.login()`: `if (e.payload.detail === "account_inactive") set({error: t("Account is not active. Contact support.")})`. Confidence: **high** (bug is real but UX-only, no data risk).

---

## Gaps (forward-looking, not bugs)

| # | Item | Missing | Blocking |
|---|------|---------|---------|
| G-01 | `POST /api/accounts/auth/signup/` | No `org_name` field in `SignupPage.tsx` form; backend supports it but FE never sends it | No |
| G-02 | `POST /me/` PATCH | No endpoint in `auth.ts` or `api.generated.ts` for changing `email` — currently immutable; if ever added, CSRF + re-verification flow needed | No |
| G-03 | `2FA disable` endpoint | `auth.ts` has no `totpDisable()` function; `TwoFactorEnrollPage` has no disable path; `MyProfilePage` shows "Enabled" badge but no disable button | No |
| G-04 | `2FA recovery codes regenerate` | `auth.ts` has no `regenerateRecoveryCodes()` wrapper; endpoint exists in backend but FE has no consumer | No |
| G-05 | Field-level validation errors | DRF returns `{ field: ["message"] }` shaped errors; `ApiError.payload` types this as `[field: string]: unknown` but all FE error handlers only read `payload.detail`. Multi-field errors (e.g. signup with bad email format) display nothing to the user | Medium priority |
| G-06 | `PATCH /me/` audit trail | `last_active_org_id` is audited but the audit `payload_before` stringifies the UUID only when non-null — `None` becomes `null`; consistent, but the audit log shows raw UUIDs not org slugs, making it hard to read in the sadmin console | No |
| G-07 | OpenAPI login response schema | Login 200 body is `content?: never` in the schema but actually carries JSON; regenerating types will not produce `LoginResponse.requires_2fa` — FE hand-types it correctly in `auth.ts` but the generated type is wrong | Medium priority |
| G-08 | `user_soft_delete` FE consumer | No FE component calls `POST /api/accounts/users/{uuid}:soft_delete/` — this is sadmin-only and the sadmin console is separate, but the API surface is orphaned from the SPA's perspective | No |
