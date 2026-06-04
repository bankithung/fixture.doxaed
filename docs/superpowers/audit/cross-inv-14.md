# Cross-Cutting Audit — Invariant 14 (USE_TZ True; DateTimeField stored UTC)

**Scope:** whole backend + frontend, excluding `backend/.venv` and `frontend/node_modules`.
**Invariant 14 (full text):** All `DateTimeField`s stored UTC (`USE_TZ = True`). Tournament TZ defaults to Org TZ; admin/scorer screens render in tournament TZ; public screens render in viewer TZ with a tournament-TZ tooltip. TZ change is blocked once tournament is `scheduled`.
**Date:** 2026-06-04
**Verdict:** Phase 1A is **substantially compliant**. UTC storage is correctly configured and consistently honored. No naive-datetime construction (`datetime.now()` / `utcnow()` / `today()`) exists in application code. Two genuine concerns (one low-severity correctness bug in the audit filter, one info-level UX gap in the sadmin console) plus several Phase 1B prep gaps. **Phase 1A does NOT block the Phase 1B TZ requirements.**

---

## Findings

### F1 — `USE_TZ = True` and UTC storage TZ correctly configured (PASS / info)
- **Severity:** info
- **File:** `backend/fixture/settings/base.py:130-132`
- **Evidence:**
  ```python
  TIME_ZONE = "UTC"  # storage TZ; tournaments override per PRD §7.8
  USE_I18N = True
  USE_TZ = True
  ```
- **Why it matters:** This is the core of invariant 14. With `USE_TZ=True` and `TIME_ZONE="UTC"`, every `DateTimeField` is stored in Postgres as UTC (`timestamptz`) and Django returns aware datetimes. Note `DEFAULT_ORG_TIMEZONE` is a *separate* tunable (`base.py:204`, default `Asia/Kolkata`) used as the per-org display TZ — it correctly does NOT change storage TZ.
- **Recommendation:** None. Correct. When `prod.py` is added (currently only `base.py` + `dev.py` exist), assert it re-exports `USE_TZ`/`TIME_ZONE` (it inherits via `from .base import *`, so this holds automatically unless overridden).

### F2 — All `DateTimeField` defaults use aware `timezone.now` (PASS / info)
- **Severity:** info
- **Files:** `backend/apps/organizations/models.py:251-253` (`_default_invite_expiry`), `models.py:285` (`expires_at = DateTimeField(default=_default_invite_expiry)`); `backend/apps/accounts/models.py:24,105,229,267`; all `auto_now_add` / `auto_now` fields across accounts/audit/sports/permissions/sadmin/organizations.
- **Evidence:**
  ```python
  # organizations/models.py:251
  def _default_invite_expiry() -> _dt.datetime:
      days = getattr(settings, "INVITE_TOKEN_TTL_DAYS", 7)
      return timezone.now() + _dt.timedelta(days=days)
  ```
- **Why it matters:** A common invariant-14 violation is `default=datetime.now` (naive) on a `DateTimeField`. None exists here — every default and every service-layer write (`accounts/views.py:171`, `accounts/services/twofa.py:138,211`, `password_reset.py:95,157,160`, `signup.py:296`, `organizations/services/invitation.py:300,339`, `lifecycle.py:130,171,242`, `sadmin/services/feedback.py`, `superadmin_verbs.py:112,346`, `organizations/views.py:387`) uses `django.utils.timezone.now()` (aware).
- **Recommendation:** None. Keep this discipline in Phase 1B.

### F3 — No naive datetime constructors anywhere in app code (PASS / info)
- **Severity:** info
- **Evidence:** Repo-wide grep for `datetime.now(` / `datetime.utcnow(` / `datetime.today(` across `backend/apps` and `backend/scripts` (excluding `.venv`) returned **no matches**. `date.today()` appears only once, in a test factory (`backend/apps/sadmin/tests/factories.py:67`) and targets a `DateField` (`KPISnapshot.snapshot_date`), not a `DateTimeField`.
- **Why it matters:** Confirms invariant 14 is not silently violated by ad-hoc datetime construction.
- **Recommendation:** Add a lint rule (ruff `DTZ` / flake8-datetimez) to CI so future code cannot introduce naive `datetime.now()`/`utcnow()` on a `DateTimeField`. Currently not enforced (see G4).

