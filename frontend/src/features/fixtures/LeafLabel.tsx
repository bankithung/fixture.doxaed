import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * A competition leaf label rendered as segment PILLS instead of the raw
 * dash-joined string ("Sepak Takraw — u-14 — boys — 3v3"). The sport (first
 * segment) gets a primary-tinted pill; the rest are neutral. Owner standing
 * rule: never show the em/en-dash strings anywhere user-facing — chips only.
 *
 * `size="sm"` is the default (cards, tables); `size="md"` bumps the sport to a
 * heading-ish weight for card titles.
 */
export function LeafLabel({
  label,
  size = "sm",
  className,
}: {
  label: string;
  size?: "sm" | "md";
  className?: string;
}): React.ReactElement {
  if (!label) {
    return (
      <span className="text-xs text-muted-foreground">{t("Uncategorized")}</span>
    );
  }
  const segs = label.split(" — ");
  const pad = size === "md" ? "px-2 py-0.5 text-sm" : "px-1.5 py-0.5 text-xs";
  return (
    <span className={cn("flex flex-wrap items-center gap-1", className)}>
      {segs.map((seg, i) => (
        <span
          key={`${i}-${seg}`}
          className={cn(
            "rounded",
            pad,
            i === 0
              ? "bg-primary/10 font-semibold text-primary"
              : "bg-muted font-medium text-foreground",
          )}
        >
          {seg}
        </span>
      ))}
    </span>
  );
}
