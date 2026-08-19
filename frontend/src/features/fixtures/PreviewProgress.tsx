import { useEffect, useState } from "react";
import { Dices } from "lucide-react";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * What a re-draw looks like while it runs (owner 2026-08-19: "the section is
 * empty… show a progress indicator with proper UI/UX and animations", and
 * then: "we can have animation at the centre… more proper animations that
 * make the wait show some TRYING type of animation").
 *
 * A draw tries several arrangements and keeps the one that gives every match
 * a time, which takes real seconds. So the wait is built to read as
 * ATTEMPTS being made rather than as a generic spinner: a die tumbling inside
 * a sweeping ring, a row of pips lighting along, the count of seconds, and a
 * bar underneath.
 *
 * The bar is deliberately NOT a percentage of anything, and the pips are not
 * numbered attempts: the server does not report which draw it is on, and
 * "draw 3 of 10" would be a number we invented. The motion is honest about
 * being indeterminate — it eases towards full and waits there, and the row
 * arriving is what finishes it.
 *
 * Every decorative animation stops under `prefers-reduced-motion`; the text
 * and the seconds carry the whole message on their own.
 */

/** About how long a full re-draw takes; the bar paces itself against this. */
const EXPECTED_SECONDS = 11;
/** Pips in the row. Decorative: the count is a rhythm, not a tally. */
const PIPS = 8;

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
  // on its own — the answer landing is what finishes it.
  const pct = Math.min(
    92,
    92 * (1 - Math.exp(-elapsed / (EXPECTED_SECONDS / 2.5))),
  );
  const secs = Math.floor(elapsed);

  return (
    <div
      data-testid="preview-progress"
      role="status"
      aria-live="polite"
      className={cn(
        "flex min-h-[50vh] w-full flex-col items-center justify-center gap-4 px-6 py-10 text-center",
        className,
      )}
    >
      {/* The die, tumbling inside a ring that keeps sweeping round it. */}
      <span className="relative flex h-20 w-20 items-center justify-center">
        <span
          aria-hidden="true"
          className="absolute inset-0 animate-sweep rounded-full border-2 border-primary/15 border-t-primary motion-reduce:animate-none"
        />
        <span
          aria-hidden="true"
          className="absolute inset-2 rounded-full bg-primary/5"
        />
        <Dices
          aria-hidden="true"
          className={cn(
            "h-8 w-8 text-primary",
            redraw && "animate-tumble motion-reduce:animate-none",
          )}
        />
      </span>

      <div className="flex flex-col items-center gap-1">
        <p className="text-base font-semibold">
          {redraw ? t("Drawing again") : t("Building the schedule")}
        </p>
        <p className="max-w-sm text-sm text-muted-foreground">
          {redraw
            ? t("Trying several draws and keeping the one that gives every match a time.")
            : t("Placing every match against your rules.")}
        </p>
      </div>

      {/* A row of pips lighting along — the search moving, one attempt at a
          time. Decorative: none of them claims to BE a given attempt. */}
      {redraw ? (
        <span aria-hidden="true" className="flex items-center gap-1.5">
          {Array.from({ length: PIPS }, (_, i) => (
            <span
              key={i}
              className="h-1.5 w-1.5 animate-pip rounded-full bg-primary motion-reduce:animate-none motion-reduce:opacity-40"
              style={{ animationDelay: `${i * 0.12}s` }}
            />
          ))}
        </span>
      ) : null}

      <div className="flex w-full max-w-sm flex-col gap-1.5">
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
            className="absolute inset-y-0 -left-1/3 w-1/3 animate-shimmer bg-gradient-to-r from-transparent via-primary-foreground/40 to-transparent motion-reduce:animate-none"
          />
        </div>
        <span
          data-testid="preview-progress-elapsed"
          className="font-tabular text-xs text-muted-foreground"
        >
          {secs}s
        </span>
      </div>
    </div>
  );
}
