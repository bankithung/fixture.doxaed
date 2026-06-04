# Correctness Audit: `backend/apps/sports`

**Date:** 2026-06-04
**Lens:** Correctness & logic bugs — wrong conditionals, off-by-one, races, wrong queryset filters, missing transaction.atomic / on_commit, serializer<->model mismatch, wrong HTTP status, None handling, tz math.
**Scope:** `backend/apps/sports/` — models, views, serializers, URLs, management command, fixture JSON, tests.

---

## Findings

### F1 — LOW: `load_sports` bare `entry["code"]` access raises unhandled `KeyError`, exits 0 on failure

**File:** `backend/apps/sports/management/commands/load_sports.py:54`

**Evidence:**
```python
with transaction.atomic():
    for entry in data:
        code = entry["code"]   # <-- bare access, no .get() / KeyError guard
```

**Why it matters:**
If a future fixture entry is missing the `"code"` key, a `KeyError` is raised inside `transaction.atomic()`. Django rolls back the entire batch silently. The command then crashes with a traceback but returns **exit code 0** (no `sys.exit(1)` / `raise CommandError` call), so CI/deploy scripts that check the exit code will treat a total rollback as success. Every subsequent `load_sports` run will also appear to be a no-op.

**Recommendation:**
Use `entry.get("code")` and raise a `CommandError` on missing or empty `code`. Move the `raise CommandError` or `self.stderr.write` + `return` before the `transaction.atomic()` block so a bad fixture is rejected before any DB work starts. Or wrap `entry["code"]` in a try/except and call `raise CommandError(...)` to get a non-zero exit.

---

### F2 — LOW: `cycling` `display_order=1000` collides with model default `default=1000`

**File:** `backend/apps/sports/fixtures/sports.json:401` and `backend/apps/sports/models.py:116`

**Evidence (fixture):**
```json
{ "code": "cycling", "display_order": 1000 }
```
**Evidence (model):**
```python
display_order = models.PositiveIntegerField(default=1000)
```

**Why it matters:**
The model docstring says "Defaults to 1000 so newly-added sports land at the bottom." But `cycling` explicitly uses 1000. Any sport added to the fixture without an explicit `display_order` gets 1000, making it co-ordered with `cycling`. The secondary sort key is `name`, so new sports will be interleaved alphabetically with `cycling` rather than appended cleanly after it. This silently breaks the "land at the bottom" contract whenever a new entry is added without a display_order.

**Recommendation:**
Assign `cycling` a display_order that is not the default sentinel (e.g., `1000` stays and the default becomes `9999`), or give `cycling` a unique value like `1050` and reserve `1000–1049` as a range. Also consider adding a data integrity test that asserts no two active fixture entries share a `display_order`.

---

### F3 — LOW: No DB-level `CheckConstraint` ensuring `is_team_sport XOR is_individual_sport`

**File:** `backend/apps/sports/models.py:101–103`

**Evidence:**
```python
is_team_sport = models.BooleanField(default=False)
is_individual_sport = models.BooleanField(default=False)
```
No `constraints = [...]` block exists in the model `Meta`.

**Why it matters:**
The fixture JSON correctly sets exactly one flag per sport. But the model itself has no `CheckConstraint` that enforces:
1. Not both `True` simultaneously (e.g., a data-entry mistake).
2. Not both `False` simultaneously (all current rows have exactly one set, but a Sport created via the shell or Phase 1B admin could have both `False`).

When Phase 1B tournament logic tries to determine if a sport is team-based or individual (e.g., for team registration validation), querying `sport.is_team_sport` on a row that has both `False` returns a silent wrong answer.

**Recommendation:**
Add a `CheckConstraint` to `Sport.Meta`:
```python
constraints = [
    models.CheckConstraint(
        check=(
            models.Q(is_team_sport=True, is_individual_sport=False) |
            models.Q(is_team_sport=False, is_individual_sport=True)
        ),
        name="sport_exactly_one_type",
    )
]
```

---

### F4 — INFO: `load_sports` reports total sport count OUTSIDE `transaction.atomic()` — can mislead in concurrent runs

**File:** `backend/apps/sports/management/commands/load_sports.py:97`

**Evidence:**
```python
        # <-- end of `with transaction.atomic():` block
        total = Sport.objects.count()
        self.stdout.write(self.style.SUCCESS(f"... total in DB: {total}."))
```

**Why it matters:**
The total count is read after the atomic block commits. If a concurrent `load_sports` invocation (or a separate deploy) has already committed more rows between the commit and the count query, the reported total is inaccurate. This is a cosmetic issue only — no data is lost — but in a deploy pipeline with parallel workers it could produce misleading output.

**Recommendation:**
Move the count inside the `with transaction.atomic():` block, or accept this as cosmetic and document it.

---

