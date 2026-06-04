# Structural Map: `backend/apps/sports`

**Date:** 2026-06-04
**Status:** Read-only Phase 1A catalog. No write paths, no per-sport plugin subapps, no FK references from any other app yet.
**Severity scale:** critical | high | medium | low | info

---

## Purpose

`apps.sports` is the platform-level sports-catalog app. It holds a single model (`Sport`) describing every sport the platform plans to support over its lifetime. Phase 1A ships only this read-only catalog (59 seeded rows). Each sport will eventually have its own per-sport plugin Django app under `apps.sports.<sport_code>` (e.g., `apps.sports.football`) when Phase 1B work for that sport begins. The catalog is intentionally NOT org-scoped.

---

## Key Files

| File | Role |
|------|------|
| `backend/apps/sports/models.py` | `Sport`, `SportStatus`, `SportCategory` enums + model definition |
| `backend/apps/sports/serializers.py` | `SportSerializer` — read-only, all fields |
| `backend/apps/sports/views.py` | `SportListView` (list + filter), `SportDetailView` (by slug) |
| `backend/apps/sports/urls.py` | `""` → list, `<slug:code>/` → detail; `app_name = "sports"` |
| `backend/apps/sports/apps.py` | `SportsConfig` — `name="apps.sports"`, `label="sports"` |
| `backend/apps/sports/fixtures/sports.json` | 59 seed entries; loaded by `load_sports` management command |
| `backend/apps/sports/management/commands/load_sports.py` | Idempotent upsert by `code`; validates category/status enums |
| `backend/apps/sports/migrations/0001_initial.py` | Only migration; creates `sports_sport` table |
| `backend/apps/sports/tests/test_catalog.py` | 6 tests: idempotency, enum validity, list endpoint, filters, detail, 404 |

---

## Models / Types

### `SportStatus` (TextChoices)
- `planned` — stub, no plugin yet (default for all 58 non-football rows)
- `coming_soon` — plugin in development (football only in seed)
- `active` — fully wired (no rows in seed)
- `deprecated` — retiring (no rows in seed)

### `SportCategory` (TextChoices)
13 values: `team`, `individual`, `racket`, `combat`, `athletics`, `aquatics`, `gymnastics`, `strength`, `shooting`, `mind`, `indigenous`, `adventure`, `other`.
The `other` category has **zero rows** in the current fixture.

### `Sport` (Model — table `sports_sport`)

| Field | Type | Notes |
|-------|------|-------|
| `id` | UUIDField (PK) | `default=uuid7` — invariant #1 satisfied |
| `code` | SlugField(64) | unique; URL key + future plugin app suffix |
| `name` | CharField(200) | display name |
| `category` | CharField(32) | indexed; `SportCategory` choices |
| `status` | CharField(16) | indexed; `SportStatus` choices |
| `description` | TextField | blank-allowed |
| `indigenous_to` | CharField(128) | free-form origin label |
| `is_team_sport` | BooleanField | |
| `is_individual_sport` | BooleanField | |
| `python_module_path` | CharField(200) | future plugin path; blank while planned/coming_soon |
| `icon` | CharField(64) | Lucide icon name hint for UI |
| `display_order` | PositiveIntegerField | default 1000; ordering key |
| `created_at` | DateTimeField | auto_now_add |
| `updated_at` | DateTimeField | auto_now |

Meta: `ordering = ["display_order", "name"]`; two `db_index`-backed fields plus two explicit `Index` objects (`sport_status_idx`, `sport_category_idx`) — the explicit indexes are **redundant** with the `db_index=True` on the same fields (see Finding 1).

---

## Endpoints / Routes

Mounted at `GET /api/sports/` via `backend/fixture/urls.py:36`.

| Method | Path | View | Auth | Notes |
|--------|------|------|------|-------|
| GET | `/api/sports/` | `SportListView` | `AllowAny` | `?status=` and `?category=` filters; no pagination |
| GET | `/api/sports/<code>/` | `SportDetailView` | `AllowAny` | lookup by slug `code` field |

No write endpoints exist (by design for Phase 1A).

---

## Findings

### Finding 1 — Redundant DB indexes (low)
**File:** `backend/apps/sports/models.py:80-92` and `models.py:125-128`

```python
category = models.CharField(
    max_length=32,
    choices=SportCategory.choices,
    default=SportCategory.OTHER,
    db_index=True,          # <-- creates an index
    ...
)
status = models.CharField(
    max_length=16,
    choices=SportStatus.choices,
    default=SportStatus.PLANNED,
    db_index=True,          # <-- creates an index
    ...
)
...
indexes = [
    models.Index(fields=["status"], name="sport_status_idx"),   # duplicate
    models.Index(fields=["category"], name="sport_category_idx"),  # duplicate
]
```