### F4 — Audit `from`/`to` query filter accepts naive datetimes ("tolerant of missing timezone")
- **Severity:** low
- **File:** `backend/apps/audit/views.py:78-87` (`_parse_iso8601`), used at `views.py:146-152`.
- **Evidence:**
  ```python
  def _parse_iso8601(value: str) -> Optional[datetime]:
      """Parse an ISO8601 timestamp; tolerant of missing timezone."""
      ...
      normalized = value.replace("Z", "+00:00")
      return datetime.fromisoformat(normalized)
  ...
  from_ts = _parse_iso8601(...)
  if from_ts is not None:
      qs = qs.filter(created_at__gte=from_ts)   # line 148
  ...
  to_ts = _parse_iso8601(...)
  if to_ts is not None:
      qs = qs.filter(created_at__lt=to_ts)      # line 151
  ```
- **Why it matters:** When a client passes a bare date/datetime with no offset (e.g. `?from=2026-01-01` or `?from=2026-01-01T00:00:00`), `datetime.fromisoformat` returns a **naive** datetime. Filtering an aware `timestamptz` column (`created_at`) with a naive value under `USE_TZ=True` emits a `RuntimeWarning: DateTimeField received a naive datetime ... while time zone support is active` and Django silently interprets the naive value in the active TZ (here UTC). Behavior is *correct only because* `TIME_ZONE="UTC"` — the code does not explicitly enforce UTC, so it is fragile and warning-noisy. It is a latent correctness bug if the active TZ ever changes (it will, in Phase 1B, when admin screens `timezone.activate()` a tournament TZ).
- **Recommendation:** After parsing, coerce naive results to aware UTC explicitly:
  ```python
  dt = datetime.fromisoformat(normalized)
  if timezone.is_naive(dt):
      dt = timezone.make_aware(dt, datetime.timezone.utc)
  return dt
  ```
  (Mirror the already-correct pattern in `accounts/decorators.py:46-47`, which guards `is_naive` before use — though that one makes-aware in `get_current_timezone()`, which for a stored ISO marker is acceptable since it round-trips the same TZ.)

### F5 — Super-admin (HTMX) console renders timestamps in UTC with no TZ label
- **Severity:** info
- **Files:** `backend/apps/sadmin/templates/sadmin/dashboard.html:24,38`; `feedback/list.html:37`; `orgs/list.html:35`; `audit/search.html:33`; `users/detail.html:10,71`; `users/list.html:33`.
- **Evidence:**
  ```html
  <td class="px-3 py-2 whitespace-nowrap">{{ ae.created_at|date:"Y-m-d H:i:s" }}</td>
  ```
- **Why it matters:** Django's `|date` filter renders in the *active* timezone. The sadmin console never calls `timezone.activate()`, so the active TZ is `settings.TIME_ZONE = "UTC"`. The IST-based super-admin therefore sees bare UTC timestamps with **no "UTC" suffix or tooltip**, which is ambiguous (could be misread as local IST). Storage is correct (UTC); this is purely a display-clarity gap. Invariant 14 mandates tooltips for the public viewer; the sadmin console is platform-level (no tournament), so UTC is a defensible default — but the missing label is worth fixing.
- **Recommendation:** Append a literal ` UTC` suffix (or `{{ ...|date:"Y-m-d H:i:s e" }}` to print the TZ name) in sadmin templates, or wrap with `{% localtime off %}...UTC{% endlocaltime %}` for explicitness. Low effort; improves operator trust.

### F6 — Frontend renders backend ISO timestamps in viewer TZ (PASS for Phase 1A / info)
- **Severity:** info
- **Files:** `frontend/src/features/orgs/OrgAuditLogPage.tsx:28-34,163`; `MemberDirectoryPage.tsx:43-64,74-77`; `InvitationsListPanel.tsx:110-113`; `InviteCreateModal.tsx:249-252`.
- **Evidence:**
  ```ts
  // OrgAuditLogPage.tsx:28
  function formatTimestamp(iso: string): string {
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  }
  ```
- **Why it matters:** DRF's default `DateTimeField` serializer, under `USE_TZ=True`, emits offset-bearing ISO-8601 (the test fixtures confirm the `Z` suffix, e.g. `generated-types.test.ts:52` `created_at: "2026-05-02T00:00:00Z"`). `new Date(iso)` parses the offset correctly and `.toLocaleString()` / `.toLocaleDateString()` converts to the **browser's local TZ**. This satisfies invariant 14's "public screens render in viewer TZ" for Phase 1A surfaces. No date-string slicing / `setHours` / `getTimezoneOffset` hacks exist (grep clean) that would corrupt the offset.
- **Recommendation:** None for Phase 1A. For Phase 1B (see G1): public match/tournament screens must add the tournament-TZ tooltip, and admin/scorer screens must render in tournament TZ (not browser TZ) — `toLocaleString(undefined, { timeZone: tournamentTz })`.

