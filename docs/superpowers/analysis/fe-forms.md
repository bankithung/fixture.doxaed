# Subsystem analysis — Frontend · Forms (builder + public + responses)

## Purpose

The forms subsystem is the registration/intake layer of the Fixture Platform. It gives a
tournament organizer a Google-Forms-style **builder** for data-driven registration forms
(sections + typed fields + branching/visibility logic), a **public wizard** that schools
fill out via a shared link with no account, and a **responses dashboard** (review,
status workflow, CSV export, Stage-2 link minting). The defining architectural property is
that the schema is interpreted, not hardcoded, and the **same branching evaluator runs on
the client and the server** so the two never disagree about which fields are reachable.

The schema lives in `Form.schema` JSONB on the backend (`apps/forms`); the frontend treats
it as the single source of truth for both authoring and rendering.

## File-by-file roles

All paths under `frontend/src/features/forms/` unless noted.

- `types.ts` — the schema contract: `FieldType` (17 types), `VisibilityOp` (7 ops),
  `Visibility`, `Option` (with `goto`), `Validation`, `FieldRole`, `Field` (recursive via
  `fields?` for `group`), `Section` (with `visibility`/`next`), `FormSchema`
  (`{version, sections}`), plus DTOs `FormSummary`, `FormResponseRow`, `ResponseStatus`,
  `FormPurpose`, `FormStatus`. The file header explicitly states it MUST stay aligned with
  `apps/forms/constants.py` and `apps/forms/services/validation.py`.
- `builderStore.ts` — Zustand store (`useBuilderStore`) holding the working `schema`,
  `selected` (sectionKey+fieldKey for the inspector), and `activeSectionKey` (palette
  target). All schema mutations are pure, immutable updates via the `mapSection` helper.
  Generates client-only keys via `uid()` (`prefix_<base36 time>_<base36 counter>`).
- `FormBuilderPage.tsx` — route container `/tournaments/:id/forms/:formId/edit`. Loads the
  form (TanStack Query), hydrates the store once per form id, owns **debounced autosave**,
  the header actions (Save/Preview/Responses/Publish/Close), and the collapsible
  `SettingsPanel` (title/closes_at/confirmation).
- `FormCanvas.tsx` — the center column. `SectionCard` + `FieldCard` render the live tree.
  `FieldCard` is the inline-edit card: collapsed = read-only preview; selected = expanded
  editor (label Input + type Select + `FieldEditor` + required/reorder/delete footer).
- `FieldEditor.tsx` — the body of an expanded card: choice options editor, help text,
  scale min/max, multi-select max, role mapping (`Maps to`), and `BranchingEditor`.
- `FieldPalette.tsx` — right-rail clickable field-type chips; clicking adds the type to
  `activeSectionKey` (falls back to first section).
- `fieldRenderers.tsx` — `FieldRenderer`, one switch per `FieldType`, shared by **all three**
  render surfaces (builder preview, FormPreview, FormPreviewDialog, PublicFormPage). Pure
  presentation; no branching, no fetching. Handles file upload via injected `onUpload`.
- `formLogic.ts` (`@/lib/`) — the **pure branching evaluator**: `isVisible`,
  `nextSectionKey`, `reachableSections`, `reachableFieldKeys`, `validateRequired`, `isEmpty`.
  This is the parity-critical module.
- `FormPreview.tsx` — inline live preview (all reachable sections at once, stateful answers).
- `FormPreviewDialog.tsx` — full-screen modal wizard preview (Next/Back), opened from the
  builder header. Nothing saved.
- `PublicFormPage.tsx` — the standalone public wizard (`/f/:formId` and `/r/:token`),
  rendered outside the AppShell via `PublicShell`. Owns answers, upload refs, step index,
  errors, the idempotency `event_id`, submit, and terminal states (closed/done/not-found).
- `ResponsesPage.tsx` — organizer dashboard `/tournaments/:id/forms/:formId/responses`:
  table/mobile cards, status filter tabs, optimistic Accept/Reject/Waitlist, detail dialog,
  CSV export, and the `SendStage2Dialog`.
- `FormsListPage.tsx` — per-tournament list `/tournaments/:id/forms`; create dialog,
  status badges, copy-public-link, open-public.
- `VisibilityRuleEditor.tsx` — authoring control for one `Visibility` rule (field/section).
- `BranchingEditor.tsx` — per-field branching: option `goto`, section `next`, field
  visibility (delegates to `VisibilityRuleEditor`).
- `visibility.ts` — `priorFields(sections, sectionKey)`: fields declared before a section,
  the only valid visibility triggers. Split out so React Fast Refresh stays happy.
- `api/forms.ts` (`@/api/`) — typed client mirroring `apps/forms/urls.py` exactly.

## Data model (client-side schema)