Both `db_index=True` and an explicit `Meta.indexes` entry create an index on the same column. Postgres ends up with two indexes per column. Neither is wrong at runtime, but it wastes storage and adds write overhead.

**Recommendation:** Remove `db_index=True` from both fields and keep only the named `Meta.indexes` entries (so they have stable names for future partial-index upgrades), OR drop the `Meta.indexes` block and rely on `db_index=True`. Either is fine; pick one convention and add a migration to drop the orphan.

---

### Finding 2 — `SportDetailView` missing `@extend_schema` decorator (low)
**File:** `backend/apps/sports/views.py:56-63`

```python
class SportDetailView(generics.RetrieveAPIView):
    """``GET /api/sports/<code>/`` — fetch a single sport by code."""

    serializer_class = SportSerializer
    permission_classes = [AllowAny]
    queryset = Sport.objects.all()
    lookup_field = "code"
    lookup_url_kwarg = "code"
```

`SportListView` has `@extend_schema(parameters=[...])` but `SportDetailView` has none. drf-spectacular will auto-generate an operationId of `sports_retrieve` (potentially colliding if other slug-by-code patterns are added), and the path parameter `{code}` won't have a description in the OpenAPI output.

**Recommendation:** Add `@extend_schema(summary="Fetch a single sport by code", tags=["Sports"])` (and equivalent on `SportListView`) to produce consistent, documented schema output and avoid future operationId collisions.

---

### Finding 3 — `AppConfig.default_auto_field = BigAutoField` conflicts with UUID v7 PK invariant (info)
**File:** `backend/apps/sports/apps.py:5`

```python
class SportsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
```

The `Sport` model manually sets `id = UUIDField(primary_key=True, default=uuid7)`, so this `default_auto_field` never fires for `Sport`. However, it is misleading: if a future developer adds a related model inside this app without explicitly specifying the PK field, Django will silently use `BigAutoField` (sequential integer) — violating architectural invariant #1 (UUID v7 PKs everywhere).

**Recommendation:** Change to `default_auto_field = "django.db.models.UUIDField"` — or better yet, use a custom `UUIDField` subclass that defaults to `uuid7`. The same issue exists in other app configs; this is a platform-wide pattern fix.

---

### Finding 4 — No `conftest.py` for sports tests; every test calls `load_sports` separately (low)
**File:** `backend/apps/sports/tests/test_catalog.py:22,33,48,60,73,85,97`

Every test function calls `call_command("load_sports")` independently. This is safe (the command is idempotent) but slow — it parses and upserts 59 rows per test. Other apps (accounts, organizations, audit, permissions, sadmin) all have a `tests/conftest.py`. Sports has none.

**Recommendation:** Add `backend/apps/sports/tests/conftest.py` with an autouse `session`-scoped fixture that calls `load_sports` once per test session, then marks the DB as shared (`django_db_setup`). Alternatively, use a `pytest.fixture(scope="session")` with `@pytest.mark.django_db(databases=["default"])`.

---

### Finding 5 — Fixture seed has 59 sports but `SportCategory.other` has zero rows (info)
**File:** `backend/apps/sports/fixtures/sports.json` (full file)

All 12 active categories are represented. The 13th category, `other`, is defined in the enum but has no seed entries and no UI documentation. This is not a bug — the category exists as a catch-all for future sports.

**Recommendation:** Document in the fixture file or in a comment in `models.py` that `other` is intentionally empty in the seed. Alternatively, add a data validation note to `load_sports` that logs a summary of category distribution so operators know if they've miscategorised an entry.

---

### Finding 6 — `python_module_path` field has no validation / constraint (medium)
**File:** `backend/apps/sports/models.py:108`

```python
python_module_path = models.CharField(max_length=200, blank=True, default="")
```

When Phase 1B begins, this field is intended to hold a dotted Python module path (e.g., `"apps.sports.football"`). There is no validator that enforces the dotted-path format, no check that the module actually exists, and no constraint that it must be non-empty when `status = "active"`. A typo in this field will cause a silent runtime dispatch failure.

**Recommendation:** Add a `clean()` method on `Sport` (or a `RegexValidator`) that validates the dotted-path format when non-empty. Add a DB-level `CheckConstraint` that requires `python_module_path != ''` when `status = 'active'`. Document the expected format in the field comment.

---

### Finding 7 — `is_team_sport` / `is_individual_sport` dual-boolean: no mutual-exclusivity constraint (medium)
**File:** `backend/apps/sports/models.py:101-102`

```python
is_team_sport = models.BooleanField(default=False)
is_individual_sport = models.BooleanField(default=False)
```

