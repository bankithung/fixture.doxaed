# Tenant Isolation Audit — `apps.sports`

**Date:** 2026-06-04  
**Auditor:** Claude Code (automated)  
**Scope:** `backend/apps/sports/` — every endpoint, queryset, serializer, and model FK, evaluated for cross-org data leakage.  
**Status:** CLEAN (no violations found). Forward-looking gaps documented below.

---

## Methodology

Reviewed all Python files in `backend/apps/sports/`:

- `models.py` — schema and FK topology
- `views.py` — endpoint access control, `get_queryset`, `get_object`
- `serializers.py` — field set, read/write separation
- `urls.py` — route surface
- `tests/test_catalog.py` — test coverage for isolation
- `migrations/0001_initial.py` — DB-level constraints

Also verified integration points:
- `fixture/urls.py` — how sports routes are mounted
- `fixture/settings/base.py` — DRF defaults
- `backend/apps/` — whether any other app imports `apps.sports.models.Sport`

---

## Findings

### FINDING-1: Sport is intentionally not org-scoped — documented and correct

| Attribute | Value |
|-----------|-------|
| Severity | info |
| File | `backend/apps/sports/models.py:12-14` |
| Category | Design intent (not a defect) |

**Evidence:**
```python
# It is intentionally NOT org-scoped — sports are platform-level metadata.
# Per-org sport opt-in (which sports an organization actually offers) is
# modelled separately when Tournament work begins.
```

**Why it matters:** The `Sport` table has no `organization` FK and carries no per-org data. This is the correct design for a shared platform catalog. Invariant #2 (multi-tenancy by Organization) explicitly does not apply to platform-wide metadata tables.

**Recommendation:** No action required. When Phase 1B adds `Tournament`, add the per-org opt-in relationship on `Tournament` (FK to `Sport`), NOT on `Sport` itself.

---

### FINDING-2: Both endpoints use `AllowAny` — consistent with public catalog intent

| Attribute | Value |
|-----------|-------|
| Severity | info |
| File | `backend/apps/sports/views.py:11, 41, 57` |
| Category | Access control (intentional) |

**Evidence (`SportListView`):**
```python
permission_classes = [AllowAny]
```
**Evidence (`SportDetailView`):**
```python
permission_classes = [AllowAny]
```

**Why it matters:** These endpoints serve read-only platform metadata (sport names, categories, statuses). `AllowAny` is appropriate and matches the docstring intent: "anyone (including unauthenticated visitors on the marketing surfaces) can see what sports the platform plans to support."

**Recommendation:** No action required for Phase 1A. Confirm this remains correct when Phase 1B adds `active` sports — the catalog list is still safely public even then.

---

### FINDING-3: `get_queryset` applies only status/category filters — no org-scoped data can leak

| Attribute | Value |
|-----------|-------|
| Severity | info |
| File | `backend/apps/sports/views.py:45-53` |
| Category | Queryset isolation |

**Evidence:**
```python
def get_queryset(self):
    qs = Sport.objects.all()
    status = self.request.query_params.get("status")
    if status and status in {s.value for s in SportStatus}:
        qs = qs.filter(status=status)
    category = self.request.query_params.get("category")
    if category and category in {c.value for c in SportCategory}:
        qs = qs.filter(category=category)
    return qs
```

`Sport.objects.all()` on a table with no org FK cannot leak cross-org rows. The two filter parameters are enum-validated before being passed to `.filter()`, preventing injection of arbitrary field lookups.

**Recommendation:** No action required.

---

### FINDING-4: Serializer is fully read-only — no write surface

| Attribute | Value |
|-----------|-------|
| Severity | info |
| File | `backend/apps/sports/serializers.py:14-29` |
| Category | Write-path isolation |

**Evidence:**
```python
class SportSerializer(serializers.ModelSerializer):
    class Meta:
        model = Sport
        fields = (
            "id", "code", "name", "category", "status",
            "description", "indigenous_to", "is_team_sport",
            "is_individual_sport", "icon", "display_order",
        )
        read_only_fields = fields
```

All exposed fields are in `read_only_fields`. Because both views inherit from `generics.ListAPIView` and `generics.RetrieveAPIView` (no `CreateAPIView`, `UpdateAPIView`, or `DestroyAPIView`), there is no write path at all in Phase 1A.

**Recommendation:** No action required. When Phase 1B adds sadmin ability to update sport status/description, create a separate `SportAdminSerializer` used only in the `sadmin` app, restricted to super-admin RBAC, to avoid accidentally exposing write fields on the public endpoint.

---

### FINDING-5: No other app imports `apps.sports.models.Sport` — zero cross-app FK exposure

| Attribute | Value |
|-----------|-------|
| Severity | info |
| File | Grep across `backend/apps/**/*.py` |
| Category | FK topology |

