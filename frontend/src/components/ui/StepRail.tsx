import { Check } from "lucide-react";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

export interface StepRailStep {
  key: string;
  label: string;
}

/**
 * Horizontal wizard step rail (numbered dots → check marks). Extracted from
 * ScheduleWizard so every multi-step dialog shares one rail language
 * (fixture-engine redesign §6). `complete` marks EVERY step done (a result
 * screen after the last step).
 */
export function StepRail({
  steps,
  current,
  complete = false,
}: {
  steps: readonly StepRailStep[];
  current: number;
  complete?: boolean;
}): React.ReactElement {
  return (
    <ol className="flex items-center gap-1 text-xs">
      {steps.map((s, i) => (
        <li key={s.key} className="flex flex-1 items-center gap-1.5">
          <span
            className={cn(
              "grid h-6 w-6 shrink-0 place-items-center rounded-full",
              i < current || complete
                ? "bg-primary text-primary-foreground"
                : i === current
                  ? "bg-primary/15 text-primary ring-1 ring-primary/40"
                  : "bg-muted text-muted-foreground",
            )}
          >
            {i < current || complete ? (
              <Check aria-hidden="true" className="h-3.5 w-3.5" />
            ) : (
              i + 1
            )}
          </span>
          <span
            className={cn(
              "hidden truncate sm:block",
              i === current && !complete
                ? "font-medium"
                : "text-muted-foreground",
            )}
          >
            {t(s.label)}
          </span>
        </li>
      ))}
    </ol>
  );
}
