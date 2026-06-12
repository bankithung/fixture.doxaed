import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/t";

/**
 * Date-chips field: pick a date, add it, see it as a removable chip. Used for
 * blackout dates and reserve days in the global setup (redesign §6 screen 2)
 * and reusable for any `dates: [date]` constraint param.
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
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex items-center gap-2">
        <Input
          type="date"
          value={draft}
          aria-label={t(`Add a date to ${label}`)}
          data-testid={testId ? `${testId}-input` : undefined}
          onChange={(e) => setDraft(e.target.value)}
          className="h-9 w-44"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!draft}
          data-testid={testId ? `${testId}-add` : undefined}
          onClick={add}
        >
          <Plus aria-hidden="true" className="h-3.5 w-3.5" />
          {t("Add")}
        </Button>
      </div>
      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" data-testid={testId}>
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
      ) : null}
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}
