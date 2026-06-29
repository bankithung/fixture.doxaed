import { Check } from "lucide-react";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import type { JourneyStep } from "./setupJourney";

/** Visible step number. The readiness pointer (`JourneyStep`) still has three
 * meaningful positions; "Clashes & sessions" (2) is an OPTIONAL step inserted
 * after the gate, so it never blocks and the required pointer skips over it
 * (readiness "no draw yet" points straight at "How each competition plays"). */
type VisibleStep = 1 | 2 | 3 | 4;

const STEPS: { n: VisibleStep; label: string; optional?: boolean }[] = [
  { n: 1, label: "When & where" },
  { n: 2, label: "Clashes & sessions", optional: true },
  { n: 3, label: "How each competition plays" },
  { n: 4, label: "Preview & publish" },
];

/** Readiness pointer → the REQUIRED visible step it highlights (the optional
 * clashes step is never a required pointer). */
const VISIBLE_POINTER: Record<"1" | "2" | "3" | "done", VisibleStep> = {
  "1": 1,
  "2": 3,
  "3": 3,
  done: 4,
};

const NEXT_LINE: Record<"1" | "2" | "3" | "done", string> = {
  "1": "Next: set your tournament dates and venues.",
  "2": "Next: set any clashes (optional), then choose how each competition plays.",
  "3": "Next: preview the schedule and publish it.",
  done: "All set. Your schedule is published.",
};

/** Page-navigation mode (the setup hub): the line describes what to do on the
 * page you're currently looking at, since the stepper is page navigation —
 * not the readiness pointer (which tracks draw generation, a later concern). */
const ACTIVE_NEXT: Record<VisibleStep, string> = {
  1: "Next: set your tournament dates and venues.",
  2: "Optional. Stop competitions clashing, or skip ahead to formats.",
  3: "Choose how each competition plays, then preview & publish.",
  4: "Preview each competition's draw below, then publish the schedule.",
};

/** Required dots are done strictly before the pointer; in the mixed step-3
 * state the header highlights 3 AND 4 together (some competitions are drawn
 * while others are still mid-path). The optional clashes step (2) renders as
 * "optional" once the gate is passed — always reachable, never blocking. */
function dotState(
  n: VisibleStep,
  step: JourneyStep,
  activeStep?: VisibleStep,
  doneSteps?: Partial<Record<VisibleStep, boolean>>,
): "done" | "current" | "todo" | "optional" {
  // Page-navigation mode (the setup hub passes activeStep): the page you're on
  // is THE current step; any step actually COMPLETE shows a tick (from real
  // data, not position) so finished steps read as done and unfinished ones
  // don't; the optional clashes step stays "optional" until configured.
  if (activeStep != null) {
    if (n === activeStep) return "current";
    if (doneSteps?.[n]) return "done";
    if (n === 2) return "optional";
    return "todo";
  }
  if (n === 2) return step === 1 ? "todo" : "optional";
  if (step === "done") return "done";
  if (step === 3) return n === 1 ? "done" : "current"; // 3 and 4 together
  if (step === 1) return n === 1 ? "current" : "todo";
  // readiness "no draw yet" → required pointer is "How each competition plays"
  if (n === 1) return "done";
  if (n === 3) return "current";
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
  activeStep,
  doneSteps,
  onStepClick,
}: {
  step: JourneyStep;
  /** Slimmer spacing for the preview page's top strip. */
  compact?: boolean;
  /** The page the hub body is currently showing — highlighted as the current
   * step so the stepper reads like page navigation. */
  activeStep?: VisibleStep;
  /** Which steps are actually COMPLETE (drives the ticks in page-nav mode). */
  doneSteps?: Partial<Record<VisibleStep, boolean>>;
  /** Deep-link from a completed, current, or optional step. */
  onStepClick?: (step: VisibleStep) => void;
}): React.ReactElement {
  const pointer = VISIBLE_POINTER[step === "done" ? "done" : (String(step) as "1" | "2" | "3")];
  // In page-nav mode the "you are here" label + line follow the active page;
  // otherwise (compact preview header) they follow the readiness pointer.
  const shownStep = activeStep ?? pointer;
  const shownLabel = (STEPS.find((s) => s.n === shownStep) ?? STEPS[0]).label;
  const nextLine =
    step === "done"
      ? NEXT_LINE.done
      : activeStep != null
        ? ACTIVE_NEXT[activeStep]
        : NEXT_LINE[String(step) as "1" | "2" | "3"];

  return (
    <nav
      data-testid="setup-journey"
      aria-label={t("Fixture setup steps")}
      className={cn("flex flex-col", compact ? "gap-1" : "gap-1.5")}
    >
      <ol className="flex items-center gap-1 text-xs">
        {STEPS.map((s) => {
          const state = dotState(s.n, step, activeStep, doneSteps);
          // Page-nav mode → every step is a reachable page (even "todo" ones);
          // pointer mode keeps upcoming steps locked.
          const clickable =
            Boolean(onStepClick) && (activeStep != null || state !== "todo");
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
                        : state === "optional"
                          ? "bg-muted text-muted-foreground ring-1 ring-border"
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
                  {s.optional ? (
                    <span className="ml-1 text-muted-foreground">{t("(optional)")}</span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {step !== "done" ? (
        <p className="text-xs text-muted-foreground sm:hidden">
          {t(`Step ${shownStep} of 4: ${shownLabel}`)}
        </p>
      ) : null}
      <p data-testid="journey-next" className="text-sm text-muted-foreground">
        {t(nextLine)}
      </p>
    </nav>
  );
}
