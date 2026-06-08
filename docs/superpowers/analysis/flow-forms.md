# Flow: Forms data-driven engine (build → publish → render → branch → submit → map → review)

A single JSONB schema interpreter (FET-style, never hardcoded forms) powers both
registration stages. The schema is authored in a Zustand builder store, validated
and persisted as `Form.schema`, published, served unauthenticated, rendered as a
paged wizard whose branching is computed by `lib/formLogic.ts`, then re-walked by
the **identical** server traversal in `services/validation.py` on submit, stored
as a `FormResponse`, and (for `team_registration`) mapped into `Team`/`Player`/
`Person` via the reused `register_school`.

## Subsystems crossed
`frontend/src/features/forms` + `frontend/src/lib/formLogic.ts` (React/Vite) →
`apps/forms` (Django: views/serializers/services/models) → `apps/teams`
(register_school → Person/Player/Team) → `apps/audit` (emit_audit) →
`apps/tournaments` (scope/permissions) → `apps/permissions` (`forms` module).

## Ordered walkthrough (file:function cited)

1. **Build (client).** `features/forms/builderStore.ts::useBuilderStore` holds the
   working `FormSchema`. Mutators `addSection`/`addField`/`updateField`/
   `reorderFields`/`updateSection` immutably edit `schema.sections[].fields[]`.
   `newField` seeds choice types with one option; `uid()` mints client-local keys
   (`f_...`/`s_...`). `FormBuilderPage.tsx` debounce-autosaves (1200ms) via
   `saveSchema.mutate()` → `formsApi.update(formId, { schema })` → `PATCH
   /api/forms/<id>/`. Live correctness is shown by `FormPreview.tsx`, which calls
   the SAME `reachableSections`/`isVisible` the public renderer uses.

