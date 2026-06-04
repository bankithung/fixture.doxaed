# Audit: sports — Missing Tests (Test Gaps)

**Lens:** missing cross-org isolation tests (#2), permission-denied/negative tests,
state-machine + blocked-transition tests, idempotent-replay tests, and untested error paths.

**Scope:** `backend/apps/sports/` — all source files and the single test file
`backend/apps/sports/tests/test_catalog.py`.

**Note on cross-org isolation (#2):** `Sport` intentionally has **no `organization` FK** —
the model docstring states "It is intentionally NOT org-scoped — sports are platform-level
metadata." Therefore invariant #2 does **not** apply here, and there are no cross-org
isolation gaps by design. All gaps below come from other audit lenses.

---

## Findings

### F-01 — Write methods (POST/PUT/PATCH/DELETE) not asserted to return 405
- **Severity:** medium
- **File:** `backend/apps/sports/tests/test_catalog.py`
- **Evidence:** The test file only exercises `GET`. `SportListView` and `SportDetailView`
  extend `generics.ListAPIView` / `generics.RetrieveAPIView`, which DRF restricts to GET
  by default — but this is never explicitly tested.
- **Why it matters:** A future refactor that accidentally adds `UpdateModelMixin` or
  swaps to `ModelViewSet` would silently open write endpoints to the public
  (`permission_classes = [AllowAny]` on both views) without any test catching it.
- **Recommendation:** Add parametrized tests for POST `/api/sports/`, and
  PUT/PATCH/DELETE `/api/sports/football/` — assert `status_code == 405`.

### F-02 — Invalid filter query-params silently ignored — no test
- **Severity:** low
- **File:** `backend/apps/sports/views.py:47-52`
- **Evidence (views.py:47-52):**
  ```python
  status = self.request.query_params.get("status")
  if status and status in {s.value for s in SportStatus}:
      qs = qs.filter(status=status)
  ```
  Invalid values are silently dropped; the full catalog is returned. This is arguably
  correct behavior but is **completely untested**.
- **Why it matters:** If the guard logic were accidentally inverted (e.g., `not in`
  instead of `in`), every valid filter would break and no test would catch it.
- **Recommendation:** Add `test_sport_list_invalid_status_filter_returns_all` and
  `test_sport_list_invalid_category_filter_returns_all` that pass bogus values and
  assert `len(body) == Sport.objects.count()`.

### F-03 — `load_sports --path` override / file-not-found error path untested
- **Severity:** low
- **File:** `backend/apps/sports/management/commands/load_sports.py:36-39`
- **Evidence (load_sports.py:36-39):**
  ```python
  if not path.exists():
      self.stderr.write(self.style.ERROR(f"Fixture not found: {path}"))
      return
  ```
  This early-exit path is dead code from a test perspective. No test passes `--path`
  pointing to a non-existent file.
- **Why it matters:** The command silently returns (no exception, no non-zero exit code)
  when the fixture is missing — a misconfigured deploy could call `load_sports` against
  an empty DB and fail silently. The test should assert `Sport.objects.count() == 0`
  after the failed call.
- **Recommendation:** Add `test_load_sports_missing_path_is_a_no_op` that calls
  `call_command("load_sports", path="/nonexistent/path.json")` and asserts 0 rows created.

### F-04 — `load_sports` category/status fallback warning path untested
- **Severity:** low
- **File:** `backend/apps/sports/management/commands/load_sports.py:56-73`
- **Evidence (load_sports.py:56-63):**
  ```python
  if category not in valid_categories:
      self.stderr.write(
          self.style.WARNING(
              f"Sport {code}: unknown category {category!r}; "
              f"falling back to 'other'."
          )
      )
      category = SportCategory.OTHER.value
  ```
  Same for the `status` fallback. Both branches are reachable but have zero test coverage.
- **Why it matters:** If the fallback were broken (e.g., assigned `None` instead of
  `SportCategory.OTHER.value`), a DB constraint would fire in production but no test
  would catch it.
- **Recommendation:** Add `test_load_sports_unknown_category_falls_back_to_other` using
  a temp JSON file (via `tmp_path` pytest fixture) with a row containing
  `"category": "nonsense"` — assert the row is created with `category == "other"`.
  Mirror for the status path.

### F-05 — No test for `load_sports` with malformed JSON (non-array root)
- **Severity:** low
- **File:** `backend/apps/sports/management/commands/load_sports.py:42-44`
- **Evidence (load_sports.py:42-44):**
  ```python
  if not isinstance(data, list):
      self.stderr.write(self.style.ERROR("sports.json must be a JSON array."))
      return
  ```
  Untested. A JSON object `{}` at root triggers the guard and silently returns.
- **Why it matters:** Same silent-failure risk as F-03.
- **Recommendation:** Add `test_load_sports_non_array_json_is_a_no_op` using `tmp_path`.

### F-06 — No test verifying timestamp fields (`created_at`/`updated_at`) are absent from API response
- **Severity:** medium
- **File:** `backend/apps/sports/serializers.py:14-29`
- **Evidence (serializers.py:13-29):**
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
  `created_at` and `updated_at` are **not** in `fields` — good. But no test asserts the
  API response body does **not** contain those keys. If `fields` were accidentally replaced
  with `"__all__"`, timestamps would leak to unauthenticated callers without any test
  failing.
- **Why it matters:** Timestamps are internal metadata; leaking them is a minor info
  disclosure and breaks API contract.
- **Recommendation:** Add assertions in `test_sport_list_endpoint_is_public` and
  `test_sport_detail_endpoint_by_code` that `"created_at" not in body[0]` and
  `"updated_at" not in body`.

### F-07 — No test for `?status=active` returning an empty list (edge case)
- **Severity:** low
- **File:** `backend/apps/sports/tests/test_catalog.py`
- **Evidence:** All seeded sports have `status="planned"` or `status="coming_soon"`.
  Filtering by `?status=active` should return `[]`, but this edge case (valid filter,
  empty result) is never tested.
- **Why it matters:** A bug that returns the full list instead of an empty list when the
  filter matches nothing would not be caught.
- **Recommendation:** Add `test_sport_list_filter_active_returns_empty` asserting
  `body == []`.

### F-08 — No test verifying authenticated users still receive 200 on public endpoints
- **Severity:** info
- **File:** `backend/apps/sports/tests/test_catalog.py`
- **Evidence:** Every test uses an anonymous `APIClient()`. No test logs in a user and
  calls `GET /api/sports/` to confirm auth does not accidentally break public access
  (e.g., via a misconfigured global `DEFAULT_PERMISSION_CLASSES` that adds
  `IsAuthenticated` project-wide).
- **Why it matters:** Regression protection. If a future settings change adds
  `IsAuthenticated` globally, only the sports endpoint (which overrides with `AllowAny`)
  might break silently in an unexpected direction.
- **Recommendation:** Add `test_sport_list_authenticated_user_also_gets_200` that logs
  in via `client.force_authenticate(user=UserFactory())` and asserts 200.

### F-09 — No factory for `Sport` model; tests depend entirely on `load_sports` command
- **Severity:** medium
- **File:** `backend/apps/sports/tests/test_catalog.py` (all tests)
- **Evidence:** Every test calls `call_command("load_sports")` to populate data.
  There is no `SportFactory` (no `backend/apps/sports/tests/factories.py`).
- **Why it matters:** Unit tests for individual Sport behavior (field validation,
  `__str__`, model ordering) require loading 59-row JSON files. Tests become slow
  and fragile (a bad fixture file breaks all sports tests). If Phase 1B adds model
  constraints (FK, unique_together), tests that need just one Sport row will continue
  loading the full catalog unnecessarily.
- **Recommendation:** Create `backend/apps/sports/tests/factories.py` with a
  `SportFactory` using `factory_boy`. Update existing tests that only need one or two
  Sport rows to use the factory instead of `call_command("load_sports")`.

### F-10 — `is_team_sport=True` AND `is_individual_sport=True` simultaneously allowed — no model or test guard
- **Severity:** low
- **File:** `backend/apps/sports/models.py:101-102`
- **Evidence (models.py:101-102):**
  ```python
  is_team_sport = models.BooleanField(default=False)
  is_individual_sport = models.BooleanField(default=False)
  ```
  No `CheckConstraint` prevents both flags from being `True` simultaneously. No test
  asserts this is blocked (or explicitly documents that it is allowed).
- **Why it matters:** A sport that is simultaneously team and individual is
  semantically incoherent for Phase 1B tournament formation logic. If left unguarded,
  a bad seed entry could create a row that breaks downstream tournament validators.
- **Recommendation:** Either add a `CheckConstraint` in `Meta.constraints` (and test
  that it fires), or add a comment + test documenting the intentional permissiveness.

---

## Gaps (forward-looking, not currently applicable)

| # | Item | Missing | Needed for | Effort |
|---|------|---------|-----------|--------|
| G-01 | Cross-org isolation for sport usage | Sport has no org FK now; when Phase 1B adds per-org sport opt-in (Tournament → Sport FK), isolation tests are required | Phase 1B tournament creation | M |
| G-02 | State-machine transitions for `SportStatus` | No state machine is enforced (`planned → coming_soon → active → deprecated`); any value can be written directly via Django admin. Phase 1B should add a transition guard + audit log + tests covering blocked transitions | Phase 1B sport activation workflow | M |
| G-03 | Write-access permission tests for super-admin | Super-admin console (`apps.sadmin`) is expected to allow catalog edits. No admin view or test for `PATCH /sadmin/sports/<id>` exists yet | Phase 1B sadmin sport management | S |
| G-04 | Idempotent-replay test for the future write endpoint | When a write API is added (Phase 1B), invariant #3 (client `event_id` idempotency) must be tested | Phase 1B sports admin API | M |
| G-05 | `python_module_path` validation test | When the field is populated (Phase 1B plugin registration), a test should verify the path is importable and the module exposes the expected interface | Phase 1B plugin dispatch | M |
