# RBAC Audit — `apps/sports` (Phase 1A)

**Audit date:** 2026-06-04
**Scope:** `backend/apps/sports/` — every mutating and sensitive-read endpoint, gating via role/module, effective_modules resolver, per-user grants, default-deny, owner-only verbs.
**Verdict:** The Phase 1A sports surface is read-only and intentionally public. No RBAC hole exists on a live write endpoint. Three medium/low findings and three forward-looking gaps are recorded below.

---

## Findings

### F-1 — MEDIUM | `django.contrib.admin` in INSTALLED_APPS with no sports admin.py (latent risk)

**File:** `backend/fixture/settings/base.py:27`
**Evidence:**
```python
DJANGO_APPS = [
    "django.contrib.admin",
    ...
]
```
**Why it matters:** `django.contrib.admin` is loaded but `/admin/` is not wired in `fixture/urls.py` (correctly commented "INTENTIONALLY DISABLED"). However, the app is still installed, so the admin autodiscovery runs. If a future developer adds an `apps/sports/admin.py` and registers `Sport` there without realising `/admin/` is unwired, there is no hard guarantee it stays unwired — a well-meaning future `path("admin/", admin.site.urls)` line in `urls.py` would silently expose a superuser-editable `Sport` table with no RBAC module gate, no audit trail, and no IP allowlist protection.
**Recommendation:** Either (a) remove `django.contrib.admin` from `INSTALLED_APPS` entirely (preferred — it is never used; the sadmin console is the privileged surface), or (b) add a test that asserts `GET /admin/` returns 404 so any future re-wiring is caught immediately.
**Confidence:** High

---

### F-2 — LOW | `deprecated` sports are returned to unauthenticated callers

**File:** `backend/apps/sports/views.py:45-52`
**Evidence:**
```python
def get_queryset(self):
    qs = Sport.objects.all()          # no default status filter
    status = self.request.query_params.get("status")
    if status and status in {s.value for s in SportStatus}:
        qs = qs.filter(status=status)
    ...
    return qs
```
**Why it matters:** `deprecated` is an end-of-life lifecycle state ("existing tournaments allowed to finish, no new ones"). Returning deprecated sports to all public callers is unlikely to be a security concern on its own, but it leaks platform lifecycle information (which sports are being retired) before any public announcement. It also means SPA consumers must filter client-side to avoid showing a deprecated sport in a "start a tournament" picker — a future foot-gun.
**Recommendation:** Either (a) add a default queryset filter `qs = Sport.objects.exclude(status=SportStatus.DEPRECATED)` with an explicit `?include_deprecated=1` override gated by `IsAuthenticated` (admin-only), or (b) at minimum document the decision in the view docstring if intentional. The latter alone would drop this to `info`.
**Confidence:** High

---

### F-3 — LOW | No throttle-scope annotation on the public sports views

**File:** `backend/apps/sports/views.py:33,56`
**Evidence:**
```python
class SportListView(generics.ListAPIView):
    permission_classes = [AllowAny]
    pagination_class = None          # returns ALL rows in one hit
```
The global anon throttle (`60/min` — `backend/fixture/settings/base.py:166`) applies, but the view returns the full catalog (59 rows) in a single unpagianted JSON response. There is no `throttle_classes` override and no custom throttle scope.
**Why it matters:** A scraper hitting `/api/sports/` 60 times per minute receives 59 × 60 = 3,540 rows per minute with no additional friction. This is low risk for a static reference catalog, but pagination or a tighter anon scope (e.g., `5/min`) would be consistent with the rest of the API's defense-in-depth posture.
**Recommendation:** Either (a) add `pagination_class = PageNumberPagination` (consistent with DRF best practice and the rest of the API), or (b) add a dedicated `SportsAnonThrottle` at `5/min`. Given the static catalog nature, option (a) is preferred.
**Confidence:** Medium (low impact in Phase 1A; higher if catalog grows)