2. **Persist + schema validation (server).** `views.py::FormDetailView.patch` →
   `services/forms.py::update_form`, which calls
   `services/schema.py::validate_schema` (unique section keys, unique field keys
   incl. group children via `_collect_fields`, known `type`, required `label`,
   options for `CHOICE_TYPES`, `visibility` rule shape + targets exist,
   `option.goto`/`section.next` target a real section or `_end`). On edits after
   responses exist, `update_form` bumps `Form.version` if an answered key
   disappeared (destructive change; invariant #7/#10). `create_form` mints a
   unique slug; every write `emit_audit`s.

3. **Publish.** `views.py::FormPublishView.post` → `services/forms.py::publish_form`
   re-runs `validate_schema`, rejects empty forms, sets `status=open` and
   `opens_at=now()` if unset, audits `form_published`.

4. **Public GET (render bootstrap).** Renderer route `/f/:formId` or `/r/:token`
   → `PublicFormPage.tsx` → `formsApi.publicGet`/`publicGetByToken` →
   `views.py::PublicFormView.get`. `_resolve` either loads the form by id or via
   `services/links.py::resolve_share_link` (sha256 token, active + unexpired +
   under submission cap). `services/forms.py::is_open` gates: `status==open` AND
   `opens_at ≤ now < closes_at`. Closed → `{closed: true}`; open →
   `_public_payload` (`{title, description, schema, confirmation_message}` +
   `tournament_name`).

5. **Render as paged wizard + client branching.** `PublicFormPage.tsx` keeps
   `answers`, `stepIndex`, `uploadRefs`, a stable `eventId` (`newEventId`, fixed
   across retries for idempotency), and `errors`. On every render it recomputes
   `sections = reachableSections(schema, answers)` (`lib/formLogic.ts`), so
   picking a branching option immediately re-routes the wizard. `current` is the
   clamped step; per-field `isVisible` filters within a section. Field widgets
   come from `features/forms/fieldRenderers.tsx::FieldRenderer`.
   `formLogic.ts::reachableSections` walks from `sections[0]`, at each section
   takes `nextSectionKey` (first goto-bearing `single_choice`/`dropdown` option's
   `goto`, else `section.next`) else the next section in document order, stops at
   `_end`/cycle (`seen` set). `validateRequired` flags only reachable+visible
   required empties. `onNext` validates the current section; `onSubmit` runs a
   full-schema `validateRequired` before POSTing.

6. **Uploads (optional).** `FieldRenderer` file inputs call
   `PublicFormPage.handleUpload` → `formsApi.publicUpload` →
   `views.py::PublicUploadView.post` (AllowAny + throttled, `MAX_BYTES=10MB`,
   `ALLOWED` content types) → creates an unattached `FormFileUpload`, returns
   `upload_ref`. The renderer collects `{fieldKey: upload_ref}` into `uploadRefs`.

7. **Submit + server branching re-eval.** `formsApi.publicSubmit(body =
   {answers, event_id, upload_refs})` → `views.py::PublicFormView.post`.
   Re-checks `is_open` (closed → 400), validates body shape via
   `PublicSubmitSerializer`, then `services/responses.py::submit_response`:
   - **Idempotency pre-check:** existing `(form, event_id)` row → return it.
   - **Server branching:** `validation.py::validate_answers(form.schema, answers)`
     re-walks the schema with `_visible` (the seven ops) and `_next_section` (the
     SAME goto/next/document-order rule + cycle guard via `visited`/`order_guard`).
     It enforces `required`/type **only on reached + visible** fields; answers to
     unreached/hidden fields are **dropped** (`clean` excludes them) so branching
     cannot be bypassed by POSTing hidden values. Per-field coercion is
     `services/fields.py::validate_value` (registry `_HANDLERS`, e.g. choice values
     must be in `_opt_values`, `maxSelections`, email/phone regex). `group`
     fields are stored as-is (deep validation is a follow-up).
   - **Promote:** `validation.py::promote` maps `role`-tagged answers
     (`email/phone/name/title`) to indexed `FormResponse` columns.
   - **Atomic create:** inside `transaction.atomic()`, create the `FormResponse`
     (`answers=clean`, `form_version=form.version`), with an inner savepoint that
     catches the `unique(form, event_id)` `IntegrityError` and returns the row a
     racing writer created. Then claim `FormFileUpload` rows (set `response`),
     `F()`-increment `Form.response_count` and the share link's
     `submission_count`, and `emit_audit("form_response_submitted",
     idempotency_key=event_id)`.

8. **Entity mapping.** Back in the view, AFTER `submit_response` returns,
   `services/mapping.py::map_response(resp)` runs. Early-return if
   `resp.mapped_entities` already set (replay-safe). Dispatch by `Form.purpose`:
   `generic`/`organization_registration` = no-op (the row IS the record);
   `team_registration` → `_map_team_registration` reads `form.settings.bindings`
   to assemble `register_school` params (school_name from role=title fallback,
   team_name, players from a `group`), derives a **distinct** audit key
   `uuid5("formresp-teamreg:"+resp.id)` (see module note — reusing `event_id`
   would defeat both audits' idempotency), and calls
   `apps/teams/services/registration.py::register_school`, which creates
   `Team` + per-player `Person` + `Player` in its own `transaction.atomic()` and
   stores `team_ids` in `resp.mapped_entities`. The view returns
   `{response_id, message: confirmation_message}` (201); the renderer shows the
   `done` confirmation screen.

9. **Responses view / CSV.** `views.py::FormResponsesView.get` (organizer-only via
   `_get_manageable_form`) lists `FormResponseSerializer` rows or, with
   `?export=csv`, streams `_csv` (header: promoted columns + every non-display
   field key, rows = answers). `FormResponseDetailView.patch` sets
   `accepted/rejected/waitlisted`. `FormSendStage2View.post` mints a single-use
   `FormShareLink` per accepted response against a `team_registration` form
   (Stage-1 → Stage-2 bridge; email enqueue is a TODO).

## Diagram-in-prose
builderStore.schema → PATCH/validate_schema → Form.schema → publish_form(open) ⇒
public GET (is_open/resolve_share_link) → PublicFormPage (reachableSections =
client branch) → POST → submit_response[validate_answers = server branch, parity]
→ FormResponse(+promote +claim uploads +counts +audit) → map_response →
register_school → Team/Player/Person → ResponsesView/CSV/send-stage2.

## Invariants this flow depends on
- **Client/server branching parity (the central contract).** `lib/formLogic.ts`
  (`isVisible`, `nextSectionKey`, `reachableSections`) MUST mirror
  `validation.py` (`_visible`, `_next_section`, `validate_answers`) exactly:
  identical seven ops, identical resolution order (option.goto → section.next →
  document order → `_end`), identical "first goto-bearing single_choice/dropdown
  wins", identical empty/`DISPLAY_TYPES` semantics. Divergence ⇒ a field required
  server-side but hidden client-side (or vice versa) ⇒ spurious 400s the user
  cannot fix. The file headers in both call this out.
- **Hidden answers dropped server-side** — security boundary; client filtering is
  UX only.
- **Idempotency (#3):** stable `eventId` on the client; `(form, event_id)` unique
  + savepoint replay; `map_response` skip-if-mapped; `register_school` distinct
  uuid5 audit key.
- **`form_version` pinning (#7):** responses keep the schema version they answered.
- **Multi-tenancy (#2):** builder/responses resolve via `accessible_tournaments` +
  `can_manage_tournament` (404 no-leak); public is `AllowAny` + throttled.
- **Schema integrity:** `validate_schema` on every write guarantees keys unique,
  goto/visibility targets exist — `validate_answers` trusts this.

## Failure modes
- **Parity drift** (above) — the single highest-risk fragility; only loosely
  guarded by parallel tests (`formLogic.test.ts` vs `test_validation.py`) with no
  shared fixtures or a generated cross-check.
- **Mapping runs outside the submit transaction and without `on_commit`.**
  `views.py::PublicFormView.post` calls `map_response` AFTER `submit_response`'s
  `atomic()` commits. If `register_school` raises, the `FormResponse` already
  exists but is unmapped, and the client sees a 500 → on retry the same
  `event_id` returns the existing response and `map_response` retries (it is
  skip-if-mapped, so it re-attempts mapping for the still-unmapped row). Net:
  response and team creation are NOT atomic together.
- **`response_count` drift.** Freeze logic keys off `response_count > 0`; an
  out-of-band delete or a failed mapping does not decrement it.
- **Group fields un-validated** (stored as-is) — `team_registration` rosters via
  `group` get no per-player coercion; malformed player dicts silently skipped in
  `_map_team_registration`.
- **`max_responses`/`one_response_per_email`** exist on the model/settings but are
  not enforced in `submit_response`.
- **`closes_at` race:** `is_open` checked at GET and again at POST, but a form can
  close between render and submit (handled — 400 `registration_closed`).
- **Number coercion** (`fields.py::_number`) may return `float` for client strings;
  branching `gt`/`lt` casts both sides, so it is tolerant, but stored types vary.

## Restructuring seams (clean re-architecture points)
1. **Single source of branching truth.** Generate one evaluator from a shared spec
   (JSON-schema'd rule grammar) and emit both TS and Python, or expose a
   `/api/forms/<id>/eval` to fold client logic into a tested server kernel — kills
   parity drift. Today the contract is prose in two file headers.
2. **Unify submit + map into one transaction** with `transaction.on_commit` for
   side effects (notifications), mirroring the match-events pattern, so
   `FormResponse` + `Team/Player` are all-or-nothing and post-commit work is
   explicit.
3. **Field registry as the only type authority.** `fields.py::_HANDLERS` already
   centralizes coercion; extend it to own `group` deep validation and to drive the
   builder via `FieldTypesView` `params_schema` (today `field-types` returns only
   `{type, has_options}`; the builder hardcodes widgets).
4. **Promote + bindings as declarative mapping.** Replace `promote` + ad-hoc
   `settings.bindings` parsing in `_map_team_registration` with one declarative
   schema→entity binding spec validated at publish.
5. **Lifecycle/quota guard** centralization: enforce `max_responses`,
   `one_response_per_email`, and freeze in one gate alongside `is_open`.
