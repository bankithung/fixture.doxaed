# Cross-Cutting Invariant Audit — Invariant 5: AuditEvent Append-Only at DB ROLE Level

**Date:** 2026-06-04
**Invariant:** #5 — `UPDATE`/`DELETE` on `AuditEvent` must be denied at the **Postgres role layer** (REVOKE), not just application code. A migration that tries to mutate audit rows must fail.
**Scope:** Whole backend + frontend (excl. `.venv` / `node_modules`). Invariant 5 is a backend/DB concern; the frontend has no role in it (no findings expected there, confirmed below).

---

## Verdict

Partial. The audit table **is** protected against `UPDATE`/`DELETE`, but the mechanism is a **PL/pgSQL `BEFORE` trigger**, not the `REVOKE UPDATE, DELETE ... FROM <app_role>` that the invariant text literally mandates. The trigger is well-tested and fires even for superusers, which is genuinely *stronger* than REVOKE in the common case. But the literal role-level REVOKE is **absent everywhere** in the repo, the app connects as the `postgres` **superuser** (so REVOKE would be a no-op even if added), there is **no separate application DB role**, **no deploy/provisioning artifact** to create one or run the REVOKE, and the trigger has a real **`session_replication_role = replica` bypass** that REVOKE would have closed. So the invariant is enforced *in spirit* but not *as written*, and the documented "defense in depth" half is vaporware.

---

## Findings

### F1 — HIGH — Invariant's literal REVOKE at the Postgres role layer does not exist anywhere; only a trigger is used

**File:** `backend/apps/audit/migrations/0002_audit_append_only.py:17-36` (the only enforcement); confirmed absent repo-wide.
**Evidence:** The enforcement is purely a trigger:
```sql
CREATE TRIGGER audit_event_no_update
    BEFORE UPDATE ON audit_event
    FOR EACH ROW EXECUTE FUNCTION audit_event_append_only();
...
CREATE TRIGGER audit_event_no_delete
    BEFORE DELETE ON audit_event
    FOR EACH ROW EXECUTE FUNCTION audit_event_append_only();
```
A repo-wide grep for `REVOKE` / `GRANT ... audit_event` / `CREATE ROLE` / `CREATE USER` returns **zero** statements that REVOKE mutate privileges on `audit_event` from any role. The migration's own docstring (lines 10-12) admits it:
> "Production deployments should ADDITIONALLY REVOKE UPDATE/DELETE on audit_event from the application role for defense in depth — handled in deploy provisioning, not here."
**Why it matters:** The invariant is phrased specifically as a role-level REVOKE ("denied by Postgres role permissions"). The trigger satisfies the *functional* requirement (mutations fail) and is actually broader (catches superusers), so this is HIGH not CRITICAL — but the literal control the spec asks for is missing and the "ADDITIONALLY ... in deploy provisioning" promise is unfulfilled (see F2).
**Recommendation:** Keep the trigger (it is the stronger primary control) AND add the role-level REVOKE as committed defense-in-depth (see F2/F3). Update CLAUDE.md invariant 5 wording to "denied at DB level via trigger + role REVOKE" so the trigger approach is officially blessed rather than a silent deviation.

---

### F2 — HIGH — The promised "deploy provisioning" REVOKE has no script, Makefile target, or CI/pre-flight check; it is undeliverable as written

**Files (absence):** No `deploy/`, no provisioning SQL, no `Caddyfile`, no `docker-compose*.yml` exist (Glob for `{deploy,provision,Caddyfile,docker-compose*}` → "No files found"). Only `scripts/dev.sh` and `scripts/dev.ps1` exist, and neither touches roles/REVOKE.
**Evidence:** `scripts/dev.sh:17-22` runs only `migrate`, `load_modules`, `load_sports` — no DB hardening:
```bash
echo "==> Checking Postgres + applying migrations"
"$PY" "$ROOT/backend/manage.py" migrate
echo "==> Seeding RBAC module catalog + sports (idempotent)"
"$PY" "$ROOT/backend/manage.py" load_modules
"$PY" "$ROOT/backend/manage.py" load_sports
```
**Why it matters:** The defense-in-depth layer the migration explicitly defers to "deploy provisioning" does not exist anywhere in the repo. A production deploy that mirrors `dev.sh` will ship with the trigger only and no role REVOKE — exactly the gap that allows the F4 bypass.
**Recommendation:** Commit `deploy/postgres_hardening.sql` containing `REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM <app_role>;`, run it from the deploy script, and add a CI/pre-flight assertion (query `information_schema.role_table_grants`) that the app role lacks UPDATE/DELETE on `audit_event`.

