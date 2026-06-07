# Registration Form Builder — Frontend Implementation Plan (Increments 6–8)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Prerequisite:** the backend plan (`2026-06-07-registration-forms-backend.md`, Increments 1–5) is merged and `npm --prefix frontend run gen:types` has been run.

**Goal:** Build the admin form **builder** (drag-and-drop designer with branching logic + live preview), the **public form renderer** (standalone page that evaluates branching and submits), and the **responses dashboard** (review, export, Stage-2 send).

**Architecture:** A Zustand store holds the working schema in the builder; the public renderer and the builder preview share ONE pure branching-evaluation module (`lib/formLogic.ts`) that mirrors the backend `services/validation.py` so client and server agree on visibility/next-section. TanStack Query for all server calls through the existing `api` client. Design-system tokens + components only; `dnd-kit` for reordering.

**Tech Stack:** React 18, TypeScript, Vite, TanStack Query, Zustand, `@dnd-kit`, Tailwind (tokens), vitest. Reuses design-system primitives seen in `frontend/src/features/registration/RegistrationFormPage.tsx`: `@/components/ui/button`, `@/components/ui/input`, `@/components/ui/label`, `@/components/ui/Select`, `@/components/ui/dialog`, `@/components/ui/toast`, `@/lib/tailwind` (`cn`), `@/lib/t`, `@/lib/useBreakpoint`, `@/lib/eventId` (`newEventId`).

**Test command:**
```bash
npm --prefix frontend run test -- src/features/forms
npm --prefix frontend run type-check
```

---

## File Structure

```
frontend/src/
  api/forms.ts                         # typed client for all /api/forms endpoints
  lib/formLogic.ts                     # pure branching eval (mirrors backend validation.py)
  lib/__tests__/formLogic.test.ts
  features/forms/
    types.ts                           # FormSchema, Section, Field, Option, Visibility (hand-typed; aligns with gen'd src/types)
    builderStore.ts                    # Zustand: working schema + mutations
    __tests__/builderStore.test.ts
    FormBuilderPage.tsx                # route container: load/save/publish/close
    FieldPalette.tsx                   # left: draggable field-type chips
    FormCanvas.tsx                     # center: sections + fields, dnd-kit reorder
    FieldInspector.tsx                 # right: edit selected field (label/required/options/visibility/goto)
    BranchingEditor.tsx                # option.goto + section.next + visibility rule editors
    FormPreview.tsx                    # renders current schema using the shared renderer
    fieldRenderers.tsx                 # one renderer per field type (shared by preview + public)
    PublicFormPage.tsx                 # standalone public page (outside AppShell)
    ResponsesPage.tsx                  # responses table + detail drawer + actions
    FormsListPage.tsx                  # per-tournament list of forms (entry point)
  (modify) App.tsx or router file      # register routes /f/:formId, /r/:token, builder + responses
  (modify) features/layout/computeNavItems.ts  # add "Registration forms" nav (module: forms)
  (modify) lib/routes.ts               # route helpers for the new pages
```

> **First task of every component step:** open the analogous existing file (`RegistrationFormPage.tsx`, an existing feature page, `lib/routes.ts`, `App.tsx`, `computeNavItems.ts`) and copy its conventions (imports, token classes, page wrapper `flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8`, `t()` on every string). Do NOT introduce `mx-auto max-w-*` centered columns on authed pages (the public page is the one exception, reusing `PublicShell`).

---

# Increment 6 — Builder UI

### Task 6.1: Shared types

**Files:**
- Create: `frontend/src/features/forms/types.ts`