There is no DB `CheckConstraint`, no model `clean()`, and no serializer validator preventing both booleans from being `True` simultaneously (or both being `False`). The current fixture data is clean (confirmed: 0 entries with both True; 0 entries with both False). But the fixture's `load_sports` command does no such validation either. A future admin edit via sadmin or a bad fixture entry would silently produce an inconsistent row.

**Recommendation:**
1. Add a `Meta.constraints` entry: `CheckConstraint(check=~Q(is_team_sport=True, is_individual_sport=True) & (Q(is_team_sport=True) | Q(is_individual_sport=True)), name="sport_one_sport_type")`.
2. Add a `clean()` method that raises `ValidationError` for the same condition.
3. Add validation to `load_sports` that warns if both or neither are set.

---

### Finding 8 — `SportListView` has `pagination_class = None` but no `PAGE_SIZE` guard (info)
**File:** `backend/apps/sports/views.py:44`

```python
pagination_class = None
```

Currently 59 rows — small enough to be safe. However, once Phase 1B matures and more sports are added, this will return the full catalog in one response. The global DRF config does not set `DEFAULT_PAGINATION_CLASS` so the absence of pagination is explicit, not accidentally inherited. At 59 rows this is fine, but worth flagging for when the catalog grows past ~200 entries (unlikely in near term, but possible long-term).

**Recommendation:** Document the intentional decision in a comment. If the catalog ever exceeds ~200 entries, add cursor pagination.

---

### Finding 9 — `load_sports` wraps entire upsert in a single `transaction.atomic()` (info)
**File:** `backend/apps/sports/management/commands/load_sports.py:52`

```python
with transaction.atomic():
    for entry in data:
        ...
        Sport.objects.update_or_create(code=code, defaults=defaults)
```

A single transaction for all 59 rows is correct — it ensures the catalog is either fully updated or not at all. This is the right pattern. Flagged as info only because the comment in `load_sports.py` doesn't explain why atomic is used (i.e., all-or-nothing semantics).

**Recommendation:** Add a one-line comment: `# All-or-nothing: bad fixture data should not leave catalog in a partially-updated state.`

---

### Finding 10 — No `@extend_schema(tags=["Sports"])` on either view (low)
**File:** `backend/apps/sports/views.py:17-63`

Neither view uses `tags=["Sports"]` in its schema decorator. The `SPECTACULAR_SETTINGS` description still says "Phase 1A — User types, Org membership..." without mentioning the sports catalog. The sports endpoints will appear untagged in the Swagger UI (`/api/docs/`).

**Recommendation:** Add `tags=["Sports"]` to `@extend_schema` on both views, and update `SPECTACULAR_SETTINGS["DESCRIPTION"]` to mention the catalog surface.

---

## Gaps (Phase 1B readiness)

| Gap | Severity | Notes |
|-----|----------|-------|
| No Tournament-to-Sport FK | info | Expected — `Tournament` model does not exist yet. Phase 1B must add `Tournament.sport = ForeignKey("sports.Sport", ...)`. |
| No per-org sport opt-in model | info | `models.py:12-13` explicitly defers this to Phase 1B. An `OrgSport` join table will be needed. |
| No per-sport plugin subapps | info | `apps.sports.football` (and peers) do not exist; `python_module_path` is blank for all 59 rows. |
| No admin interface for the catalog | info | No `admin.py` registered; the sadmin console has no sports management surface. Fine for Phase 1A but needed before operators can add new sports without running `load_sports`. |
| No search by `name` (text) | low | List endpoint supports `?status=` and `?category=` but not `?q=` free-text search on `name`. Fine for 59 rows; may matter at scale. |
| `status=active` has zero rows in seed | info | No sport is fully wired yet. The `active` path through the Phase 1B dispatch runtime is untested end-to-end. |
| No versioning on the fixture file | info | `sports.json` has no schema version field. If fields are added/renamed, `load_sports` would silently drop unrecognised keys via `.get()`. Consider adding `"_schema_version": 1` and asserting it in `load_sports`. |

---

## Summary

The sports app is structurally clean and minimal for its Phase 1A role. The code is well-documented, the `load_sports` command is correctly idempotent, the two public endpoints are auth-free (appropriate for catalog metadata), and the 6 tests cover the essential paths. The highest-priority issues before Phase 1B begins are:

1. **(medium)** Add a DB `CheckConstraint` enforcing `is_team_sport XOR is_individual_sport` (Finding 7).
2. **(medium)** Add a `CheckConstraint` + `clean()` requiring `python_module_path` non-empty when `status = 'active'` (Finding 6).
3. **(low)** Drop the redundant double-index on `status` and `category` (Finding 1).
4. **(low)** Fix `AppConfig.default_auto_field` to prevent accidental sequential-int PKs on future models (Finding 3).
