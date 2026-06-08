# Backend · Forms Engine — Subsystem Analysis

> Path: `backend/apps/forms/` · Mounted at `/api/forms/` (root `backend/fixture/urls.py:66`) plus one route grafted onto `apps/tournaments/urls.py`. Read against repo `CLAUDE.md` invariants (UUID v7 PKs, org multi-tenancy, idempotent writes, audit, session auth).

## Purpose

A **data-driven, FET-style registration form engine**. A `Form.schema` JSONB document defines a multi-section, branching form; a `FormResponse.answers` JSONB holds a submission. It deliberately mirrors the `Tournament.rules`/`constraints` JSONB pattern (interpret-at-runtime, never hardcode field types). It generalizes the older `apps/teams.RegistrationLink` token flow into reusable `FormShareLink`s. Three concrete jobs: (1) let organizers build/publish forms in a tournament; (2) let the public submit them via `AllowAny` + throttled endpoints (by form id or opaque share token); (3) map accepted/team-registration submissions back into domain entities (`Team`/`Player`/`Person`) by reusing `apps/teams`.

## File-by-file roles

- `models.py` — 4 models: `Form`, `FormShareLink`, `FormResponse`, `FormFileUpload`. All org-scoped, UUID v7 PKs.
- `constants.py` — enums (`FormStatus`, `FormPurpose`, `ResponseStatus`) + four frozensets that are the schema vocabulary: `FIELD_TYPES`, `CHOICE_TYPES`, `DISPLAY_TYPES`, `VISIBILITY_OPS`, `PROMOTED_ROLES`.
- `services/schema.py` — `validate_schema` (structural validation of a schema document at the API boundary).
- `services/fields.py` — per-field-type coerce+validate registry (`_HANDLERS`, `validate_value`). "Add a type = add a handler here; no migration."
- `services/validation.py` — branching-aware **answer** validation: `_visible`, `_next_section`, `validate_answers`, `promote`.
- `services/forms.py` — lifecycle: `create_form`, `update_form` (freeze/version logic), `publish_form`, `close_form`, `duplicate_form`, `is_open`, slug helpers.
- `services/links.py` — share-token mint/resolve (`create_share_link` returns `(link, plaintext)`, `resolve_share_link` validates active/expiry/cap; sha256 hash stored).
- `services/responses.py` — `submit_response`: idempotent, atomic submission (validate → promote → create → claim uploads → bump counters → audit).
- `services/mapping.py` — `map_response`: dispatch by `Form.purpose`; `team_registration` → `apps/teams.register_school`.
- `views.py` — all DRF `GenericAPIView`s (builder, public, responses, stage-2).
- `serializers.py` — `FormSchemaField` (runs `validate_schema` at boundary), `FormSerializer`, `FormCreateSerializer`, `FormResponseSerializer`, `PublicSubmitSerializer`.
- `throttling.py` — `PublicFormThrottle` (`30/hour` by IP ident, hardcoded `rate`).
- `urls.py` — route table (note the `:verb` action suffix convention, e.g. `<uuid>:publish/`).
- `migrations/0001_initial.py` — full schema; the two partial unique constraints + three indexes live here.
- `tests/` — 11 test files (schema, fields, validation, freeze, idempotency, mapping, public_api, responses_api, isolation, builder_api, models).

## Data model

`Form` (`forms_form`): `organization` + `tournament` FKs (CASCADE), `slug` (max 63), `title`, `description`, `purpose` (FormPurpose, default `generic` per model — but `FormCreateSerializer` defaults to `organization_registration`; mismatch noted below), `schema` JSONB (default `{}`), `status` (FormStatus, default `draft`, indexed), `opens_at`/`closes_at` (the open-window), `version` (PositiveInt, default 1 — the response-pinning counter), `max_responses` + `response_count` (cap + denormalized counter), `confirmation_message`, `settings` JSONB (holds `bindings` for mapping), `created_by` (SET_NULL), soft delete (`deleted_at` indexed), timestamps. Constraints: **partial unique** `(tournament, slug)` where `deleted_at IS NULL` (`unique_form_slug_per_tournament`); index `(tournament, status)`.

