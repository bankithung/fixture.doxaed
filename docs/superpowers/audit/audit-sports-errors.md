# Audit: backend/apps/sports — Silent Failures & Error Handling
**Date:** 2026-06-04
**Lens:** bare/broad except, except:pass, masking fallbacks, missing validation, unguarded None/KeyError, non-atomic multi-writes, 500-on-bad-input where 400 is right, inconsistent error bodies.
**Verdict:** The sports app is minimal and largely well-behaved, but carries five concrete issues (none critical, one high).

---

## Findings

### F1 — MEDIUM | Silently ignores unknown query params; no 400 for clearly invalid filter values

**File:** `backend/apps/sports/views.py:47–52`

```python
status = self.request.query_params.get("status")
if status and status in {s.value for s in SportStatus}:
    qs = qs.filter(status=status)
category = self.request.query_params.get("category")
if category and category in {c.value for c in SportCategory}:
    qs = qs.filter(category=category)
```

**Why it matters:** A caller who typos `?status=acitve` or `?category=raquet` gets a silent full-list response with HTTP 200. This is a classic silent-failure: the filter is invisibly dropped. The caller has no way to know the param was unrecognised. Industry-standard REST practice is to return HTTP 400 with `{"status": ["Value 'acitve' is not a valid choice."]}` when a filter param is supplied but invalid. This is especially important for automated consumers (frontend TanStack Query hooks, public API users) that may cache the bad response and serve wrong data silently.

**Recommendation:** Return 400 when a non-empty `status` or `category` param does not match a valid enum value. A simple DRF `ValidationError` raised inside `get_queryset` (or via a `django-filter`/manual validation step) is sufficient:

```python
from rest_framework.exceptions import ValidationError

if status and status not in {s.value for s in SportStatus}:
    raise ValidationError({"status": f"'{status}' is not a valid status. Valid: {sorted(valid_statuses)}"})
```

**Confidence:** High

---

### F2 — MEDIUM | `load_sports` command: bare `entry["code"]` KeyError crashes the whole import transaction

**File:** `backend/apps/sports/management/commands/load_sports.py:54`

```python
for entry in data:
    code = entry["code"]   # bare dict access — KeyError if field absent
```

**Why it matters:** Every other field uses `.get()` with a default. `code` alone uses a bare `[]` access. If any entry in `sports.json` (or an operator-supplied override file via `--path`) is missing the `code` key, the command raises an unhandled `KeyError`, which propagates out of the `transaction.atomic()` block and aborts the entire import with an unformatted Python traceback on stderr. The `management.BaseCommand` does not wrap exceptions from `handle()` in a user-friendly error message; the operator sees a raw stack trace with no recovery guidance.

This is a data-loading command, not a view, so there is no risk of a 500 response to end users — but it is an "unguarded None/KeyError" finding per the audit lens.

**Recommendation:** Guard the `code` field and emit a formatted `stderr` error and `continue` (or abort with a clean message):

```python
code = entry.get("code", "").strip()
if not code:
    self.stderr.write(self.style.ERROR(
        f"Entry at index {idx} is missing a 'code' field; skipping."
    ))
    continue
```

**Confidence:** High

---

### F3 — LOW | `load_sports`: `display_order` cast may raise `ValueError` silently propagating through `atomic()`

**File:** `backend/apps/sports/management/commands/load_sports.py:86`

```python
"display_order": int(entry.get("display_order", 1000)),
```

**Why it matters:** If a fixture entry has `"display_order": "high"` or a non-integer value, `int(...)` raises a `ValueError` inside the `atomic()` block. Like F2, this causes the whole transaction to roll back with a raw traceback rather than a clean operator error. The default value `1000` is only used when the key is absent — not when the key is present with a bad type.

**Recommendation:** Wrap the cast:

```python
raw_order = entry.get("display_order", 1000)
try:
    display_order = int(raw_order)
except (TypeError, ValueError):
    self.stderr.write(self.style.WARNING(
        f"Sport {code}: invalid display_order {raw_order!r}; defaulting to 1000."
    ))
    display_order = 1000
```

**Confidence:** High

---

### F4 — LOW | `SportDetailView` uses model `ordering` for detail but lookup is by `code` (SlugField) — no 404 body customisation; not a problem per se, but error response is plain DRF default

