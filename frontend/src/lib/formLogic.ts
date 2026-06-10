/**
 * Pure branching evaluator shared by the builder preview and the public
 * renderer. It MUST mirror the backend traversal in
 * `apps/forms/services/validation.py` exactly, otherwise a field can be
 * required server-side but hidden client-side (or vice-versa), producing
 * spurious 400s.
 *
 * Parity contract (keep in sync with the backend):
 *   - Visibility ops: equals / not_equals / in / includes / gt / lt / answered.
 *   - Section traversal: the chosen option's `goto`, else `section.next`, else
 *     the NEXT section in document order, else end.
 *   - "First goto-bearing single_choice/dropdown field in a section wins."
 *   - Display-only types (`section_text`) never produce an answer.
 */
import type {
  Field,
  FormSchema,
  Option,
  Section,
  Visibility,
} from "@/features/forms/types";

/** Display-only field types — mirrors backend `DISPLAY_TYPES`. */
const DISPLAY_TYPES = new Set<string>(["section_text"]);

/** True when a value counts as "empty" (mirrors backend `raw in (None,"",[],{})`). */
function isEmpty(val: unknown): boolean {
  if (val === undefined || val === null || val === "") return true;
  if (Array.isArray(val) && val.length === 0) return true;
  if (
    typeof val === "object" &&
    val !== null &&
    !Array.isArray(val) &&
    Object.keys(val as Record<string, unknown>).length === 0
  ) {
    return true;
  }
  return false;
}

/**
 * Parse a value to a finite number, or null when it isn't one — the client-side
 * mirror of Python's `float(x)` inside a try/except (used by the backend
 * `_visible` for gt/lt). null/undefined/"" and arrays/objects/NaN/±Infinity all
 * yield null so gt/lt evaluate to false on non-numbers, matching the server.
 */
function toFiniteNumber(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val === "object") return null; // arrays/objects: float() would raise
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

export function isVisible(
  rule: Visibility | null | undefined,
  answers: Record<string, unknown>,
): boolean {
  if (!rule) return true;
  const val = answers[rule.field];
  const target = rule.value;
  switch (rule.op) {
    case "answered":
      return !isEmpty(val);
    case "equals":
      return val === target;
    case "not_equals":
      return val !== target;
    case "in":
      return Array.isArray(target) && target.includes(val as never);
    case "includes":
      return Array.isArray(val) && (val as unknown[]).includes(target);
    case "gt": {
      // Parity with backend apps/forms/services/validation.py::_visible — it
      // uses float(val)/float(target) in try/except, returning False when
      // either side isn't a finite number. The old Number() coercion treated
      // "" and null as 0 (Number("")===0), so an empty optional number with
      // rule gt:-1 showed client-side but was hidden server-side → spurious
      // 400 (verified bug V5). toFiniteNumber mirrors float()'s "raise → False".
      const a = toFiniteNumber(val);
      const b = toFiniteNumber(target);
      return a !== null && b !== null && a > b;
    }
    case "lt": {
      const a = toFiniteNumber(val);
      const b = toFiniteNumber(target);
      return a !== null && b !== null && a < b;
    }
    default:
      return false;
  }
}

/**
 * Is `option` of choice field `parent` currently chosen? single_choice/dropdown
 * match by equality; multi_choice matches membership. Mirrors the backend
 * `_option_selected`. Drives nested-option reveals.
 */
export function optionSelected(
  parent: Field,
  optionValue: string,
  answers: Record<string, unknown>,
): boolean {
  const a = answers[parent.key];
  if (Array.isArray(a)) return a.map(String).includes(String(optionValue));
  return a != null && String(a) === String(optionValue);
}

/**
 * Flatten a field list into the fields that are currently ACTIVE: each field's
 * own `visibility` must pass, and a choice option's nested `fields` are included
 * only while that option is selected (recursive). Additive — a form with no
 * nested options yields exactly `fields.filter(visible)`.
 */
export function activeFieldsIn(
  fields: Field[],
  answers: Record<string, unknown>,
): Field[] {
  const out: Field[] = [];
  for (const f of fields) {
    if (!isVisible(f.visibility, answers)) continue;
    out.push(f);
    for (const o of (f.options ?? []) as Option[]) {
      if (o.fields?.length && optionSelected(f, o.value, answers)) {
        out.push(...activeFieldsIn(o.fields, answers));
      }
    }
  }
  return out;
}

/** Active fields within a section (visibility + nested-option reveals), flat. */
export function sectionActiveFields(
  section: Section,
  answers: Record<string, unknown>,
): Field[] {
  return activeFieldsIn(section.fields, answers);
}

/**
 * Resolve a section's explicit next target: the first goto-bearing
 * single_choice/dropdown field whose chosen option has a `goto`, else
 * `section.next`. Returns undefined when neither applies (the caller then
 * falls through to document order).
 */
export function nextSectionKey(
  section: Section,
  answers: Record<string, unknown>,
): string | undefined {
  for (const f of section.fields) {
    if (f.type === "single_choice" || f.type === "dropdown") {
      const chosen = answers[f.key];
      const opt = (f.options ?? []).find(
        (o) => String(o.value) === String(chosen),
      );
      if (opt?.goto) return opt.goto;
    }
  }
  return section.next;
}

/**
 * Walk the schema following branching; return the ordered list of reachable +
 * visible sections. Traversal matches the backend `_next_section`: chosen
 * option's goto, else `section.next`, else the next section in document order.
 */
export function reachableSections(
  schema: FormSchema,
  answers: Record<string, unknown>,
): Section[] {
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

/** Ordered keys of fields that are both reached AND visible (excludes display). */
export function reachableFieldKeys(
  schema: FormSchema,
  answers: Record<string, unknown>,
): string[] {
  const keys: string[] = [];
  for (const sec of reachableSections(schema, answers)) {
    for (const f of activeFieldsIn(sec.fields, answers)) {
      if (DISPLAY_TYPES.has(f.type)) continue;
      keys.push(f.key);
    }
  }
  return keys;
}

/**
 * Client-side required check (the server re-validates). Returns a map of
 * fieldKey -> error code for every reachable+visible required field left empty.
 */
export function validateRequired(
  schema: FormSchema,
  answers: Record<string, unknown>,
): Record<string, string> {
  const errs: Record<string, string> = {};
  for (const sec of reachableSections(schema, answers)) {
    for (const f of activeFieldsIn(sec.fields, answers)) {
      if (DISPLAY_TYPES.has(f.type)) continue;
      if (f.required && isEmpty(answers[f.key])) errs[f.key] = "required";
    }
  }
  return errs;
}