`FormSchema = { version: number, sections: Section[] }`.
`Section = { key, title, description?, visibility?, next?, fields: Field[] }`.
`Field = { key, type, label, help?, required?, role?, options?, validation?, visibility?, fields? }`.
`Option = { value, label, goto? }` — `goto` drives per-answer section jumps.
`Visibility = { field, op, value? }` — `op` ∈ equals/not_equals/in/includes/gt/lt/answered.

Keys are opaque strings. Builder-created keys come from `uid()`; the renderer/evaluator
identify everything by `field.key` and `section.key`. `role` promotes an answer onto a
`FormResponse` column server-side (title/email/phone/name). `value` for `in` is stored as
an **array**; `includes` matches a scalar `target` inside an array `val`.

`FormResponseRow` carries `answers` (key→value), promoted `respondent_email/phone/name`,
`title`, `status` (submitted/accepted/rejected/waitlisted), `mapped_entities`, `created_at`.

## Core algorithms (file:function) with step-by-step logic

### `formLogic.ts::reachableSections(schema, answers)` — wizard path
1. Start `cur = sections[0].key`; keep a `seen` set as a cycle guard.
2. Loop while `cur` is set, not `"_end"`, not already seen.
3. Find the section by key; if `isVisible(sec.visibility, answers)` push it to output.
4. Compute the next key via `nextSectionKey(sec, answers)` (option `goto`, else `section.next`);
   if undefined, fall through to the **next section in document order** (`sections[idx+1]`).
5. Return the ordered, visible, reachable sections.

Critical subtlety: traversal advances **from** a section even when that section is hidden
(it only gates whether it is *pushed*, not whether its `next`/`goto` is honoured). The
backend `_next_section` does the same, so they agree.

### `formLogic.ts::nextSectionKey(section, answers)`
Iterates `section.fields`; for the first `single_choice`/`dropdown` whose chosen option has
a `goto`, returns that `goto`; else `section.next`. Mirrors backend "first goto-bearing
single_choice/dropdown field wins."

### `formLogic.ts::isVisible(rule, answers)`
`null` rule → visible. Otherwise switch on `op`: `answered` → `!isEmpty(val)`; `equals`/`not_equals`
strict `===`/`!==`; `in` → `Array.isArray(target) && target.includes(val)`; `includes` →
`Array.isArray(val) && val.includes(target)`; `gt`/`lt` → numeric coercion via `Number(...)`.

### `formLogic.ts::validateRequired(schema, answers)`
Walks `reachableSections`, skips `DISPLAY_TYPES` (`section_text`) and hidden fields, and for
each `required` field that `isEmpty` records `errs[key] = "required"`. Used both per-step
(filtered to current section) and full-schema at submit.

### `FormBuilderPage.tsx::FormBuilderPage` — autosave
- One `useQuery(["form", formId])`; a `loadedId` ref ensures `load(schema)` runs once per
  distinct form id (avoids clobbering edits on refetch).
- A `dirtyRef` guard skips the **first** schema effect (the hydration render) so loading a
  form never triggers a save. Subsequent `schema` changes start a **1200 ms** `setTimeout`
  that fires `saveSchema.mutate()` (PATCH `{schema}`); the timeout is cleared on each change
  (debounce). Header shows "Saving…" / "All changes saved" from `saveSchema.isPending` /
  `savedAt`.
- Publish/Close mutate then invalidate `["form", formId]` + `["forms", id]`.

### `PublicFormPage.tsx::PublicFormPage` — submission
- Loads via token (`publicGetByToken`) or id (`publicGet`); `retry:false`.
- `sections = reachableSections(schema, answers)` recomputed every render (memoized on
  `[schema, answers]`), so picking an option immediately re-routes the wizard. `stepIndex`
  is clamped to the live section count.
- `onNext` validates ONLY the current section's required fields; `onSubmit` runs the
  **full-schema** `validateRequired`, and on server 400 maps `{errors}` to per-field errors
  and jumps to the first failing section.
- `event_id` is generated once (`newEventId`, stable across retries) for idempotency
  (invariant 3). Uploads are staged first (`publicUpload` → `upload_ref`), collected into
  `upload_refs`, and passed on submit so the backend claims the upload rows. Token-flow
  submit omits `upload_refs`.

### `ResponsesPage.tsx` — status workflow
- `RowStatusActions` uses optimistic update: `onMutate` cancels + snapshots + writes the new
  status into the `["form-responses", formId]` cache; `onError` rolls back; `onSettled`
  invalidates. `buildLabelMap` walks sections + nested `group.fields` to label answers in
  the detail dialog. CSV via `window.open(formsApi.csvUrl(formId))`. `SendStage2Dialog`
  filters this tournament's `team_registration` forms as targets and renders mintable links.

