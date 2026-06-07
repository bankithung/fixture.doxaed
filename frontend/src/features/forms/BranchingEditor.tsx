import { useBuilderStore } from "./builderStore";
import type { Field } from "./types";
import { priorFields } from "./visibility";
import { VisibilityRuleEditor } from "./VisibilityRuleEditor";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/Select";
import { t } from "@/lib/t";

const END_KEY = "_end";

/**
 * Branching controls for the selected field + its section:
 *   (a) per-option `goto` targets (single_choice / dropdown),
 *   (b) the section's fall-through `next`,
 *   (c) the field's visibility rule (via the shared VisibilityRuleEditor).
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
          label="Show this field when"
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
