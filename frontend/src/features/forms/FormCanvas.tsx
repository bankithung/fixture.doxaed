import { useEffect, useRef } from "react";
import {
  ArrowDown,
  ArrowUp,
  GitBranch,
  GripVertical,
  Plus,
  Trash2,
} from "lucide-react";
import { useBuilderStore } from "./builderStore";
import { FieldEditor } from "./FieldEditor";
import { FieldRenderer } from "./fieldRenderers";
import type { Field, FieldType, Section } from "./types";
import { priorFields } from "./visibility";
import { VisibilityRuleEditor } from "./VisibilityRuleEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/** Short human label for a field type. */
const TYPE_LABEL: Record<string, string> = {
  short_text: "Short text",
  long_text: "Paragraph",
  single_choice: "Single choice",
  multi_choice: "Checkboxes",
  dropdown: "Dropdown",
  email: "Email",
  phone: "Phone",
  number: "Number",
  date: "Date",
  time: "Time",
  rating: "Rating",
  linear_scale: "Scale",
  address: "Address",
  file_upload: "File upload",
  section_text: "Text block",
  yes_no: "Yes / No",
  group: "Repeating group",
};

const TYPE_OPTIONS = Object.entries(TYPE_LABEL).map(([value, label]) => ({
  value,
  label: t(label),
}));

const CHOICE_TYPES = new Set<string>([
  "single_choice",
  "multi_choice",
  "dropdown",
]);

/**
 * One question card. Google-Forms style: a compact read-only preview when not
 * selected; click anywhere to expand into a full inline editor (title + type +
 * options + settings). Reorder / delete controls live in the expanded footer.
 */