## API / endpoint surface (`api/forms.ts`, verified against `apps/forms/urls.py`)

Authenticated organizer endpoints:
- `list` GET `/api/tournaments/{tid}/forms/`; `create` POST same.
- `get` GET `/api/forms/{id}/`; `update` PATCH same (title/description/schema/opens_at/
  closes_at/confirmation_message/settings).
- `publish` POST `/api/forms/{id}:publish/`; `close` `:close/`; `duplicate` `:duplicate/`.
- `fieldTypes` GET `/api/forms/field-types/`.
- `responses` GET `/api/forms/{id}/responses/`; `setResponseStatus` PATCH
  `/api/forms/{id}/responses/{rid}/`.
- `sendStage2` POST `/api/forms/{id}:send-stage2/` `{target_form_id}` → `{sent, links[]}`.
- `csvUrl` → `/api/forms/{id}/responses/?export=csv` (opened directly, not via `api`).

Public (unauthenticated):
- `publicGet` GET `/api/forms/{id}/public/`; `publicSubmit` POST same `{answers,event_id,upload_refs?}`.
- `publicUpload` POST `/api/forms/{id}/uploads/` (multipart `file`+`field_key`) → `{upload_ref}`.
- `publicGetByToken` GET `/api/forms/r/{token}/`; `publicSubmitByToken` POST same.

The `:action` URL suffix style (colon, not slash segment) is a backend convention the client
must preserve. The `api` client (`api/client.ts`) sends `credentials:"include"` + CSRF on
unsafe verbs — public submits still flow through it, so CSRF/cookies apply to them too.

## Invariants that must be preserved

1. **Client/server branching parity.** `formLogic.ts` MUST match `apps/forms/services/validation.py`
   (`_visible`, `_next_section`, `validate_answers`) op-for-op and traversal-for-traversal.
   Confirmed identical today: 7 ops, goto→next→document-order, `section_text` display-only,
   emptiness = `None/""/[]/{}`, cycle guard. Any drift produces spurious 400s (field
   required server-side but hidden client-side, or vice-versa).
2. **Hidden answers are dropped server-side.** The backend only keeps reached+visible
   answers; the public test asserts the hidden TT branch never contributes `tt_cats`. The
   client must not assume all `answers` keys survive.
3. **Idempotent submit.** `event_id` generated once per page mount and reused on retry
   (invariant 3); never regenerate on resubmit.
4. **`in` stores an array; `includes` a scalar.** VisibilityRuleEditor + evaluator + backend
   all depend on this asymmetry (tested in `VisibilityRuleEditor.test.tsx`).
5. **`section_text` produces no answer and is excluded from required/label maps.**
6. **Visibility triggers are prior-only** (`priorFields`) — a field/section may only gate on
   answers asked earlier in document order.
7. **Autosave must not fire on hydration** (`dirtyRef` skip) and must debounce; load once per
   form id (`loadedId` ref).
8. **Keys are stable identifiers.** Reorder/duplicate/branch all key off `field.key`/`section.key`;
   regenerating keys would orphan `visibility.field` and `option.goto` references.
9. **i18n + a11y** (invariant 13): every visible string wrapped in `t()`, controls labelled,
   custom `Select` (no native `<select>`), `useBreakpoint` for table↔cards.

## Dependencies / coupling

**Outgoing (this subsystem → others):**
- `@/api/client` (fetch/CSRF/session), `@/types/api` (`ApiError`).
- UI kit: `components/ui/{button,input,label,Select,dialog,toast}`.
- `lib/{routes,tailwind(cn),t,useBreakpoint,eventId}`.
- `@/features/registration/PublicShell` (`PublicShell`, `Centered`) — public chrome reused
  from the registration feature; the public form does NOT own its outer shell.
- TanStack Query (server cache), Zustand (builder client state), react-router, lucide icons.
- Route registration in `App.tsx` (`/f/:formId`, `/r/:token` outside AppShell;
  builder/responses inside).

**Incoming (others → this subsystem):**
- `App.tsx` mounts all four pages.
- The schema contract in `types.ts` is the hard coupling to the backend `apps/forms` schema
  and (per `gen:types`) the broader DRF type generation pipeline; this set of types is
  hand-maintained rather than generated, which is itself a coupling risk.

## Tech debt / smells / duplication

- **Three near-duplicate wizard renderers.** `FormPreview`, `FormPreviewDialog`, and
  `PublicFormPage` each re-implement: `reachableSections` memo, step clamping, `isVisible`
  field filter, and field-mapping. The preview dialog and public page are ~80% the same Next/Back
  shell. A shared `<FormWizard schema answers .../>` would remove the dup.
