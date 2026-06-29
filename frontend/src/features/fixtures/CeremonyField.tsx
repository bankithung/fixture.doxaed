import { CalendarDays, Clock, Flag, PartyPopper, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/** One ceremony block: a date + wall-clock window the grid subtracts. */
export interface CeremonyValue {
  date: string;
  from: string;
  to: string;
}

/**
 * Opening/closing ceremony editor, styled as the reference's ceremony panel: a
 * coloured icon header (party-popper / flag), title + description, then a date
 * "control" and a start/end time group. Off by default; "Add" reveals the
 * inputs (prefilled from the auto-detected match day) and persists as a
 * `ceremony_block` constraint record. Tokens only, so it tracks light/dark.
 */
export function CeremonyField({
  label,
  value,
  onChange,
  testId,
  defaultDate,
  tone = "opening",
  children,
}: {
  label: string;
  value: CeremonyValue | null;
  onChange: (v: CeremonyValue | null) => void;
  testId?: string;
  /** Auto-detected date (e.g. the first/last match day) the ceremony defaults
   * to when added — still editable after. */
  defaultDate?: string;
  /** Drives the coloured icon: opening = primary, closing = destructive. */
  tone?: "opening" | "closing";
  /** Extra content rendered at the bottom of the panel once a ceremony exists
   * (e.g. the closing ceremony's "no matches while a ceremony is on" note). */
  children?: React.ReactNode;
}): React.ReactElement {
  const set = (patch: Partial<CeremonyValue>): void => {
    if (value) onChange({ ...value, ...patch });
  };
  const Icon = tone === "opening" ? PartyPopper : Flag;

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start gap-2.5">
        <Icon
          aria-hidden="true"
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0",
            tone === "opening" ? "text-primary" : "text-destructive",
          )}
        />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{label}</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {t("Auto-detected from your match days. Change if it falls on a different day.")}
          </p>
        </div>
        {value !== null ? (
          <button
            type="button"
            aria-label={t(`Remove ${label}`)}
            className="-mr-1 -mt-0.5 shrink-0 rounded-full p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => onChange(null)}
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {value === null ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-3 border-primary text-primary hover:bg-accent hover:text-primary"
          data-testid={testId ? `${testId}-add` : undefined}
          onClick={() =>
            onChange({ date: defaultDate ?? "", from: "09:00", to: "10:00" })
          }
        >
          {t("Add")}
        </Button>
      ) : (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1">
            <span className="text-[0.8125rem] font-medium text-foreground">
              {t("Date")}
            </span>
            <span className="relative block">
              <CalendarDays
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="date"
                value={value.date}
                aria-label={t(`${label} date`)}
                data-testid={testId ? `${testId}-date` : undefined}
                onChange={(e) => set({ date: e.target.value })}
                className="h-9 pl-9 dark:[color-scheme:dark]"
              />
            </span>
          </label>

          <div className="flex min-w-[16rem] flex-[2] items-end gap-2.5">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-[0.8125rem] font-medium text-foreground">
                {t("Start time")}
              </span>
              <span className="relative block">
                <Clock
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  type="time"
                  value={value.from}
                  aria-label={t(`${label} from`)}
                  onChange={(e) => set({ from: e.target.value })}
                  className="h-9 pl-9 dark:[color-scheme:dark]"
                />
              </span>
            </label>
            <span className="pb-2 text-xs text-muted-foreground">{t("to")}</span>
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-[0.8125rem] font-medium text-foreground">
                {t("End time")}
              </span>
              <span className="relative block">
                <Clock
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  type="time"
                  value={value.to}
                  aria-label={t(`${label} to`)}
                  onChange={(e) => set({ to: e.target.value })}
                  className="h-9 pl-9 dark:[color-scheme:dark]"
                />
              </span>
            </label>
          </div>
        </div>
      )}

      {value !== null ? children : null}
    </section>
  );
}
