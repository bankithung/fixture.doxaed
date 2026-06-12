import { Check } from "lucide-react";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import type { JourneyStep } from "./setupJourney";

const STEPS: { n: 1 | 2 | 3; label: string }[] = [
  { n: 1, label: "When & where" },
  { n: 2, label: "How each competition plays" },
  { n: 3, label: "Preview & publish" },
];

const NEXT_LINE: Record<"1" | "2" | "3" | "done", string> = {
  "1": "Next: set your tournament dates and venues.",
  "2": "Next: choose how each competition plays.",
  "3": "Next: preview the schedule and publish it.",
  done: "All set. Your schedule is published.",
};

/** Dots done strictly before the pointer; in the mixed step-3 state the
 * header highlights 2 AND 3 together (spec §3 — some competitions are drawn
 * while others are still mid-path). */
function dotState(n: 1 | 2 | 3, step: JourneyStep): "done" | "current" | "todo" {
  if (step === "done") return "done";
  if (step === 3) return n === 1 ? "done" : "current";
  if (n < step) return "done";
  if (n === step) return "current";
  return "todo";
}

/**
 * The always-on numbered journey (clarity rebuild §3.1): three steps, one
 * "next" line, completed steps tappable to deep-link back. Reuses the
 * StepRail visual language with the journey's own copy.
 */
export function SetupJourneyHeader({
  step,
  compact = false,
  onStepClick,
}: {
  step: JourneyStep;
  /** Slimmer spacing for the preview page's top strip. */
  compact?: boolean;
  /** Deep-link back from a completed (or current) step. */
  onStepClick?: (step: 1 | 2 | 3) => void;
}): React.ReactElement {
  const pointer = step === "done" ? 3 : step;
  const current = STEPS.find((s) => s.n === pointer) ?? STEPS[0];

  return (
    <nav
      data-testid="setup-journey"
      aria-label={t("Fixture setup steps")}
      className={cn("flex flex-col", compact ? "gap-1" : "gap-1.5")}
    >
      <ol className="flex items-center gap-1 text-xs">
        {STEPS.map((s) => {
          const state = dotState(s.n, step);
          const clickable = Boolean(onStepClick) && state !== "todo";
          return (
            <li key={s.n} className="flex flex-1 items-center gap-1.5">
              <button
                type="button"
                data-testid={`journey-step-${s.n}`}
                disabled={!clickable}
                onClick={() => onStepClick?.(s.n)}
                className={cn(
                  "flex min-w-0 items-center gap-1.5 rounded-md text-left",
                  clickable && "cursor-pointer",
                )}
              >
                <span
                  className={cn(
                    "grid h-6 w-6 shrink-0 place-items-center rounded-full",
                    state === "done"
                      ? "bg-primary text-primary-foreground"
                      : state === "current"
                        ? "bg-primary/15 text-primary ring-1 ring-primary/40"
                        : "bg-muted text-muted-foreground",
                  )}
                >
                  {state === "done" ? (
                    <Check aria-hidden="true" className="h-3.5 w-3.5" />
                  ) : (
                    <span className="font-tabular">{s.n}</span>
                  )}
                </span>
                <span
                  className={cn(
                    "hidden truncate sm:block",
                    state === "current" ? "font-medium" : "text-muted-foreground",
                  )}
                >
                  {t(s.label)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {step !== "done" ? (
        <p className="text-xs text-muted-foreground sm:hidden">
          {t(`Step ${pointer} of 3: ${current.label}`)}
        </p>
      ) : null}
      <p data-testid="journey-next" className="text-sm text-muted-foreground">
        {t(NEXT_LINE[step === "done" ? "done" : (String(step) as "1" | "2" | "3")])}
      </p>
    </nav>
  );
}
