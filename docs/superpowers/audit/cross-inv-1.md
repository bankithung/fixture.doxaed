# Cross-cutting audit — Invariant 1: UUID v7 PKs everywhere

**Scope:** Whole backend + frontend (excluding `backend/.venv` and `frontend/node_modules`).
**Invariant:** UUID v7 primary keys everywhere. No sequential / auto-increment IDs on domain models. Public URLs use `(slug, UUID)` pairs.
**Date:** 2026-06-04
**Verdict:** Invariant **HELD** for all 16 Phase 1A domain models. No actual UUID-PK violation found. Two *latent* configuration hazards (`DEFAULT_AUTO_FIELD` / per-app `default_auto_field` both = `BigAutoField`) will silently produce `BigAutoField` PKs on any future model that forgets an explicit `id` declaration — this is a real Phase 1B trap, not a current breach. Recorded below as findings + gaps.

---

## Findings

### F1 — Project default PK type is `BigAutoField`, not UUID (latent trap for Phase 1B)
- **Severity:** medium
- **File:** `backend/fixture/settings/base.py:141`
- **Evidence:**
  ```python
  DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
  ```
- **Why it matters:** Every Phase 1A model dodges this because each declares an explicit `id = models.UUIDField(primary_key=True, default=uuid7, editable=False)`. But the global default is the *opposite* of invariant 1. The moment a Phase 1B model (Tournament, Team, Person, Player, Match, MatchEvent, Lineup, Dispute, Notification, plus every M2M through-table that needs an explicit PK) is written without the explicit UUID `id` line, Django silently gives it a `bigint` auto-increment PK and `makemigrations` will not warn. This directly contradicts invariant 1 and the chassis is supposed to make the safe path the default. It does not *block* Phase 1B, but it removes the guardrail.
- **Recommendation:** Flip the project default to UUID v7 by routing through a custom field, e.g. add `class UUID7Field(models.UUIDField)` (with `default=uuid7`, `editable=False`) in a shared `apps/common/fields.py` and set `DEFAULT_AUTO_FIELD = "apps.common.fields.UUID7Field"`. (Django allows a non-AutoField as `DEFAULT_AUTO_FIELD` only if it subclasses `AutoFieldMixin`/`AutoField`; the practical pattern is a UUID `AutoField` subclass — see `django-uuid-pk` style helpers, or keep the explicit-`id` convention but add a CI guard, see Gap G1.) At minimum, add a CI/`check` that fails if any model in `apps.*` has a non-UUID PK.

### F2 — Per-app `default_auto_field = BigAutoField` in all six AppConfigs (overrides global; same latent trap)
- **Severity:** medium
- **Files:**
  - `backend/apps/accounts/apps.py:5`
  - `backend/apps/audit/apps.py:5`
  - `backend/apps/organizations/apps.py:5`
  - `backend/apps/permissions/apps.py:5`
  - `backend/apps/sadmin/apps.py:5`
  - `backend/apps/sports/apps.py:5`
- **Evidence (representative):**
  ```python
  class AccountsConfig(AppConfig):
      default_auto_field = "django.db.models.BigAutoField"
  ```
- **Why it matters:** `AppConfig.default_auto_field` takes precedence over the project-level `DEFAULT_AUTO_FIELD` for models in that app. So even if F1 is fixed at the project level, these six per-app overrides would keep the unsafe default for any future model added to these apps (notably `apps.accounts`, where M2M through-tables and future helper models could land). They re-assert `BigAutoField` six times. Currently harmless only because every model has an explicit UUID `id`.
- **Recommendation:** Remove the `default_auto_field` line from each AppConfig (let it inherit the corrected project default), or point it at the shared UUID7 field once F1 is implemented. Do this in the same change as F1 so the two settings don't disagree.

### F3 — `auth` M2M through-tables (`accounts_user_groups`, `accounts_user_user_permissions`) carry `BigAutoField` hidden PKs
- **Severity:** low (info-adjacent)
- **File:** `backend/apps/accounts/migrations/0001_initial.py:97-118` (the `groups` and `user_permissions` M2M fields inherited from `AbstractUser`)
- **Evidence:**
  ```python
  ("groups", models.ManyToManyField(... to="auth.group", ...)),
  ("user_permissions", models.ManyToManyField(... to="auth.permission", ...)),
  ```
- **Why it matters:** Django auto-creates the join tables for these two M2Ms. Their hidden `id` PK type follows `accounts` AppConfig's `default_auto_field` (currently `BigAutoField`, F2), so these two join tables get `bigint` auto-increment PKs. These are Django framework plumbing tables (User↔Group, User↔Permission), not platform domain entities, and the project may not even use Django Groups (RBAC is the custom module/grant system). Invariant 1 is about *domain* models, so this is a defensible carve-out, but it is technically a non-UUID PK in the schema and worth a conscious decision.
- **Recommendation:** Acceptable to leave as-is (framework tables, low risk, never exposed in public URLs). If strict zero-tolerance is desired, the cleanest fix is to not rely on Django Groups at all (the custom RBAC already supersedes them) and/or document the carve-out. No action required for invariant compliance.

### F4 — `scope.py` docstring example model omits the UUID `id` line (prep hygiene, not a real model)
- **Severity:** info
- **File:** `backend/apps/permissions/scope.py:18`
- **Evidence:** inside the module docstring (lines 9-29):
  ```python
  class Tournament(models.Model):
      organization = models.ForeignKey(Organization, ...)
      ...
      objects = ScopedManager.from_queryset(TournamentQuerySet)()
  ```
