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
import type { FormSchema, Section, Visibility } from "@/features/forms/types";

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
    case "gt":
      return Number(val) > Number(target);
    case "lt":
      return Number(val) < Number(target);
    default:
      return false;
  }
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
    for (const f of sec.fields) {
      if (DISPLAY_TYPES.has(f.type)) continue;
      if (isVisible(f.visibility, answers)) keys.push(f.key);
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
    for (const f of sec.fields) {
      if (DISPLAY_TYPES.has(f.type) || !isVisible(f.visibility, answers)) {
        continue;
      }
      if (f.required && isEmpty(answers[f.key])) errs[f.key] = "required";
    }
  }
  return errs;
}
