/**
 * Pure helpers for authoring `Visibility` rules in the form builder. Kept in a
 * non-component module so React Fast Refresh stays happy (the editor component
 * lives in `VisibilityRuleEditor.tsx`).
 */
import type { Field } from "./types";

/**
 * All fields that appear before the given section. A section/field may only be
 * gated on answers asked EARLIER in the form, so these are the only valid
 * visibility triggers.
 */
export function priorFields(
  sections: { key: string; fields: Field[] }[],
  sectionKey: string,
): Field[] {
  const out: Field[] = [];
  for (const sec of sections) {
    if (sec.key === sectionKey) break;
    out.push(...sec.fields);
  }
  return out;
}