- [ ] **Step 1: Write the types** (align names with the backend schema)
```ts
export type FieldType =
  | "short_text" | "long_text" | "single_choice" | "multi_choice" | "dropdown"
  | "email" | "phone" | "number" | "date" | "time" | "rating" | "linear_scale"
  | "address" | "file_upload" | "section_text" | "yes_no" | "group";

export type VisibilityOp =
  | "equals" | "not_equals" | "in" | "includes" | "gt" | "lt" | "answered";

export interface Visibility { field: string; op: VisibilityOp; value?: unknown; }
export interface Option { value: string; label: string; goto?: string; }
export interface Validation {
  min?: number; max?: number; minLength?: number; maxLength?: number;
  pattern?: string; maxSelections?: number; minSelections?: number;
}
export type FieldRole = "title" | "email" | "phone" | "name";

export interface Field {
  key: string; type: FieldType; label: string; help?: string; required?: boolean;
  role?: FieldRole; options?: Option[]; validation?: Validation; visibility?: Visibility | null;
  fields?: Field[]; // for type: "group"
}
export interface Section {
  key: string; title: string; description?: string;
  visibility?: Visibility | null; next?: string; fields: Field[];
}
export interface FormSchema { version: number; sections: Section[]; }

export type FormPurpose = "organization_registration" | "team_registration" | "generic";
export type FormStatus = "draft" | "open" | "closed";

export interface FormSummary {
  id: string; slug: string; title: string; description: string; purpose: FormPurpose;
  status: FormStatus; opens_at: string | null; closes_at: string | null; version: number;
  response_count: number; confirmation_message: string; settings: Record<string, unknown>;
  schema: FormSchema;
}
export interface FormResponseRow {
  id: string; answers: Record<string, unknown>; respondent_email: string;
  respondent_phone: string; respondent_name: string; title: string;
  status: "submitted" | "accepted" | "rejected" | "waitlisted";
  mapped_entities: Record<string, unknown>; created_at: string;
}
```

- [ ] **Step 2: Commit** `git add frontend/src/features/forms/types.ts && git commit -m "feat(forms-ui): shared form schema types"`

---

### Task 6.2: API client

**Files:**
- Create: `frontend/src/api/forms.ts`

- [ ] **Step 1: Implement** (mirror `frontend/src/api/registration.ts` shape)
```ts
import { api } from "./client";
import type { FormSchema, FormSummary, FormResponseRow } from "@/features/forms/types";

export interface PublicFormPayload {
  form?: { id: string; title: string; description: string; schema: FormSchema; confirmation_message: string };
  tournament_name: string;
  closed?: boolean;
}

export const formsApi = {
  list: (tournamentId: string) => api.get<FormSummary[]>(`/api/tournaments/${tournamentId}/forms/`),
  create: (tournamentId: string, body: { title: string; purpose: string }) =>
    api.post<FormSummary>(`/api/tournaments/${tournamentId}/forms/`, body),
  get: (formId: string) => api.get<FormSummary>(`/api/forms/${formId}/`),
  update: (formId: string, body: Partial<Pick<FormSummary, "title" | "description" | "schema" | "closes_at" | "opens_at" | "confirmation_message" | "settings">>) =>
    api.patch<FormSummary>(`/api/forms/${formId}/`, body),
  publish: (formId: string) => api.post<FormSummary>(`/api/forms/${formId}:publish/`, {}),
  close: (formId: string) => api.post<FormSummary>(`/api/forms/${formId}:close/`, {}),
  duplicate: (formId: string) => api.post<FormSummary>(`/api/forms/${formId}:duplicate/`, {}),
  fieldTypes: () => api.get<{ type: string; has_options: boolean }[]>(`/api/forms/field-types/`),
  responses: (formId: string) => api.get<FormResponseRow[]>(`/api/forms/${formId}/responses/`),
  setResponseStatus: (formId: string, rid: string, status: string) =>
    api.patch<FormResponseRow>(`/api/forms/${formId}/responses/${rid}/`, { status }),
  sendStage2: (formId: string, targetFormId: string) =>
    api.post<{ sent: number; links: { response_id: string; email: string; path: string }[] }>(
      `/api/forms/${formId}:send-stage2/`, { target_form_id: targetFormId }),
  // public
  publicGet: (formId: string) => api.get<PublicFormPayload>(`/api/forms/${formId}/public/`),
  publicSubmit: (formId: string, body: { answers: Record<string, unknown>; event_id: string; upload_refs?: Record<string, string> }) =>
    api.post<{ response_id: string; message: string }>(`/api/forms/${formId}/public/`, body),
  publicGetByToken: (token: string) => api.get<PublicFormPayload>(`/api/forms/r/${token}/`),
  publicSubmitByToken: (token: string, body: { answers: Record<string, unknown>; event_id: string }) =>
    api.post<{ response_id: string; message: string }>(`/api/forms/r/${token}/`, body),
  csvUrl: (formId: string) => `/api/forms/${formId}/responses/?export=csv`,
};
```
> If the project's `api` client lacks `patch`, add a thin `patch` next to `get/post` in `frontend/src/api/client.ts` following the existing `post` implementation (same `credentials`/CSRF handling).

