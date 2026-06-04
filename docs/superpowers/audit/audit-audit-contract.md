# Audit App — FE↔BE Contract Audit

**Date:** 2026-06-04
**Scope:** `backend/apps/audit` — serializer output shape, field nullability, validation, auth/permission classes, error bodies, endpoint-consumer alignment.
**Status:** Phase 1A. No Phase 1B code exists. Audit app has one list endpoint.

---

## Summary

The audit app is small and mostly correct. The serializer field set is well-aligned with what the generated OpenAPI types expose and what the frontend consumes. The critical issues are:

1. `target_label` type annotation lie: declared `@extend_schema_field(CharField(allow_null=True))` but the method signature and body never return `None` — the generated type says `string | null`, the frontend uses the null-guard `ev.target_label ?? ev.target_type`, which masks a real discrepancy between schema and runtime.
2. `previous_cursor` is semantically broken — it echoes back the *incoming* cursor rather than a real backward-navigation cursor. The frontend's "Previous" button cannot actually page backward; it re-fetches the same page as the current one or jumps to an arbitrary position.
3. The OpenAPI operation ID is `audit_orgs_retrieve` (singular resource) — misleading for a list operation and inconsistent with project conventions (`_list` suffix expected).
4. Unauthenticated test asserts `status_code in (401, 403)` — the known bug where DRF SessionAuthentication returns 403 not 401 is acknowledged but not fixed; the frontend `ApiError.isUnauthenticated` helper catches this, yet the OpenAPI schema documents no 401/403 responses for this endpoint.
5. No detail endpoint exists (`/api/audit/orgs/<slug>/<id>/`). The serializer comment promises it as "Phase 1B" but the frontend `OrgAuditLogPage.tsx` has no link/row-click handler, so this gap is not yet a contract break — only a forward risk.

---

## Findings

### F-1 — `target_label` return type annotation contradicts implementation (medium)

**File:** `backend/apps/audit/serializers.py:60–63`

```python
@extend_schema_field(serializers.CharField(allow_null=True))
def get_target_label(self, obj: AuditEvent) -> str:      # ← return hint says str, not str|None
    return f"{obj.target_type}:{obj.target_id}"          # never returns None
```

**Generated type** (`frontend/src/types/api.generated.ts:872`):
```ts
readonly target_label: string | null;
```

**Why it matters:** drf-spectacular emits `nullable: true` from `allow_null=True`, so the frontend type is `string | null`. The backend implementation never returns `None`, but if the decorator or body ever changes to match the `allow_null=True` intent, the frontend code at `OrgAuditLogPage.tsx:174` already handles it (`ev.target_label ?? ev.target_type`). The discrepancy is harmless today but the schema is documenting a capability that does not exist; any future use of this field that relies on nullable semantics will be surprised.

**Recommendation:** Either remove `allow_null=True` from the `@extend_schema_field` and change the generated type to `string`, or make the method return `None` when `target_type`/`target_id` are unavailable. The simpler fix is to drop `allow_null=True`.

---

### F-2 — `previous_cursor` is not a real backward cursor — pagination is one-directional (high)

**File:** `backend/apps/audit/views.py:197–199`

```python
return Response(
    {
        "results": AuditEventSerializer(page, many=True).data,
        "next_cursor": next_cursor,
        "previous_cursor": cursor_raw or None,   # ← just echoes the incoming cursor
    }
)
```

**Frontend usage** (`frontend/src/features/orgs/OrgAuditLogPage.tsx:95–96,188–200`):
```tsx
const prevCursor = query.data?.previous_cursor ?? null;
// ...
disabled={!prevCursor}
onClick={() => setCursor(prevCursor ?? null)}   // sends cursor_raw back → fetches same page again
```

**Why it matters:** On page 1, `cursor_raw` is empty, so `previous_cursor` is `null` and the "Previous" button is correctly disabled. But on page 2 onward, `previous_cursor` is whatever cursor was sent **to get page 2**, not a cursor pointing to page 1. Clicking "Previous" re-fetches page 2, not page 1 — the user is stuck. The UI shows "Previous" as enabled (non-null) but it is not functional. This is a real UX regression that will be found immediately during QA.

**Recommendation:** For true bidirectional pagination, derive a `previous_cursor` from the first row of the current page (pointing backward) and store a page history stack on the client, OR switch to a unidirectional model and remove the "Previous" button and the `previous_cursor` field entirely. The simplest correct fix is to drop `previous_cursor` from the response, remove the "Previous" button from `OrgAuditLogPage.tsx`, and clarify the cursor-pagination contract in the serializer docstring.

