# Sadmin FE↔BE Contract Audit

**Date:** 2026-06-04  
**Scope:** `backend/apps/sadmin` — serializer output shapes, required-field validation, error bodies, auth/permission classes, endpoint consumers.

---

## Summary

The `sadmin` module has one real JSON contract between the SPA and the backend: `POST /api/feedback/submit/`. The three sadmin-console JSON endpoints (`/sadmin/api/*`) have NO React SPA consumers — they are wired but orphaned from the React frontend. The most critical finding is a field name mismatch (`source_url` → `page_url`) that silently drops the page URL from every feedback row. A secondary high-severity finding is that the spec requires anonymous feedback submission but `IsAuthenticated` blocks it. The generated TypeScript type incorrectly marks `category` as required, and the hand-authored `FeedbackSubmitResponse` declares a phantom `ok` field that the backend never sends.

---

## Findings

### F-1 — Field name mismatch: FE sends `source_url`, BE reads `page_url`

**Severity:** HIGH  
**File:** `frontend/src/api/feedback.ts:14` and `backend/apps/sadmin/serializers.py:30`

**Evidence (FE):**
```ts
// frontend/src/api/feedback.ts:14
source_url?: string;
```
```ts
// frontend/src/features/layout/OrgDashboardPage.tsx:82
source_url: typeof window !== "undefined" ? window.location.pathname : undefined,
```

**Evidence (BE):**
```python
# backend/apps/sadmin/serializers.py:30
page_url = serializers.CharField(max_length=2048, required=False, allow_blank=True)
```
```python
# backend/apps/sadmin/views/feedback.py:157
page_url = data.get("page_url") or ""
```

**Why it matters:** Every feedback submission silently sends `source_url` which the BE serializer ignores (it reads `page_url`). The page URL is never appended to the feedback body. The field simply evaporates. The backend backend test at `test_feedback_submit.py:31` uses the correct key `page_url`, confirming the backend expectation.

**Recommendation:** Rename `source_url` → `page_url` in `frontend/src/api/feedback.ts` and in `OrgDashboardPage.tsx`. Alternatively, accept both in the serializer (add `source_url` as an alias), but field rename is cleaner.

---

### F-2 — Anonymous feedback blocked; spec requires it to work

**Severity:** HIGH  
**File:** `backend/apps/sadmin/views/feedback.py:132`

**Evidence (view):**
```python
# backend/apps/sadmin/views/feedback.py:132
permission_classes = [IsAuthenticated]
```

**Evidence (spec):**
```
# docs/superpowers/specs/v1Users.md:1928
Submit anonymous feedback via the Feedback widget (`personal.feedback_widget` is
accessible to Viewers; `Feedback.user_id` is nullable per §1.7).
```
```
# docs/superpowers/specs/v1Users.md:2073
`personal.feedback_widget` Module is accessible to Viewers (anonymous), so journalists
can still submit feedback.
```

**Evidence (model comment):**
```python
# backend/apps/sadmin/models.py:47
# Nullable so anonymous viewers (§1.12, §9.6) can submit, AND so the
# row survives soft-deletion of the submitter (SET_NULL).
```

**Why it matters:** The `Feedback.submitted_by` FK is nullable precisely so anonymous users can submit. v1Users.md §9.6 and §2073 lock the spec: Viewers (unauthenticated journalists/public) must be able to send feedback. `IsAuthenticated` blocks all unauthenticated requests with a 403, contradicting the data model intent, the spec, and the model docstring. The backend test acknowledges this issue implicitly: `test_feedback_submit.py:83` just asserts `status_code in (401, 403)` without asserting the correct design.

**Recommendation:** Change to `permission_classes = [IsAuthenticatedOrReadOnly]` or a custom permission. Pass `user=request.user if request.user.is_authenticated else None` (the service layer already handles `None`). Add a separate `AnonRateThrottle` keyed to the `feedback_submit` scope with rate `5/hour/IP` (spec table at v1Users.md:2557 says `5/hr/IP`).

---

### F-3 — Generated type marks `category` as required; BE treats it as optional with a default

**Severity:** MEDIUM  
**File:** `frontend/src/types/api.generated.ts:915` vs `backend/apps/sadmin/serializers.py:36-40`

**Evidence (generated type):**
```ts
// frontend/src/types/api.generated.ts:915
category: components["schemas"]["FeedbackSubmitCategoryEnum"];  // NOT optional
```

