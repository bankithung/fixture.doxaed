# DEEP-DIVE — Audit Immutability (Invariant #5: append-only audit at DB level)

**Date:** 2026-06-04
**Pass:** SECOND / DEEPER (supersedes the surface treatment in
`audit-audit-integrity.md` F7 and `audit-audit-security.md` G4, both of which
only noted the missing `REVOKE` and the `session_replication_role` line).
**Scope:** the append-only migration (`0002_audit_append_only.py`), the
`AuditEvent` model, every write path to `audit_event`, the trigger function
itself, the DB connection identity, and the test suite that claims to prove
immutability.
**Method:** read every file that touches `audit_event`; traced the DB
connection identity end-to-end; reasoned adversarially about each DDL/DML
primitive Postgres offers for mutating or destroying rows.

---

## TL;DR — the protection is ONE trigger, run as a SUPERUSER, with NO REVOKE

Invariant 5 says UPDATE/DELETE on `audit_event` are denied "at the database
level — not just in application code … A migration that tries to mutate audit
rows must fail." The implementation is a single pair of `BEFORE UPDATE` /
`BEFORE DELETE` row triggers (`0002_audit_append_only.py:27-35`). That trigger
is real and does fire — but it is the *only* layer, and the application
connects to Postgres as the **`postgres` superuser** (`backend/.env:3`).
A superuser-owned connection can neutralise a trigger six different ways and
can destroy the whole table via a path the trigger structurally cannot see
(`TRUNCATE`). The "defense in depth" `REVOKE` that the migration's own
docstring says is required (`0002_audit_append_only.py:10-12`) does not exist
anywhere in the repo — no migration, no SQL file, no deploy script, no CI
check. So in practice the audit log is **mutable and destroyable by the
running application's own DB credentials**, which directly violates invariant 5.

The first audit pass logged this as a single LOW/“gap” item. It is more
serious than that and has multiple distinct, independently-exploitable bypass
mechanisms enumerated below.

---

## Establishing the trust model (the load-bearing fact)

```
backend/.env:3
DATABASE_URL=postgres://postgres:postgress@localhost:5432/fixturedb
```
```
backend/fixture/settings/base.py:101
DATABASES = {"default": env.db("DATABASE_URL")}
```

The Django app — and therefore every ORM call, every `connection.cursor()`,
every migration — runs as the Postgres role **`postgres`**, which is a
`SUPERUSER` / `BYPASSRLS` role and (critically) the **owner** of the
`audit_event` table and the `audit_event_append_only()` function it creates.
There is no separate, de-privileged application role anywhere in settings, the
`.env`, or the deploy scripts (`scripts/dev.sh`, `scripts/dev.ps1` — neither
provisions a restricted role). Every bypass below follows from this single
fact: **the code that writes audit rows holds superuser + table-owner rights.**

Note: the placeholder prod password and dev password are identical
(`postgress`), and the `.env` is the only DB config — there is no prod settings
override that swaps in a restricted role. So this is not merely a dev-only
concern; the documented prod posture inherits the same superuser connection.

---

## The protection as built

```python
# backend/apps/audit/migrations/0002_audit_append_only.py:17-35
CREATE OR REPLACE FUNCTION audit_event_append_only()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'audit_event is append-only ...' USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_event_no_update BEFORE UPDATE ON audit_event
    FOR EACH ROW EXECUTE FUNCTION audit_event_append_only();
CREATE TRIGGER audit_event_no_delete BEFORE DELETE ON audit_event
    FOR EACH ROW EXECUTE FUNCTION audit_event_append_only();
```

What it correctly does: blocks per-row `UPDATE` and `DELETE` for *any* role
(triggers fire for superusers too, which is why the first pass called it
"robust"). INSERTs are allowed (append-only, not read-only) — verified by
`test_insert_still_works` (`tests/test_append_only.py:76-87`).

What it structurally does **not** cover, and what a superuser/table-owner can
do to it, is the rest of this document.

---

## Enumerated bypasses (every way to mutate / delete / forge audit rows)

### B1 — HIGH — `TRUNCATE audit_event` erases the ENTIRE log; row triggers never fire