---

### F-3 — OpenAPI operation ID `audit_orgs_retrieve` is semantically wrong (low)

**File:** `backend/apps/audit/urls.py:27` (inferred from generated `frontend/src/types/api.generated.ts:1680`)

```ts
audit_orgs_retrieve: {   // "retrieve" implies single-resource; this is a list
```

drf-spectacular defaults to `retrieve` for `APIView.get()` when it cannot tell from the view class. The correct suffix for a paginated list should be `_list`.

**Why it matters:** The generated client type name (`audit_orgs_retrieve`) is confusing and inconsistent with every other list operation in the API. TypeScript consumers importing the operation type will be confused.

**Recommendation:** Add `@extend_schema(operation_id="audit_org_list")` to `OrgAuditListView.get()` in `backend/apps/audit/views.py`.

---

### F-4 — OpenAPI schema documents no error responses for the audit endpoint (medium)

**File:** `backend/apps/audit/views.py:109–123`

```python
@extend_schema(
    ...
    responses={200: AuditEventListResponseSerializer},   # only 200 documented
    ...
)
```

The view can return:
- `400` with `{"detail": "Invalid actor_id; expected a UUID."}` or `{"detail": "Invalid cursor."}`
- `403` from `IsAuthenticated` or `HasModule`
- `404` from `raise Http404("Organization not found.")`

None of these are in the schema. The generated `api.generated.ts` operation (`audit_orgs_retrieve`) has only a `200` response documented.

**Why it matters:** The frontend error handler at `OrgAuditLogPage.tsx:135` reads `query.error.payload.detail` which will work for 400/403 at runtime because the `ApiError` class extracts `detail`, but type-checking gives no assurance that the error fields are present. Swagger UI misleads API consumers into thinking the endpoint never fails.

**Recommendation:** Extend the `@extend_schema` decorator to include `400`, `403`, and `404` responses using `OpenApiResponse` objects. At minimum:
```python
responses={
    200: AuditEventListResponseSerializer,
    400: OpenApiResponse(description="Invalid query parameter (actor_id or cursor)"),
    403: OpenApiResponse(description="Not authenticated or lacks org.audit_log module"),
    404: OpenApiResponse(description="Organization not found"),
}
```

---

### F-5 — Unauthenticated request returns 403 not 401 (known, unresolved) (medium)

**File:** `backend/apps/audit/tests/test_audit_list_view.py:240–241`

```python
# IsAuthenticated → 403 with DRF SessionAuth + no creds.
assert resp.status_code in (401, 403)
```

The test explicitly acknowledges the known project-wide bug (KNOWN ISSUE b): `SessionAuthentication` returns 403 instead of 401 for unauthenticated requests. The frontend `ApiError.isUnauthenticated` at `frontend/src/types/api.ts:33–43` handles the 403-masking-401 case for `authentication credentials` in the detail string, but the audit endpoint's 403 response from `HasModule` says `"User lacks required module: org.audit_log"` — which is **not** caught by `isUnauthenticated`. So a completely unauthenticated user hitting `/api/audit/orgs/<slug>/` will cause the frontend to show "Could not load audit log" with an access-denied error rather than redirecting to login.

**Recommendation:** Either add `BasicAuthentication` (or a custom auth class) as a secondary authenticator so that unauthenticated requests get 401 from the `WWW-Authenticate` header machinery, or implement the project-wide fix described in KNOWN ISSUE (b) by overriding `authentication_classes` to include `SessionAuthentication` + a custom class that raises `AuthenticationFailed` on anonymous users. Short-term: the audit view can override `authentication_classes` and inject a class that returns 401. Pair with the frontend interceptor that redirects on 401.

---

### F-6 — `actor_email_at_time` live email leaks PII across org boundary (high)

**File:** `backend/apps/audit/serializers.py:49–58`

```python
def get_actor_email_at_time(self, obj: AuditEvent) -> str | None:
    if obj.actor_user_id is None:
        return obj.deleted_user_handle or None
    try:
        return obj.actor_user.email  # no PII redaction applied here
    except Exception:
        return obj.deleted_user_handle or None
```

The serializer docstring says: *"PII redaction is applied at the email field per B.11 if a non-Super-admin viewer fetches a row authored by another user."* But the implementation applies **no redaction** — it returns the live email unconditionally regardless of the requesting user's role.