---

## No findings (items verified clean)

- **Write endpoints:** None exist. `SportListView` and `SportDetailView` are both `generics.ListAPIView` / `generics.RetrieveAPIView` — HTTP verbs POST/PUT/PATCH/DELETE are not wired at the view or URL level. A curl `POST /api/sports/` returns 405.
- **Sensitive field leakage:** `python_module_path`, `created_at`, `updated_at` are all absent from `SportSerializer.fields` (`backend/apps/sports/serializers.py:14-29`). All declared fields have `read_only_fields = fields`.
- **Cross-org leakage:** `Sport` is intentionally platform-scoped (not org-scoped). No `organization` FK. Invariant #2 does not apply.
- **Module catalog coverage:** Correct — no module in the 22-module catalog (`backend/apps/permissions/fixtures/modules.json`) covers sport catalog management. The catalog is platform metadata, not an org-scoped surface, so the module RBAC layer correctly does not apply in Phase 1A.
- **effective_modules resolver:** Not called at all from `apps/sports` — correct for a public AllowAny surface.
- **HasModule gate:** Not applicable and not expected for read-only public metadata.
- **Django admin registration:** No `apps/sports/admin.py` exists. Sport rows cannot be edited via Django admin (though the risk of accidental re-wiring is noted in F-1).
- **load_sports management command:** OS-level access required; not accessible via HTTP. Correct.
- **Sadmin console:** Sports management routes are absent from `backend/apps/sadmin/urls.py` and all sadmin views. Correct for Phase 1A.
- **Idempotent write / event_id:** Not applicable (no write endpoints).
- **Audit trail:** Not applicable (no mutations in Phase 1A).
- **UUID v7 PK:** Confirmed on `Sport.id` (`backend/apps/sports/models.py:71`: `id = models.UUIDField(primary_key=True, default=uuid7, editable=False)`).

---

## Gaps (forward-looking, Phase 1B)

### G-1 — No `sport.catalog_admin` module defined (Phase 1B write surface)

**Area:** `backend/apps/permissions/fixtures/modules.json`
**Current state:** 22 modules exist; none covers sport catalog management (create/edit/deprecate sport rows).
**Missing:** When Phase 1B lands write endpoints for the sport catalog (e.g., `PATCH /api/sports/<code>/` to flip `status` from `planned` to `coming_soon`), a `sport.catalog_admin` module must be added to the catalog and those endpoints must be gated by `HasModule("sport.catalog_admin")` + `IsSuperAdmin`. Without this, the write surface will need a separate gating decision at implementation time.
**Needed for:** Phase 1B sport catalog write endpoints
**Effort:** S
**Blocking:** No (Phase 1B not started)

---

### G-2 — No sadmin sport management surface (Phase 1B)

**Area:** `backend/apps/sadmin/urls.py`, `backend/apps/sadmin/views/`
**Current state:** Sadmin has no routes or views for sport catalog management.
**Missing:** A sadmin sports view for super-admin to flip a sport's `status` (e.g., `planned → coming_soon → active`) and populate `python_module_path` when a per-sport plugin ships. Currently the only mutation path is the `load_sports` management command (SSH-level access).
**Needed for:** Phase 1B operational workflow (announcing new sports)
**Effort:** M
**Blocking:** No

---

### G-3 — No test asserting write verbs return 405 on sports endpoints

**Area:** `backend/apps/sports/tests/test_catalog.py`
**Current state:** Tests cover GET list, GET detail, filter-by-status, filter-by-category, and 404-for-unknown-code. No test asserts that `POST /api/sports/` and `PUT/PATCH/DELETE /api/sports/<code>/` return 405.
**Missing:** Regression tests for the "no writes allowed" invariant. If a future developer accidentally switches `ListAPIView → ListCreateAPIView`, there is no test gate.
**Needed for:** Correctness + regression safety
**Effort:** S
**Blocking:** No