### F5 — INFO: `test_sport_list_endpoint_is_public` ordering assertion is only first-vs-last, not monotonically verified

**File:** `backend/apps/sports/tests/test_catalog.py:55`

**Evidence:**
```python
assert body[0]["display_order"] <= body[-1]["display_order"]
```

**Why it matters:**
With 59 unique display orders, the DB `ORDER BY display_order, name` guarantees strictly monotonic output. But the test only checks `body[0] <= body[-1]`, which would pass even if the middle of the list were out of order (e.g., due to a pagination bug, or if someone bypasses the model ordering). This provides weak regression coverage for the ordering contract.

**Recommendation:**
Replace with:
```python
orders = [s["display_order"] for s in body]
assert orders == sorted(orders), "Catalog must be ordered by display_order ascending"
```

---

### F6 — INFO: Invalid filter values in `SportListView.get_queryset()` silently no-op — correct but untested

**File:** `backend/apps/sports/views.py:47–52`

**Evidence:**
```python
if status and status in {s.value for s in SportStatus}:
    qs = qs.filter(status=status)
```

**Why it matters:**
`?status=invalid` returns all sports (the filter is skipped). This is the correct behavior, but there is no test asserting it. A future developer could misread this as "invalid status should return 400" and change the conditional, breaking the silent-skip contract without a failing test to warn them.

**Recommendation:**
Add a test:
```python
def test_sport_list_ignores_unknown_status_filter():
    res = client.get("/api/sports/?status=invalid")
    assert res.status_code == 200
    assert len(res.json()) == Sport.objects.count()
```

---

## No Issues Found (checked but clean)

| Area | Finding |
|---|---|
| Transaction wrapping in `load_sports` | `transaction.atomic()` correctly wraps all `update_or_create` calls. |
| Idempotency | `update_or_create(code=code, defaults=...)` is correct; re-run is safe. |
| HTTP status codes | Both views are read-only (`ListAPIView`, `RetrieveAPIView`); returns 200/404 per DRF convention. No write paths = no idempotent-replay concern here. |
| Permission class correctness | Both views explicitly set `permission_classes = [AllowAny]`, correctly overriding the global `IsAuthenticated` default. |
| Serializer<->model field match | All 10 serializer fields match model fields. `python_module_path`, `created_at`, `updated_at` are intentionally excluded from the API response. |
| URL routing | `<slug:code>/` pattern correctly constrains the `code` URL param to slug-safe characters, matching the `SlugField` in the model. |
| Timezone math | No datetime arithmetic in this app; `created_at`/`updated_at` use `auto_now_add`/`auto_now` (UTC-stored correctly). |
| None handling | All `entry.get(key, default)` calls in `load_sports` provide non-None defaults. |
| Enum iteration for filter validation | `{s.value for s in SportStatus}` correctly iterates `TextChoices` members and returns string values. |
| Status `max_length` | Longest value is `coming_soon` (11 chars); field `max_length=16` fits. |
| Duplicate codes/display_orders in fixture | None found (59 unique codes, 59 unique display orders). |
| Cross-org data leak | `Sport` is intentionally NOT org-scoped; correct for platform metadata. |

---

## Gaps (forward-looking, not current bugs)

| # | Gap | Needed for | Effort | Blocking |
|---|---|---|---|---|
| G1 | No `CheckConstraint` for `is_team_sport XOR is_individual_sport` at DB level (see F3). | Phase 1B team-registration validation; prevents silent wrong sport-type queries. | S | No (Phase 1B) |
| G2 | `cycling` `display_order=1000` collides with model default. Fixture needs a clean `display_order` assignment scheme that doesn't conflict with the default sentinel. | Fixture data hygiene before catalog grows. | S | No |
| G3 | No multi-tenancy isolation test needed here (Sport is platform-level, not org-scoped) — but Phase 1B must add `OrgSport` opt-in table. The current `Sport` table has no org FK and no org filter, which is correct for Phase 1A but needs a spec decision before Phase 1B re-uses these endpoints. | Phase 1B tournament creation (which sport is enabled for an org). | M | No (Phase 1B) |
| G4 | `load_sports` command has no dry-run (`--dry-run`) or diff output mode. When updating an existing production catalog, operators cannot preview what will change before committing. | Operational safety for production catalog updates. | S | No |
| G5 | `SportListView.pagination_class = None` is fine for 59 sports, but there is no documented upper-bound cap. If the catalog grows beyond ~200 sports, unpaginated responses become a performance concern. | Not blocking now; revisit at 150+ sports. | S | No |
| G6 | `python_module_path` field is writable via `load_sports` but has no runtime validation that the path is a real importable module. Phase 1B's plugin dispatch will rely on this field; bad values will cause runtime ImportErrors. A validator or management command check should be added before Phase 1B ships. | Phase 1B sport plugin dispatch. | S | No (Phase 1B) |