---

### F3 — HIGH — App connects as the Postgres **superuser** and there is no separate application role, so a REVOKE would be a no-op today

**Files:** `backend/.env.example:3`; `backend/fixture/settings/base.py:101`.
**Evidence:**
```
# .env.example
DATABASE_URL=postgres://postgres:CHANGEME@localhost:5432/fixturedb
```
```python
# settings/base.py
DATABASES = {"default": env.db("DATABASE_URL")}
```
The example (and therefore the default dev/prod path) connects as `postgres`, the cluster superuser. Superusers **bypass all GRANT/REVOKE**. No `CREATE ROLE` / least-privilege application role is defined anywhere in the repo.
**Why it matters:** Even if F2's REVOKE script existed, running it against the `postgres` superuser role accomplishes nothing — superusers ignore table privileges. The role-level half of invariant 5 is structurally impossible until a non-superuser app role exists. This is *why* the trigger (which fires for superusers too) is currently the only thing actually enforcing the invariant.
**Recommendation:** Provision a dedicated non-superuser application role (`fixture_app`) owned/created by deploy provisioning; point `DATABASE_URL` at it in prod; grant it normal CRUD on app tables but only `INSERT, SELECT` on `audit_event`. Migrations that need DDL run as a separate migration role. Document the two-role model.

---

### F4 — MEDIUM — Trigger is bypassable via `SET session_replication_role = replica`; the migration's docstring claim that it is robust against this is incorrect for a superuser

**File:** `backend/apps/audit/migrations/0002_audit_append_only.py:8-12` (claim) and `:28-35` (trigger definition).
**Evidence:** The docstring claims:
> "Triggers fire regardless of role (including superuser), so this is robust even in dev where the app connects as the Postgres `postgres` superuser."

The triggers are created as plain (ORIGIN) triggers. By PostgreSQL semantics, `BEFORE ROW` triggers in `origin`/`local` mode do **not** fire when the session sets `session_replication_role = replica`. Because the app connects as a superuser (F3), the app session *can* execute `SET session_replication_role = replica;` and then `UPDATE`/`DELETE audit_event` with the triggers silently skipped. The prior internal audit (`docs/superpowers/audit/audit-audit-integrity.md:137`) flags this same `replica`-mode bypass.
**Why it matters:** The single control protecting invariant 5 has a known, one-line bypass available to the very role the app uses. Append-only is not actually guaranteed against a malicious or buggy management command. A role-level REVOKE (F2/F3) is **not** bypassable by `session_replication_role` and would close this hole — which is precisely why the invariant specifies role-level enforcement.
**Recommendation:** Two fixes, ideally both: (a) recreate the triggers with `ALTER TABLE audit_event ENABLE ALWAYS TRIGGER audit_event_no_update;` (and `..._no_delete`) so they fire even in `replica` mode; (b) land the role REVOKE + non-superuser app role (F2/F3) so the bypass surface is removed entirely. Fix the docstring's inaccurate robustness claim.

---

### F5 — LOW — No protection against `TRUNCATE` on `audit_event` (deletes all rows, bypasses ROW triggers)

**File:** `backend/apps/audit/migrations/0002_audit_append_only.py:28-35`.
**Evidence:** Only `BEFORE UPDATE` and `BEFORE DELETE` `FOR EACH ROW` triggers exist. `TRUNCATE` is a separate statement-level privilege and does **not** fire `FOR EACH ROW` triggers. A grep for `TRUNCATE` in the migration returns nothing. As superuser (F3), `TRUNCATE audit_event;` wipes the entire append-only log.
**Why it matters:** "Append-only" must also mean "no mass-erase." A `TRUNCATE` defeats the entire audit log in one statement, and neither the row triggers nor any REVOKE-of-TRUNCATE exists.
**Recommendation:** Add a `BEFORE TRUNCATE ... FOR EACH STATEMENT` trigger that raises, and include `TRUNCATE` in the REVOKE list (`REVOKE ..., TRUNCATE ON audit_event FROM <app_role>`).

---

### F6 — LOW — Migration-mutation negative test (`migration that tries to mutate audit rows must fail`) is not asserted