**Why it matters:** A `referee` or `game_coordinator` (both have `org.audit_log` by default) will see the full email address of every actor in the org, including the admin who created the org, which is PII. The spec explicitly called this out as a required privacy control.

**Recommendation:** In `get_actor_email_at_time`, check `self.context["request"].user` against the row's `actor_user_id`. If the viewer is not a super-admin AND the actor is a different user, return a redacted string (e.g. the first character + `***` + domain, or just `"[redacted]"`). The context is available because `AuditEventSerializer(page, many=True, context={"request": request})` needs to be passed in the view — currently the view calls `AuditEventSerializer(page, many=True).data` at line 196 **without passing `context`**, which means `self.context` will be empty and the request cannot be inspected even if the redaction code is added.

This is actually two bugs in one:
1. The view does not pass `context={"request": request}` to the serializer (views.py:196).
2. The serializer does not implement the promised PII redaction.

---

### F-7 — Serializer context not forwarded; `request` unavailable in serializer methods (medium)

**File:** `backend/apps/audit/views.py:196`

```python
"results": AuditEventSerializer(page, many=True).data,
```

No `context={"request": request}` is passed. DRF `SerializerMethodField` methods that need to inspect `self.context["request"]` (e.g. for PII redaction, for HATEOAS links, for permission checks) will raise `KeyError` or silently fail. This also blocks drf-spectacular from generating correct hyperlinked fields should they ever be added.

**Recommendation:** Change to:
```python
"results": AuditEventSerializer(page, many=True, context={"request": request}).data,
```

---

### F-8 — `AuditEventListResponseSerializer` is not used for response serialization (info)

**File:** `backend/apps/audit/serializers.py:73–78` and `backend/apps/audit/views.py:194–200`

```python
class AuditEventListResponseSerializer(serializers.Serializer):
    results = AuditEventSerializer(many=True)
    next_cursor = serializers.CharField(allow_null=True, required=False)
    previous_cursor = serializers.CharField(allow_null=True, required=False)
```

The view builds a plain `dict` and passes it to `Response(...)` directly — it does **not** use `AuditEventListResponseSerializer` to validate or serialize the response body. `AuditEventListResponseSerializer` exists only as an `@extend_schema(responses=...)` hint.

This is common DRF practice but it means:
- If a developer changes the `dict` keys in the view without updating the serializer, the schema silently diverges.
- `next_cursor` and `previous_cursor` are declared `required=False` which generates `optional` fields in OpenAPI — the frontend type correctly reflects `next_cursor?: string | null` — but the view always emits both keys (the dict always has `"next_cursor"` and `"previous_cursor"`), so `required=False` is misleading: the fields are always present, just sometimes null.

**Recommendation:** Either use the response serializer to serialize the dict (adds validation), or change `required=False` to required and mark `allow_null=True` to make the contract clearer: these fields are always present, just nullable.

---

## Gaps (forward-looking, not current bugs)

| # | Gap | Missing | Needed for | Effort | Blocking |
|---|-----|---------|------------|--------|---------|
| G-1 | Detail endpoint `/api/audit/orgs/<slug>/<id>/` | No view, no URL, no serializer. The list serializer comment says "Phase 1B" | Row-level drill-down; payload diff view | S | No |
| G-2 | Referee row-scoping | `OrgAuditLogPage` comment says "server-side row scoping is a Phase 1B follow-up — Phase 1A returns the whole org feed". Referees see all org events. | Privacy; module spec says referee sees only their match-scoped events | M | No (Phase 1B) |
| G-3 | Filter by `target_type` and `target_id` | No query param for filtering by target. Phase 1B match/tournament pages would want to show events for one entity | Contextual audit panels | S | No |
| G-4 | Export / download CSV | No endpoint. SaaS org admins will ask for it | Compliance | M | No |
| G-5 | `serialize_payload` stub | `backend/apps/audit/models.py:103–107` has a `# Stub for payload serialization` that does nothing — UUIDs and datetimes inside `payload_before`/`payload_after` JSONB are not normalized | Phase 1B when payloads carry nested domain objects | M | No |
| G-6 | `organization_id` not exposed in serializer | The model stores `organization_id`, `tournament_id`, `match_id` scope fields but the serializer (`AuditEventSerializer.Meta.fields`) omits them. Phase 1B detail endpoint may need them. | Multi-scope filtering | S | No |
| G-7 | Throttling on audit list endpoint | No throttle class override. Default `user: 240/min` applies. A script could read the full audit log of a large org in seconds. | Rate-limit protection for sensitive data | S | No |
