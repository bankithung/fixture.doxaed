# Stage 1 → Stage 2 Registration Handoff — Design

**Date:** 2026-06-09
**Status:** Draft v1 (brainstormed; ready to plan/execute)
**Owner decisions captured:** (Q1) Both entry modes — public dropdown link **and** per-institution pre-bound links; (Q2) prefill = institution **identity + contact + category**; (Q3) on advance, **auto-create a DRAFT** team form for the admin to review & publish.

## 1. Problem

The owner's intended flow:

1. Any user signs up and creates a tournament.
2. **Stage 1 — Institution registration:** admin builds a form, shares the link (or admin-adds institutions directly).
3. On advancing to **Stage 2 — Team registration:** the Stage-1 form must **stop accepting submissions** — its public link shows "Registration closed" and offers a **read-only directory** of registered institutions.
4. On entering Stage 2, a **team-registration form is auto-derived from the org form and prefilled** with the registered institutions, so the admin just reviews/edits and publishes.
5. Registrants then submit team registrations.

Everything must be **dynamic/declarative, not hardcoded.**

## 2. Current reality (grounded in code)

~80% exists. The gaps + one root-cause bug:

| Capability | File(s) | Status |
|---|---|---|
| Stage form auto-close on forward advance / reopen on backward | `apps/tournaments/services/state.py` `_close_stage_form`/`_reopen_stage_form`/`_stage_form` | FULL — **but keys off `Form.stage`** |
| Form create (Forms page "New form") | `FormsListPage` dialog → `TournamentFormsView.post` → `create_form` (`stage="" ` default) | **🐛 sends no `stage`** |
| Closed public form → "Registration closed" | `PublicFormPage.tsx` (`closed` branch), `PublicFormView` (`{closed:true}`) | FULL — no directory link |
| Read-only institutions directory (works open+closed) | `PublicDirectoryPage.tsx`, `PublicInstitutionDirectoryView` `/api/forms/{id}/directory/` | FULL — not surfaced from closed page |
| Team form auto-derived from org form + live "Select your institution" dropdown + per-category sections | `apps/forms/services/generation.py` `generate_team_form_template` / `build_team_form_schema`; `GenerateTeamFormView` | FULL — **manual-only** |
| Data-bound fields (`data_source: institution_list`) live-populated | `PublicFormView._resolve_data_sources` | FULL |
| org-reg response → Institution (`source_response_id` back-ref) | `apps/forms/services/mapping.py` `_map_organization_registration`; `apps/teams/services/registration.py` `get_or_create_institution` | FULL |
| Per-institution share links (`bound_entity`, `prefill`) + send-stage2 mint | `apps/forms/models.py` `FormShareLink`; `FormSendStage2View`; `apps/forms/services/links.py` | PARTIAL — links minted, **binding/prefill never applied** on render/submit; email is a TODO |

### Root cause of "the form doesn't stop"

`_close_stage_form` locates the form via `_stage_form()` which filters `Form.objects.filter(..., stage=<stage>)`. But the **"New form" dialog posts only `{title, purpose}`** (no `stage`), and `create_form` defaults `stage=""`. So registration forms built from the Forms page are **purpose-bound but not stage-bound**, and the auto-close never sees them. The owner's "Anpsa" has two such Open forms — neither will close on advance. (Also, `_stage_form` returns only `.first()`, so even correctly-bound multiples wouldn't all close.)

## 3. Design principles

1. **One canonical map** drives everything (no per-form hardcoding):
   `REGISTRATION_STAGE_PURPOSE = { "org_registration": "organization_registration", "team_registration": "team_registration" }` (+ its inverse). Single source of truth in `apps/forms/constants.py` (or `apps/tournaments`), imported by create/close/generate.
2. **Reuse existing engines** (stage machine, generation, data-bound fields, share links, directory). Add wiring, not parallel systems.
3. **Idempotent & reversible** — auto-create never duplicates; reopen restores prior state; re-advance is a no-op.
4. **Declarative schema** — the team form remains JSONB schema + `settings.bindings`; institution data flows via `data_source` + share-link `prefill`, never baked into code.

## 4. Solution

### WS-A — Fix the root-cause bug (forms not closing)  ⟵ ship first

