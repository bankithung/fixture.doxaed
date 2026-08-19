/**
 * Shared form-schema types for the registration form builder + renderer.
 *
 * These mirror the backend schema (`apps/forms`): field types, visibility
 * operators, and the section/field tree stored in `Form.schema` JSONB. The
 * branching evaluator (`@/lib/formLogic`) and the field renderers both consume
 * these, so they MUST stay aligned with `apps/forms/constants.py` and
 * `apps/forms/services/validation.py`.
 */

export type FieldType =
  | "short_text"
  | "long_text"
  | "single_choice"
  | "multi_choice"
  | "dropdown"
  | "email"
  | "phone"
  | "number"
  | "date"
  | "time"
  | "rating"
  | "linear_scale"
  | "address"
  | "file_upload"
  | "section_text"
  | "yes_no"
  | "group"
  // A generated row id: submitted, but never rendered and never typed. It is
  // the identity a picker elsewhere in the form points at (owner 2026-08-17).
  | "hidden";

export type VisibilityOp =
  | "equals"
  | "not_equals"
  | "in"
  | "includes"
  | "gt"
  | "lt"
  | "answered";

export interface Visibility {
  field: string;
  op: VisibilityOp;
  value?: unknown;
}

export interface Option {
  value: string;
  label: string;
  /** `layout: "matrix"` fields: which cell this option is. `row` is the
   * left-hand heading, `col` the column heading. */
  row?: string;
  col?: string;
  /** `layout: "columns"` fields: the sport band this option sits under and
   * the short code heading its column (the directory matrix's initials). */
  sport?: string;
  code?: string;
  /** Facts a sheet cell locks on: the competition's gender node and the age
   * rule its path carries. */
  gender?: string;
  age?: { op: "under" | "over" | "between"; age?: number; min?: number; max?: number };
  /** Squad bounds off the competition's format node: the team-number chip
   * shows only when one team can hold more than one player. */
  squad_min?: number;
  squad_max?: number;
  /** Optional per-option image/logo (a compressed data URL set in the builder),
   * shown beside the option on the public form. */
  image?: string;
  /** Branching: jump to this section key when this option is chosen. */
  goto?: string;
  /** institution_list options: the competition leaves the institution
   * registered at Stage 1 (drives team-form competition scoping). */
  leaves?: string[];
  /** institution_list options: true when this school must enter its emailed
   * access code before registering/editing teams. */
  requires_code?: boolean;
  /** institution_list options: false when no code has been issued yet — the
   * school cannot submit publicly until the organizer sends one. */
  has_code?: boolean;
  /**
   * Nested follow-up questions revealed when this option is chosen (recursive —
   * a nested choice field's options can themselves carry `fields`). Answers stay
   * flat by key; a nested field is only active/required while its option is
   * selected. Mirrors the backend validator's option-descent.
   */
  fields?: Field[];
}

export interface Validation {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  maxSelections?: number;
  minSelections?: number;
}

export type FieldRole = "title" | "email" | "phone" | "name";

