import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * A placing, wherever a placing appears.
 *
 * Gold, silver and bronze are fixed by the world rather than by the brand, so
 * they are their own token trio (`--medal-*`, validated in both themes). The
 * chip ALWAYS carries its place as text as well as its colour: silver reads
 * neutral by definition, a fifth of readers cannot separate the gold from the
 * bronze, and a medal tally that can only be read in colour is not a tally.
 */

const TINT: Record<number, string> = {
  1: "bg-medal-1-muted text-medal-1 ring-medal-1/30",
  2: "bg-medal-2-muted text-medal-2 ring-medal-2/30",
  3: "bg-medal-3-muted text-medal-3 ring-medal-3/30",
};

const FALLBACK = "bg-muted text-muted-foreground ring-border";

export function medalTint(place: number): string {
  return TINT[place] ?? FALLBACK;
}

export function MedalChip({
  place,
  label,
  size = "md",
  title,
  className,
}: {
  place: number;
  /** The ladder's own word ("Gold"). Read by screen readers, shown on `lg`. */
  label?: string;
  size?: "sm" | "md";
  title?: string;
  className?: string;
}): React.ReactElement {
  return (
    <span
      title={title}
      data-testid={`medal-${place}`}
      className={cn(
        "inline-flex items-center justify-center rounded-full font-tabular font-semibold ring-1 ring-inset",
        size === "sm" ? "h-5 min-w-5 px-1 text-[0.625rem]" : "h-6 min-w-6 px-1.5 text-xs",
        medalTint(place),
        className,
      )}
    >
      <span aria-hidden="true">{place}</span>
      <span className="sr-only">
        {label
          ? `${label} (${t("place")} ${place})`
          : `${t("place")} ${place}`}
      </span>
    </span>
  );
}

/** The gold/silver/bronze counters that end a tally row. */
export function MedalCount({
  place,
  count,
  label,
}: {
  place: number;
  count: number;
  label: string;
}): React.ReactElement {
  return (
    <span
      className="inline-flex items-center gap-1"
      data-testid={`medal-count-${place}`}
    >
      <span
        aria-hidden="true"
        className={cn("h-2.5 w-2.5 shrink-0 rounded-full", {
          1: "bg-medal-1",
          2: "bg-medal-2",
          3: "bg-medal-3",
        }[place] ?? "bg-muted-foreground")}
      />
      <span className="font-tabular text-xs">
        {count}
        <span className="sr-only"> {label}</span>
      </span>
    </span>
  );
}