Grep for `from apps.sports` across the entire backend (excluding `.venv`) returns only intra-sports-app imports:
- `apps/sports/views.py`
- `apps/sports/serializers.py`
- `apps/sports/urls.py`
- `apps/sports/tests/test_catalog.py`
- `apps/sports/management/commands/load_sports.py`

No other Phase 1A app (`accounts`, `organizations`, `permissions`, `audit`, `sadmin`) holds a FK to `Sport`. There is no `related_name` traversal that could be used to probe org-adjacent data.

**Recommendation:** No action required now. When Phase 1B adds `Tournament.sport = FK(Sport)`, ensure that FK lookup cannot be reversed to expose `Tournament` data to unauthenticated users via the `/api/sports/<code>/` endpoint (the current `SportDetailView` does not expose related tournaments, but confirm after Phase 1B serializer changes).

---

### FINDING-6: No rate limiting on sports endpoints — minor gap for Phase 1A

| Attribute | Value |
|-----------|-------|
| Severity | low |
| File | `backend/apps/sports/views.py:41-53` |
| Category | Availability / enumeration |

`AllowAny` endpoints bypass the DRF `UserRateThrottle` (which applies only to authenticated users). The `AnonRateThrottle` default of `60/min` (from `base.py:164`) still applies globally, but there is no sport-catalog-specific throttle.

For a 59-row catalog this is negligible, but once Phase 1B grows the catalog or adds per-sport detail that is computationally richer, a dedicated throttle class would be prudent.

**Recommendation (deferred to Phase 1B):** Add `throttle_classes = [AnonRateThrottle]` explicitly to both views as documentation. Consider a dedicated `SportCatalogThrottle` at `120/min` anon once Phase 1B ships heavier per-sport payloads.

---

## Summary Table

| ID | Severity | Verdict |
|----|----------|---------|
| FINDING-1 | info | No org FK — intentional and correct |
| FINDING-2 | info | `AllowAny` — intentional, catalog is public |
| FINDING-3 | info | `get_queryset` safe — no org data, enum-validated filters |
| FINDING-4 | info | Serializer fully read-only — no write surface |
| FINDING-5 | info | No FK from any other app to Sport — zero cross-app exposure |
| FINDING-6 | low | Missing explicit anon throttle on endpoints |

**Cross-org isolation verdict: CLEAN.** The sports catalog is platform-scoped by design, contains no per-org data, exposes only read operations, and has no FK links from org-scoped models in Phase 1A.

---

## Gaps (Forward-Looking)

These are not current defects but must be addressed before Phase 1B ships.

### GAP-1: No cross-org isolation test exists — N/A now, required in Phase 1B

| Attribute | Value |
|-----------|-------|
| Item | Missing cross-org isolation test for sports |
| Missing | A test asserting that a request authenticated as Org A cannot enumerate or access Org B sports data |
| Current state | Sports is org-agnostic; such a test would be trivially vacuous today |
| Needed for | Phase 1B, once `Tournament.sport` FK is added and any org-scoped sport-opt-in endpoint ships |
| Effort | S |
| Blocking | No — not blocking Phase 1A |

**Recommendation:** When Phase 1B adds per-org tournament or sport-opt-in endpoints, add a parametrized cross-org test in `backend/apps/sports/tests/test_isolation.py` following the pattern in `apps/permissions/tests/test_module_gated_queryset.py`.

---

### GAP-2: No `deprecated` sports hidden from public API

| Attribute | Value |
|-----------|-------|
| Item | Deprecated sports remain fully visible via the public list endpoint |
| Missing | Filter or warning to prevent public marketing surfaces from advertising deprecated sports unless explicitly queried |
| Current state | `?status=deprecated` returns deprecated rows; the default unfiltered list also includes them |
| Needed for | Phase 1B when sports start transitioning through lifecycle states |
| Effort | S |
| Blocking | No |

**Recommendation:** When Phase 1B ships, consider defaulting `get_queryset` to `Sport.objects.exclude(status=SportStatus.DEPRECATED)` unless `?include_deprecated=1` is passed (sadmin-only). This is a UX concern, not a security concern, but worth tracking.

---

### GAP-3: `Sport.python_module_path` exposes internal dotted paths — moderate info-disclosure risk in Phase 1B

| Attribute | Value |
|-----------|-------|
| Item | `python_module_path` field is included in the public serializer |
| Missing | Decision on whether to expose internal plugin paths to the public API |
| Current state | All Phase 1A rows have `python_module_path=""`, so no data is leaked today |
| Needed for | Phase 1B, when active sports populate this field (e.g., `"apps.sports.football"`) |
| Effort | S |
| Blocking | No |

**Recommendation:** Before Phase 1B populates `python_module_path`, either (a) remove it from `SportSerializer.Meta.fields` (preferred — internal implementation detail), or (b) explicitly document that exposing the module path is acceptable. Leaking internal Django app paths is a minor information disclosure but follows principle of least exposure to remove it.

---

*End of audit report.*
