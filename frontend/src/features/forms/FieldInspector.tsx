import { Plus, Trash2 } from "lucide-react";
import { useBuilderStore } from "./builderStore";
import { BranchingEditor } from "./BranchingEditor";
import type { FieldRole, Option } from "./types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

const ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "No special role" },
  { value: "title", label: "Title (entry name)" },
  { value: "email", label: "Respondent email" },
  { value: "phone", label: "Respondent phone" },
  { value: "name", label: "Respondent name" },
];

const CHOICE_TYPES = new Set<string>([
  "single_choice",
  "multi_choice",
  "dropdown",
]);
const SCALE_TYPES = new Set<string>(["rating", "linear_scale", "number"]);

/** Right rail of the builder: edit the selected field. */
export function FieldInspector({
  className,
}: {
  className?: string;
}): React.ReactElement {
  const selected = useBuilderStore((s) => s.selected);
  const sections = useBuilderStore((s) => s.schema.sections);
  const updateField = useBuilderStore((s) => s.updateField);

  const section = sections.find((s) => s.key === selected?.sectionKey);
  const field = section?.fields.find((f) => f.key === selected?.fieldKey);

  if (!selected || !field || !section) {
    return (
      <aside
        aria-label={t("Field settings")}
        className={cn(
          "flex flex-col gap-2 rounded-xl border border-border bg-card p-4 shadow-sm",
          className,
        )}
      >
        <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {t("Field settings")}
        </p>
        <p className="text-sm text-muted-foreground">
          {t("Select a field on the canvas to edit it.")}
        </p>
      </aside>
    );
  }

  const sectionKey = section.key;
  const isChoice = CHOICE_TYPES.has(field.type);
  const isScale = SCALE_TYPES.has(field.type);
  const options = field.options ?? [];

  const setOption = (i: number, patch: Partial<Option>) =>
    updateField(sectionKey, field.key, {
      options: options.map((o, j) => (j === i ? { ...o, ...patch } : o)),
    });
  const addOption = () =>
    updateField(sectionKey, field.key, {
      options: [
        ...options,
        { value: `opt${options.length + 1}`, label: `Option ${options.length + 1}` },
      ],
    });
  const removeOption = (i: number) =>
    updateField(sectionKey, field.key, {
      options: options.filter((_, j) => j !== i),
    });

  return (
    <aside
      aria-label={t("Field settings")}
      className={cn(
        "flex flex-col gap-4 rounded-xl border border-border bg-card p-4 shadow-sm",
        className,
      )}
    >
      <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {t("Field settings")}
      </p>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="insp-label">{t("Label")}</Label>
        <Input
          id="insp-label"
          value={field.label}
          onChange={(e) =>
            updateField(sectionKey, field.key, { label: e.target.value })
          }
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="insp-help">{t("Help text")}</Label>
        <Input
          id="insp-help"
          value={field.help ?? ""}
          onChange={(e) =>
            updateField(sectionKey, field.key, { help: e.target.value })
          }
          placeholder={t("Optional hint shown under the label")}
        />
      </div>

      {field.type !== "section_text" ? (
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={!!field.required}
            onChange={(e) =>
              updateField(sectionKey, field.key, { required: e.target.checked })
            }
            className="h-4 w-4 accent-[hsl(var(--primary))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <span>{t("Required")}</span>
        </label>
      ) : null}

      {field.type !== "section_text" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="insp-role">{t("Maps to")}</Label>
          <Select
            id="insp-role"
            value={field.role ?? ""}
            options={ROLE_OPTIONS.map((o) => ({
              value: o.value,
              label: t(o.label),
            }))}
            onChange={(role) =>
              updateField(sectionKey, field.key, {
                role: (role || undefined) as FieldRole | undefined,
              })
            }
            placeholder={t("No special role")}
          />
        </div>
      ) : null}

      {/* Options editor for choice fields. */}
      {isChoice ? (
        <div className="flex flex-col gap-2">
          <Label>{t("Options")}</Label>
          {options.map((o, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                aria-label={t("Option label")}
                value={o.label}
                onChange={(e) => setOption(i, { label: e.target.value })}
                placeholder={t("Option label")}
              />
              <Input
                aria-label={t("Option value")}
                value={o.value}
                onChange={(e) => setOption(i, { value: e.target.value })}
                placeholder={t("value")}
                className="w-24 font-tabular"
              />
              {options.length > 1 ? (
                <button
                  type="button"
                  onClick={() => removeOption(i)}
                  aria-label={t("Remove option")}
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Trash2 aria-hidden="true" className="h-4 w-4" />
                </button>
              ) : null}
            </div>
          ))}
          <div>
            <Button type="button" variant="outline" size="sm" onClick={addOption}>
              <Plus aria-hidden="true" className="h-4 w-4" />
              {t("Add option")}
            </Button>
          </div>
        </div>
      ) : null}

      {/* Validation bounds for scaled/numeric fields. */}
      {isScale ? (
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="insp-min">{t("Min")}</Label>
            <Input
              id="insp-min"
              inputMode="numeric"
              value={field.validation?.min ?? ""}
              onChange={(e) =>
                updateField(sectionKey, field.key, {
                  validation: {
                    ...field.validation,
                    min: e.target.value === "" ? undefined : Number(e.target.value),
                  },
                })
              }
              className="font-tabular"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="insp-max">{t("Max")}</Label>
            <Input
              id="insp-max"
              inputMode="numeric"
              value={field.validation?.max ?? ""}
              onChange={(e) =>
                updateField(sectionKey, field.key, {
                  validation: {
                    ...field.validation,
                    max: e.target.value === "" ? undefined : Number(e.target.value),
                  },
                })
              }
              className="font-tabular"
            />
          </div>
        </div>
      ) : null}

      {field.type === "multi_choice" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="insp-maxsel">{t("Max selections")}</Label>
          <Input
            id="insp-maxsel"
            inputMode="numeric"
            value={field.validation?.maxSelections ?? ""}
            onChange={(e) =>
              updateField(sectionKey, field.key, {
                validation: {
                  ...field.validation,
                  maxSelections:
                    e.target.value === "" ? undefined : Number(e.target.value),
                },
              })
            }
            className="font-tabular"
          />
        </div>
      ) : null}

      <BranchingEditor sectionKey={sectionKey} field={field} />
    </aside>
  );
}