- [ ] **Step 2: type-check** `npm --prefix frontend run type-check` → clean.
- [ ] **Step 3: Commit** `git add frontend/src/api/forms.ts frontend/src/api/client.ts && git commit -m "feat(forms-ui): typed forms API client"`

---

### Task 6.3: Pure branching-eval module (shared, tested)

**Files:**
- Create: `frontend/src/lib/formLogic.ts`
- Create: `frontend/src/lib/__tests__/formLogic.test.ts`

- [ ] **Step 1: Write failing vitest** (mirror backend `validate_answers` walk)
```ts
import { describe, expect, it } from "vitest";
import { isVisible, nextSectionKey, reachableFieldKeys } from "@/lib/formLogic";
import type { FormSchema } from "@/features/forms/types";

const schema: FormSchema = { version: 1, sections: [
  { key: "school", title: "S", fields: [
    { key: "school_name", type: "short_text", label: "School", required: true, role: "title" } ] },
  { key: "competition", title: "C", fields: [
    { key: "competition", type: "single_choice", label: "Which?", required: true, options: [
      { value: "sepak", label: "Sepak", goto: "sepak" },
      { value: "tt", label: "TT", goto: "tt" },
      { value: "none", label: "None", goto: "confirm" } ] } ] },
  { key: "sepak", title: "Sepak", visibility: { field: "competition", op: "in", value: ["sepak", "both"] },
    fields: [{ key: "sepak_cats", type: "multi_choice", label: "Cats", required: true, options: [{ value: "u14b", label: "U14B" }] }], next: "confirm" },
  { key: "tt", title: "TT", visibility: { field: "competition", op: "in", value: ["tt", "both"] },
    fields: [{ key: "tt_cats", type: "multi_choice", label: "Cats", required: true, options: [{ value: "x", label: "X" }] }], next: "confirm" },
  { key: "confirm", title: "Confirm", fields: [{ key: "agree", type: "single_choice", label: "OK", required: true, options: [{ value: "yes", label: "Yes" }] }] },
]};

it("isVisible evaluates 'in'", () => {
  expect(isVisible({ field: "competition", op: "in", value: ["sepak", "both"] }, { competition: "sepak" })).toBe(true);
  expect(isVisible({ field: "competition", op: "in", value: ["sepak"] }, { competition: "tt" })).toBe(false);
  expect(isVisible(null, {})).toBe(true);
});

it("nextSectionKey follows option.goto", () => {
  expect(nextSectionKey(schema.sections[1], { competition: "tt" })).toBe("tt");
});

it("reachableFieldKeys excludes hidden branch", () => {
  const keys = reachableFieldKeys(schema, { school_name: "MH", competition: "sepak", sepak_cats: ["u14b"], agree: "yes" });
  expect(keys).toContain("sepak_cats");
  expect(keys).not.toContain("tt_cats");
});
```

- [ ] **Step 2: Run to verify fail.** `npm --prefix frontend run test -- src/lib/__tests__/formLogic.test.ts` → FAIL.