**Mechanism:** `BEFORE UPDATE`/`BEFORE DELETE` `FOR EACH ROW` triggers are not
fired by `TRUNCATE`. Postgres treats `TRUNCATE` as a separate event class
(`BEFORE TRUNCATE` statement-level triggers), and there is no truncate trigger
here.
**File/line:** `0002_audit_append_only.py:28-34` defines only `UPDATE` and
`DELETE` triggers; nothing covers `TRUNCATE`.
**Exploit:** any superuser/owner connection (i.e. the app itself, or a
`manage.py dbshell`, or a stray management command) runs
`TRUNCATE audit_event;` (or `TRUNCATE audit_event RESTART IDENTITY CASCADE;`)
and the complete append-only history is gone with no error and no audit of the
truncation. This is the single most destructive bypass and the one the first
pass never mentioned.
**Why it matters:** Invariant 5's whole purpose is tamper-evident history.
`TRUNCATE` is the canonical "wipe the evidence" operation and it sails straight
past the only control.
**Fix:** add a `BEFORE TRUNCATE ON audit_event ... FOR EACH STATEMENT EXECUTE
FUNCTION audit_event_append_only()` trigger AND `REVOKE TRUNCATE` (see B2).
Confidence: **high** (read the trigger definitions directly; this is standard
Postgres trigger semantics).

---

### B2 — HIGH — No `REVOKE`; the app role can UPDATE/DELETE/TRUNCATE once the trigger is neutralised

**Mechanism:** The migration docstring itself admits the REVOKE is required and
punts it to "deploy provisioning, not here" (`0002_audit_append_only.py:10-12`).
Grepping the entire repo for `REVOKE` finds **only** the docstring text and the
two prior audit notes — **no executable REVOKE exists** (no migration, no
`deploy/*.sql`, no Makefile target, no `scripts/*`).
**File/line:** `0002_audit_append_only.py:10-12` (the unfulfilled promise);
absence confirmed across `**/*.{py,sql,sh,ps1,yml,yaml,toml}`.
**Exploit:** with no REVOKE, the only thing standing between the app role and a
mutation is the trigger — and the app role *owns* the trigger (B3–B6). Once the
trigger is dropped/disabled/replaced, `UPDATE audit_event SET ...` and
`DELETE FROM audit_event` succeed immediately because table privileges were
never withdrawn. REVOKE would have been a second, independent wall; its absence
means the system is single-layer, contradicting "not just in application code …
at the database level."
**Why it matters:** invariant 5 explicitly wants DB-*role*-level enforcement
(CLAUDE.md: "denied by Postgres role permissions, not just application code").
That layer is entirely missing; only the trigger exists. And REVOKE alone would
not even work here because superuser bypasses `GRANT`/`REVOKE` — see B7.
**Fix:** create a dedicated **non-superuser** app role, connect as it, and
`REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM app_role;` in a checked-in
migration/SQL artifact that CI verifies. Confidence: **high**.

---

### B3 — HIGH — Superuser/owner can `DROP TRIGGER` then mutate freely

**Mechanism:** The triggers are owned by the app role (it created them). A table
owner / superuser may `DROP TRIGGER audit_event_no_update ON audit_event;` (and
`..._no_delete`) at will. The migration even ships the exact DROP statements as
its `REVERSE_SQL` (`0002_audit_append_only.py:39-43`), so the drop is a
copy-paste away and is "blessed" code.
**File/line:** `0002_audit_append_only.py:40-41` (the reverse drops both
triggers).
**Exploit:** `DROP TRIGGER audit_event_no_update ON audit_event; DROP TRIGGER
audit_event_no_delete ON audit_event; UPDATE audit_event SET reason='clean'
WHERE ...; ` — three statements, no special privilege beyond what the app
already holds.
**Fix:** as B2, run as a non-owner role that lacks `DROP TRIGGER` rights
(trigger DDL requires table ownership); keep table ownership with a separate
admin/migration role used only during deploy, not at app runtime.
Confidence: **high**.

---

### B4 — HIGH — `ALTER TABLE audit_event DISABLE TRIGGER` silently neuters enforcement

