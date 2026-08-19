import { useEffect, useState } from "react";
import { Dices, Loader2 } from "lucide-react";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * What a re-draw looks like while it runs (owner 2026-08-19: "when the user
 * presses try another draw the section is empty, so show a progress indicator
 * with proper UI/UX and animations").
 *
 * A draw now tries up to ten arrangements and keeps the one that gives every
 * match a time, which takes real seconds — and a bare pulsing skeleton for
 * that long reads as a page that has stopped rather than one that is working
 * hard. This says what it is doing, shows it moving, and counts the seconds
 * so the wait has a shape.
 *
 * The bar is deliberately NOT a percentage of anything: the server does not
 * report which attempt it is on, and inventing "draw 3 of 10" would be a
 * number we made up. It eases towards full and waits there — motion that is
 * honest about being indeterminate.
 */

/** About how long a full re-draw takes; the bar paces itself against this and
 * then holds just short of the end until the answer actually arrives. */
const EXPECTED_SECONDS = 25;

export function PreviewProgress({
  /** A re-draw (many attempts) rather than a first load (one). */
  redraw,
  className,
}: {
  redraw: boolean;
  className?: string;
}): React.ReactElement {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const id = window.setInterval(
      () => setElapsed((Date.now() - started) / 1000),
      250,
    );
    return () => window.clearInterval(id);
  }, []);

  // Ease towards 92% over the expected wait, then creep. It never reaches 100
  // on its own — the row arriving is what finishes it.
  const pct = Math.min(92, 92 * (1 - Math.exp(-elapsed / (EXPECTED_SECONDS / 2.5))));
  const secs = Math.floor(elapsed);

  return (
    <div
      data-testid="preview-progress"
      role="status"
      aria-live="polite"
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border bg-card p-3",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10">
          {redraw ? (
            <Dices aria-hidden="true" className="h-4 w-4 text-primary" />
          ) : (
            <Loader2
              aria-hidden="true"
              className="h-4 w-4 animate-spin text-primary"
            />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {redraw ? t("Drawing again") : t("Building the schedule")}
          </p>
          <p className="text-xs text-muted-foreground">
            {redraw
              ? t("Trying up to 10 draws and keeping the one that gives every match a time.")
              : t("Placing every match against your rules.")}
          </p>
        </div>
        <span
          data-testid="preview-progress-elapsed"
          className="shrink-0 font-tabular text-xs text-muted-foreground"
        >
          {secs}s
        </span>
      </div>

      {/* The bar itself: a filling track with a sheen travelling across it, so
          it reads as working even while the fill is barely moving. */}
      <div
        className="relative h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={t("Working")}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
        <span
          aria-hidden="true"
          className="absolute inset-y-0 -left-1/3 w-1/3 animate-shimmer bg-gradient-to-r from-transparent via-primary-foreground/40 to-transparent"
        />
      </div>
    </div>
  );
}
