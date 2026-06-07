import {
  ArrowDown,
  ArrowUp,
  GitBranch,
  Plus,
  Trash2,
} from "lucide-react";
import { useBuilderStore } from "./builderStore";
import type { Field, Section } from "./types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/** Short human label for a field type shown on the canvas row. */
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

function FieldRow({
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
  const removeField = useBuilderStore((s) => s.removeField);
  const reorderFields = useBuilderStore((s) => s.reorderFields);
  const selected = useBuilderStore((s) => s.selected);
  const isSelected =
    selected?.sectionKey === section.key && selected?.fieldKey === field.key;
  const hasBranching =
    !!field.visibility ||
    (field.options ?? []).some((o) => !!o.goto);

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-2 transition-colors",
        isSelected
          ? "border-primary bg-accent/40"
          : "border-border bg-background hover:bg-accent/30",
      )}
    >
      <button
        type="button"
        onClick={() => select(section.key, field.key)}
        className="flex min-w-0 flex-1 flex-col items-start text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t("Edit field")}
        aria-pressed={isSelected}
      >
        <span className="flex items-center gap-1.5 truncate text-sm font-medium">
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
        </span>
        <span className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
          {t(TYPE_LABEL[field.type] ?? field.type)}
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-0.5">
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
  const updateSection = useBuilderStore((s) => s.updateSection);
  const removeSection = useBuilderStore((s) => s.removeSection);
  const setActiveSection = useBuilderStore((s) => s.setActiveSection);
  const activeSectionKey = useBuilderStore((s) => s.activeSectionKey);
  const isActive = activeSectionKey === section.key;

  return (
    <section
      aria-label={section.title || t("Section")}
      onFocusCapture={() => setActiveSection(section.key)}
      onClick={() => setActiveSection(section.key)}
      className={cn(
        "rounded-xl border bg-card shadow-sm",
        isActive ? "border-primary" : "border-border",
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
      <div className="flex flex-col gap-2 p-4">
        {section.fields.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            {t("No fields yet — add one from the palette.")}
          </p>
        ) : (
          section.fields.map((f, i) => (
            <FieldRow
              key={f.key}
              section={section}
              field={f}
              index={i}
              count={section.fields.length}
            />
          ))
        )}
      </div>
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
    <div className={cn("flex flex-col gap-4", className)}>
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