**Files:** `backend/apps/audit/tests/test_append_only.py` (covers ORM/raw UPDATE/DELETE + INSERT-still-works, but not a migration).
**Evidence:** The invariant text says "A migration that tries to mutate audit rows must fail." The test suite proves ORM `.save()`/`.delete()` and raw SQL `UPDATE`/`DELETE` are blocked (`test_orm_update_blocked_by_trigger`, `test_raw_delete_blocked_by_trigger`, etc.) and that INSERT still works — solid coverage of the trigger — but there is **no** test asserting a `RunSQL`/`RunPython` migration that mutates `audit_event` fails. There is also no test asserting the `session_replication_role=replica` bypass is closed (because it currently is not — F4), nor a TRUNCATE-blocked test (F5).
**Why it matters:** The exact scenario named in the invariant ("a migration that tries to mutate audit rows must fail") is not regression-guarded. The bypass paths (replica mode, TRUNCATE) are entirely uncovered.
**Recommendation:** Add tests: (1) a migration-style `RunSQL` UPDATE against `audit_event` raises; (2) once F4 is fixed, that `SET session_replication_role='replica'; UPDATE audit_event ...` still raises; (3) once F5 is fixed, that `TRUNCATE audit_event` raises.

---

### F7 — INFO — `sadmin.UsageEvent` is documented "append-only" but has zero DB-level enforcement (informational; outside the literal invariant-5 scope)

**File:** `backend/apps/sadmin/models.py:105-106`.
**Evidence:**
```python
class UsageEvent(models.Model):
    """Append-only telemetry firehose. Cheap fire-and-forget writes."""
```
No trigger / REVOKE protects `sadmin_usage_event` (only `audit_event` has migration 0002). Invariant 5 names `AuditEvent` specifically, so this is not a violation of #5 — but it is a second table claiming append-only semantics with no enforcement, which a reader may wrongly assume is hardened like `AuditEvent`.
**Why it matters:** Low-stakes telemetry, but the inconsistent meaning of "append-only" across two models invites a false sense of security and may matter if KPI/usage data ever becomes audit-relevant.
**Recommendation:** Either downgrade the docstring to "insert-mostly telemetry (not DB-enforced)" or, if it should be tamper-evident, apply the same trigger pattern.

---

### Frontend — no findings (confirmed)

Invariant 5 is a database/role concern with no client surface. Grep across the repo for `REVOKE`/`GRANT`/append-only found nothing under `frontend/` (excl. `node_modules`). No frontend code can or should enforce this; recorded here so the "whole frontend" scope is not silently skipped.

---

## Does Phase 1A BLOCK Phase 1B for invariant 5?

**No.** Phase 1A's `AuditEvent` model + trigger is the shared backbone Phase 1B will write to via `emit_audit()`. Nothing about the current implementation prevents Phase 1B (`Tournament`/`Match`/`MatchEvent` state-transition audit) from being added. The prep gaps below are the work needed to make invariant 5 fully compliant before Phase 1B's higher-stakes audit volume lands.

## Gaps (prep work)

| # | Item | Missing | Needed for | Effort | Blocking 1B? |
|---|------|---------|-----------|--------|--------------|
| G1 | Role-level REVOKE | No `REVOKE UPDATE, DELETE, TRUNCATE ON audit_event` anywhere (F1/F2) | Literal compliance with invariant 5 + closing the `replica`/TRUNCATE bypass | S | No |
| G2 | Non-superuser app role | App connects as `postgres` superuser; no `CREATE ROLE`/least-privilege role (F3) | Makes any REVOKE actually effective | M | No |
| G3 | Deploy/provisioning artifact | No `deploy/`, no hardening SQL, no CI pre-flight asserting the grant state (F2) | So the REVOKE cannot be forgotten on prod | S | No |
| G4 | `ENABLE ALWAYS TRIGGER` | Triggers are origin-mode; bypassable via `session_replication_role=replica` (F4) | Close the superuser bypass without relying on REVOKE alone | S | No |
| G5 | TRUNCATE protection | No `BEFORE TRUNCATE` trigger and no TRUNCATE in REVOKE (F5) | Prevent mass-erase of the audit log | S | No |
| G6 | Negative tests | No migration-mutation / replica-mode / TRUNCATE blocked tests (F6) | Regression-guard the exact invariant-5 scenarios | S | No |
| G7 | CLAUDE.md wording | Invariant 5 text says "role permissions" but impl is a trigger; deviation undocumented (F1) | Bless the trigger approach so it isn't a silent deviation | S | No |
