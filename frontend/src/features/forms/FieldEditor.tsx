import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CheckSquare,
  ChevronDownSquare,
  Circle,
  GripVertical,
  ImagePlus,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useBuilderStore } from "./builderStore";
import { BranchingEditor } from "./BranchingEditor";
import type { Field, FieldRole, FieldType, Option, Section } from "./types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/Select";
import { compressImage } from "@/lib/compressImage";
import { t } from "@/lib/t";
import { cn } from "@/lib/tailwind";

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
  // Drag-to-reorder (mouse) state: which row is being dragged + the row it's
  // hovering over. The arrow buttons stay as the keyboard-accessible path.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  // Bulk-add text (comma/newline-separated names → one option each).
  const [bulk, setBulk] = useState("");

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
  // Per-option logo: compress to a small thumbnail and store it inline as a
  // data URL on the option (no upload/serving infra — see lib/compressImage).
  const setOptionImage = async (
    i: number,
    file: File | undefined,
  ): Promise<void> => {
    if (!file) return;
    const small = await compressImage(file, { maxDim: 160, quality: 0.8 });
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("read_failed"));
      reader.readAsDataURL(small);
    });
    setOption(i, { image: dataUrl });
  };
  // Reorder options so the admin can place any choice at any position.
  const moveOption = (i: number, dir: -1 | 1): void => {
    const j = i + dir;
    if (j < 0 || j >= options.length) return;
    const next = [...options];
    [next[i], next[j]] = [next[j], next[i]];
    updateField(sectionKey, field.key, { options: next });
  };
  // Drop a dragged option at any position (remove from `from`, insert at `to`
  // — the dragged option lands exactly on the target row's index).
  const reorderOption = (from: number, to: number): void => {
    if (
      from === to ||
      from < 0 ||
      to < 0 ||
      from >= options.length ||
      to >= options.length
    )
      return;
    const next = [...options];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    updateField(sectionKey, field.key, { options: next });
  };

  // Bulk-add: type/paste names separated by commas or new lines → one option
  // each (e.g. a list of schools). Blanks and labels already present are
  // skipped; the stored value is slugged from the label, uniquified, falling
  // back to optN when the name has no usable letters/digits.
  const slugValue = (label: string): string =>
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
  const addFromList = (): void => {
    const names = bulk
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.length === 0) return;
    const seenLabels = new Set(options.map((o) => o.label.trim().toLowerCase()));
    const usedValues = new Set(options.map((o) => o.value));
    const additions: Option[] = [];
    for (const label of names) {
      const lower = label.toLowerCase();
      if (seenLabels.has(lower)) continue;
      seenLabels.add(lower);
      let value = slugValue(label);
      if (!value || usedValues.has(value)) {
        let n = options.length + additions.length + 1;
        let candidate = value ? `${value}_${n}` : `opt${n}`;
        while (usedValues.has(candidate)) {
          n += 1;
          candidate = value ? `${value}_${n}` : `opt${n}`;
        }
        value = candidate;
      }
      usedValues.add(value);
      additions.push({ label, value });
    }
    if (additions.length === 0) return;
    updateField(sectionKey, field.key, {
      options: [...options, ...additions],
    });
    setBulk("");
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Choice options — the primary body for choice fields. */}
      {isChoice ? (
        <div className="flex flex-col gap-2">
          {options.map((o, i) => (
            <div
              key={i}
              data-option-row
              onDragOver={(e) => {
                if (dragIndex === null) return;
                e.preventDefault();
                if (overIndex !== i) setOverIndex(i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIndex !== null) reorderOption(dragIndex, i);
                setDragIndex(null);
                setOverIndex(null);
              }}
              className={cn(
                "flex items-center gap-1.5 rounded-md transition-colors",
                dragIndex === i ? "opacity-50" : "",
                overIndex === i && dragIndex !== null && dragIndex !== i
                  ? "ring-2 ring-primary/50"
                  : "",
              )}
            >
              {/* Drag handle — mouse reorder. Only the handle is draggable so
                  the label/value inputs stay text-selectable. Keyboard users
                  reorder with the arrow buttons. */}
              <span
                aria-hidden="true"
                draggable
                onDragStart={(e) => {
                  setDragIndex(i);
                  e.dataTransfer.effectAllowed = "move";
                  const row = e.currentTarget.closest("[data-option-row]");
                  if (row instanceof HTMLElement)
                    e.dataTransfer.setDragImage(row, 12, row.offsetHeight / 2);
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                  setOverIndex(null);
                }}
                title={t("Drag to reorder")}
                className="flex h-9 w-4 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/40 hover:text-muted-foreground active:cursor-grabbing"
              >
                <GripVertical className="h-4 w-4" />
              </span>
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
              {/* Per-option logo: thumbnail + remove, or an upload button. */}
              {o.image ? (
                <span className="relative inline-flex h-9 w-9 shrink-0">
                  <img
                    src={o.image}
                    alt=""
                    className="h-9 w-9 rounded-md border border-border object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => setOption(i, { image: undefined })}
                    aria-label={t("Remove image")}
                    className="absolute -right-1.5 -top-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X aria-hidden="true" className="h-2.5 w-2.5" />
                  </button>
                </span>
              ) : (
                <label
                  title={t("Add an image/logo for this option")}
                  className="inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-within:ring-2 focus-within:ring-ring"
                >
                  <ImagePlus aria-hidden="true" className="h-4 w-4" />
                  <span className="sr-only">{t("Add image")}</span>
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={(e) => {
                      void setOptionImage(i, e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
              )}
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

          {/* Bulk-add — paste/type a comma- or newline-separated list (e.g.
              every school's name) and Enter turns each into an option. */}
          <div className="flex flex-col gap-1.5 rounded-md border border-dashed border-border bg-muted/20 p-2.5">
            <Label htmlFor={`bulk-${field.key}`} className="text-xs font-medium">
              {t("Add many at once")}
            </Label>
            <div className="flex items-start gap-2">
              <textarea
                id={`bulk-${field.key}`}
                value={bulk}
                onChange={(e) => setBulk(e.target.value)}
                onKeyDown={(e) => {
                  // Enter adds the list; Shift+Enter keeps a newline so a
                  // multi-line paste can be edited before adding.
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    addFromList();
                  }
                }}
                rows={2}
                placeholder={t(
                  "Type names separated by commas, then press Enter · e.g. St. Xavier's, Don Bosco, Holy Cross",
                )}
                aria-label={t("Add many options at once")}
                className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addFromList}
                disabled={!bulk.trim()}
              >
                <Plus aria-hidden="true" className="h-4 w-4" />
                {t("Add")}
              </Button>
            </div>
            <p className="text-[0.6875rem] text-muted-foreground">
              {t("Commas or new lines work. Enter adds; duplicates are skipped.")}
            </p>
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

      {/* Repeatable-group row bounds (W2-B): how many rows a respondent may
          add · e.g. widen a 1v1 category's players group from 1/1 to 1/3 to
          allow substitutes. Server-enforced on submission. */}
      {field.type === "group" && field.repeatable ? (
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`minitems-${field.key}`}>{t("Min rows")}</Label>
            <Input
              id={`minitems-${field.key}`}
              inputMode="numeric"
              value={field.min_items ?? ""}
              onChange={(e) =>
                updateField(sectionKey, field.key, {
                  min_items:
                    e.target.value === ""
                      ? undefined
                      : Math.max(0, Math.floor(Number(e.target.value) || 0)),
                })
              }
              className="font-tabular"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`maxitems-${field.key}`}>{t("Max rows")}</Label>
            <Input
              id={`maxitems-${field.key}`}
              inputMode="numeric"
              value={field.max_items ?? ""}
              onChange={(e) =>
                updateField(sectionKey, field.key, {
                  max_items:
                    e.target.value === ""
                      ? undefined
                      : Math.max(0, Math.floor(Number(e.target.value) || 0)),
                })
              }
              className="font-tabular"
            />
          </div>
        </div>
      ) : null}

      {/* Public-directory exposure (W2): each included choice field becomes
          a filter + breakdown card on the public registered-institutions
          page · too many gets noisy, so admins can opt fields out. The
          generator already opts category-chain questions out by default. */}
      {["single_choice", "multi_choice", "dropdown"].includes(field.type) ? (
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={field.directory !== false}
            onChange={(e) =>
              updateField(sectionKey, field.key, {
                directory: e.target.checked ? undefined : false,
              })
            }
            className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]"
          />
          <span>
            {t("Show in the public directory (filter + breakdown)")}
            <span className="block text-xs text-muted-foreground">
              {t("Each adds a filter on the public page; keep only the useful ones.")}
            </span>
          </span>
        </label>
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
          {t("Unchanged if you rename the label or change the type.")}
        </span>
      </div>
    </div>
  );
}
