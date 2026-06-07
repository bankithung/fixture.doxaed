import { useBuilderStore } from "./builderStore";
import type { Field, Section, Visibility, VisibilityOp } from "./types";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/Select";
import { t } from "@/lib/t";

const END_KEY = "_end";

/** Visibility operators offered in the rule builder (mirrors backend
 *  `VISIBILITY_OPS`). */
const VISIBILITY_OPS: { value: VisibilityOp; label: string }[] = [
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "in", label: "is one of" },
  { value: "includes", label: "includes" },
  { value: "gt", label: "greater than" },
  { value: "lt", label: "less than" },
  { value: "answered", label: "is answered" },
];

const CHOICE_TYPES = new Set<string>([
  "single_choice",
  "multi_choice",
  "dropdown",
]);

/** Operators that don't need a value input. */
const VALUELESS_OPS = new Set<VisibilityOp>(["answered"]);

/** All fields that appear before the given section (valid visibility triggers). */
function priorFields(sections: Section[], sectionKey: string): Field[] {
  const out: Field[] = [];
  for (const sec of sections) {
    if (sec.key === sectionKey) break;
    out.push(...sec.fields);
  }
  return out;
}

function VisibilityRuleEditor({
  label,
  rule,
  triggers,
  onChange,
}: {
  label: string;
  rule: Visibility | null | undefined;
  triggers: Field[];
  onChange: (rule: Visibility | null) => void;
}): React.ReactElement {
  const trigger = triggers.find((f) => f.key === rule?.field);
  const triggerOpts = [
    { value: "", label: t("Always show") },
    ...triggers.map((f) => ({ value: f.key, label: f.label || f.key })),
  ];
  const valueOpts = (trigger?.options ?? []).map((o) => ({
    value: String(o.value),
    label: o.label,
  }));

  return (
    <div className="flex flex-col gap-2">
      <Label>{t(label)}</Label>
      <Select
        aria-label={t("Condition field")}
        value={rule?.field ?? ""}
        options={triggerOpts}
        onChange={(field) =>
          onChange(field ? { field, op: rule?.op ?? "equals", value: rule?.value } : null)
        }
        placeholder={t("Always show")}
      />
      {rule?.field ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-2.5">
          <Select
            aria-label={t("Condition operator")}
            value={rule.op}
            options={VISIBILITY_OPS.map((o) => ({
              value: o.value,
              label: t(o.label),
            }))}
            onChange={(op) =>
              onChange({ ...rule, op: op as VisibilityOp })
            }
          />
          {VALUELESS_OPS.has(rule.op) ? null : valueOpts.length > 0 ? (
            <Select
              aria-label={t("Condition value")}
              value={String(rule.value ?? "")}
              options={[{ value: "", label: t("Select a value…") }, ...valueOpts]}
              onChange={(value) =>
                onChange({
                  ...rule,
                  value: rule.op === "in" ? [value] : value,
                })
              }
              placeholder={t("Select a value…")}
            />
          ) : (
            <input
              aria-label={t("Condition value")}
              value={String(rule.value ?? "")}
              onChange={(e) => onChange({ ...rule, value: e.target.value })}
              placeholder={t("Value")}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Branching controls for the selected field + its section:
 *   (a) per-option `goto` targets (single_choice / dropdown),
 *   (b) the section's fall-through `next`,
 *   (c) the field's visibility rule (and the section's, when relevant).
 * Section keys + an "End" sentinel populate every goto/next Select.
 */
export function BranchingEditor({
  sectionKey,
  field,
}: {
  sectionKey: string;
  field: Field;
}): React.ReactElement {
  const sections = useBuilderStore((s) => s.schema.sections);
  const updateField = useBuilderStore((s) => s.updateField);
  const updateSection = useBuilderStore((s) => s.updateSection);
  const section = sections.find((s) => s.key === sectionKey);

  const sectionTargets = [
    { value: "", label: t("Default (next section)") },
    ...sections
      .filter((s) => s.key !== sectionKey)
      .map((s) => ({ value: s.key, label: s.title || s.key })),
    { value: END_KEY, label: t("End of form") },
  ];

  const triggers = priorFields(sections, sectionKey);
  const isChoice = CHOICE_TYPES.has(field.type);

  return (
    <div className="flex flex-col gap-4 border-t border-border pt-4">
      <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {t("Branching & logic")}
      </p>

      {/* (a) Per-option goto (single_choice / dropdown only). */}
      {field.type === "single_choice" || field.type === "dropdown" ? (
        <div className="flex flex-col gap-2">
          <Label>{t("Jump to a section per answer")}</Label>
          {(field.options ?? []).map((opt, i) => (
            <div key={`${opt.value}-${i}`} className="flex items-center gap-2">
              <span className="w-28 shrink-0 truncate text-sm text-muted-foreground">
                {opt.label || opt.value}
              </span>
              <Select
                aria-label={`${t("Go to")} — ${opt.label || opt.value}`}
                className="flex-1"
                value={opt.goto ?? ""}
                options={sectionTargets.filter((o) => o.value !== "")}
                placeholder={t("No jump")}
                onChange={(goto) => {
                  const options = (field.options ?? []).map((o, j) =>
                    j === i ? { ...o, goto: goto || undefined } : o,
                  );
                  updateField(sectionKey, field.key, { options });
                }}
              />
            </div>
          ))}
        </div>
      ) : null}

      {/* (b) Section fall-through next. */}
      {section ? (
        <div className="flex flex-col gap-2">
          <Label>{t("After this section, go to")}</Label>
          <Select
            aria-label={t("Next section")}
            value={section.next ?? ""}
            options={sectionTargets}
            onChange={(next) =>
              updateSection(sectionKey, { next: next || undefined })
            }
            placeholder={t("Default (next section)")}
          />
        </div>
      ) : null}

      {/* (c) Field visibility rule. */}
      {triggers.length > 0 ? (
        <VisibilityRuleEditor
          label={isChoice ? "Show this field when" : "Show this field when"}
          rule={field.visibility}
          triggers={triggers}
          onChange={(rule) =>
            updateField(sectionKey, field.key, { visibility: rule })
          }
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          {t("Add choice fields earlier in the form to gate this field on an answer.")}
        </p>
      )}
    </div>
  );
}
