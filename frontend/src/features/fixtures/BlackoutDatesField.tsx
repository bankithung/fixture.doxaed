import { useState } from "react";
import { CalendarDays, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/t";

/**
 * Date-chips field: a title + description, then pick a date, add it, and see it
 * as a removable chip (an empty "No days added" chip until then). Styled as the
 * reference's days-off / spare-days block — a full-width date "control" with a
 * leading calendar icon and a green-outline Add. Used for blackout dates and
 * reserve days in the global setup, and reusable for any `dates: [date]` param.
 */
export function BlackoutDatesField({
  label,
  value,
  onChange,
  hint,
  testId,
}: {
  label: string;
  value: string[];
  onChange: (dates: string[]) => void;
  hint?: string;
  testId?: string;
}): React.ReactElement {
  const [draft, setDraft] = useState("");

  const add = (): void => {
    if (!draft || value.includes(draft)) return;
    onChange([...value, draft].sort());
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-[0.8125rem] font-medium text-foreground">{label}</h3>
      {hint ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
      ) : null}
      <div className="mt-1.5 flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <CalendarDays
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="date"
            value={draft}
            aria-label={t(`Add a date to ${label}`)}
            data-testid={testId ? `${testId}-input` : undefined}
            onChange={(e) => setDraft(e.target.value)}
            className="h-9 w-full pl-9 dark:[color-scheme:dark]"
          />
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!draft}
          data-testid={testId ? `${testId}-add` : undefined}
          className="h-9 shrink-0 border-primary text-primary hover:bg-accent hover:text-primary"
          onClick={add}
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
          {t("Add")}
        </Button>
      </div>
      {value.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5" data-testid={testId}>
          {value.map((d) => (
            <li
              key={d}
              className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-0.5 text-xs text-secondary-foreground"
            >
              <span className="font-tabular">{d}</span>
              <button
                type="button"
                aria-label={t(`Remove ${d}`)}
                className="rounded-full p-0.5 hover:bg-accent"
                onClick={() => onChange(value.filter((x) => x !== d))}
              >
                <X aria-hidden="true" className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <span className="mt-2 inline-flex w-fit items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
          <CalendarDays
            aria-hidden="true"
            className="h-3.5 w-3.5 text-muted-foreground/60"
          />
          {t("No days added")}
        </span>
      )}
    </div>
  );
}