`FormShareLink` (`forms_share_link`): `organization` + `form` FKs, `token_hash` (sha256 hex, indexed), `label`, `is_active`, `expires_at`, `max_submissions` + `submission_count`, `bound_entity` JSONB (e.g. `{"participant_response_id": ...}`), `prefill` JSONB, `created_by`. No soft delete. Plaintext token never stored.

`FormResponse` (`forms_response`): `form` FK, plus denormalized `organization` + `tournament` FKs, `answers` JSONB (the **cleaned** answers, not raw), `form_version` (snapshot of `Form.version` at submit — the pinning value), promoted/indexed columns `respondent_email`/`respondent_phone`/`respondent_name`/`title`, `status` (ResponseStatus, default `submitted`, indexed), `event_id` (UUID, nullable — the idempotency key), `submitted_via` FK→`FormShareLink` (SET_NULL), `mapped_entities` JSONB (e.g. `{"team_ids":[...]}`), soft delete. Constraints: **partial unique** `(form, event_id)` where `event_id IS NOT NULL` (`unique_form_response_event_id`); indexes `(form, status)`, `(form, created_at)`.

`FormFileUpload` (`forms_file_upload`): `organization` + `form` FKs, `response` FK (nullable, SET_NULL — null until claimed), `field_key`, `upload_ref` (UUID v7, indexed — the client-facing handle), `file` (FileField → `form_uploads/%Y/%m/`), `original_name`, `content_type`, `size`. No soft delete.

## Core algorithms / services (with file:function)

### Schema validation — `services/schema.py::validate_schema`
1. schema must be dict with non-empty `sections` list.
2. section `key`s must be unique and all truthy.
3. `_collect_fields` flattens all section fields **and recurses into `group` children**, raising on missing/duplicate keys (so keys are globally unique across the form, including nested groups).
4. Per section: `_check_visibility` (visibility rule must be a dict with `field` referencing a known field + `op` in `VISIBILITY_OPS`); `section.next` must target a known section key or the sentinel `"_end"`.
5. Per field: `_check_field` (type in `FIELD_TYPES`, `label` present, optional `role` in `PROMOTED_ROLES`, `CHOICE_TYPES` need non-empty `options` each with `value`+`label`); field-level visibility checked; each option `goto` must target a known section or `"_end"`.

Invoked at the API boundary by `serializers.FormSchemaField.to_internal_value` (only when `data.get("sections")` is truthy → 400 not 500) and again inside `create_form`/`update_form`/`publish_form`.

### Field coercion — `services/fields.py::validate_value`
Dispatches to `_HANDLERS[ftype]`. Handlers: `_text` (min/max length, regex `pattern`), `_email`/`_phone` (regex), `_number` (int if integral-looking else float; `min`/`max`), `_single_choice`/`dropdown` (stringified value must be an option), `_multi_choice` (list subset of options + `min/maxSelections`), `_date` (`YYYY-MM-DD`), `_time` (`HH:MM`), `_rating` (0..max, default max 5), `_linear_scale` (min..max defaults 1..10), `_address` (dict restricted to `_ADDRESS_KEYS`), `_yes_no` (bool/yes/true/1 ↔ no/false/0), `_file_upload` (returns list of stringified refs — content validity is enforced separately in `submit_response`/`PublicUploadView`). `section_text` (DISPLAY) and `group` raise here on purpose — they are handled by the walker.

### Branching-aware answer validation — `services/validation.py::validate_answers`
Walks sections starting at `sections[0]`. For the current section, if `_visible(section.visibility, answers)` then for each field: skip DISPLAY types; skip fields whose own visibility is false; treat `None/""/[]/{}` as empty → error `"required"` if `required` else skip; `group` is **stored as-is (no deep validation — v1 follow-up)**; otherwise `validate_value` and collect FieldError into `errors[key]`. Then `current = _next_section(...)`. Loop bounded by `order_guard < len(sections)+1`, a `visited` set (cycle break), and `"_end"`/None termination. Raises `AnswerError(errors)` if any. **Returns only reached+visible answers** — hidden/unreached posted answers are dropped (proven by `test_hidden_answer_is_dropped`), so branching can't be bypassed by stuffing the payload.

