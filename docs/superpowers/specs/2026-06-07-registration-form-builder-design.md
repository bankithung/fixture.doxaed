# Registration Form Builder (Flexible Form Engine) — Design

**Status:** Approved (full scope), 2026-06-07. Owner chose: **Both stages, unified** on a **new generic forms app**, **all field types** (incl. file upload, rating, address), **full section branching**.

**Goal:** Let a tournament admin build a fully flexible, Google-Forms-style (and beyond) registration form — arbitrary fields, choices, checkboxes, conditional/branching sections, email + phone capture, a close date, and a confirmation notice — share it via a public link, collect responses, review/export them, and hand accepted registrants off to the next stage. One **data-driven form engine** (FET-style: a schema *interpreter*, not hardcoded forms) powers **both** registration stages.

**Implements** PRD invariants #1 (UUID v7), #2 (multi-tenancy), #3 (idempotent writes), #5 (append-only audit), #7 (freeze philosophy), #13 (i18n + a11y), #14 (UTC/TZ), #15 (session auth + AllowAny public). **Reuses** `apps/teams/services/registration.py::register_school` for Stage-2 mapping (no rewrite → existing ~448 backend tests stay green).

## 0. The two-stage funnel (domain framing)

| | **Stage 1 — Organization registration** | **Stage 2 — Team / player registration** |
|---|---|---|
| Who | A school/college/org declares intent | The accepted org submits its roster |
| Form `purpose` | `organization_registration` | `team_registration` |
| Identity | Public link, no account; email/phone captured | Per-org tokenized link |
| Output | Accepted `FormResponse` = participant record | `Team` + `Player` rows (via `register_school`) feeding fixtures |
| Trigger to next | Admin accepts → mint + email Stage-2 link | — |

The existing `RegistrationLink` + `SchoolRegistrationSerializer` + `RegistrationFormPage.tsx` are a **hardcoded Stage-2 form**. The new engine generalizes intake; the existing teams service is reused as the Stage-2 mapping target. The legacy `/register/{token}` path stays working during the build (back-compat) and is superseded by the generic renderer in Increment 7.

---

## 1. Data model (`backend/apps/forms/models.py`) — new app

