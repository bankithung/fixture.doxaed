# Sports App — FE↔BE Contract Audit

**Date:** 2026-06-04
**Scope:** `backend/apps/sports/` — serializer output shape vs. frontend expectations; required-field validation; error bodies; auth/permission classes; endpoint consumers and route coverage.

---

## Summary

The sports catalog is read-only, public, and very simple — two endpoints (`GET /api/sports/` list and `GET /api/sports/<code>/` detail). The backend serializer, generated OpenAPI types, and the `api.generated.ts` file are all internally consistent. There is **no dedicated frontend API module** (`frontend/src/api/sports.ts` does not exist) and **no React component** currently consuming the catalog endpoints. The only FE references to "sport" are static text in the landing page and about page.

The main contract issues are: (1) invalid query-parameter values are silently ignored (no 400); (2) global throttle applies to AllowAny endpoints — requires the session-auth middleware to run against public endpoints; (3) `python_module_path` is a backend-only field excluded from serializer output correctly, but this is only by omission; (4) the query-param enums are typed as `string` in the OpenAPI spec rather than the valid enum values; (5) the entire FE side of the contract is unbuilt (no `api/sports.ts`, no hook, no component).

---

## Findings

### F-1 — Invalid query-param values silently ignored (no 400) [medium]

**File:** `backend/apps/sports/views.py:46-53`

```python
status = self.request.query_params.get("status")
if status and status in {s.value for s in SportStatus}:
    qs = qs.filter(status=status)
category = self.request.query_params.get("category")
if category and category in {c.value for c in SportCategory}:
    qs = qs.filter(category=category)
```

**Why it matters:** `GET /api/sports/?status=bogus` silently returns the full unfiltered list (200 + all records). From the FE perspective this is a silent misfire — a typo in a filter param returns wrong data with no error signal. The generated OpenAPI types declare `status` and `category` as plain `string`, so the client has no type guard either.

**Recommendation:** Return `HTTP 400` with `{"detail": "Invalid status 'bogus'. Valid values: planned, coming_soon, active, deprecated."}` when the param is present but not a valid enum value. Alternatively, add DRF filter backend + `filterset_fields` which handles validation automatically.

---

### F-2 — OpenAPI query-param types are `string` not enum-constrained [low]

**File:** `backend/apps/sports/views.py:19-31` (`@extend_schema` decorator), `frontend/src/types/api.generated.ts:2431-2439`

```typescript
query?: {
  /** @description Filter by category band (team/racket/combat/etc). */
  category?: string;
  /** @description Filter by lifecycle status (planned/coming_soon/active/deprecated). */
  status?: string;
};
```

The schema declares both params as `type: string` (open-ended) rather than referencing `SportCategoryEnum` and `SportStatusEnum` — the enums that already exist in the same generated file. This means no TypeScript-level enforcement of valid filter values for future FE code that calls these endpoints.

**Recommendation:** In the `@extend_schema` decorator, add `enum=[s.value for s in SportStatus]` / `enum=[c.value for c in SportCategory]` to the `OpenApiParameter` definitions, which will make drf-spectacular emit the enum constraint and openapi-typescript will generate `"planned" | "coming_soon" | ...` parameter types automatically.

---

### F-3 — `authentication_classes` not overridden on public endpoints [low]

**File:** `backend/apps/sports/views.py:33-63`

```python
permission_classes = [AllowAny]
# authentication_classes is NOT set
```

The global default (`settings.REST_FRAMEWORK["DEFAULT_AUTHENTICATION_CLASSES"]`) is `[SessionAuthentication]`. `SessionAuthentication` unconditionally calls `enforce_csrf` on every request bearing a session cookie, and on AJAX requests it will raise `PermissionDenied` if the CSRF token is missing — even though `AllowAny` is the permission class. For public unauthenticated requests to `/api/sports/` this is benign because the client sends no cookie. However, if a logged-in user's browser hits this endpoint without the `X-CSRFToken` header (e.g., a prefetch from an SSR page, a `<link rel=preload>`, or any non-apiFetch call) Django's session middleware reads the session and `SessionAuthentication.enforce_csrf` fires before `AllowAny` is evaluated.