- `_visible(rule, answers)`: empty rule → True. Ops: `answered` (val not in empties), `equals`, `not_equals`, `in` (val in target list), `includes` (target in val list), `gt`/`lt` (float-coerced, False on TypeError/ValueError). Unknown op → False.
- `_next_section(section, answers, sections)`: resolution order = (a) for each `single_choice`/`dropdown` field, if chosen option (string-compared) has a `goto`, return it; else (b) `section.next`; else (c) the next section in document order; else None. Note: option-`goto` only fires for `single_choice`/`dropdown`, never `multi_choice`.
- `promote(schema, clean)`: collects `role → str(value)` for fields whose key is in `clean`. Roles are `email/phone/name/title` (`PROMOTED_ROLES`).

### Submission — `services/responses.py::submit_response`
Pre-check: if `event_id` and a prior `(form,event_id)` row exists, return it (fast idempotency). Else `validate_answers` → `promote`. Inside `transaction.atomic()` with a nested savepoint: create `FormResponse` (answers=clean, `form_version=form.version`, promoted columns truncated to column widths, `submitted_via=share_link`). On `IntegrityError` (concurrent same-event_id race hitting the partial unique constraint): if `event_id` is None re-raise, else fetch and return the winner's row. Then: claim uploads (`FormFileUpload.filter(form, upload_ref__in=values, response__isnull=True).update(response=resp)`), `Form.response_count = F+1`, share-link `submission_count = F+1`, and `emit_audit` (`form_response_submitted`, `idempotency_key=event_id`) **inside the txn**.

### Mapping — `services/mapping.py::map_response`
Early-return if `mapped_entities` already set (idempotent). `team_registration` → `_map_team_registration`: reads `form.settings["bindings"]` to find answer keys (`school_name`, `team_name`, `players_group`, `player_name`, with sensible defaults), builds `players` from a repeating group (dict rows with the name key; non-dict / nameless rows skipped), derives a **distinct** audit key `uuid5(NAMESPACE_URL, "formresp-teamreg:{resp.id}")`, calls `register_school(...)`, then persists `mapped_entities={"team_ids":[...]}`. `organization_registration` and `generic` are no-ops (the response row IS the record). The module docstring documents *why* the derived key is required (see Invariants).

### Lifecycle / freeze — `services/forms.py`
- `create_form`: default schema `{"version":1,"sections":[]}`; validate only if non-empty; unique slug via `_unique_slug` (slugify + numeric suffix loop); audit `form_created`.
- `update_form`: partial. If `schema` present → `validate_schema`; if `response_count > 0` and an **answered** key (`_answered_keys` unions all `response.answers.keys()`) disappears from the new schema (`_schema_field_keys`), bump `version` (destructive). Safe edits (labels) don't bump. Also patches title/description/confirmation_message/closes_at/opens_at/max_responses/settings. Audit `form_updated` with `changed` list.
- `publish_form`: reject empty form (`FormEditError`), validate, status→`open`, set `opens_at` if null; audit `form_published`.
- `close_form`: status→`closed`; audit.
- `duplicate_form`: clone into a new draft with a fresh `"... (copy)"` slug. **No audit emitted** (asymmetry vs other lifecycle ops).
- `is_open`: status==`open` AND now within `[opens_at, closes_at)`.

## API / endpoint surface

Builder (IsAuthenticated, manager-scoped via `_get_manageable_*`):
- `GET/POST /api/tournaments/{tournament_id}/forms/` — `TournamentFormsView` (list access-scoped; create manager-only). **This view lives in `apps/forms/views.py` but is routed from `apps/tournaments/urls.py`** — a cross-app coupling.
- `GET/PATCH/DELETE /api/forms/{form_id}/` — `FormDetailView` (read / partial-update / soft-delete).
- `POST /api/forms/{form_id}:publish/` · `:close/` · `:duplicate/` — lifecycle.
- `GET /api/forms/field-types/` — `FieldTypesView` (catalog `{type, has_options}` for builder UI).