**Mechanism:** A table owner can `ALTER TABLE audit_event DISABLE TRIGGER ALL;`
(or name each trigger). This leaves the triggers *defined* (so a casual
`\d audit_event` or a "do the triggers exist?" check still shows them) but
**not firing**. Mutations then succeed; re-enabling afterward restores the
appearance of integrity.
**File/line:** no guard anywhere; ownership flows from `backend/.env:3`.
**Exploit:** `ALTER TABLE audit_event DISABLE TRIGGER USER; DELETE FROM
audit_event WHERE id='...'; ALTER TABLE audit_event ENABLE TRIGGER USER;` — the
log is edited and the control looks intact afterward. This is *more* dangerous
than B3 because it is reversible and leaves no structural footprint.
**Fix:** non-owner app role (DISABLE TRIGGER requires ownership); plus REVOKE so
that even with triggers off the DML is denied. Confidence: **high**.

---

### B5 — HIGH — `SET session_replication_role = replica` disables ALL triggers for the session

**Mechanism:** Setting `session_replication_role = replica` (or `local`) causes
Postgres to skip "origin" triggers — including these `BEFORE` triggers — for
the duration of the session. Setting this GUC requires superuser, which the app
connection has (`backend/.env:3`). This is the one bypass the first pass *named*
(audit-audit-integrity.md:137) but did not develop; it is fully live here.
**File/line:** enabled by superuser identity at `backend/.env:3`; trigger has no
defense (`0002_audit_append_only.py` cannot prevent a GUC change).
**Exploit (raw, via the app's own connection or `manage.py dbshell`):**
```sql
SET session_replication_role = replica;
DELETE FROM audit_event WHERE actor_user_id = '<incriminating-user>';
UPDATE audit_event SET reason = '' , payload_before = NULL;
SET session_replication_role = origin;
```
All three succeed; the trigger never runs. From Python this is reachable via
`connection.cursor().execute("SET session_replication_role='replica'")` because
nothing restricts raw cursor use to non-superuser roles.
**Why it matters:** even WITH the missing REVOKE added, `session_replication_role`
plus superuser would still bypass it — REVOKE is only honored for non-superuser
roles (B7). This is the strongest argument that the fix MUST be a de-privileged
app role, not just a REVOKE.
**Fix:** connect as a non-superuser role (cannot set
`session_replication_role`) AND add the REVOKE/trigger-on-truncate.
Confidence: **high**.

---

### B6 — HIGH — `CREATE OR REPLACE FUNCTION` lets the owner swap the trigger body for a no-op

**Mechanism:** The function is defined with `CREATE OR REPLACE FUNCTION`
(`0002_audit_append_only.py:18`) and is owned by the app role. The same role can
re-`CREATE OR REPLACE` it with an empty body (`RETURN NEW;` for update /
`RETURN OLD;` for delete). The triggers stay attached and "fire," but now do
nothing — invariant 5 is silently void while every structural check ("trigger
exists? function exists?") still passes.
**File/line:** `0002_audit_append_only.py:18`.
**Exploit:**
```sql
CREATE OR REPLACE FUNCTION audit_event_append_only() RETURNS trigger
AS $$ BEGIN RETURN COALESCE(NEW, OLD); END; $$ LANGUAGE plpgsql;
-- triggers now fire a no-op; UPDATE/DELETE succeed
```
Compounded by the function having **no `SECURITY DEFINER` and no pinned
`search_path`**, so it is also susceptible to ordinary owner redefinition with
zero friction.
**Fix:** own the function with a separate admin role not used at runtime; lock
it down; run app as non-owner. Confidence: **high**.

---

### B7 — HIGH — Even a future REVOKE is INEFFECTIVE while the app is a superuser

**Mechanism:** Postgres `SUPERUSER` roles bypass *all* permission checks,
including `REVOKE`. So the remediation the first pass recommended (just add
`REVOKE UPDATE, DELETE ON audit_event FROM <app_role>`) is a **no-op against the
current `postgres` connection**. The first audit treated REVOKE as the fix; in
reality REVOKE only helps after the connection identity is changed to a
non-superuser role. This is the key correction this deeper pass adds.
**File/line:** `backend/.env:3` (superuser) vs the REVOKE recommendation in
`audit-audit-integrity.md:140` / `:174`.
**Why it matters:** prevents a false-fix. Shipping a REVOKE migration while
still connecting as `postgres` would create the *appearance* of hardening with
none of the substance — and the test suite (B11) would not catch the gap.
**Fix:** the ordering matters — (1) create non-superuser app role, (2) switch
`DATABASE_URL` to it, (3) REVOKE UPDATE/DELETE/TRUNCATE, (4) re-own
triggers/function under a separate role. Confidence: **high**.

---

### B8 — MEDIUM — The migration's own `REVERSE_SQL` is a sanctioned tamper path

**Mechanism:** `python manage.py migrate audit 0001` runs `REVERSE_SQL`
(`0002_audit_append_only.py:39-43`), which DROPs both triggers and the function.
After that, the table is fully mutable by the (superuser) app role with no
trigger at all. Because migrations run as the same superuser connection, this is
trivially available and looks like a routine rollback.
**File/line:** `0002_audit_append_only.py:39-43`, `:53` (`reverse_sql=REVERSE_SQL`).
**Exploit:** rollback the migration (or include a later migration that depends
on `0002` and silently re-runs the reverse), mutate, then re-apply. Invariant 5
says "a migration that tries to mutate audit rows must fail" — but a migration
that *removes the protection* and *then* mutates does not fail; nothing forbids
reversing this migration in prod.
**Why it matters:** the invariant anticipates malicious/erroneous migrations;
the protection can be undone by an ordinary Django migration command.
**Fix:** make `REVERSE_SQL` raise (irreversible migration) in non-dev
environments, or gate trigger ownership behind a role the runtime cannot
assume. Confidence: **high** (reverse SQL read directly).

---

### B9 — MEDIUM — `pg_dump` / restore round-trip is an untracked mutation channel

**Mechanism:** The platform's backup story is nightly `pg_dump` to S3
(CLAUDE.md). A `pg_dump` → edit the plaintext `.sql`/`COPY` block → restore
into a fresh DB recreates `audit_event` rows arbitrarily; on restore the
triggers are created *after* the `COPY`, so the tampered rows are inserted
without the trigger blocking them, and the restored DB looks pristine. No
in-DB control can prevent this, but there is also no hash-chain / signature on
audit rows that would make such tampering *detectable*.
**File/line:** no anti-tamper field on the model — `models.py:35-100` has
`created_at` and a UUIDv7 PK but no `prev_hash`/`row_signature`. (UUIDv7 gives
ordering, not integrity.)
**Why it matters:** append-only at the live DB is necessary but not sufficient
for a forensic log; the backup/restore path is a realistic mutation vector for
anyone with VPS/S3 access, and nothing makes it evident.
**Fix (Phase 1B-grade):** add a tamper-evident hash chain (`prev_hash`,
`row_hash` over canonicalised content) so out-of-band edits are detectable even
though they cannot be prevented at restore time. Confidence: **medium**
(mechanism is standard; this is a design gap, not a coded bug).

---

### B10 — MEDIUM — Forgery (not mutation): `actor_*`, `ip_address`, `created_at` are caller-supplied at INSERT

**Mechanism:** Append-only protects rows *after* insert; it does nothing about
**what** is inserted. `emit_audit` (`services.py:24-77`) writes whatever the
caller passes for `actor_user`, `actor_role`, `organization_id`, `reason`,
payloads, and derives `ip_address` from a spoofable `X-Forwarded-For`
(`services.py:53-55`). `actor_role` is a free `CharField` whose value is taken
verbatim (`services.py:59`), so a caller can record `system` or `super_admin`
for an action a low-privileged user performed. Because INSERT is *allowed* and
unguarded, a forged-but-immutable row is then permanently "trusted."
**File/line:** `services.py:53-55` (IP), `services.py:59-72` (verbatim
actor/role/payload), `models.py:58` (`actor_role` is `CharField`, not FK-checked
at write time).
**Why it matters:** immutability of a *forged* record is worse than no record —
it launders attacker-chosen data into a tamper-proof store. Invariant 5's value
depends on insert-time integrity, which has no control.
**Fix:** derive `actor_user`/`actor_role` from the authenticated
request/session inside `emit_audit` (don't trust caller args for identity); use
`REMOTE_ADDR` or a trusted-proxy-validated IP; consider DB `DEFAULT now()` for
`created_at` rather than ORM-supplied. Confidence: **high** (read all call
sites and the model).

---

### B11 — MEDIUM — The test suite over-claims: it proves "trigger fires," NOT "role-level / TRUNCATE / replica safe"

**Mechanism:** `tests/test_append_only.py` asserts ORM/raw UPDATE+DELETE raise
(`:36-73`). Its module docstring claims this proves enforcement "even for the
test runner connecting as a Postgres superuser … cannot be silently violated by
a future contributor" (`:1-8`). But the tests only exercise the *happy bypass*
(plain UPDATE/DELETE). They do **not** test `TRUNCATE` (B1), do **not** test
`SET session_replication_role=replica` (B5), do **not** test `DISABLE TRIGGER`
(B4), and there is **no** test asserting a REVOKE denies the app role (B2/B7)
— so the very gaps that make the control bypassable are exactly the ones with
no coverage. The reassuring docstring is therefore misleading.
**File/line:** `tests/test_append_only.py:1-8` (claim) vs `:35-73` (what is
actually tested). No `TRUNCATE`/`session_replication_role` test exists in the
file.
**Why it matters:** false confidence — a future contributor reads the docstring
and assumes immutability is locked, when 5 of the 6 bypass classes are
untested.
**Fix:** add tests that (a) `TRUNCATE audit_event` either fails or is blocked,
(b) `SET session_replication_role=replica; DELETE ...` fails under the intended
non-superuser role, (c) the app role lacks UPDATE/DELETE/TRUNCATE privilege
(`has_table_privilege`). These will fail today, which is the point.
Confidence: **high**.

---

## Confirmed NON-issues (so they aren't re-flagged)

- **No app-layer UPDATE/DELETE of audit rows exists.** Grep over
  `backend/apps/**` shows every `AuditEvent.objects.*` call is `.filter(...)`,
  `.first()`, `.count()`, `.create()`, or `.latest()` — i.e. read or insert
  only. The only writers are `emit_audit` / `submit_feedback` (both INSERT).
  Sadmin's `feedback.py:75` and views `feedback.py:177` use `audit_event` only
  to *read* idempotency keys (`.exists()`). So the trigger has no legitimate
  ORM mutation to fight; all bypasses are DB-DDL/GUC level, not app code.
- **`ATOMIC_REQUESTS = True`** (`settings/base.py:102`) means the pass-1
  "missing `transaction.atomic`" findings (F3/F4) are largely mitigated for
  request-path emitters — each request is one transaction, so a failing
  `emit_audit` rolls back the state change too. (Not an immutability issue;
  noted to keep the picture accurate.)
- **Trigger DOES fire for plain UPDATE/DELETE for all roles**, including
  superuser — so the *naive* tamper (just run UPDATE) is genuinely blocked.
  The bypasses above are the non-naive paths.

---

## Severity-ranked remediation (single coherent fix)

1. **Stop connecting as `postgres` superuser** (`backend/.env:3`). Provision a
   dedicated **non-superuser, non-owner** app role; this single change defeats
   B3, B4, B5, B6, B8 and makes B2/B7 effective.
2. **Checked-in hardening migration/SQL** (closes B1, B2): create truncate
   trigger + `REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM app_role;`
   owned by a separate admin role.
3. **Make `0002` reverse irreversible in prod** (B8).
4. **Harden insert-time integrity** in `emit_audit` (B10): server-derived
   actor/role/IP.
5. **Add the missing tests** (B11): TRUNCATE, replica-GUC, privilege assertion.
6. **Phase 1B:** hash-chain audit rows for restore-time tamper *evidence* (B9).

---

## Invariant-5 verdict

**PARTIALLY MET → effectively NOT met under the documented connection identity.**
The trigger blocks the naive UPDATE/DELETE, but the spec language ("denied by
Postgres *role* permissions, not just application code") is unmet (no REVOKE, no
de-privileged role), and at least six distinct superuser/owner bypasses plus
`TRUNCATE` leave the append-only log mutable and destroyable by the running
app's own credentials. The first audit pass under-rated this (single LOW gap);
it is a HIGH-severity cluster.