- [ ] **Step 3: Implement `lib/formLogic.ts`** (complete; semantics identical to backend)
```ts
import type { FormSchema, Section, Visibility } from "@/features/forms/types";

export function isVisible(rule: Visibility | null | undefined, answers: Record<string, unknown>): boolean {
  if (!rule) return true;
  const val = answers[rule.field];
  const target = rule.value;
  switch (rule.op) {
    case "answered": return val !== undefined && val !== null && val !== "" &&
      !(Array.isArray(val) && val.length === 0);
    case "equals": return val === target;
    case "not_equals": return val !== target;
    case "in": return Array.isArray(target) && target.includes(val as never);
    case "includes": return Array.isArray(val) && (val as unknown[]).includes(target);
    case "gt": return Number(val) > Number(target);
    case "lt": return Number(val) < Number(target);
    default: return false;
  }
}

export function nextSectionKey(section: Section, answers: Record<string, unknown>): string | undefined {
  for (const f of section.fields) {
    if (f.type === "single_choice" || f.type === "dropdown") {
      const chosen = answers[f.key];
      const opt = (f.options ?? []).find((o) => String(o.value) === String(chosen));
      if (opt?.goto) return opt.goto;
    }
  }
  return section.next;
}

/** Walk the schema following branching; return the ordered list of reachable+visible sections.
 *  Traversal MUST match the backend services/validation.py::_next_section exactly:
 *  chosen option's goto, else section.next, else the next section in document order. */
export function reachableSections(schema: FormSchema, answers: Record<string, unknown>): Section[] {
  const sections = schema.sections;
  const out: Section[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = sections[0]?.key;
  while (cur && cur !== "_end" && !seen.has(cur)) {
    seen.add(cur);
    const idx = sections.findIndex((s) => s.key === cur);
    const sec = idx >= 0 ? sections[idx] : undefined;
    if (!sec) break;
    if (isVisible(sec.visibility, answers)) out.push(sec);
    const explicit = nextSectionKey(sec, answers); // option.goto or section.next
    cur = explicit ?? (idx + 1 < sections.length ? sections[idx + 1].key : undefined);
  }
  return out;
}

export function reachableFieldKeys(schema: FormSchema, answers: Record<string, unknown>): string[] {
  const keys: string[] = [];
  for (const sec of reachableSections(schema, answers)) {
    for (const f of sec.fields) {
      if (f.type === "section_text") continue;
      if (isVisible(f.visibility, answers)) keys.push(f.key);
    }
  }
  return keys;
}

/** Client-side required check (server re-validates). Returns map of fieldKey->error. */
export function validateRequired(schema: FormSchema, answers: Record<string, unknown>): Record<string, string> {
  const errs: Record<string, string> = {};
  for (const sec of reachableSections(schema, answers)) {
    for (const f of sec.fields) {
      if (f.type === "section_text" || !isVisible(f.visibility, answers)) continue;
      const v = answers[f.key];
      const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
      if (f.required && empty) errs[f.key] = "required";
    }
  }
  return errs;
}
```

- [ ] **Step 4: Run to verify pass.** Expect passed.
- [ ] **Step 5: Commit** `git add frontend/src/lib/formLogic.ts frontend/src/lib/__tests__/formLogic.test.ts && git commit -m "feat(forms-ui): shared branching-eval (mirrors backend) + tests"`

---

### Task 6.4: Builder store (tested)

**Files:**
- Create: `frontend/src/features/forms/builderStore.ts`
- Create: `frontend/src/features/forms/__tests__/builderStore.test.ts`