- **Duplicated type-label tables.** `TYPE_LABEL` in `FormCanvas.tsx`, `DEFAULT_LABEL` in
  `builderStore.ts`, and the `PALETTE` labels in `FieldPalette.tsx` redefine the same 17
  type→label map three times; `CHOICE_TYPES`/`SCALE_TYPES` sets are redefined in
  `builderStore`, `FormCanvas`, `FieldEditor`, `VisibilityRuleEditor`. No single registry.
- **`group` is a stub.** `fieldRenderers.tsx` renders a group's children once ("Repeat-row UX
  is a follow-up"); backend stores the group answer as-is; `validateRequired`/backend do not
  deep-validate group children. Required-ness inside a group is unenforced.
- **`reachableSections` recomputed on every keystroke.** `answers` changes on each character;
  the memo dep is the whole `answers` object, so every input re-walks the schema. Fine at
  current sizes, but O(sections) per keystroke.
- **Per-step error UX is lossy.** `onNext`/`onBack` overwrite the entire `errors` object with
  the current section's errors only, discarding errors discovered for other sections.
- **`event_id` fallback is non-UUID.** `newEventId` falls back to `Date.now()-random` when
  Web Crypto is missing — not a real UUID; backend uniqueness still holds but type intent ("UUID")
  is violated in that path.
- **CSV export bypasses the typed client** (`window.open` of a raw URL) — no auth-error
  handling, no toast on failure, relies on the session cookie being sent by the browser.
- **`uid()` uses a module-global `counter`** — fine in a browser tab, but two builder tabs or
  SSR could in theory collide on `Date.now()` ties; keys are not cryptographically unique.
- **`FieldEditor` validation inputs** read `field.validation?.min ?? ""` but write `Number(...)`,
  so non-numeric typing silently coerces; no min<max or maxSelections sanity check.
- **`FieldCard` reorder is button-only** (up/down); `GripVertical` is decorative — no real DnD,
  despite the affordance.
- **Label maps and renderer both call `t(field.label)`** on user-authored runtime strings; `t()`
  on dynamic content is a no-op-ish pattern that bloats and can mislead future i18n extraction.

## Restructuring seams & risks

- **Seam 1 — extract a shared wizard.** Factor `FormWizard`/`useFormWizard(schema)` (answers,
  step, validation, navigation, branching) and have `FormPreviewDialog`/`PublicFormPage`/
  `FormPreview` consume it. Lowest-risk, highest-payoff dedup; covered by existing
  `FormPreview.test.tsx` + `PublicFormPage.test.tsx`.
- **Seam 2 — single field-type registry.** One table `{type → {label, icon, hasOptions,
  isChoice, isScale, defaultLabel, renderer}}` consumed by palette, canvas, editor, and
  renderer. Removes 3–4 duplicate maps/sets. Must keep types aligned with
  `apps/forms/constants.py::FIELD_TYPES`.
- **Seam 3 — co-locate the parity contract.** `formLogic.ts` and the backend `validation.py`
  are a paired contract maintained by hand. Risk: silent divergence. Mitigation: a shared
  golden fixture (e.g. the Sepak/TT schema already in tests) run against both client
  (`reachableSections`/`validateRequired`) and a backend endpoint to assert identical
  reachable-key sets. This is the single biggest correctness risk in any restructure.
- **Seam 4 — generate `types.ts` from the backend schema.** Today it is hand-mirrored; moving
  it into the `gen:types` pipeline (or a JSON Schema both sides import) closes a drift class.
  Risk: the schema is JSONB with semantic invariants DRF spectacular won't fully capture.
- **Seam 5 — builder store boundary.** `useBuilderStore` is a clean island; the only external
  coupling is `FormBuilderPage` hydrating it and reading `schema` for autosave. It can be
  refactored (e.g. add undo/redo, real DnD, multi-form) without touching renderers.
- **Risk — autosave + status transitions.** Backend rule-freeze semantics (PRD §5 /
  invariant 7) likely restrict schema edits once a form/tournament reaches certain states;
  the builder offers Save/Publish unconditionally and surfaces failures only via toast. A
  restructure should make freeze state explicit in the builder (disable, not just error).
- **Risk — public form lives outside AppShell** and depends on `features/registration/PublicShell`.
  Any move of registration's shell breaks the public form; this cross-feature dependency
  should be made explicit (shared `components/public/` shell).

## Ambiguities / things to verify

- Whether the backend enforces schema-edit freezing on `PATCH /api/forms/{id}/` (the FE
  assumes always-editable). Not confirmed from the FE files alone.
- `group` required-validation and repeat-row persistence are explicitly deferred ("v1");
  the exact backend storage shape for repeated groups is undefined here.
- `settings` (`Record<string, unknown>`) is opaque on the client — its keys/semantics are
  defined only backend-side and are not exercised by the builder UI.
