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
  | "group";

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
  /** Branching: jump to this section key when this option is chosen. */
  goto?: string;
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
  /** Repeatable group row bounds (W2-B roster limits, server-enforced). */
  min_items?: number;
  max_items?: number;
}

export interface Section {
  key: string;
  title: string;
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