- [ ] **Step 1: Write failing vitest**
```ts
import { describe, expect, it, beforeEach } from "vitest";
import { useBuilderStore } from "@/features/forms/builderStore";

const reset = () => useBuilderStore.getState().load({ version: 1, sections: [
  { key: "s1", title: "Section 1", fields: [] }] });

describe("builderStore", () => {
  beforeEach(reset);

  it("adds a field with a unique key", () => {
    useBuilderStore.getState().addField("s1", "short_text");
    const s = useBuilderStore.getState().schema.sections[0];
    expect(s.fields).toHaveLength(1);
    expect(s.fields[0].type).toBe("short_text");
    expect(s.fields[0].key).toBeTruthy();
  });

  it("addField twice yields distinct keys", () => {
    useBuilderStore.getState().addField("s1", "short_text");
    useBuilderStore.getState().addField("s1", "short_text");
    const f = useBuilderStore.getState().schema.sections[0].fields;
    expect(f[0].key).not.toBe(f[1].key);
  });

  it("updates a field", () => {
    useBuilderStore.getState().addField("s1", "short_text");
    const key = useBuilderStore.getState().schema.sections[0].fields[0].key;
    useBuilderStore.getState().updateField("s1", key, { label: "Name", required: true });
    const f = useBuilderStore.getState().schema.sections[0].fields[0];
    expect(f.label).toBe("Name"); expect(f.required).toBe(true);
  });

  it("adds and removes a section", () => {
    useBuilderStore.getState().addSection();
    expect(useBuilderStore.getState().schema.sections).toHaveLength(2);
    const k = useBuilderStore.getState().schema.sections[1].key;
    useBuilderStore.getState().removeSection(k);
    expect(useBuilderStore.getState().schema.sections).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement `builderStore.ts`** (complete)
```ts
import { create } from "zustand";
import type { Field, FieldType, FormSchema, Section } from "./types";

let counter = 0;
const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(counter++).toString(36)}`;

const DEFAULT_LABEL: Record<string, string> = {
  short_text: "Short answer", long_text: "Paragraph", single_choice: "Single choice",
  multi_choice: "Checkboxes", dropdown: "Dropdown", email: "Email", phone: "Phone",
  number: "Number", date: "Date", time: "Time", rating: "Rating", linear_scale: "Scale",
  address: "Address", file_upload: "File upload", section_text: "Text block", yes_no: "Yes / No",
  group: "Repeating group",
};

function newField(type: FieldType): Field {
  const f: Field = { key: uid("f"), type, label: DEFAULT_LABEL[type] ?? "Field" };
  if (type === "single_choice" || type === "multi_choice" || type === "dropdown") {
    f.options = [{ value: "opt1", label: "Option 1" }];
  }
  return f;
}

interface BuilderState {
  schema: FormSchema;
  selected: { sectionKey: string; fieldKey: string } | null;
  load: (schema: FormSchema) => void;
  addSection: () => void;
  removeSection: (key: string) => void;
  updateSection: (key: string, patch: Partial<Section>) => void;
  addField: (sectionKey: string, type: FieldType) => void;
  updateField: (sectionKey: string, fieldKey: string, patch: Partial<Field>) => void;
  removeField: (sectionKey: string, fieldKey: string) => void;
  reorderFields: (sectionKey: string, from: number, to: number) => void;
  select: (sectionKey: string, fieldKey: string) => void;
}

function mapSection(s: FormSchema, key: string, fn: (sec: Section) => Section): FormSchema {
  return { ...s, sections: s.sections.map((sec) => (sec.key === key ? fn(sec) : sec)) };
}

export const useBuilderStore = create<BuilderState>((set) => ({
  schema: { version: 1, sections: [{ key: uid("s"), title: "Untitled section", fields: [] }] },
  selected: null,
  load: (schema) => set({ schema: schema.sections.length ? schema : { version: 1, sections: [{ key: uid("s"), title: "Untitled section", fields: [] }] }, selected: null }),
  addSection: () => set((st) => ({ schema: { ...st.schema, sections: [...st.schema.sections, { key: uid("s"), title: "Untitled section", fields: [] }] } })),
  removeSection: (key) => set((st) => ({ schema: { ...st.schema, sections: st.schema.sections.filter((s) => s.key !== key) } })),
  updateSection: (key, patch) => set((st) => ({ schema: mapSection(st.schema, key, (sec) => ({ ...sec, ...patch })) })),
  addField: (sectionKey, type) => set((st) => ({ schema: mapSection(st.schema, sectionKey, (sec) => ({ ...sec, fields: [...sec.fields, newField(type)] })) })),
  updateField: (sectionKey, fieldKey, patch) => set((st) => ({ schema: mapSection(st.schema, sectionKey, (sec) => ({ ...sec, fields: sec.fields.map((f) => (f.key === fieldKey ? { ...f, ...patch } : f)) })) })),
  removeField: (sectionKey, fieldKey) => set((st) => ({ schema: mapSection(st.schema, sectionKey, (sec) => ({ ...sec, fields: sec.fields.filter((f) => f.key !== fieldKey) })) })),
  reorderFields: (sectionKey, from, to) => set((st) => ({ schema: mapSection(st.schema, sectionKey, (sec) => { const fields = [...sec.fields]; const [m] = fields.splice(from, 1); fields.splice(to, 0, m); return { ...sec, fields }; }) })),
  select: (sectionKey, fieldKey) => set({ selected: { sectionKey, fieldKey } }),
}));
```

- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** `git add frontend/src/features/forms/builderStore.ts frontend/src/features/forms/__tests__/builderStore.test.ts && git commit -m "feat(forms-ui): builder Zustand store + tests"`

---

### Task 6.5: Field renderers (shared by preview + public)

**Files:**
- Create: `frontend/src/features/forms/fieldRenderers.tsx`

- [ ] **Step 1: Implement renderers** — a `renderField(field, value, onChange)` switch using design-system inputs. One case per type:
  - `short_text`/`email`/`phone`/`number`/`date`/`time` → `<Input>` (set `type`/`inputMode` accordingly)
  - `long_text` → `<textarea>` with token classes
  - `single_choice`/`yes_no` → radio group (accessible `<input type=radio>` + label)
  - `multi_choice` → checkbox group
  - `dropdown` → `@/components/ui/Select`
  - `rating` → star buttons; `linear_scale` → numbered buttons
  - `address` → grouped `<Input>`s for line1/city/district/state/pincode
  - `file_upload` → `<input type=file>` calling an upload handler prop → stores `upload_ref`
  - `section_text` → display-only `<p>`
  - `group` → repeatable subform (map child fields; add/remove row) — v1 may render a simple repeat of children
  Every label wrapped in `t()`, every input has an `aria-label`/`<Label htmlFor>`. Keep this file focused on rendering only (no data fetching).
- [ ] **Step 2: type-check** clean.
- [ ] **Step 3: Commit** `git commit -m "feat(forms-ui): field renderers for all types"`

---

### Task 6.6: Builder page + palette + canvas + inspector + branching editor + preview

**Files:**
- Create: `FieldPalette.tsx`, `FormCanvas.tsx`, `FieldInspector.tsx`, `BranchingEditor.tsx`, `FormPreview.tsx`, `FormBuilderPage.tsx`, `FormsListPage.tsx`
- Modify: router (App.tsx) + `lib/routes.ts` + `features/layout/computeNavItems.ts`