Public (AllowAny + `PublicFormThrottle`):
- `GET/POST /api/forms/{form_id}/public/` and `GET/POST /api/forms/r/{token}/` — `PublicFormView`. GET returns schema or `{"closed":true}`; POST validates+records, then **always calls `map_response`** (even on idempotent replay). Resolution by form id (any non-deleted form) or active share token.
- `POST /api/forms/{form_id}/uploads/` — `PublicUploadView`. Stages a file (≤10 MB; `application/pdf|image/png|image/jpeg` only), returns `upload_ref`.

Responses (IsAuthenticated, manager-scoped):
- `GET /api/forms/{form_id}/responses/` — list or `?export=csv` (CSV header is `title,email,phone,status,submitted_at` + every non-`section_text` schema field key).
- `PATCH /api/forms/{form_id}/responses/{response_id}/` — set `status` (validated against `ResponseStatus.values`; **free transition, no state machine**).
- `POST /api/forms/{form_id}:send-stage2/` — for each `accepted` response, mint a single-use `FormShareLink` against a target `team_registration` form; returns `/r/{token}` paths. Email enqueue is a `TODO(notify)`.

## Invariants that MUST be preserved

1. **Idempotency (invariant #3).** `(form, event_id)` partial unique + the savepoint/IntegrityError catch in `submit_response`; replay returns the same row with 201 (not 500). The end-to-end test `test_public_team_registration_submit_and_replay_no_duplicate_team` is the canonical guard.
2. **Triple-idempotency for team registration.** submit (event_id), submit-audit (`form_response_submitted` keyed on event_id), and `register_school` (keyed on the **uuid5-derived** key) must stay on *distinct* audit keys, because `AuditEvent.idempotency_key` is **globally unique** and `register_school` re-detects prior work by querying `event_type="school_registered"`. Reusing the submit event_id silently re-creates teams on replay. This is documented in `mapping.py` and tested.
3. **Hidden/unreached answers are dropped**, not stored. `validate_answers` returns only reached+visible cleaned answers — required for both correctness and to stop branch-bypass.
4. **Response pinning via `form_version`.** Destructive schema edits bump `Form.version`; existing responses keep their `form_version`. Old responses must remain interpretable against the schema they were submitted against.
5. **Cross-org isolation (invariant #2).** Builder/responses endpoints resolve via `accessible_tournaments(...)` → 404 (no existence leak) then `can_manage_tournament` → 403. Covered by `test_isolation.py` + `test_responses_outsider_404`.
6. **Share tokens stored hashed only**; resolution enforces active + expiry + submission cap. Plaintext returned once at mint.
7. **Public upload allowlist + size cap** (`MAX_BYTES`, `ALLOWED`) and uploads claimed only when `response__isnull=True` and `form` matches.
8. **UUID v7 PKs + soft delete** semantics (`deleted_at IS NULL` in every read filter and in the partial unique slug constraint).
9. **Audit on every state change** (create/update/publish/close/submit) — except `duplicate_form` (gap).

## Dependencies / coupling

Outgoing: `apps.accounts.models.uuid7`; `apps.organizations.Organization` + `apps.tournaments.Tournament` (FKs); `apps.tournaments.scope.accessible_tournaments` + `apps.tournaments.permissions.can_manage_tournament` (authz); `apps.audit` (`emit_audit`, `ActorRole`); **`apps.teams.services.registration.register_school`** (the heaviest behavioral coupling — mapping depends on its `teams=[{name,players:[{full_name,jersey_no,position,dob_year,...}]}]` contract and its audit-idempotency internals); `apps.tournaments.services.create` (tests only). `register_school` itself fans out to `Team`/`Person`/`Player` and the Person↔Player split (invariant #8).

Incoming: `apps/tournaments/urls.py` imports `TournamentFormsView` from `apps/forms/views.py`. No other backend app imports `apps.forms` — the engine is otherwise a leaf consumer. (Frontend consumes the REST surface separately.)

## Tech debt / smells / duplication

- **`TournamentFormsView` lives in `forms` but is routed from `tournaments`** — a split-brain seam; the list/create endpoint and its `_get_manageable_tournament` helper belong with the other tournament-nested resources or should be cleanly re-exported.
- **Default-purpose mismatch:** `Form.purpose` model default is `generic`; `FormCreateSerializer.purpose` default is `organization_registration`. Direct ORM creates and API creates diverge.
- **No `max_responses` enforcement.** The field + `response_count` exist but `submit_response`/`is_open` never check the cap (only the share-link `max_submissions` is enforced, in `resolve_share_link`). Likely a latent bug vs intent.
- **`group` fields are stored unvalidated** (`validate_answers` stores raw), yet `_map_team_registration` reads a players group structurally — a malformed/abusive group payload reaches mapping unchecked.
- **`response_count` denormalization can drift** from actual row count (incremented in submit, decremented nowhere on soft-delete; `_answered_keys` and freeze logic depend on it being > 0, not exact).
- **`map_response` runs synchronously in the request path** (and re-runs on every replay), inside the public AllowAny handler — a slow/failing `register_school` becomes a public-endpoint failure; no `on_commit`/queue boundary (contrast with the matches event publish pattern).
- **`promote` stringifies everything** (`str(value)`), so a numeric/`yes_no` role value becomes a string in the indexed column — fine for email/phone/title but lossy if roles widen.
- **Throttle is per-IP and in-memory** (dev cache); shared NAT users collide, and it resets per-process. `rate` hardcoded (intentional per docstring, mirrors teams).
- **`_collect_fields` enforces global key uniqueness including group children**, but the walker treats group children opaquely — the uniqueness guarantee is partly unused.
- **Stage-2 link minting has no idempotency** — calling `:send-stage2/` twice mints duplicate links per accepted response.
- **CSV export reads the *current* schema field keys** to build columns, but responses may be pinned to older `form_version`s; columns can mismatch historical answers.

## Restructuring seams & risks

- **Clean seam at `services/`**: schema, fields, validation, forms, links, responses, mapping are already small, pure-ish functions with explicit signatures. `validate_schema`/`validate_value`/`validate_answers`/`promote`/`is_open` are dependency-light and trivially portable. The vocabulary (`constants.py` frozensets + `fields._HANDLERS`) is the extension point: "add a type = add a handler."
- **Mapping is the riskiest seam.** It hard-binds to `register_school`'s positional contract *and* its audit-idempotency mechanism. Any restructuring of `apps/teams` registration must preserve: the `teams=[{name,players}]` shape, `event_id` idempotency semantics, and the global-unique audit-key behavior. Introduce an explicit interface (e.g. a `RegistrationTarget` protocol) before moving either side. Consider moving `map_response` to an `on_commit` hook / task to decouple it from the public request and make replays cheap.
- **Status review has no state machine** (free `submitted↔accepted↔rejected↔waitlisted`), unlike Tournament/Match. If responses gain workflow (notify on accept, lock after stage-2), introduce an explicit transition table + audit (parallels invariant #6) — but note that would be a *new* behavior, not preservation.
- **Freeze/versioning is coarser than tournaments'**: it only bumps `version` on destructive edits; there is no grace window, no notify, no hard freeze tied to form `status`. If forms must align with the rule-freeze invariant (#7), expect to add status-gated edit guards.
- **Public submit + map coupling**: splitting validation from persistence from mapping into a pipeline would let mapping be retried/queued and let `max_responses` be enforced in one place. The atomic block in `submit_response` is the natural transaction boundary to preserve.
- **Migration constraints are load-bearing** (`unique_form_response_event_id`, `unique_form_slug_per_tournament`) — any model split must carry these partial unique constraints intact or idempotency/slug guarantees silently break.

## Ambiguities / things to verify before relying on them

- Whether `max_responses` is *intended* to hard-block submission (field exists, never enforced) — currently dead.
- `group` deep-validation is explicitly deferred ("follow-up; store as-is for v1") — mapping trusts unvalidated structure.
- `duplicate_form` audit omission may be intentional or an oversight.
- The model-vs-serializer `purpose` default divergence: which is canonical is unstated.