1. **Bind stage from purpose at creation.** In `create_form`, when `stage` is blank and `purpose ∈ REGISTRATION_STAGE_PURPOSE.values`, set `stage = inverse_map[purpose]`. Explicit `stage` still wins. Now every org/team registration form is stage-bound regardless of which UI created it.
2. **Close ALL matching open forms on advance.** Replace `_stage_form`-returns-first with a queryset: on leaving `stage S`, close every `Form` with `status=OPEN` and (`stage == S` **OR** (`stage == "" AND purpose == map[S]`)). Catches legacy blank-stage forms and multiple forms.
3. **Backfill migration** — set `stage` from `purpose` for existing blank-stage registration forms (fixes Anpsa's current forms). Data migration, not schema.
4. Tests: advancing org→team closes a blank-stage org form, a correctly-bound one, and **multiple** open org forms; reopening reopens; generic (purpose=generic, stage="") forms are never touched.

### WS-B — Closed form surfaces the directory

1. `PublicFormView` closed payload adds `has_directory` (true when `purpose == organization_registration`) and `form_id`.
2. `PublicFormPage` closed branch: render a **"View registered institutions"** button → `/f/{id}/directory` when `has_directory`.
3. Test: closed org form payload carries `has_directory:true`; FE renders the link.

### WS-C — Auto-create the team DRAFT on entering Stage 2

1. In `transition_tournament` (forward into `team_registration`), `transaction.on_commit` → if **no** team-registration form exists (by stage OR purpose, non-deleted), call `generate_team_form_template(...)` → DRAFT. Idempotent (skip if exists).
2. Stays DRAFT — admin reviews & publishes (Q3). Reversible: going back then forward again does not duplicate.
3. Stage-advance preview/warning copy: "Closes the institution-registration form and creates a team-registration draft."
4. Tests: entering team_registration creates exactly one draft; re-entering is a no-op; respects an admin-deleted/manual form.

### WS-D — Prefill + per-institution scoping (Q1 "Both", Q2 identity+contact+category)

The team form is one schema; two entry modes feed it.

**Mode 1 — public link + dropdown (extend existing):**
- `institution_id` data-bound dropdown already lists current registrants.
- Enhance `_resolve_data_sources` to attach a per-option `prefill` map (contact + category derived from each Institution + its `source_response_id` answers). The renderer applies prefill into the matching fields when an institution is selected (editable). Keeps it dynamic.

**Mode 2 — per-institution pre-bound links (finish the partial):**
- At `send-stage2` (and a new "share links" action), compute each institution's prefill (identity + contact + category) and store it in `FormShareLink.prefill`, plus `bound_entity={institution_id, participant_response_id}`.
- `PublicFormView` token path: when a share link carries `bound_entity`, **pre-select and lock** the institution field and merge `prefill` into the returned payload's initial answers.
- `publicGetByToken` renderer (`PublicFormPage` token mode): apply initial answers; render the bound institution as fixed (read-only chip), contact/category prefilled & editable.
- On submit, stamp the response's institution from `bound_entity` (authoritative), so mapping is correct regardless of edits.
- Tests: token render returns locked institution + prefilled contact/category; submit maps to the bound institution; max_submissions enforced.

### WS-E — Admin UI

1. **Stage 2 entry**: Forms page / Teams tab shows the auto-created **draft** with "Review & publish"; keep an idempotent "Regenerate from institutions" action.
2. **Per-institution links panel**: list registered institutions + each unique link (copy; email when WS-F lands), from send-stage2.
3. Advance confirmation copy (WS-C #3).
4. Vitest + a visual check.

### WS-F (optional) — Email delivery

Wire `send-stage2`'s per-link emails through `apps/notifications` (currently a `TODO(notify)`).

## 5. Phasing & risk

- **WS-A** is the actual bug and is self-contained + low-risk → ship first (incl. backfill).
- **WS-B** tiny, independent.
- **WS-C** depends on A (stage binding) + existing generation.
- **WS-D** the largest; builds on `FormShareLink` + data-bound fields.
- **WS-E** UI glue. **WS-F** optional.

Each WS: tests + `type-check` green before commit; deploy per the repo's live workflow.

## 6. Open questions (deferred)

- Should accepting an institution be required before it appears in the team dropdown / gets a link? (Today the directory + data-bound list exclude `withdrawn`/`rejected`; team links are `ACCEPTED`-only.) Confirm whether "registered" == "accepted".
- Multiple categories per institution: one team form covers all via per-category sections; confirm a school registering for 2 sports uses one link with both category sections (current generation supports this).
