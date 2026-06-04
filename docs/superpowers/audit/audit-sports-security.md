# Security Audit — `backend/apps/sports`

**Date:** 2026-06-04
**Auditor:** Claude Code (Sonnet 4.6)
**Scope:** `backend/apps/sports/` only — broken access control/IDOR, injection (raw SQL/.extra/command/template), hardcoded secrets, weak crypto, auth/session flaws, CSRF gaps, DRF mass-assignment/over-exposed fields, SSRF, missing rate limits, 404-vs-403 info leak, token entropy/hashing.

---

## Findings

### FINDING 1 — Missing rate-limit (throttle) on `AllowAny` public endpoints
**Severity:** Medium
**Files:** `backend/apps/sports/views.py:42,60`

```python
permission_classes = [AllowAny]
# SportListView also has:
pagination_class = None
```

Both `SportListView` (`GET /api/sports/`) and `SportDetailView` (`GET /api/sports/<code>/`) use `permission_classes = [AllowAny]` with no explicit `throttle_classes`. The global DRF setting applies `AnonRateThrottle` at `60/min` (base.py:161–163), which is shared across **all** anonymous endpoints — scraping the full catalog in tight loops would consume the entire anon quota. More importantly, `pagination_class = None` means `SportListView` always returns every row in a single response with no upper bound. With ~59 rows today this is trivial, but as the catalog grows (Phase 1B adds per-sport rows), the list endpoint will return an ever-larger unbounded payload. The combination of `AllowAny` + no pagination + shared anon throttle bucket means no per-endpoint rate limit and no response-size ceiling.

**Recommendation:**
- Add `throttle_classes = [AnonRateThrottle]` and a `throttle_scope = "catalog"` on both views, with a named rate of `120/min` or lower in `DEFAULT_THROTTLE_RATES`.
- Add pagination even if the current row count is small (`PageNumberPagination` with `page_size=100`), or cap results with a `CATALOG_MAX_SIZE` guard.

---

### FINDING 2 — `python_module_path` exposed in the public API response
**Severity:** Medium
**Files:** `backend/apps/sports/serializers.py:16–28`, `backend/apps/sports/models.py:105–108`

```python
fields = (
    ...
    "python_module_path",   # line 27 — absent here, but model field exists
    ...
)
```

Wait — `python_module_path` is **not** in `SportSerializer.fields` (the serializer lists id, code, name, category, status, description, indigenous_to, is_team_sport, is_individual_sport, icon, display_order). This is correct.

**Status: NOT an active finding.** The serializer correctly omits `python_module_path`. Recorded here because the field exists on the model and its absence from the serializer must be maintained.

---

### FINDING 3 — `load_sports` management command accepts arbitrary `--path` argument (path-traversal surface)
**Severity:** Low
**File:** `backend/apps/sports/management/commands/load_sports.py:29–31`

```python
parser.add_argument(
    "--path",
    default=str(FIXTURE_PATH),
    help="Override path to sports.json fixture file.",
)
```

The `--path` argument is passed directly to `Path(options["path"])` on line 35 and used for `path.read_text()`. Any operator with shell access can point this at any file on the server (e.g., `--path /etc/passwd`). The file is deserialized via `json.loads`, so an attacker with deploy access who can also run management commands could read and partially dump arbitrary server files (JSON decode will fail on non-JSON content, but the error message in `self.stderr.write` would include the raw content or a partial parse trace).

This is a management-command-level risk, not an HTTP endpoint risk; it requires existing server access. However, management commands can be invoked via CI/CD pipelines or misconfigured cron jobs.

**Recommendation:**
- Validate `path` is within `BASE_DIR` (or within the fixture directory) before reading. Example: `if not str(path.resolve()).startswith(str(BASE_DIR)): raise CommandError("Path outside project directory.")`.
- Or remove the `--path` override entirely; it has no legitimate production use.

---

### FINDING 4 — 404 returned for unknown sport code (potential info-leak via error code distinction)
**Severity:** Low (Info)
**File:** `backend/apps/sports/views.py:56–63`, `backend/apps/sports/tests/test_catalog.py:96–100`

```python
class SportDetailView(generics.RetrieveAPIView):
    ...
    lookup_field = "code"
    lookup_url_kwarg = "code"
```

`GET /api/sports/quidditch/` returns HTTP 404. Because the endpoint is `AllowAny`, unauthenticated users can enumerate all valid sport codes by probing the catalog. There is no ambiguity here to "solve" — the catalog is intentionally public and 404 is the correct and expected response for an unknown code. This is by design and is not a vulnerability.

However, if in Phase 1B individual sport entries are ever access-controlled (e.g., "private beta" sports visible only to specific orgs), then 404 vs 403 distinction would leak existence. The code currently does not have this problem because all sports are platform-level public metadata.

**Recommendation:** No action needed now. Flag for Phase 1B: if any sport rows are ever org-scoped or visibility-gated, return 404 for both "not found" and "not authorized" cases to avoid existence-enumeration.