**Recommendation:** Add `authentication_classes = []` to both `SportListView` and `SportDetailView`. This is the standard pattern for truly public DRF endpoints and eliminates the CSRF interaction entirely on endpoints that carry no auth semantics.

---

### F-4 — No frontend `api/sports.ts` module or TanStack Query hook [info]

**File:** `frontend/src/api/` (directory listing)

The frontend API directory contains `auth.ts`, `audit.ts`, `orgs.ts`, `permissions.ts`, `feedback.ts` — but no `sports.ts`. The OpenAPI types for the sports endpoints exist in `api.generated.ts` (Sport schema at line 1199, `sports_list` and `sports_retrieve` operations at lines 2430 and 2454), but no fetcher function or `useQuery` hook has been written to consume them.

The LandingPage and AboutPage reference sports only as static copy. No component renders the live catalog from the API.

**Why it matters:** This is a forward-looking gap, not an active bug (Phase 1B work will need this). Documenting it here to make the gap explicit.

**Recommendation:** When Phase 1B begins, create `frontend/src/api/sports.ts` with `listSports(params?)` and `getSport(code)` helpers using the typed `components["schemas"]["Sport"]` shape from `api.generated.ts`.

---

### F-5 — `python_module_path` is a sensitive internal field not exposed, but not explicitly excluded [info]

**File:** `backend/apps/sports/serializers.py:16-28`, `backend/apps/sports/models.py:108`

```python
fields = (
    "id", "code", "name", "category", "status", "description",
    "indigenous_to", "is_team_sport", "is_individual_sport",
    "icon", "display_order",
)
```

The model has `python_module_path` (dotted Python import path for the per-sport plugin app), `created_at`, and `updated_at` — none are in the serializer's field list. The omission is intentional and correct. However the pattern is `fields = (...)` (allowlist), so any future field added to the model will be excluded by default — which is the right behavior.

**Recommendation:** Add a comment in the serializer noting that `python_module_path`, `created_at`, and `updated_at` are intentionally omitted from the public contract. No code change required, documentation only.

---

### F-6 — Sport list returns raw array (no envelope) — consistent with generated types but no pagination [info]

**File:** `backend/apps/sports/views.py:43`, `frontend/src/types/api.generated.ts:2449`

```python
pagination_class = None
```

The list view explicitly sets `pagination_class = None`, returning a raw JSON array of all 59 sports. The generated types expect `Sport[]` (raw array, no `{results: [], count: N}` wrapper), so the contract is consistent today. However, with 59 rows this is fine — if the catalog grows significantly, adding cursor pagination will be a breaking change to the FE contract.

**Recommendation:** No immediate action. Document the no-pagination decision explicitly in the view docstring so it is a conscious choice, not an oversight.

---

## Gaps (forward-looking)

| # | Item | Missing | Needed for | Effort | Blocking? |
|---|------|---------|------------|--------|-----------|
| G-1 | `frontend/src/api/sports.ts` | Fetcher + TanStack Query hooks for list and detail | Phase 1B (tournament creation picks a sport) | S | No |
| G-2 | FE `SportCatalogPage` / sports picker component | Any UI that renders the live catalog | Phase 1B UX | M | No |
| G-3 | Query-param enum validation (400 on invalid values) | Correct error signaling to FE | Immediately | S | No |
| G-4 | `@extend_schema` enum constraints on query params | TypeScript-level safety for future FE callers | Phase 1B | S | No |
| G-5 | `authentication_classes = []` on public sports views | Avoids CSRF friction for logged-in users hitting endpoint via non-apiFetch paths | Immediately | XS | No |
| G-6 | Write-path (PATCH/POST) for sadmin to flip sport status | Super-admin needs to promote `planned` → `coming_soon` → `active` | Phase 1B deployment | M | No |
