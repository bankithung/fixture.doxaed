import { Sparkline } from "./charts";
import { useCountUp } from "./useCountUp";

/** Overview stat tile: uppercase label (optional live ping), count-up value,
 * quiet sub line, optional 12-point sparkline. Rendered inside a BentoCard. */
export function StatTile({
  label,
  value,
  sub,
  live,
  spark,
  size = "md",
}: {
  label: string;
  value: number;
  sub?: string;
  live?: boolean;
  spark?: number[];
  /** "sm" = the quieter secondary-page band (owner: the md tiles read big). */
  size?: "md" | "sm";
}): React.ReactElement {
  const shown = useCountUp(value);
  const sm = size === "sm";
  return (
    <div
      className={
        sm
          ? "flex h-full flex-col justify-between gap-1 p-3"
          : "flex h-full flex-col justify-between gap-2 p-4"
      }
    >
      <div className="flex items-center gap-2 text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-muted-foreground">
        {live ? (
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
        ) : null}
        {label}
      </div>
      <div className="flex items-end justify-between gap-2">
        <div className="min-w-0">
          <div
            className={
              sm
                ? "text-lg font-semibold tracking-tight"
                : "text-2xl font-semibold tracking-tight"
            }
            aria-label={value.toLocaleString()}
          >
            {shown.toLocaleString()}
          </div>
          {sub ? (
            <div
              className={
                sm
                  ? "truncate text-[11px] text-muted-foreground"
                  : "mt-0.5 truncate text-xs text-muted-foreground"
              }
            >
              {sub}
            </div>
          ) : null}
        </div>
        {spark ? <Sparkline points={spark} /> : null}
      </div>
    </div>
  );
}