export interface Field {
  key: string;
  type: FieldType;
  /** Empty only on `hidden` fields, which name nothing anyone can see. */
  label: string;
  help?: string;
  required?: boolean;
  role?: FieldRole;
  options?: Option[];
  validation?: Validation;
  visibility?: Visibility | null;
  /** Child fields for `type: "group"` (repeating subform). */
  fields?: Field[];
  /** `type: "group"` → render as add/remove repeatable rows (array value). */
  repeatable?: boolean;
  /** `layout: "columns"` tick fields: the sibling hidden field storing each
   * row's team number per competition, as a JSON string {leaf: n}. */
  team_no_field?: string;
  /** Repeatable group row bounds (W2-B roster limits, server-enforced). */
  min_items?: number;
  max_items?: number;
  /**
   * Presentation grouping (W2): consecutive fields sharing `group` render
   * inside one card titled `group_label`, indented by `indent` levels and
   * labelled with `short_label`. Pure display metadata — never validated.
   */
  group?: string;
  group_label?: string;
  indent?: number;
  short_label?: string;
  /** false = keep this choice field OUT of the public directory's
   * filters/breakdown (the generator opts chain questions out). */
  directory?: boolean;
  /** Live-bound options. Some are resolved by the server at fetch time
   * (`institution_list`), some arrive with the access-code exchange
   * (`roster_students`), and `form_group` is resolved from THIS form's own
   * answers — the participants the school is typing right now (owner
   * 2026-08-17), named by `group`/`value_field`/`label_field`. */
  data_source?: {
    type: string;
    group?: string;
    value_field?: string;
    label_field?: string;
    hint_field?: string;
  };
  /** Repeatable group whose new rows get a generated id in this child key, so
   * a picker elsewhere can reference one row and survive reordering. */
  row_key?: string;
  /** Repeatable group: which child field names a row once it is saved, so a
   * filled row can collapse to that name instead of staying a wall of inputs
   * (owner 2026-08-18). Falls back to the first plain-text child. */
  row_title?: string;
  /** Prefill this field from something the form already knows. "institution"
   * = the school picked at the top, so a team is named after its school
   * unless the respondent says otherwise (owner 2026-08-18). Applied only to
   * an UNTOUCHED field, so a cleared box stays cleared. */
  default_from?: string;
  /** Repeatable group inside a competition section: seed its rows from a
   * participants sheet (owner 2026-08-18, "merge with the table"). Every row
   * of `seed_from_group` whose `seed_events` ticks cover this section's
   * competition lands here as a row with `seed_field` set to its
   * `seed_row_id`. Only an untouched group is seeded. */
  seed_from_group?: string;
  seed_events?: string;
  seed_row_id?: string;
  seed_field?: string;
  /** Appended to a `default_from` value, plus the row number, so a team is
   * named "<School> <SPORT>-<n>" (owner 2026-08-18). */
  default_suffix?: string;
  /** Overrides the add button's text when "Add <label>" reads wrong. */
  add_label?: string;
  /** "matrix" renders a multi_choice as a TICK-MARK TABLE, using each
   * option's `row`/`col` (owner 2026-08-18): the same reading as the public
   * directory's registration matrix. "sheet" renders a repeatable group as
   * an Excel-style table, one column per child field (owner 2026-08-18). */
  layout?: string;
  /** Sheet groups: the tab this sheet sits behind when several sheets share
   * one surface (Students / Teachers). */
  tab_label?: string;
  /** Filter this field's options to the competitions the selected school
   * registered at Stage 1 (owner 2026-08-18). */
  scope_to_institution?: boolean;
  /** `type: "file_upload"` → allow several files (value becomes an array of
   * upload refs) and/or constrain the picker's accepted types. */
  multiple?: boolean;
  accept?: string;
}

export interface Section {
  key: string;
  title: string;
  /** Built from the participants sheet's ticks and skipped in the walk;
   * it re-enters only while it holds a validation problem. */
  auto?: boolean;
  description?: string;
  visibility?: Visibility | null;
  /** Branching: explicit next-section key (overridden by an option `goto`). */
  next?: string;
  fields: Field[];
}

export interface FormSchema {
  version: number;
  sections: Section[];
}

export type FormPurpose =
  | "organization_registration"
  | "team_registration"
  | "generic";
export type FormStatus = "draft" | "open" | "closed";

export interface FormSummary {
  id: string;
  slug: string;
  title: string;
  description: string;
  purpose: FormPurpose;
  stage: string;
  status: FormStatus;
  opens_at: string | null;
  closes_at: string | null;
  version: number;
  response_count: number;
  confirmation_message: string;
  settings: Record<string, unknown>;
  /** Generated form whose sports/category inputs changed since generation. */
  stale?: boolean;
  schema: FormSchema;
}

export type ResponseStatus = "submitted" | "accepted" | "rejected" | "waitlisted";

export interface FormResponseRow {
  id: string;
  answers: Record<string, unknown>;
  respondent_email: string;
  respondent_phone: string;
  respondent_name: string;
  title: string;
  status: ResponseStatus;
  mapped_entities: Record<string, unknown>;
  created_at: string;
}