- [ ] **Step 1: `FieldPalette.tsx`** — list field types from `formsApi.fieldTypes()` (or the static `FieldType` union); each is a `dnd-kit` draggable + a click handler that calls `addField(currentSection, type)`. Token-styled chips with lucide icons.
- [ ] **Step 2: `FormCanvas.tsx`** — render `schema.sections`; per section a card (`rounded-xl border border-border bg-card shadow-sm`) with title (editable via `updateSection`), its fields as rows (click → `select`), `dnd-kit` `SortableContext` for field reorder (`reorderFields`), add-section button, per-field delete.
- [ ] **Step 3: `FieldInspector.tsx`** — for the `selected` field: edit `label`, `help`, `required` (toggle), `role` (Select), `options` (add/remove/edit rows for choice types), `validation` (min/max/maxSelections), and embed `<BranchingEditor>`.
- [ ] **Step 4: `BranchingEditor.tsx`** — (a) per-option `goto` → `Select` of section keys (+ "End"); (b) section `next` → `Select`; (c) field/section `visibility` rule builder: pick trigger field (Select of prior choice fields), op (Select of `VISIBILITY_OPS`), value (Select/multiselect of that field's options). Writes via `updateField`/`updateSection`.
- [ ] **Step 5: `FormPreview.tsx`** — local `answers` state; render only `reachableSections(schema, answers)` via `fieldRenderers`; updates show/hide live (proves branching).
- [ ] **Step 6: `FormBuilderPage.tsx`** — route `/orgs/:orgSlug/tournaments/:tournamentId/forms/:formId/edit` (match existing route nesting): `useQuery(formsApi.get)`, `load()` into store on success; autosave (debounced) or explicit Save → `formsApi.update(formId, { schema })`; header actions Publish/Close (`useToast` on success); settings panel for `title`, `confirmation_message`, `closes_at` (date input). Layout: 3-column grid filling width (`flex w-full ... px-4 py-6 sm:px-6 lg:px-8`), collapsing to stacked on mobile via `useBreakpoint`.
- [ ] **Step 7: `FormsListPage.tsx`** — route `/orgs/:orgSlug/tournaments/:tournamentId/forms`: list forms (`formsApi.list`), "New form" dialog (title + purpose Select) → `formsApi.create` → navigate to builder. Show status pills + response counts (`font-tabular`).
- [ ] **Step 8: Routes + nav** — register routes in the app router; add helpers in `lib/routes.ts`; add a "Registration forms" item in `computeNavItems.ts` gated on module `forms` (matches backend Increment 3).
- [ ] **Step 9: Verify** `npm --prefix frontend run type-check` and `npm --prefix frontend run lint` clean; load the app and click through builder (manual). Add a vitest smoke test for `FormPreview` showing/hiding a conditional section.
- [ ] **Step 10: Commit** `git add frontend/src/features/forms/ frontend/src/lib/routes.ts frontend/src/features/layout/computeNavItems.ts && git commit -m "feat(forms-ui): form builder (palette/canvas/inspector/branching/preview) + list page"`

---

# Increment 7 — Public renderer

### Task 7.1: PublicFormPage

**Files:**
- Create: `frontend/src/features/forms/PublicFormPage.tsx`
- Modify: router — add `/f/:formId` and `/r/:token` OUTSIDE the authed `AppShell` (same place `RegistrationFormPage` `/register/:token` is mounted)

- [ ] **Step 1: Implement** — reuse the `PublicShell`/`Centered` pattern from `RegistrationFormPage.tsx` (copy those helpers or extract to a shared `features/forms/PublicShell.tsx`). Flow:
  - `useQuery` → `formsApi.publicGet(formId)` (or `publicGetByToken(token)`).
  - If `closed` → show "Registration closed" state (icon + message), like the existing invalid-link state.
  - Else render a **paged wizard**: `answers` state; compute `reachableSections(schema, answers)`; show current section's visible fields via `fieldRenderers`; Back/Next buttons navigate the reachable list; on the last section show Submit.
  - File fields upload immediately to `/api/forms/:id/uploads/` returning `upload_ref`, collected into `upload_refs`.
  - Validate with `validateRequired` before advancing/submitting; show inline errors (`role="alert"`).
  - Submit → `formsApi.publicSubmit(formId, { answers, event_id: newEventId(), upload_refs })`; on success show the `message` (the confirmation notice, e.g. "documents by 20 Aug 2026"); on `400 {errors}` map server errors back onto fields.
  - All strings via `t()`; WCAG AA (labels, focus ring, `aria-live` on success/error).
- [ ] **Step 2: vitest** — render with a mocked `publicGet` returning the Sepak/TT schema; choose "Sepak Takraw only" → assert TT categories never render and Sepak categories do; fill required + submit → assert `publicSubmit` called with expected `answers`.
- [ ] **Step 3: Verify** type-check + the new test pass; manual: open `/f/<id>` for a published form in the browser.
- [ ] **Step 4: Commit** `git commit -m "feat(forms-ui): public form renderer with live branching + uploads"`

---

# Increment 8 — Responses dashboard + export + Stage-2 send

### Task 8.1: ResponsesPage

**Files:**
- Create: `frontend/src/features/forms/ResponsesPage.tsx`
- Modify: router — add `/orgs/:orgSlug/tournaments/:tournamentId/forms/:formId/responses`

- [ ] **Step 1: Implement** —
  - `useQuery` → `formsApi.responses(formId)`; render a table (desktop) / stacked cards (mobile via `useBreakpoint`) with columns: `title`, `respondent_email`, `respondent_phone`, `status` pill, `created_at` (tournament TZ), actions.
  - Row click → detail **drawer/dialog** (`@/components/ui/dialog`) showing all `answers` keyed by the schema labels (fetch the form via `formsApi.get` for labels).
  - Status actions: Accept / Reject / Waitlist → `formsApi.setResponseStatus` (optimistic update + `useToast`).
  - **Export CSV** button → `window.open(formsApi.csvUrl(formId))` (same-origin, cookie-auth).
  - **Send Stage-2 links**: a dialog to pick the target `team_registration` form (list filtered by `purpose`), then `formsApi.sendStage2(formId, targetFormId)`; show the returned links (copyable) + count; toast.
  - Filters: status tabs (All / Submitted / Accepted / Rejected). Numbers in `font-tabular`.
- [ ] **Step 2: vitest** — mock `responses` + `setResponseStatus`; click Accept → assert API called and pill updates.
- [ ] **Step 3: Verify** type-check + tests pass; manual click-through.
- [ ] **Step 4: Commit** `git commit -m "feat(forms-ui): responses dashboard + CSV export + Stage-2 send"`

---

### Task 8.2: Full frontend gate + types regen

- [ ] **Step 1:** `npm --prefix frontend run gen:types` (pick up backend schema) — reconcile `features/forms/types.ts` with generated `src/types` if they drift.
- [ ] **Step 2:** `npm --prefix frontend run test` (whole suite green, ~193 prior + new).
- [ ] **Step 3:** `npm --prefix frontend run type-check` clean; `npm --prefix frontend run lint` clean.
- [ ] **Step 4:** `npm --prefix frontend run build` succeeds.
- [ ] **Step 5: Commit** any reconciliation `git commit -m "chore(forms-ui): regen types + full suite green"`

---

## Frontend self-review checklist

- [ ] **Spec coverage:** builder (§9) ✓, public renderer (§9) ✓, responses dashboard + export + Stage-2 (§9/§5) ✓, branching parity with backend (§3 via shared `formLogic.ts`) ✓, module-gated nav (§8) ✓.
- [ ] **Design system:** no `mx-auto max-w-*` on authed pages; tokens only (no hex); `t()` on all strings; `font-tabular` on numbers; custom `Select`/`dialog`/`toast` (no native dropdowns/alerts).
- [ ] **Branching parity:** `lib/formLogic.ts` ops match backend `services/validation.py::_visible` exactly (equals/not_equals/in/includes/gt/lt/answered) and `nextSectionKey` matches `_next_section`. A divergence = a field required server-side but hidden client-side (or vice-versa) → 400s. Keep them in sync.
- [ ] **Idempotency:** public submit always sends `event_id: newEventId()`; retries reuse the same id within a mount.
- [ ] **a11y:** keyboard reachable builder (dnd-kit keyboard sensor), focus rings, `aria-live` on submit result.
