import {
  AlignLeft,
  Building2,
  CalendarDays,
  CheckSquare,
  ChevronDownSquare,
  Circle,
  Clock,
  FileUp,
  GraduationCap,
  Hash,
  Heading,
  ListChecks,
  Mail,
  MapPin,
  Phone,
  Sliders,
  Star,
  ToggleLeft,
  Type,
  User,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useBuilderStore } from "./builderStore";
import type { Field, FieldRole, FieldType } from "./types";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/** One-click "common fields" — real, named variables with the right role + key,
 *  so an admin builds a registration form fast without renaming everything. The
 *  `key` is the stable variable; the store de-duplicates it if added twice. */
const COMMON_FIELDS: {
  init: Partial<Field>;
  type: FieldType;
  label: string;
  icon: LucideIcon;
}[] = [
  { type: "short_text", label: "School name", icon: GraduationCap,
    init: { key: "school_name", label: "School name", role: "title" as FieldRole } },
  { type: "short_text", label: "College name", icon: Building2,
    init: { key: "college_name", label: "College name", role: "title" as FieldRole } },
  { type: "short_text", label: "Contact person", icon: User,
    init: { key: "contact_name", label: "Contact person", role: "name" as FieldRole } },
  { type: "email", label: "Email", icon: Mail,
    init: { key: "contact_email", label: "Email", role: "email" as FieldRole } },
  { type: "phone", label: "Phone", icon: Phone,
    init: { key: "contact_phone", label: "Phone", role: "phone" as FieldRole } },
  { type: "date", label: "Date", icon: CalendarDays,
    init: { key: "date", label: "Date" } },
];

/** Field-type palette entries: icon + label. Order groups text / choice /
 *  scaled / special so the toolbox reads top-to-bottom sensibly. */
const PALETTE: { type: FieldType; label: string; icon: LucideIcon }[] = [
  { type: "short_text", label: "Short text", icon: Type },
  { type: "long_text", label: "Paragraph", icon: AlignLeft },
  { type: "single_choice", label: "Single choice", icon: Circle },
  { type: "multi_choice", label: "Checkboxes", icon: CheckSquare },
  { type: "dropdown", label: "Dropdown", icon: ChevronDownSquare },
  { type: "yes_no", label: "Yes / No", icon: ToggleLeft },
  { type: "email", label: "Email", icon: Mail },
  { type: "phone", label: "Phone", icon: Phone },
  { type: "number", label: "Number", icon: Hash },
  { type: "date", label: "Date", icon: CalendarDays },
  { type: "time", label: "Time", icon: Clock },
  { type: "rating", label: "Rating", icon: Star },
  { type: "linear_scale", label: "Scale", icon: Sliders },
  { type: "address", label: "Address", icon: MapPin },
  { type: "file_upload", label: "File upload", icon: FileUp },
  { type: "section_text", label: "Text block", icon: Heading },
  { type: "group", label: "Repeating group", icon: ListChecks },
];

/**
 * Left rail of the builder: clickable field-type chips. Clicking a chip adds
 * the field to the active section (the store tracks `activeSectionKey`). Kept
 * keyboard-accessible (each chip is a real <button>).
 */
export function FieldPalette({
  className,
}: {
  className?: string;
}): React.ReactElement {
  const addField = useBuilderStore((s) => s.addField);
  const activeSectionKey = useBuilderStore((s) => s.activeSectionKey);
  const firstSection = useBuilderStore((s) => s.schema.sections[0]?.key);
  const target = activeSectionKey ?? firstSection ?? "";

  return (
    <aside
      aria-label={t("Field types")}
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm",
        className,
      )}
    >
      <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {t("Common fields")}
      </p>
      <div className="grid grid-cols-2 gap-2">
        {COMMON_FIELDS.map(({ type, label, icon: Icon, init }) => (
          <button
            key={init.key}
            type="button"
            disabled={!target}
            onClick={() => target && addField(target, type, init)}
            className="flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-2 text-left text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate">{t(label)}</span>
          </button>
        ))}
      </div>

      <p className="mt-1 text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {t("Add a field")}
      </p>
      <div className="grid grid-cols-2 gap-2">
        {PALETTE.map(({ type, label, icon: Icon }) => (
          <button
            key={type}
            type="button"
            disabled={!target}
            onClick={() => target && addField(target, type)}
            className="flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-2 text-left text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate">{t(label)}</span>
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("Fields are added to the selected section.")}
      </p>
    </aside>
  );
}