---

### FINDING 5 — No CSRF concern for read-only `AllowAny` views (confirmed clean)
**Severity:** Info
**File:** `backend/apps/sports/views.py`

Both views are `GET`-only (`ListAPIView`, `RetrieveAPIView`). CSRF protection is irrelevant for safe (read-only) HTTP methods. No mutation path exists in this app. Clean.

---

### FINDING 6 — No injection vectors found (confirmed clean)
**Severity:** Info
**File:** `backend/apps/sports/views.py:45–53`

```python
status = self.request.query_params.get("status")
if status and status in {s.value for s in SportStatus}:
    qs = qs.filter(status=status)
category = self.request.query_params.get("category")
if category and category in {c.value for c in SportCategory}:
    qs = qs.filter(category=category)
```

Query parameters are validated against a closed enum before being passed to the ORM. No raw SQL, no `.extra()`, no `.raw()`, no `RawSQL()`, no `format()`-based query building. The Django ORM parameterizes all values. No injection risk.

---

### FINDING 7 — No hardcoded secrets or credentials (confirmed clean)
**Severity:** Info
**Files:** All `backend/apps/sports/*.py`

No API keys, tokens, passwords, or secret strings appear anywhere in the sports app. The `sports.json` fixture contains only catalog metadata. Clean.

---

### FINDING 8 — No SSRF vectors (confirmed clean)
**Severity:** Info

The sports app makes no outbound HTTP requests. The `icon` field is a free-form string (Lucide icon name / emoji / static path) that the frontend interprets — no server-side URL fetch occurs. Clean.

---

### FINDING 9 — No mass-assignment risk (confirmed clean)
**Severity:** Info
**File:** `backend/apps/sports/serializers.py:28`

```python
read_only_fields = fields
```

All serializer fields are marked `read_only_fields = fields`. There are no write endpoints in Phase 1A. Zero mass-assignment surface.

---

### FINDING 10 — No broken access control / IDOR (confirmed clean for current scope)
**Severity:** Info

`Sport` is platform-level metadata with no `organization` FK. It is intentionally not org-scoped (as documented in `models.py:12`). There is nothing to IDOR against — all rows are publicly readable. No per-user, per-org, or per-role gating is needed or attempted. Clean within Phase 1A scope.

---

## Gaps (Forward-looking — not current vulnerabilities)

### GAP 1 — `python_module_path` is stored but no validation or trust boundary defined
**Effort:** S | **Blocking:** No | **Needed for:** Phase 1B sport dispatch

When Phase 1B begins using `python_module_path` for dynamic sport dispatch (e.g., `importlib.import_module(sport.python_module_path)`), this field becomes a code-execution vector if an attacker can write arbitrary values to it. Currently no write API exists, so it is safe. When the admin/write path is built:
- Validate `python_module_path` against an allowlist of known app prefixes (`apps.sports.*`).
- Never use it in `exec()`, `eval()`, or unrestricted `import_module()` with user-controlled input.
- Require super-admin role to update this field; log it in `AuditEvent`.

### GAP 2 — Shared anon throttle bucket across all unauthenticated endpoints
**Effort:** S | **Blocking:** No | **Needed for:** Phase 1B (higher endpoint count)

The global `anon: 60/min` rate is shared across every `AllowAny` endpoint. A scraper hammering `/api/sports/` can exhaust the quota for legitimate unauthenticated users hitting `/api/accounts/login/` or other public endpoints. Per-scope throttle classes should be added to sports views as a named scope separate from auth endpoints.

### GAP 3 — No test asserting that POST/PUT/PATCH/DELETE returns 405
**Effort:** S | **Blocking:** No | **Needed for:** CI correctness

`test_catalog.py` only tests GET. There is no test asserting that write verbs are rejected (405 Method Not Allowed) on sports endpoints. If a future refactor accidentally changes the view base class to a writable one, no test catches it.

### GAP 4 — `load_sports` path override not sanitized (see Finding 3)
**Effort:** S | **Blocking:** No | **Needed for:** Hardening

Already described in Finding 3. Removing or constraining the `--path` argument.

### GAP 5 — No test for throttle behavior on sports endpoints
**Effort:** M | **Blocking:** No | **Needed for:** Ensuring rate-limit coverage

No test exercises the throttle limit on `GET /api/sports/`. If the throttle class is misconfigured or the scope changes, no test catches it.

---

## Summary

The `apps/sports` module is a small, read-only public catalog with a clean security posture for its current Phase 1A scope. No injection, SSRF, IDOR, mass-assignment, CSRF, hardcoded secrets, or broken access-control issues were found. The two actionable findings are:

1. **Medium:** No per-endpoint throttle scope on `AllowAny` list/detail views; shared anon quota and unbounded response size on the list endpoint.
2. **Low:** The `--path` management command argument accepts any file path with no boundary check.

The `python_module_path` field is safe now (not exposed in API, not dynamically imported) but must be governed carefully when Phase 1B dispatch code is written.