All models: UUID v7 PK (`apps.accounts.models.uuid7`), `organization` FK (invariant #2), `created_at`/`updated_at`, soft-delete `deleted_at` where mutable.

### 1a. `Form` — the form definition
```python
id            UUIDField(pk, default=uuid7)
organization  FK(organizations.Organization, CASCADE, related_name="forms")
tournament    FK(tournaments.Tournament, CASCADE, related_name="forms")
slug          CharField(63)
title         CharField(200)
description   TextField(blank)
purpose       CharField(choices: organization_registration | team_registration | generic)
schema        JSONField(default=dict)          # the form definition — see §2
status        CharField(choices: draft | open | closed, default=draft, db_index)
opens_at      DateTimeField(null)              # UTC; rendered in tournament TZ (invariant #14)
closes_at     DateTimeField(null)              # registration close date
version       PositiveIntegerField(default=1)  # bumped on destructive edits after responses exist
max_responses PositiveIntegerField(null)
response_count PositiveIntegerField(default=0)
confirmation_message TextField(blank)          # "Player names & documents due 20 Aug 2026."
settings      JSONField(default=dict)          # {one_response_per_email, require_email, ...}
created_by    FK(user, SET_NULL, null)
```
Constraints: `unique(tournament, slug) where deleted_at is null`. Index `(tournament, status)`.

### 1b. `FormResponse` — one submission
```python
id            UUIDField(pk, default=uuid7)
form          FK(Form, CASCADE, related_name="responses")
organization  FK(Organization, CASCADE)        # denorm from form for scope/index
tournament    FK(Tournament, CASCADE)
answers       JSONField(default=dict)           # {field_key: value}; value shape per field type
form_version  PositiveIntegerField              # schema version answered (response fidelity)
respondent_email CharField(254, blank, db_index) # promoted from the role=email field
respondent_phone CharField(32, blank, db_index)  # promoted from role=phone
respondent_name  CharField(200, blank)           # promoted from role=name
title         CharField(200, blank, db_index)    # promoted from role=title (e.g. school name)
status        CharField(choices: submitted | accepted | rejected | waitlisted, default=submitted, db_index)
event_id      UUIDField(null)                    # idempotency (invariant #3)
submitted_via FK(FormShareLink, SET_NULL, null)
mapped_entities JSONField(default=dict)          # {team_ids:[...], person_ids:[...], ...} after mapping
created_at    DateTimeField(auto_now_add)
```
Constraints: `unique(form, event_id) where event_id not null`; optional `unique(form, respondent_email) where settings.one_response_per_email and deleted_at is null` (enforced in service, not DB, since it's settings-driven). Indexes `(form, status)`, `(form, created_at)`.

### 1c. `FormShareLink` — public access token (generalizes `RegistrationLink`)
```python
id            UUIDField(pk, default=uuid7)
organization  FK(Organization, CASCADE)
form          FK(Form, CASCADE, related_name="share_links")
token_hash    CharField(128, db_index)          # sha256(plaintext); plaintext shown once
label         CharField(120, blank)
is_active     BooleanField(default=True)
expires_at    DateTimeField(null)
max_submissions PositiveIntegerField(null)
submission_count PositiveIntegerField(default=0)
bound_entity  JSONField(default=dict)           # Stage-2: {team_id} / {participant_response_id} to bind/prefill
prefill       JSONField(default=dict)           # pre-filled answers for the recipient
created_by    FK(user, SET_NULL, null)
created_at    DateTimeField(auto_now_add)
```
Token pattern mirrors `create_registration_link`/`resolve_registration_link` (sha256, active+unexpired+under-cap).

### 1d. `FormFileUpload` — uploaded-file metadata
```python
id            UUIDField(pk, default=uuid7)
organization  FK(Organization, CASCADE)
form          FK(Form, CASCADE)
response      FK(FormResponse, SET_NULL, null)  # null until the submit that claims it
field_key     CharField(80)
upload_ref    UUIDField(default=uuid7, db_index) # opaque ref returned to client pre-submit
file          FileField(upload_to=form-scoped path)
original_name CharField(255)
content_type  CharField(127)
size          PositiveIntegerField
created_at    DateTimeField(auto_now_add)
```
Security: server-side allowed content-type + max-size validation; stored outside web root; admin download via short-lived signed URL. **Follow-up:** virus scanning (noted, not v1).

---

## 2. The form schema (JSONB, `Form.schema`) — interpreted at runtime

```jsonc
{
  "version": 1,
  "sections": [
    {
      "key": "school",                       // unique within form
      "title": "School details",
      "description": "",
      "visibility": null,                    // null = always; else a rule (see §3)
      "next": "competition",                 // default next section (branching)
      "fields": [
        { "key": "school_name", "type": "short_text", "label": "School name", "required": true, "role": "title" },
        { "key": "contact",     "type": "phone",      "label": "Contact number", "required": true, "role": "phone" },
        { "key": "your_name",   "type": "short_text", "label": "Your name", "required": true, "role": "name" },
        { "key": "email",       "type": "email",      "label": "Email", "required": true, "role": "email" }
      ]
    },
    {
      "key": "competition", "title": "Competition selection",
      "fields": [
        { "key": "competition", "type": "single_choice", "label": "Which competition will your school participate in?",
          "required": true,
          "options": [
            { "value": "sepak", "label": "Sepak Takraw only", "goto": "sepak" },
            { "value": "tt",    "label": "Table Tennis only", "goto": "tt" },
            { "value": "both",  "label": "Both",              "goto": "sepak" },
            { "value": "none",  "label": "Not participating", "goto": "confirm" }
          ] }
      ]
    },
    {
      "key": "sepak", "title": "Sepak Takraw categories",
      "visibility": { "field": "competition", "op": "in", "value": ["sepak", "both"] },
      "fields": [
        { "key": "sepak_cats", "type": "multi_choice", "label": "Categories", "required": true,
          "options": [ { "value": "u14b", "label": "U-14 Boys" }, { "value": "u14g", "label": "U-14 Girls" } ] }
      ]
    },
    {
      "key": "tt", "title": "Table Tennis categories",
      "visibility": { "field": "competition", "op": "in", "value": ["tt", "both"] },
      "fields": [
        { "key": "tt_cats", "type": "multi_choice", "label": "Categories", "required": true,
          "options": [
            { "value": "u14bs", "label": "U-14 Boys Singles" }, { "value": "u14bd", "label": "U-14 Boys Doubles" },
            { "value": "u14gs", "label": "U-14 Girls Singles" }, { "value": "u14gd", "label": "U-14 Girls Doubles" },
            { "value": "a14bs", "label": "Above 14 Boys Singles" }, { "value": "a14bd", "label": "Above 14 Boys Doubles" },
            { "value": "a14gs", "label": "Above 14 Girls Singles" }, { "value": "a14gd", "label": "Above 14 Girls Doubles" }
          ] }
      ]
    },
    {
      "key": "confirm", "title": "Final confirmation",
      "fields": [
        { "key": "notice", "type": "section_text",
          "label": "Player names and documents must be submitted by 20 August 2026." },
        { "key": "agree",  "type": "single_choice", "label": "I understand", "required": true,
          "options": [ { "value": "yes", "label": "I agree" } ] }
      ]
    }
  ]
}
```

### 2a. Field-type catalog (v1)
`short_text`, `long_text`, `single_choice`, `multi_choice`, `dropdown`, `email`, `phone`, `number`, `date`, `time`, `rating` (max stars), `linear_scale` (min/max/labels), `address` (line1/line2/city/district/state/pincode), `file_upload` (multiple?, accept[], max_mb), `section_text` (display-only), `yes_no`, **`group`** (repeatable subform: `fields[]` + `min`/`max` repeats — the mechanism that lets a team→players roster be a form).

Each field type maps to a handler in a **field registry** (`apps/forms/services/fields.py`) exposing `coerce(value)`, `validate(value, field)`, and JSON-serializable `answer` shape. Adding a type = one registry entry, **no migration**.

### 2b. Common field keys
`key` (unique within form), `type`, `label`, `help` (opt), `required` (bool), `role` (opt: `title|email|phone|name` → promotes answer to the matching `FormResponse` column), `options[]` (for choice types: `{value,label,goto?}`), `validation` (opt: `{min,max,minLength,maxLength,pattern,maxSelections}`), `visibility` (field-level rule, §3).

---

## 3. Branching & visibility (covers "full section branching")

Two mechanisms, both evaluated **client-side for UX and re-evaluated server-side for integrity**:

1. **Visibility rule** (`section.visibility` or `field.visibility`): `{ "field": <key>, "op": <op>, "value": <v> }`, `op ∈ equals | not_equals | in | includes | gt | lt | answered`. Hidden sections/fields are skipped.
2. **Page jump** (`option.goto` → section key; `section.next` → default): Google-Forms "go to section based on answer." Resolution order: the chosen option's `goto`, else `section.next`, else next in array; `goto: "_end"` finishes.

**Server-side enforcement (security):** `apps/forms/services/validation.py::validate_answers(form, answers)` walks the schema from the first section, follows branching using the submitted answers, and enforces `required`/type/validation **only on reached + visible fields**. Answers to unreachable/hidden fields are dropped (not stored), so branching can't be bypassed by POSTing hidden values. Cycle-guard on `goto`.

---

## 4. Lifecycle, close date, freeze (invariant #7 philosophy)

- `draft`: fully editable. `POST …:publish` → `status=open` (sets `opens_at=now` if unset).
- Public access allowed only when `status=open` **and** `opens_at ≤ now < closes_at` (when set). Otherwise the public GET returns a `closed` payload → renderer shows "Registration closed."
- `POST …:close` → `status=closed`. Admin may reopen (move `closes_at` / re-publish).
- **Schema-edit freeze after first response:** once `response_count > 0`, edits are restricted to **safe/additive** (add optional field, edit labels/help/options-labels, extend `closes_at`). Destructive edits (delete field with answers, change a field's type, remove an option in use) **bump `version`**; existing responses keep their `form_version`. Enforced in the builder PATCH serializer with a clear diff/warning (mirrors the rule-freeze + conflict-warning pattern, invariants #7/#10).

---

## 5. Builder API (admin) — `backend/apps/forms/views.py` + `urls.py`

All `IsAuthenticated` + scoped via `accessible_tournaments` (404 no-leak) + `can_manage_tournament` + new module gate (§8). Idempotent writes take `event_id` (invariant #3). All mutations `emit_audit`.

- `GET  /api/tournaments/<id>/forms/` → list forms for a tournament.
- `POST /api/tournaments/<id>/forms/` → create (title, purpose, optional starter schema).
- `GET/PATCH/DELETE /api/forms/<form_id>/` → read/update (schema validated)/soft-delete.
- `POST /api/forms/<form_id>:publish/` · `:close/` · `:duplicate/`.
- `GET  /api/forms/<form_id>/responses/` → paginated; `?export=csv|xlsx` → file download.
- `PATCH /api/forms/<form_id>/responses/<rid>/` → set status (accept/reject/waitlist).
- `POST /api/forms/<form_id>/share-links/` → mint a `FormShareLink` (Stage-2 targeted), returns plaintext token once.
- `POST /api/forms/<form_id>:send-stage2/` → for accepted responses, mint links + notify via `apps/notifications` (the Stage-1→Stage-2 bridge).
- `GET  /api/forms/field-types/` → static catalog `[{type,label,has_options,params_schema}]` so the builder renders without hardcoding (mirrors `constraint-types`).

Serializers in `apps/forms/serializers.py`: `FormSerializer`, `FormSchemaSerializer` (deep validation: unique keys, valid types, valid `goto`/visibility targets, option shape), `FormResponseSerializer`.

---

## 6. Public submission API — `AllowAny` + throttled

Throttle: reuse the `apps/teams/throttling.py::RegistrationRateThrottle` pattern (per-IP). No account needed.

- `GET  /api/forms/<form_id>/public/` **or** `GET /api/r/<token>/` → if open & in-window: `{ form: {title, description, schema, confirmation_message}, tournament_name }`; else `{ closed: true, reason }`.
- `POST /api/forms/<form_id>/public/` (or `/api/r/<token>/`) body `{ answers, event_id, upload_refs? }` → `validate_answers` (branching-aware), idempotency replay on `event_id`, store `FormResponse` (promote role columns), claim any `FormFileUpload` rows, run entity mapping (§7), increment counts, `emit_audit`, return `{ response_id, message: confirmation_message }`.
- `POST /api/forms/<form_id>/uploads/` → multipart; validates type/size; returns `{ upload_ref }` to include in the final submit.

---

## 7. Entity mapping — `apps/forms/services/mapping.py`

On submit (or on accept, per `settings`), dispatch by `Form.purpose`:
- `generic`: no mapping; the `FormResponse` is the record.
- `organization_registration`: `FormResponse` **is** the participant record; accepting it enables `:send-stage2`.
- `team_registration`: read field **bindings** (`form.settings.bindings` mapping schema keys/groups → `register_school` params: school_name, teams[].name, players[].full_name/jersey_no/position/dob_year) and call the **existing** `register_school(...)`. Store resulting ids in `mapped_entities`. Idempotency shared via `event_id`.

---

## 8. RBAC / module (invariant #12)

Add a `forms` (label: "Registration forms") module to the 22-module catalog (`backend/apps/permissions/fixtures/modules.json` → becomes 23) with sensible role defaults (admin/co-organizer: manage; others: none/ view as appropriate). Builder endpoints gate on `HasModule("forms")` + `can_manage_tournament`. Public endpoints are module-exempt (`AllowAny`). Add the matching nav item via `computeNavItems.ts`.

---

## 9. Frontend (`frontend/src/features/forms/`)

Design-system only (tokens, `components/ui/Select`, `dialog`, `toast`, Inter/`font-tabular`, `cn`, `lib/routes.ts`); `dnd-kit` (already a dep) for reordering; TanStack Query + Zustand.

- **Builder** `FormBuilderPage.tsx`: left **field palette** → center **canvas** (sections + fields, drag-reorder) → right **inspector** (type, label, required, options, visibility rule, option `goto`). Live **preview** toggle. Branching editor. A Zustand store holds the working schema; saves PATCH the form.
- **Public renderer** `PublicFormPage.tsx`: standalone (outside `AppShell`, reuse `PublicShell`); fetches schema, renders fields by type, evaluates branching live, handles file upload, shows `confirmation_message`, submits with a minted `event_id`. Route `/f/:formId` and `/r/:token`.
- **Responses dashboard** `ResponsesPage.tsx`: table (promoted columns + status), row → answer detail drawer, accept/reject, CSV/XLSX export, "Send Stage-2 links" action. Mobile → stacked cards via `useBreakpoint`.
- `frontend/src/api/forms.ts`: typed client; regenerate `src/types` from backend schema (`npm run gen:types`).

---

## 10. Invariants honored

UUID v7 ✓ · org FK + cross-org 404-no-leak isolation tests ✓ · idempotent `event_id` ✓ · append-only audit on create/submit/accept/mapping ✓ · `t()`/`gettext` i18n + WCAG AA on public + admin ✓ · UTC storage / tournament-TZ render of `opens_at`/`closes_at` ✓ · session auth (admin) + AllowAny-throttled (public) ✓ · RBAC module + verb both gate the builder ✓ · data-driven JSONB schema interpreted at runtime (consistent with rules/constraints) ✓.

---

## 11. Testing strategy (tests-first for non-trivial logic)

**Backend (pytest):**
- Field registry: coerce/validate per type (incl. address, group, file_upload, rating, linear_scale).
- `validate_answers`: branching reachability, required-only-for-visible, hidden-answer drop, `maxSelections`, cycle-guard.
- Lifecycle: publish/close, in-window vs closed public access, schema-edit freeze (safe vs destructive → version bump).
- Idempotency replay; multi-tenancy isolation (every endpoint); throttle.
- File upload limits/type; claim-on-submit.
- Mapping: `team_registration` → `register_school` (reuse), `mapped_entities` recorded; `organization_registration` participant + `:send-stage2`.
- Responses export (csv/xlsx) shape.

**Frontend (vitest):** builder store (add/reorder/branch/visibility), renderer (show/hide, page jump, validation, file upload), public submit happy + closed paths, responses table actions. `type-check` clean.

---

## 12. Increments (commit each, green before moving on)

1. **App + models + migrations** — `Form`, `FormResponse`, `FormShareLink`, `FormFileUpload`; admin reg; model-constraint + multi-tenancy tests.
2. **Schema + validation service** — field registry, `validate_schema`, branching-aware `validate_answers`; tests-first.
3. **Builder API** — CRUD + `:publish`/`:close`/`:duplicate` + `field-types` + module `forms`; scoped/audited; tests.
4. **Public submission API** — GET/POST public + token, throttle, idempotency, uploads, audit; tests.
5. **Entity mapping** — purpose dispatch; `team_registration` → `register_school`; Stage-1 participant + `:send-stage2`; tests.
6. **Builder UI** — palette/canvas/inspector/branching/preview (`dnd-kit`); vitest.
7. **Public renderer UI** — standalone page, live branching, uploads, submit; vitest; supersedes legacy `/register` path.
8. **Responses dashboard + export + Stage-2 send** — table, accept/reject, CSV/XLSX, mint+notify links; tests.

---

## 13. Open questions / deferred (follow-ups, not v1 blockers)

- **Virus scanning** of uploaded files (clamav or provider) — store + flag; scan async later.
- **XLSX** export may need a lib (`openpyxl`); CSV ships first if we want zero new deps.
- **Payment/registration fee** on submit — out of scope; revisit if needed.
- **Multi-language form content** (admin authoring strings in NL languages) — UI is i18n'd; per-form translated content is a later enhancement.
- **Legacy `/register/{token}` + `register_school` direct path** retired only after Increment 7 proves parity.
