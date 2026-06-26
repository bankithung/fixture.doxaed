import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/t";

/** One ceremony block: a date + wall-clock window the grid subtracts. */
export interface CeremonyValue {
  date: string;
  from: string;
  to: string;
}

/**
 * Opening/closing ceremony editor (redesign §6 screen 2). Off by default;
 * "Add" reveals date + window inputs that persist as a `ceremony_block`
 * constraint record.
 */
export function CeremonyField({
  label,
  value,
  onChange,
  testId,
  defaultDate,
}: {
  label: string;
  value: CeremonyValue | null;
  onChange: (v: CeremonyValue | null) => void;
  testId?: string;
  /** Auto-detected date (e.g. the first/last match day) the ceremony defaults
   * to when added — still editable after. */
  defaultDate?: string;
}): React.ReactElement {
  if (value === null) {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={testId ? `${testId}-add` : undefined}
          onClick={() =>
            onChange({ date: defaultDate ?? "", from: "09:00", to: "10:00" })
          }
        >
          {t("Add")}
        </Button>
      </div>
    );
  }
  const set = (patch: Partial<CeremonyValue>): void =>
    onChange({ ...value, ...patch });
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <button
          type="button"
          aria-label={t(`Remove ${label}`)}
          className="rounded-full p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          onClick={() => onChange(null)}
        >
          <X aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="date"
          value={value.date}
          aria-label={t(`${label} date`)}
          data-testid={testId ? `${testId}-date` : undefined}
          onChange={(e) => set({ date: e.target.value })}
          className="h-9 w-44"
        />
        <Input
          type="time"
          value={value.from}
          aria-label={t(`${label} from`)}
          onChange={(e) => set({ from: e.target.value })}
          className="h-9 w-28"
        />
        <span className="text-xs text-muted-foreground">{t("to")}</span>
        <Input
          type="time"
          value={value.to}
          aria-label={t(`${label} to`)}
          onChange={(e) => set({ to: e.target.value })}
          className="h-9 w-28"
        />
      </div>
      {defaultDate && value.date === defaultDate ? (
        <span className="text-xs text-muted-foreground">
          {t("Auto-detected from your match days — change it if the ceremony is on a different day.")}
        </span>
      ) : null}
    </div>
  );
}
