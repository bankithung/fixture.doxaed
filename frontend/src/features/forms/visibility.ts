/**
 * Pure helpers for authoring `Visibility` rules in the form builder. Kept in a
 * non-component module so React Fast Refresh stays happy (the editor component
 * lives in `VisibilityRuleEditor.tsx`).
 */
import type { Field } from "./types";

/**
 * All fields that appear before the given section — and, when `fieldKey` is
 * given, before that field WITHIN the section too. A section/field may only
 * be gated on answers asked EARLIER in the form, so these are the only valid
 * visibility triggers. Same-section triggers are what progressive category
 * chains use (sport → U19 → Boys → 5v5 inside one section), so field-level
 * rules must offer them (W2-A) while section-level rules must not (a section
 * gate applies before any of its own fields renders).
 */
export function priorFields(
  sections: { key: string; fields: Field[] }[],
  sectionKey: string,
  fieldKey?: string,
): Field[] {
  const out: Field[] = [];
  for (const sec of sections) {
    if (sec.key === sectionKey) {
      if (fieldKey !== undefined) {
        for (const f of sec.fields) {
          if (f.key === fieldKey) break;
          out.push(f);
        }
      }
      break;
    }
    out.push(...sec.fields);
  }
  return out;
}