**Evidence (BE serializer):**
```python
# backend/apps/sadmin/serializers.py:36-40
category = serializers.ChoiceField(
    choices=FeedbackCategory.choices,
    required=False,
    default=FeedbackCategory.OTHER,
)
```

**Why it matters:** The generated type forces TypeScript consumers to always supply `category`. Any code that imports `components["schemas"]["FeedbackSubmit"]` directly and does not supply `category` will fail type-checking even though the backend accepts the request perfectly. The hand-authored `FeedbackSubmitPayload` in `feedback.ts:12` correctly declares `category?: string`, but the two type definitions diverge and future refactors may import the generated type.

**Recommendation:** Regenerate the OpenAPI schema — drf-spectacular should emit `required=False` as an omitted field in the schema's `required` array. If the generator consistently marks defaulted fields as required, add `@extend_schema_field(serializers.ChoiceField(choices=..., required=False))` or configure the spectacular postprocessing hook.

---

### F-4 — Phantom `ok` field in FE `FeedbackSubmitResponse`; BE never sends it

**Severity:** MEDIUM  
**File:** `frontend/src/api/feedback.ts:22` vs `backend/apps/sadmin/views/feedback.py:199-201`

**Evidence (FE):**
```ts
// frontend/src/api/feedback.ts:22
ok?: true;
```

**Evidence (BE):**
```python
# backend/apps/sadmin/views/feedback.py:200
return Response(
    {"id": str(fb.id)},
    status=status.HTTP_200_OK if existed_before else status.HTTP_201_CREATED,
)
```

**Why it matters:** The BE always returns `{"id": "<uuid>"}`. The FE response type declares `id?: string` (optional) and `ok?: true` (phantom). Any caller that checks `if (response.ok)` will always get `undefined` (falsy). The generated type at `api.generated.ts:930-933` correctly shows only `id: string`, confirming the mismatch is in the hand-authored type.

**Recommendation:** Remove `ok?: true` from `FeedbackSubmitResponse`. Make `id` non-optional (`id: string`) to match the BE serializer (`FeedbackSubmitResponseSerializer.id = serializers.UUIDField()`).

---

### F-5 — `BulkEmailRequestSerializer` / `SystemHealthResponseSerializer` / `FeedbackArchiveResponseSerializer` declared but never used by their views

**Severity:** MEDIUM  
**File:** `backend/apps/sadmin/serializers.py:56-88`; `backend/apps/sadmin/views/superadmin.py`

**Evidence:**
```python
# backend/apps/sadmin/serializers.py:56-88
class BulkEmailRequestSerializer(serializers.Serializer): ...
class BulkEmailResponseSerializer(serializers.Serializer): ...
class SystemHealthResponseSerializer(serializers.Serializer): ...
class FeedbackArchiveResponseSerializer(serializers.Serializer): ...
```
```python
# backend/apps/sadmin/views/superadmin.py — no import of any of these
# Only feedback.py imports: from apps.sadmin.serializers import (
#     FeedbackSubmitResponseSerializer, FeedbackSubmitSerializer,
# )
```

**Why it matters:** The three sadmin-console JSON views (`bulk_email_api`, `system_health_api`, `archive_feedback_api`) parse input manually via `_parse_json_body()` and return raw `JsonResponse` dicts. The serializers exist as documentation artefacts but:
- They are not used for request validation (so invalid input passes silently through).
- They carry no `@extend_schema` so they are absent from the OpenAPI spec.
- `bulk_email_api` validates only `subject`; it does not check that `body` is non-empty even though `BulkEmailRequestSerializer.body` has `min_length=1`.
- `system_health` can return an extra `db_error` key not present in `SystemHealthResponseSerializer`.

**Recommendation:** Either (a) convert the three endpoints to `APIView` subclasses using these serializers for validation and `@extend_schema` for schema, or (b) mark the serializers as internal documentation only and add inline comments clarifying they are not wired. Option (a) is preferred for correctness.

---

### F-6 — `bulk_email_api` and `archive_feedback_api` are decorated `@csrf_exempt`; inconsistent with invariant 15

**Severity:** MEDIUM  
**File:** `backend/apps/sadmin/views/superadmin.py:47,97`

**Evidence:**
```python
# backend/apps/sadmin/views/superadmin.py:47
@csrf_exempt
def bulk_email_api(request: HttpRequest) -> HttpResponse:

# backend/apps/sadmin/views/superadmin.py:97
@csrf_exempt
def archive_feedback_api(request: HttpRequest, feedback_id: uuid.UUID) -> HttpResponse:
```

