# Cross-Cutting Audit: Migrations

Scope: every `backend/apps/*/migrations/*.py` file (8 non-`__init__` migrations across
`accounts`, `audit`, `organizations`, `permissions`, `sadmin`, `sports`). Verified
against models, the ownership service, the append-only test, deploy scripts, and DB
settings. Methodology: direct Read/Grep on real files. Every finding cites `file:line`
with quoted evidence.

Migration inventory:
- `accounts/0001_initial.py`, `accounts/0002_user_email_verified_at_...py`
- `audit/0001_initial.py`, `audit/0002_audit_append_only.py`
- `organizations/0001_initial.py`
- `permissions/0001_initial.py`
- `sadmin/0001_initial.py`
- `sports/0001_initial.py`

---

## Findings

### 1. Audit append-only is enforced by a TRIGGER, not by Postgres ROLE permissions (invariant 5 partially unmet)
- Severity: **high**
- File: `backend/apps/audit/migrations/0002_audit_append_only.py:17-36`
- Evidence:
  ```python
  CREATE OR REPLACE FUNCTION audit_event_append_only()
  RETURNS trigger AS $$
  BEGIN
      RAISE EXCEPTION 'audit_event is append-only ...' USING ERRCODE = '42501';
  ...
  CREATE TRIGGER audit_event_no_update BEFORE UPDATE ON audit_event ...
  CREATE TRIGGER audit_event_no_delete BEFORE DELETE ON audit_event ...
  ```
  And the migration's own docstring concedes the role-level layer is **not** done here
  (`backend/apps/audit/migrations/0002_audit_append_only.py:10-12`):
  > "Production deployments should ADDITIONALLY REVOKE UPDATE/DELETE on audit_event
  > from the application role for defense in depth — handled in deploy provisioning, not here."
- Why it matters: CLAUDE.md invariant 5 and the project brief state the denial must be
  **"at the database role level — `UPDATE`/`DELETE` on `AuditEvent` are denied by Postgres
  role permissions, not just application code."** A `BEFORE` trigger is application-defined
  SQL, not a role grant. The model docstring even mislabels the mechanism
  (`backend/apps/audit/models.py:5-8`: "physically prevents UPDATE/DELETE ... at the
  database role level"). A trigger is arguably *stronger* than REVOKE in dev (it fires even
  for superusers), so this is not a functional regression — but the *role-level* half of the
  invariant is entirely absent and is only promised, not implemented (see Finding 2). The
  trigger can also be dropped by any role with table-owner privileges, so without a separate
  restricted application role the "physical" guarantee is weaker than the invariant intends.
- Recommendation: Keep the trigger (good belt-and-suspenders). ADD the role-level layer the
  docstring promises: a migration (or provisioning SQL run under deploy) that `REVOKE UPDATE,
  DELETE ON audit_event FROM <app_role>` and configures a non-owner application DB role.
  Until a restricted role exists (Finding 3), the invariant's "role permissions" clause is
  unsatisfied.

### 2. The promised "deploy provisioning" REVOKE does not exist anywhere in the repo
- Severity: **high**
- File: `backend/apps/audit/migrations/0002_audit_append_only.py:10-12` (the claim) vs.
  whole-repo search (the absence)
- Evidence: A repo-wide grep for `REVOKE|GRANT|CREATE ROLE|CREATE USER` in non-doc source
  returns **zero** REVOKE/role-creation statements. The only deploy artifact is
  `scripts/dev.sh` (and `dev.ps1`), which only runs `migrate`, `load_modules`, `load_sports`,
  `runserver`, and Vite — `scripts/dev.sh:17-29`. There is no production deploy/provisioning
  script in the repo at all.
- Why it matters: The migration defers the role-level guarantee to "deploy provisioning,"
  but no such provisioning exists. So the role-level clause of invariant 5 is currently a
  TODO with no owner and no tracking. The append-only test
  (`backend/apps/audit/tests/test_append_only.py:35-73`) only exercises the trigger, so CI
  greenness gives false confidence that invariant 5 is "done."
- Recommendation: Either (a) implement the REVOKE as SQL in a migration so it is versioned
  and CI-tested, or (b) create a real provisioning script and a test that asserts the app
  role lacks UPDATE/DELETE. Track it in PRD/v1Users decisions log so it is not lost.

### 3. No separate restricted application DB role — app connects as a single (dev: superuser) role
- Severity: **medium**
- File: `backend/fixture/settings/base.py:101-102`
- Evidence:
  ```python
  DATABASES = {"default": env.db("DATABASE_URL")}
  DATABASES["default"]["ATOMIC_REQUESTS"] = True
  ```
  Single connection string; no privilege-separated role. The append-only test header states
  the runner connects "as a Postgres superuser (which bypasses GRANT/REVOKE)"
  (`backend/apps/audit/tests/test_append_only.py:5-8`), and the audit migration assumes the
  app "connects as the Postgres `postgres` superuser" in dev
  (`backend/apps/audit/migrations/0002_audit_append_only.py:8-10`).