### F7 — KPI daily rollup derives "today" from UTC (DateField, adjacent to inv-14)
- **Severity:** low
- **Files:** `backend/apps/sadmin/services/kpi.py:39,70` (`timezone.now().date()`); model `backend/apps/sadmin/models.py:146` (`snapshot_date = models.DateField(unique=True)`).
- **Evidence:**
  ```python
  snap_date = date or timezone.now().date()   # kpi.py:39
  ```
- **Why it matters:** Because the active TZ is UTC, `timezone.now().date()` is the UTC calendar date. For the IST operator, the daily KPI snapshot's "today" rolls over at 05:30 IST, not midnight IST — a near-midnight off-by-one for a daily metric. This is a `DateField`, so not a *direct* `DateTimeField`-storage violation, but it is the kind of UTC-vs-local-date subtlety invariant 14 exists to surface. Low impact (internal metrics only, idempotent upsert).
- **Recommendation:** If IST-aligned daily buckets are wanted, derive the date in the operator/platform TZ: `timezone.localtime(timezone.now(), pytz/zoneinfo(DEFAULT_ORG_TIMEZONE)).date()`. Otherwise document that KPI buckets are UTC-day. Defer to product preference; low priority.

---

## Gaps (Phase 1B prep — 1A does not block)

### G1 — Tournament/match TZ display rules unimplemented (no Phase 1B models)
- **Missing:** Tournament TZ field (defaults to Org TZ), the "admin/scorer screens render in tournament TZ" rule, the "public screens render in viewer TZ **with tournament-TZ tooltip**" rule, and the "TZ change blocked once tournament is `scheduled`" guard. None exist because `tournaments`/`matches` apps are not built.
- **Current state:** Org already carries a `timezone` field (validated against `zoneinfo.available_timezones()` per `organizations/serializers.py:4` and `organizations/models.py:125`), so the *source* of the tournament-TZ default is in place. `DEFAULT_ORG_TIMEZONE` setting exists. Frontend already renders in viewer TZ (F6).
- **Needed for:** Phase 1B tournament/match scheduling + public viewer.
- **Effort:** M. **Blocking 1A? No.**

### G2 — No shared frontend datetime/TZ utility
- **Missing:** A central `formatDateTime(iso, { tz })` helper. Each component re-implements `new Date(iso).toLocaleString()` inline (4+ call sites). Phase 1B needs tournament-TZ-aware formatting + tooltips; doing it ad-hoc will scatter the logic.
- **Current state:** Inline `toLocaleString()` per component; correct but duplicated.
- **Needed for:** Phase 1B viewer TZ tooltip + admin/scorer tournament-TZ rendering, consistently.
- **Effort:** S. **Blocking 1A? No.**

### G3 — `from`/`to` audit filter hardening (fix F4 before Phase 1B activates non-UTC active TZ)
- **Missing:** Explicit `make_aware(..., utc)` coercion in `_parse_iso8601` (`audit/views.py:78-87`).
- **Current state:** Works only because active TZ == UTC. Phase 1B admin screens will call `timezone.activate(tournament_tz)`; if an audit request runs under an activated non-UTC TZ, a naive `from`/`to` would be interpreted in the tournament TZ, not UTC — silently wrong results.
- **Needed for:** Correctness once `timezone.activate()` is used anywhere in the request path.
- **Effort:** S. **Blocking 1A? No, but fix-now recommended (cheap).**

### G4 — No CI lint guard against naive datetimes
- **Missing:** A ruff `flake8-datetimez` (DTZ) rule set (or equivalent) in `backend/pyproject.toml` to fail CI on `datetime.now()`/`datetime.utcnow()`/`datetime.fromisoformat` without TZ handling.
- **Current state:** Discipline is currently perfect by convention only (F3); nothing prevents regression.
- **Needed for:** Keeping invariant 14 enforced as Phase 1B adds many datetime touchpoints (match clock, kickoff times, suspensions, grace windows).
- **Effort:** S. **Blocking 1A? No.**

### G5 — `prod.py` settings file does not yet exist
- **Missing:** `backend/fixture/settings/prod.py` (only `base.py` + `dev.py` present). Not an inv-14 violation today (prod would inherit `USE_TZ`/`TIME_ZONE` via `from .base import *`), but flagged so the prod settings author does not accidentally override `TIME_ZONE`/`USE_TZ`.
- **Current state:** N/A — file absent.
- **Needed for:** Production deploy.
- **Effort:** S (for the TZ aspect). **Blocking 1A? No.**