function FieldCard({
  section,
  field,
  index,
  count,
}: {
  section: Section;
  field: Field;
  index: number;
  count: number;
}): React.ReactElement {
  const select = useBuilderStore((s) => s.select);
  const updateField = useBuilderStore((s) => s.updateField);
  const removeField = useBuilderStore((s) => s.removeField);
  const reorderFields = useBuilderStore((s) => s.reorderFields);
  const clearSelection = useBuilderStore((s) => s.clearSelection);
  const selected = useBuilderStore((s) => s.selected);
  const isSelected =
    selected?.sectionKey === section.key && selected?.fieldKey === field.key;
  const cardRef = useRef<HTMLDivElement>(null);

  // Click anywhere outside the open field card collapses it (deselect). Clicks
  // inside the card — or inside a portal'd Select dropdown (role="listbox") —
  // keep it open.
  useEffect(() => {
    if (!isSelected) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node | null;
      if (!target) return;
      if (cardRef.current?.contains(target)) return;
      if (
        target instanceof Element &&
        target.closest('[role="listbox"], [data-select-panel]')
      )
        return;
      clearSelection();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [isSelected, clearSelection]);
  const isChoice = CHOICE_TYPES.has(field.type);
  const hasBranching =
    !!field.visibility || (field.options ?? []).some((o) => !!o.goto);

  const changeType = (next: string): void => {
    const patch: Partial<Field> = { type: next as FieldType };
    if (CHOICE_TYPES.has(next) && !(field.options && field.options.length)) {
      patch.options = [{ value: "opt1", label: "Option 1" }];
    }
    updateField(section.key, field.key, patch);
  };

  // -- Compact (collapsed) card -------------------------------------------
  if (!isSelected) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => select(section.key, field.key)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            select(section.key, field.key);
          }
        }}
        className="group cursor-pointer rounded-xl border border-border bg-background p-4 transition-colors hover:border-primary/40 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="mb-2 flex items-start justify-between gap-2">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            {field.label || t("Untitled field")}
            {field.required ? (
              <span aria-hidden="true" className="text-destructive">
                *
              </span>
            ) : null}
            {hasBranching ? (
              <GitBranch
                aria-label={t("Has branching")}
                className="h-3.5 w-3.5 text-primary"
              />
            ) : null}
          </p>
          <span className="shrink-0 text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
            {t(TYPE_LABEL[field.type] ?? field.type)}
          </span>
        </div>
        {/* Non-interactive preview of the respondent control. */}
        <div className="pointer-events-none opacity-70">
          <FieldRenderer
            field={field}
            value={undefined}
            onChange={() => {}}
            disabled
          />
        </div>
      </div>
    );
  }

  // -- Expanded (editing) card --------------------------------------------
  return (
    <div
      ref={cardRef}
      className="rounded-xl border border-primary bg-card shadow-sm ring-1 ring-primary/20"
    >
      {/* Accent bar like Google Forms' active question. */}
      <div className="h-1.5 rounded-t-xl bg-primary" />
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-start gap-2">
          <GripVertical
            aria-hidden="true"
            className="mt-2 h-4 w-4 shrink-0 text-muted-foreground/40"
          />
          <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-start">
            <Input
              aria-label={t("Question")}
              value={field.label}
              autoFocus
              onChange={(e) =>
                updateField(section.key, field.key, { label: e.target.value })
              }
              placeholder={t("Question")}
              className="flex-1 text-base font-medium"
            />
            <Select
              aria-label={t("Field type")}
              value={field.type}
              options={TYPE_OPTIONS}
              onChange={changeType}
              className="sm:w-48"
            />
          </div>
        </div>

        {/* Preview for non-choice types (choice options are edited below). */}
        {!isChoice && field.type !== "section_text" ? (
          <div className="pointer-events-none rounded-lg border border-dashed border-border bg-muted/20 p-3 opacity-80">
            <FieldRenderer
              field={field}
              value={undefined}
              onChange={() => {}}
              disabled
            />
          </div>
        ) : null}

        <FieldEditor section={section} field={field} />

        {/* Footer: required + reorder + delete. */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          {field.type !== "section_text" ? (
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={!!field.required}
                onChange={(e) =>
                  updateField(section.key, field.key, {
                    required: e.target.checked,
                  })
                }
                className="h-4 w-4 accent-[hsl(var(--primary))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <span>{t("Required")}</span>
            </label>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              disabled={index === 0}
              onClick={() => reorderFields(section.key, index, index - 1)}
              aria-label={t("Move field up")}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30"
            >
              <ArrowUp aria-hidden="true" className="h-4 w-4" />
            </button>
            <button
              type="button"
              disabled={index === count - 1}
              onClick={() => reorderFields(section.key, index, index + 1)}
              aria-label={t("Move field down")}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30"
            >
              <ArrowDown aria-hidden="true" className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => removeField(section.key, field.key)}
              aria-label={t("Delete field")}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Trash2 aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionCard({
  section,
  index,
  total,
}: {
  section: Section;
  index: number;
  total: number;
}): React.ReactElement {
  const sections = useBuilderStore((s) => s.schema.sections);
  const updateSection = useBuilderStore((s) => s.updateSection);
  const removeSection = useBuilderStore((s) => s.removeSection);
  const setActiveSection = useBuilderStore((s) => s.setActiveSection);
  const activeSectionKey = useBuilderStore((s) => s.activeSectionKey);
  const isActive = activeSectionKey === section.key;

  const triggers = priorFields(sections, section.key);
  const hasVisibility = !!section.visibility;

  return (
    <section
      aria-label={section.title || t("Section")}
      onFocusCapture={() => setActiveSection(section.key)}
      onClick={() => setActiveSection(section.key)}
      className={cn(
        "rounded-xl border bg-card shadow-sm",
        isActive ? "border-primary/60" : "border-border",
      )}
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-primary/10 px-1.5 font-tabular text-xs font-semibold text-primary">
          {index + 1}
        </span>
        <Input
          aria-label={t("Section title")}
          value={section.title}
          onChange={(e) => updateSection(section.key, { title: e.target.value })}
          placeholder={t("Section title")}
          className="h-9 flex-1 border-transparent bg-transparent px-2 font-semibold focus-visible:border-input"
        />
        {hasVisibility ? (
          <GitBranch
            aria-label={t("Section is conditional")}
            className="h-4 w-4 shrink-0 text-primary"
          />
        ) : null}
        {total > 1 ? (
          <button
            type="button"
            onClick={() => removeSection(section.key)}
            aria-label={t("Delete section")}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" />
          </button>
        ) : null}
      </div>
      <div className="flex flex-col gap-3 p-4">
        {section.fields.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
            {t("No questions yet. Add one from “Add a field”.")}
          </p>
        ) : (
          section.fields.map((f, i) => (
            <FieldCard
              key={f.key}
              section={section}
              field={f}
              index={i}
              count={section.fields.length}
            />
          ))
        )}
      </div>

      {triggers.length > 0 ? (
        <div className="border-t border-border px-4 py-3">
          <p className="mb-2 text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {t("Conditions")}
          </p>
          <VisibilityRuleEditor
            label="Show this section when"
            rule={section.visibility}
            triggers={triggers}
            onChange={(rule) => updateSection(section.key, { visibility: rule })}
          />
        </div>
      ) : null}
    </section>
  );
}

/** Center column of the builder: the live section/field tree. */
export function FormCanvas({
  className,
}: {
  className?: string;
}): React.ReactElement {
  const sections = useBuilderStore((s) => s.schema.sections);
  const addSection = useBuilderStore((s) => s.addSection);

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {sections.map((s, i) => (
        <SectionCard key={s.key} section={s} index={i} total={sections.length} />
      ))}
      <div>
        <Button type="button" variant="outline" onClick={addSection}>
          <Plus aria-hidden="true" className="h-4 w-4" />
          {t("Add section")}
        </Button>
      </div>
    </div>
  );
}