- Why it matters: Role-level enforcement (invariant 5) is impossible without a non-owner,
  non-superuser application role. This is the missing precondition for Findings 1-2. It also
  means a future production deploy that reuses one powerful role would silently fail to gain
  the role-level protection.
- Recommendation: Provision a restricted application role for production; document the role
  in settings/deploy. Pair with the REVOKE from Finding 2.

### 4. `one_owner_per_org` DEFERRABLE INITIALLY DEFERRED follow-up migration was promised but NEVER WRITTEN
- Severity: **medium**
- Files:
  - Constraint as shipped (IMMEDIATE, partial unique, not deferrable):
    `backend/apps/organizations/migrations/0001_initial.py:294-301`
    ```python
    migrations.AddConstraint(
        model_name="organizationmembership",
        constraint=models.UniqueConstraint(
            condition=models.Q(("is_active", True), ("is_org_owner", True)),
            fields=("organization",),
            name="one_owner_per_org",
        ),
    ),
    ```
  - Model comment promising a follow-up RunSQL migration:
    `backend/apps/organizations/models.py:216-226`
    > "Django prohibits combining `condition` with `deferrable` — the spec's DEFERRABLE
    > INITIALLY DEFERRED requirement is therefore added by a follow-up RunSQL migration
    > owned by the organizations agent. This declarative constraint stays IMMEDIATE until then."
  - Model module docstring also asserts it is in place:
    `backend/apps/organizations/models.py:6-7` ("DEFERRABLE INITIALLY DEFERRED on
    `one_owner_per_org` so atomic ownership-swap ... works").
  - Directory listing proves only `0001_initial.py` exists in
    `backend/apps/organizations/migrations/` — no follow-up migration.
- Why it matters: The promised DEFERRABLE follow-up does not exist. The spec
  (v1Users.md §2.7, referenced at `backend/apps/organizations/services/ownership.py:17-18`)
  called for DEFERRABLE INITIALLY DEFERRED. Note this is partly an *impossible* request:
  Postgres cannot make a **partial** unique index deferrable (a true deferrable UNIQUE
  CONSTRAINT cannot carry a `WHERE`), as the ownership service correctly explains
  (`backend/apps/organizations/services/ownership.py:5-8`). So the literal follow-up cannot
  be written as-is. The runtime is nonetheless **correct** because `transfer_ownership`
  clears the outgoing owner before setting the incoming one inside one `transaction.atomic()`
  (`backend/apps/organizations/services/ownership.py:91-97`).
- Recommendation: Resolve the contradiction in writing. Either (a) drop the DEFERRABLE
  requirement from the model docstrings/comments and the v1Users decisions log, documenting
  that ordered-write-in-atomic-block is the accepted approach, or (b) if true deferred
  semantics are required, replace the partial unique with a full deferrable UNIQUE plus an
  exclusion/trigger and write the migration. As-is, three docstrings claim a guarantee that
  the DB does not provide.

### 5. Misleading comment in ownership service claims a constraint behaviour that does not exist
- Severity: **low**
- File: `backend/apps/organizations/services/ownership.py:91-92`
- Evidence:
  ```python
  # Atomic swap. Thanks to DEFERRABLE INITIALLY DEFERRED, the
  # constraint is checked at COMMIT, not after each UPDATE.
  ```
  This directly contradicts the same file's header
  (`backend/apps/organizations/services/ownership.py:5-8`), which states Django "silently
  drops the `deferrable=Deferrable.DEFERRED` flag on a partial UniqueConstraint." The
  constraint is in fact checked IMMEDIATELY after each UPDATE.
- Why it matters: A future maintainer reading line 91-92 could reorder the two saves or
  remove the clear-first ordering, believing deferral protects them — which would break the
  swap with a unique-violation. The correctness here depends entirely on the save ordering,
  not on deferral.
- Recommendation: Fix the inline comment to state the real mechanism ("we clear the outgoing
  owner first so the partial-unique condition matches zero rows before setting the incoming
  owner; the constraint is checked IMMEDIATELY").

### 6. `default_auto_field = BigAutoField` set app-wide but harmless (UUID v7 invariant intact)
- Severity: **info**
- Files: `backend/apps/permissions/apps.py` (`default_auto_field = "django.db.models.BigAutoField"`);
  every model overrides `id = models.UUIDField(default=...uuid7, primary_key=True)`.
- Evidence: All migration `id` fields are `models.UUIDField(default=apps.accounts.models.uuid7,
  editable=False, primary_key=True, serialize=False)` — e.g.
  `backend/apps/organizations/migrations/0001_initial.py:22-30`,
  `backend/apps/audit/migrations/0001_initial.py:21-29`,
  `backend/apps/sports/migrations/0001_initial.py:17-25`,
  `backend/apps/permissions/migrations/0001_initial.py:23-31`,
  `backend/apps/sadmin/migrations/0001_initial.py:21-29`,
  `backend/apps/accounts/migrations/0001_initial.py:69-77`.
- Why it matters: Invariant 1 (UUID v7 PKs, no autoincrement) is satisfied at the migration
  level — every PK is a UUIDField with the `uuid7` callable default. The `BigAutoField`
  default is dead config because models always override `id`, but it is a latent footgun if a
  future model forgets to declare `id` (it would silently get a BigAutoField, violating
  invariant 1). No autoincrement PK exists today.
- Recommendation: For safety, set a project base model or `DEFAULT_AUTO_FIELD` that does not
  introduce sequential PKs, or add a CI check that asserts every model PK is a UUIDField.

### 7. UUID v7 default is `uuid_utils.uuid7` wrapped, referenced cross-app from migrations — verify dependency pinned
- Severity: **info**
- Files: `backend/apps/accounts/models.py:28-30`; referenced as
  `default=apps.accounts.models.uuid7` from every migration, including the dependency-free
  `sports/0001_initial.py:11` (`dependencies = []`) at line 20.
- Evidence:
  ```python
  def uuid7() -> uuid.UUID:
      return uuid.UUID(str(uuid_utils.uuid7()))
  ```
- Why it matters: The default is a plain function reference (correct for migrations — it
  serializes the import path, not a value), so this is fine. The note is that `sports`
  migration imports `apps.accounts.models` despite declaring no migration dependency on
  `accounts`; at migration *run* time this is only an import, not a graph edge, so it works,
  but it is an undeclared coupling. Also, the whole PK scheme depends on the third-party
  `uuid_utils` package being installed and pinned.
- Recommendation: Confirm `uuid_utils` is pinned in `pyproject.toml`/lockfile. Optionally
  centralize `uuid7` in a shared `apps.common` so app-to-app import coupling in migrations is
  explicit.

---

## Constraint / model parity check (verified, no defects)

These were checked and **match** between model and migration — recorded for completeness:

- `OrganizationMembership` constraints — model `backend/apps/organizations/models.py:208-238`
  vs migration `backend/apps/organizations/migrations/0001_initial.py:286-318`: all four
  (`unique_active_role_per_user_per_org`, `one_owner_per_org`, `single_org_per_admin_user`,
  `owner_flag_only_on_admin_role`) present and identical. (Caveat: deferral, Finding 4.)
- `AdminInvitation.unique_pending_invite_per_email_per_org` — model lines 306-312 vs
  migration lines 265-272: match.
- `MembershipModuleGrant.unique_grant_per_user_org_module` + index — model
  `backend/apps/permissions/models.py:141-143` / migration lines 119-125: match.
  `module` FK uses `to="permissions_app.module"` (migration line 108) which is correct: the
  app label is intentionally `permissions_app` (`backend/apps/permissions/apps.py`,
  `label = "permissions_app"`), not a typo.
- `AuditEvent.idempotency_key` unique + indexes — model `backend/apps/audit/models.py:48,
  81-96` vs migration `backend/apps/audit/migrations/0001_initial.py:30-33, 81-97`: match.
  Idempotency (invariant 3) is enforced by the `unique=True` on `idempotency_key`.
- `TwoFactorDevice.one_confirmed_totp_per_user` partial unique — migration
  `backend/apps/accounts/migrations/0002_...py:149-156`: present.
- `KPISnapshot.snapshot_date` unique, `Sport.code` unique, `Organization.slug` unique,
  `SlugRedirect.old_slug` unique — all present in respective migrations.
- No destructive operations: a grep for `RunPython|RemoveField|DeleteModel|AlterField|
  RenameField|RenameModel|DROP TABLE|DROP COLUMN` across all migrations returns **nothing**.
  Migration history is purely additive (`CreateModel` / `AddField` / `AddIndex` /
  `AddConstraint` / one `RunSQL` for the trigger). No data-loss risk in current history.

---

## Gaps

1. **Role-level REVOKE for `audit_event` (invariant 5).** Missing entirely. Promised by the
   audit migration docstring as "deploy provisioning" but no such SQL/script exists anywhere
   in the repo. Blocking for a true invariant-5 claim. Effort: S (one migration + a role).
2. **Restricted application DB role.** No privilege-separated role configured
   (`base.py:101` is a single `DATABASE_URL`). This is the precondition for Gap 1. Effort: M
   (provisioning + settings + test).
3. **`one_owner_per_org` DEFERRABLE follow-up migration.** Promised in three docstrings,
   never written, and not writable as literally specified (Postgres can't defer a partial
   unique). Needs a written decision: drop the requirement (document the ordered-write
   approach) or redesign the constraint. Effort: S (decision + comment fixes) or M (redesign).
4. **CI guard for invariant 1.** No check prevents a future model from silently inheriting
   `BigAutoField` (the app-level default). Effort: S.
5. **Append-only test does not cover the role layer.** `test_append_only.py` only proves the
   trigger fires; once a restricted role + REVOKE exist, add a test asserting the app role
   cannot UPDATE/DELETE even with the trigger removed. Effort: S.
6. **Docstring/code drift.** `audit/models.py:5-8` ("database role level"),
   `organizations/models.py:6-7`, and `ownership.py:91-92` all assert guarantees the DB does
   not currently provide. Effort: S (doc fixes), but they actively mislead reviewers.