- **Why it matters:** This is documentation, not a registered model — confirmed it is inside the triple-quoted module docstring, so it never executes and creates no table. But it is the literal template the Phase 1B tournaments agent is told to copy ("# apps/tournaments/models.py"), and it does **not** show `id = models.UUIDField(primary_key=True, default=uuid7, editable=False)`. A copy-paste of this example would inherit the F1/F2 `BigAutoField` default and violate invariant 1.
- **Recommendation:** Add the explicit UUID `id` line to the docstring example so the sanctioned Phase 1B integration pattern bakes in invariant 1.

---

## What is correct (verified, not assumed)

- **All 16 Phase 1A domain models declare an explicit UUID v7 PK.** Every model has
  `id = models.UUIDField(primary_key=True, default=uuid7, editable=False)`:
  - `accounts`: `User` (models.py:69), `TwoFactorDevice` (:138), `RecoveryCode` (:170), `PasswordResetToken` (:205), `EmailVerificationToken` (:247)
  - `organizations`: `Organization` (:112), `OrganizationMembership` (:170), `AdminInvitation` (:257), `SlugRedirect` (:343)
  - `permissions`: `Module` (:50), `MembershipModuleGrant` (:100)
  - `audit`: `AuditEvent` (:47)
  - `sadmin`: `Feedback` (:45), `UsageEvent` (:108), `KPISnapshot` (:145)
  - `sports`: `Sport` (:71)
- **The `uuid7()` helper is correct.** `backend/apps/accounts/models.py:28-30` wraps `uuid_utils.uuid7()` and converts to a stdlib `uuid.UUID` for DB storage (the conversion preserves version bits, so the stored value is a genuine v7). `uuid-utils>=0.10` is a declared dependency (`backend/pyproject.toml:34`).
- **Migrations confirm UUID PKs landed in the schema.** Every `primary_key=True` in every migration file is a `models.UUIDField(default=apps.accounts.models.uuid7, editable=False, primary_key=True)`. A grep for `AutoField` / `BigAutoField` / `SmallAutoField` across all `apps/**/migrations/*.py` returned **zero** matches — no migration ever created an auto-increment PK column on a domain model.
- **`User.last_active_org_id` and audit/usage scope IDs are `UUIDField`** (e.g. `accounts/models.py:86`, `audit/models.py:60,63-65,70`), so denormalized cross-references stay UUID-typed.
- **Frontend assumes string (UUID-safe) IDs everywhere.** All entity `id`/`*_id` fields in `frontend/src/types/user.ts` and `frontend/src/types/api.generated.ts` are typed `string`; route params are `uuid: string` / `slug_or_uuid: string`. The only `: number` hits are an unrelated pagination `limit` (`frontend/src/api/audit.ts:14`) and a toast timeout. No `parseInt`/`Number()` coercion of domain IDs. No frontend code assumes numeric PKs.

---

## Gaps (Phase 1B prep / hardening)

### G1 — No CI guard that domain-model PKs are UUID
- **Missing:** A test or `django check` that fails when any model under `apps.*` has a non-UUID PK (or a non-`uuid7` default). Invariant 1 is currently upheld only by hand-written convention repeated in each model; nothing enforces it. Combined with F1/F2 (`BigAutoField` defaults), the first forgotten `id` line in Phase 1B silently breaks the invariant with no signal.
- **Needed for:** Keeping invariant 1 true as Phase 1B adds ~9+ new models.
- **Effort:** S (a parametrized test iterating `django.apps.apps.get_models()` asserting `model._meta.pk` is a `UUIDField`, skipping `auth`/`contenttypes`/`sessions`/`admin`/`axes`/`waffle` framework apps).
- **Blocking:** No (1A is not blocked; this is preventative).

### G2 — Default PK type contradicts the invariant (see F1/F2)
- **Missing:** Project- and app-level defaults that make UUID v7 the *automatic* PK, so the safe path is the default rather than an opt-in repeated per model.
- **Needed for:** Reducing per-model boilerplate and eliminating the F1/F2 trap before Phase 1B model authoring begins.
- **Effort:** M (introduce a shared UUID7 field/abstract base `UUIDPKModel` in `apps/common/`, then update settings + AppConfigs; optionally provide an abstract base model the Phase 1B models inherit).
- **Blocking:** No.

### G3 — No shared abstract base model carrying the UUID PK
- **Missing:** There is no `apps/common/` abstract base (e.g. `class UUIDPKModel(models.Model): id = UUIDField(...); class Meta: abstract = True`) that Phase 1B models can inherit. Each Phase 1A model re-declares the identical `id` line by hand. Phase 1B will repeat it ~9+ more times, each an opportunity to forget it.
- **Needed for:** DRY, consistent UUID-PK adoption across Phase 1B (Tournament/Team/Person/Player/Match/MatchEvent/Lineup/Dispute/Notification + TournamentMembership).
- **Effort:** S.
- **Blocking:** No. 1A does **not** block Phase 1B on this — the convention is well-established and copyable; a base class is an improvement, not a prerequisite.

### G4 — Sanctioned Phase 1B integration template omits the UUID PK (see F4)
- **Missing:** The `scope.py` docstring template (the thing the tournaments agent is directed to copy) does not include the UUID `id` line.
- **Needed for:** Ensuring copy-paste of the official pattern satisfies invariant 1.
- **Effort:** S (one-line docstring edit).
- **Blocking:** No.