**Why it matters:** Architectural invariant 15 mandates session auth with CSRF protection for all SPA-facing and console-facing endpoints. These two POST endpoints skip CSRF. Since the sadmin console renders Django templates that include the CSRF token, the templates likely have `{% csrf_token %}` and HTMX sends the token automatically, so the exemption is unnecessary and weakens the security posture. `system_health_api` (GET) does not need CSRF, but the POST endpoints do.

**Recommendation:** Remove `@csrf_exempt` from `bulk_email_api` and `archive_feedback_api`. The `superadmin_required` decorator uses Django sessions, so CSRF middleware can protect these correctly. Verify the sadmin templates include `{% csrf_token %}` or that the HTMX `hx-headers` include the CSRF token.

---

### F-7 — Three `/sadmin/api/*` JSON endpoints have no React SPA consumers

**Severity:** LOW (info / forward-looking)  
**File:** `backend/apps/sadmin/urls.py:62-76`; `frontend/src/`

**Evidence:**
```python
# backend/apps/sadmin/urls.py:62-76
path("api/bulk-email/", views.bulk_email_api, name="api_bulk_email"),
path("api/system-health/", views.system_health_api, name="api_system_health"),
path("api/feedback/<uuid:feedback_id>:archive/", views.archive_feedback_api, name="api_archive_feedback"),
```
No matching fetch calls exist in `frontend/src/` (confirmed by grep; zero matches for `sadmin/api`, `bulk-email`, `system-health`, `api_archive_feedback`).

**Why it matters:** These endpoints are gated by `@superadmin_required` + the sadmin session, so they are intentionally console-only, not SPA-facing. The Django+HTMX console templates invoke them (or will invoke them). This is not a bug, but it means these three routes have no FE contract to audit and their serializers serve as documentation only.

**Recommendation:** Document in `apps/sadmin/serializers.py` module docstring that the `Bulk*`, `SystemHealth*`, `FeedbackArchive*` serializers describe the HTMX console contract, not the SPA contract. Add `@extend_schema(exclude=True)` to avoid polluting the OpenAPI spec that the SPA consumes.

---

### F-8 — `FeedbackSubmitView.permission_classes` uses DRF default but returns 403 for unauthenticated instead of 401

**Severity:** LOW  
**File:** `backend/apps/sadmin/views/feedback.py:132`

**Evidence:**
```python
# backend/apps/sadmin/views/feedback.py:132
permission_classes = [IsAuthenticated]
```
```python
# backend/apps/sadmin/tests/test_feedback_submit.py:83-84
# IsAuthenticated → 403 with DRF SessionAuth + no creds.
assert resp.status_code in (401, 403)
```

**Why it matters:** `SessionAuthentication` + `IsAuthenticated` returns 403 (not 401) for unauthenticated requests, because `SessionAuthentication` never raises `AuthenticationFailed` — it silently leaves `request.user = AnonymousUser`. The test accepts both 403 and 401 as correct, but this is the same known issue documented in KNOWN ISSUES (b): `/api/accounts/me/` returns 403 not 401. Same root cause here. Downstream FE code that checks `if (status === 401) redirect to login` will miss this case.

**Recommendation:** Either add `authentication_classes = [SessionAuthentication]` with custom handling that returns 401 when no session cookie is present, or add `BasicAuthentication` to the authentication classes so DRF returns 401 with `WWW-Authenticate`, or handle 403 in the FE error handler as equivalent to 401 for unauthenticated cases. This is systemic and tracked in KNOWN ISSUES (b).

---

## Gaps (Forward-Looking)

| Item | Missing | Needed For | Effort | Blocking? |
|------|---------|-----------|--------|-----------|
| Spec-compliant anonymous feedback | Allow unauthenticated POST to `/api/feedback/submit/` with IP-based throttle | v1Users.md §9.6 compliance | S | No |
| Sadmin API `@extend_schema(exclude=True)` | Prevent sadmin-console-only endpoints from appearing in the public OpenAPI spec | Clean SPA schema | S | No |
| Wire `BulkEmailRequestSerializer` for validation | `bulk_email_api` silently accepts empty `body`; serializer enforces `min_length=1` | Correctness | S | No |
| `api.generated.ts` regeneration | `category` incorrectly required; generated type will drift further with Phase 1B | Type safety | M | No |
| HTMX sadmin console templates | Verify `{% csrf_token %}` present in sadmin POST forms so `@csrf_exempt` removal doesn't break the console | Security | S | No |
