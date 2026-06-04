# Adversarial Verify B — app connects as Postgres superuser / REVOKE no-op (Invariant 5)

**Verdict: PARTIALLY REAL fact, but finding is MISFRAMED → is_real = false at stated severity. Corrected severity: low (info/hardening note).**

## The finding
> high / Invariant 5 / `backend/.env.example:3`
> "App connects as the Postgres superuser; no separate app role, so a REVOKE would be a no-op today."
> Claims: even if a REVOKE script existed, running it against `postgres` accomplishes nothing, therefore the append-only audit invariant is unenforced.

## What the real code shows

### Literal facts in the finding — TRUE
1. `backend/.env.example:3` — `DATABASE_URL=postgres://postgres:CHANGEME@localhost:5432/fixturedb` connects as the cluster superuser `postgres`. CONFIRMED (read file).
2. DB config — CONFIRMED, but cited path is wrong. It is `backend/fixture/settings/base.py:101` (NOT `config/settings/base.py`):
   - L101 `DATABASES = {"default": env.db("DATABASE_URL")}`
   - L102 `DATABASES["default"]["ATOMIC_REQUESTS"] = True`
   The line number (101) and exact content match; only the directory in the citation is wrong (`config/` vs `fixture/`).
3. No `CREATE ROLE` / `CREATE USER` / least-privilege application role exists anywhere in the repo (grep across backend, *.md, scripts — only deploy artifacts are `scripts/dev.sh` / `scripts/dev.ps1`; neither creates a role or runs REVOKE). CONFIRMED.
4. Postgres superusers bypass GRANT/REVOKE; so a REVOKE on `audit_event` against the `postgres` role would indeed be a no-op. TRUE as a standalone Postgres fact.

### Why the finding is MISFRAMED (the load-bearing error)
The finding's headline and evidence imply invariant 5's append-only protection is defeated ("Even if the REVOKE script existed, running it against the postgres superuser accomplishes nothing"). **That implication is false.** Invariant 5 is NOT implemented via GRANT/REVOKE in this codebase.

`backend/apps/audit/migrations/0002_audit_append_only.py` enforces append-only with **BEFORE UPDATE OR DELETE triggers**, not role permissions:
- L18-25: `CREATE OR REPLACE FUNCTION audit_event_append_only()` → `RAISE EXCEPTION ... USING ERRCODE = '42501'` (insufficient_privilege).
- L28-35: triggers `audit_event_no_update` (BEFORE UPDATE) and `audit_event_no_delete` (BEFORE DELETE), `FOR EACH ROW`.
- Migration docstring L7-12 explicitly states: *"Triggers fire regardless of role (including superuser), so this is robust even in dev where the app connects as the Postgres `postgres` superuser. Production deployments should ADDITIONALLY REVOKE ... for defense in depth — handled in deploy provisioning, not here."*

The design **anticipated exactly this finding's concern** and chose triggers precisely because the dev app runs as superuser.

### Tests prove the protection actually holds under the superuser connection
`backend/apps/audit/tests/test_append_only.py` (docstring L4-8 explicitly: triggers fire "even for the test runner connecting as a Postgres superuser (which bypasses GRANT/REVOKE)"):
- L36 `test_orm_update_blocked_by_trigger` — ORM save() raises.
- L46 `test_orm_delete_blocked_by_trigger` — ORM delete() raises.
- L55 `test_raw_update_blocked_by_trigger` — raw SQL `UPDATE audit_event ...` raises (proves not ORM-layer).
- L66 `test_raw_delete_blocked_by_trigger` — raw SQL DELETE raises.
- L77 `test_insert_still_works` — append still allowed.

All run as the (superuser) test connection. So audit rows are NOT mutable today; the finding's premise that they are is wrong.

## Severity assessment
- The security goal of invariant 5 (UPDATE/DELETE on audit_event denied at the DB layer, not just app code; a mutating migration must fail) is **met and tested**.
- The only residual truth is a literalist gap + hardening note: invariant 5's wording says "denied by **Postgres role permissions**." The implementation uses triggers, not role grants, and the production-side role REVOKE (defense-in-depth) is deferred to deploy provisioning that does not exist in-repo. That is a real but **low** hardening gap, not a high-severity hole — because the trigger already provides the actual guarantee independent of role.
- Dev `.env.example` using the superuser is also conventional and low-impact (example file, `CHANGEME` password). Least-privilege app role is a reasonable production hardening recommendation, but framing it as defeating audit append-only is incorrect.

## Conclusion
- Severity as stated (high, "invariant unenforced because REVOKE is a no-op") = **NOT REAL**. The append-only invariant is enforced by role-independent triggers, with passing tests under the superuser connection.
- Underlying hardening observation (no least-privilege app role; production role-level REVOKE not yet provisioned in-repo) = real but **low**.
- Citation accuracy: `.env.example:3` exact; settings cite has wrong directory (`config/` should be `fixture/`) though line/content match.

Confidence: high.
