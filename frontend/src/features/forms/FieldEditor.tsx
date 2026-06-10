import {
  ArrowDown,
  ArrowUp,
  CheckSquare,
  ChevronDownSquare,
  Circle,
  Plus,
  Trash2,
} from "lucide-react";
import { useBuilderStore } from "./builderStore";
import { BranchingEditor } from "./BranchingEditor";
import type { Field, FieldRole, FieldType, Option, Section } from "./types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/Select";
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

/** Per-option leading glyph that mirrors how the option will render. */
function optionGlyph(type: FieldType): React.ReactElement {
  if (type === "multi_choice")
    return <CheckSquare aria-hidden="true" className="h-4 w-4 text-muted-foreground" />;
  if (type === "dropdown")
    return (
      <ChevronDownSquare aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
    );
  return <Circle aria-hidden="true" className="h-4 w-4 text-muted-foreground" />;
}

/**
 * Inline field editor — the controls that live INSIDE an expanded field card
 * (Google-Forms style). The card itself owns the label + type controls; this
 * renders options, help, required, role mapping, validation, and branching.
 */
export function FieldEditor({
  section,
  field,
}: {
  section: Section;
  field: Field;
}): React.ReactElement {
  const updateField = useBuilderStore((s) => s.updateField);
  const sectionKey = section.key;
  const isChoice = CHOICE_TYPES.has(field.type);
  const isScale = SCALE_TYPES.has(field.type);
  const options = field.options ?? [];

  const setOption = (i: number, patch: Partial<Option>): void =>
    updateField(sectionKey, field.key, {
      options: options.map((o, j) => (j === i ? { ...o, ...patch } : o)),
    });
  const addOption = (): void =>
    updateField(sectionKey, field.key, {
      options: [
        ...options,
        {
          value: `opt${options.length + 1}`,
          label: `Option ${options.length + 1}`,
        },
      ],
    });
  const removeOption = (i: number): void =>
    updateField(sectionKey, field.key, {
      options: options.filter((_, j) => j !== i),
    });
  // Reorder options so the admin can place any choice at any position.
  const moveOption = (i: number, dir: -1 | 1): void => {
    const j = i + dir;
    if (j < 0 || j >= options.length) return;
    const next = [...options];
    [next[i], next[j]] = [next[j], next[i]];
    updateField(sectionKey, field.key, { options: next });
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Choice options — the primary body for choice fields. */}
      {isChoice ? (
        <div className="flex flex-col gap-2">
          {options.map((o, i) => (
            <div key={i} className="flex items-center gap-2">
              {optionGlyph(field.type)}
              <Input
                aria-label={t("Option label")}
                value={o.label}
                onChange={(e) => setOption(i, { label: e.target.value })}
                placeholder={t("Option")}
                className="flex-1"
              />
              <Input
                aria-label={t("Stored value")}
                value={o.value}
                onChange={(e) => setOption(i, { value: e.target.value })}
                placeholder={t("value")}
                className="w-24 font-tabular text-xs"
              />
              <button
                type="button"
                disabled={i === 0}
                onClick={() => moveOption(i, -1)}
                aria-label={t("Move option up")}
                className="inline-flex h-9 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30"
              >
                <ArrowUp aria-hidden="true" className="h-4 w-4" />
              </button>
              <button
                type="button"
                disabled={i === options.length - 1}
                onClick={() => moveOption(i, 1)}
                aria-label={t("Move option down")}
                className="inline-flex h-9 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30"
              >
                <ArrowDown aria-hidden="true" className="h-4 w-4" />
              </button>
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

      {/* Help text. */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`help-${field.key}`}>{t("Help text")}</Label>
        <Input
          id={`help-${field.key}`}
          value={field.help ?? ""}
          onChange={(e) =>
            updateField(sectionKey, field.key, { help: e.target.value })
          }
          placeholder={t("Optional hint shown under the label")}
        />
      </div>

      {/* Validation bounds for scaled/numeric fields. */}
      {isScale ? (
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`min-${field.key}`}>{t("Min")}</Label>
            <Input
              id={`min-${field.key}`}
              inputMode="numeric"
              value={field.validation?.min ?? ""}
              onChange={(e) =>
                updateField(sectionKey, field.key, {
                  validation: {
                    ...field.validation,
                    min:
                      e.target.value === ""
                        ? undefined
                        : Number(e.target.value),
                  },
                })
              }
              className="font-tabular"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`max-${field.key}`}>{t("Max")}</Label>
            <Input
              id={`max-${field.key}`}
              inputMode="numeric"
              value={field.validation?.max ?? ""}
              onChange={(e) =>
                updateField(sectionKey, field.key, {
                  validation: {
                    ...field.validation,
                    max:
                      e.target.value === ""
                        ? undefined
                        : Number(e.target.value),
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
          <Label htmlFor={`maxsel-${field.key}`}>{t("Max selections")}</Label>
          <Input
            id={`maxsel-${field.key}`}
            inputMode="numeric"
            value={field.validation?.maxSelections ?? ""}
            onChange={(e) =>
              updateField(sectionKey, field.key, {
                validation: {
                  ...field.validation,
                  maxSelections:
                    e.target.value === ""
                      ? undefined
                      : Number(e.target.value),
                },
              })
            }
            className="w-32 font-tabular"
          />
        </div>
      ) : null}

      {/* Maps-to role. */}
      {field.type !== "section_text" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`role-${field.key}`}>{t("Maps to")}</Label>
          <Select
            id={`role-${field.key}`}
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
            className="max-w-xs"
          />
        </div>
      ) : null}

      <BranchingEditor sectionKey={sectionKey} field={field} />

      {/* The field's stable variable — used to read its answers everywhere. It
          never changes when you rename the label or switch the type. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
        <span className="font-medium">{t("Variable")}</span>
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem] text-foreground">
          {field.key}
        </code>
        <span>
          {t("Stays the same if you rename the label or change the type.")}
        </span>
      </div>
    </div>
  );
}