**File:** `backend/apps/sports/views.py:56–63`

```python
class SportDetailView(generics.RetrieveAPIView):
    serializer_class = SportSerializer
    permission_classes = [AllowAny]
    queryset = Sport.objects.all()
    lookup_field = "code"
    lookup_url_kwarg = "code"
```

**Why it matters:** This is not a bug — DRF `RetrieveAPIView` correctly returns `{"detail": "Not found."}` on a 404. However, the rest of the codebase (accounts, organizations) uses a custom exception handler that returns structured `{"errors": [...]}` bodies. The sports 404 body deviates from that pattern, creating inconsistent error body shapes across the API. This is a medium-severity API contract inconsistency, not a silent failure.

**Recommendation:** Confirm that the project-level DRF `EXCEPTION_HANDLER` (if one exists) covers sports views. If the custom handler is only wired into certain routers, sports views should be included. At minimum, document the exception body shape divergence.

**Confidence:** Medium (depends on whether a custom exception handler exists project-wide)

---

### F5 — INFO | `SportSerializer.read_only_fields` uses a tuple literal that references `fields` before assignment is complete

**File:** `backend/apps/sports/serializers.py:26–29`

```python
class Meta:
    model = Sport
    fields = (
        "id", "code", "name", "category", "status",
        "description", "indigenous_to", "is_team_sport",
        "is_individual_sport", "icon", "display_order",
    )
    read_only_fields = fields
```

**Why it matters:** Assigning `read_only_fields = fields` inside the same `Meta` class body is a known DRF pattern, and it works because Python evaluates the right-hand side of `read_only_fields = fields` in the current class namespace where `fields` is already bound. There is no runtime bug here. However, it is a subtle "looks like a forward reference" anti-pattern that confuses readers and linters. More practically: because `fields` is the same tuple object as `read_only_fields`, if someone appends a write-only field to `fields` in the future they will inadvertently mark it read-only too.

**Recommendation:** Spell `read_only_fields` out explicitly, or add a comment clarifying the intent:

```python
read_only_fields = (
    "id", "code", "name", "category", "status",
    "description", "indigenous_to", "is_team_sport",
    "is_individual_sport", "icon", "display_order",
)
```

**Confidence:** High (no current bug; future footgun)

---

### F6 — INFO | `SportListView` has `pagination_class = None` but the catalog will grow; no throttle override for public anonymous bulk-list

**File:** `backend/apps/sports/views.py:43`

```python
pagination_class = None
```

**Why it matters:** The catalog currently has ~59 sports (a manageable payload). But `AllowAny` + no pagination means any anonymous caller can enumerate the entire catalog with a single request at the global `AnonRateThrottle` of 60/min. There is no throttle override for this view. At 59 rows the payload is ~10 KB — acceptable. This becomes a concern if the catalog grows to hundreds of sports or if this endpoint is hit by scrapers. Not a current silent failure, but a forward gap.

**Recommendation:** Add pagination or document the decision to keep it unpaginated and capped. Alternatively add a `throttle_classes` override that applies a more generous public-read throttle.

**Confidence:** High (no current bug; forward risk)

---

## Gaps (Forward-Looking)

| # | Area | What is missing | Needed for | Effort | Blocking? |
|---|------|-----------------|-----------|--------|-----------|
| G1 | `views.py` | No 400 response for invalid filter values (F1 above) | Correct API contract for all consumers | S | No |
| G2 | `load_sports.py` | `code` KeyError and `display_order` ValueError are unhandled | Operator-safe data loading | S | No |
| G3 | Error body shape | Sports 404/400 bodies may deviate from project-wide custom exception handler | API consistency | S | No |
| G4 | Test coverage | No test for `?status=<invalid>` or `?category=<invalid>` filter behaviour | Regression guard for F1 | S | No |
| G5 | Test coverage | No test for `load_sports --path` with a malformed JSON entry (missing `code`, bad `display_order`) | Regression guard for F2/F3 | S | No |
| G6 | Pagination | `SportListView` returns unbounded list; no pagination | Scale-readiness | M | No |
| G7 | `apps.py` | `default_auto_field = "django.db.models.BigAutoField"` is set in `SportsConfig` but the model uses UUID PK — moot for `Sport` itself but could mislead any future sub-models added without explicit PK declaration | Architectural clarity (Invariant #1) | S | No |
