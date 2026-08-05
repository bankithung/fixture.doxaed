import { cn } from "@/lib/tailwind";

/**
 * The house folder tabs, as used across the streaming surfaces.
 *
 * The open tab is cut out of the panel below it — its bottom edge is the card
 * colour, not a border — so the strip reads as tabs on a file rather than a row
 * of buttons. The closed ones keep the same bookmark shape a shade back and a
 * notch shorter, and rise to meet the open one on hover, which is what makes
 * them look pressable at rest.
 */
export interface FolderTab<K extends string> {
  key: K;
  label: string;
  /** Optional size badge; a tab that carries 102 rows should say so. */
  count?: number;
}

export function FolderTabs<K extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
  testidPrefix,
}: {
  tabs: FolderTab<K>[];
  value: K;
  onChange: (key: K) => void;
  ariaLabel: string;
  /** Each tab gets `${testidPrefix}-${key}`. */
  testidPrefix: string;
}): React.ReactElement {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="flex items-end gap-1 overflow-x-auto border-b border-border bg-muted/30 px-3 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {tabs.map((tb) => {
        const active = tb.key === value;
        return (
          <button
            key={tb.key}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={`${testidPrefix}-${tb.key}`}
            onClick={() => onChange(tb.key)}
            className={cn(
              "-mb-px inline-flex shrink-0 items-center gap-2 rounded-t-lg border px-3.5 text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              active
                ? "h-9 border-border border-b-card bg-card font-semibold text-foreground"
                : "h-8 border-border/60 bg-secondary/50 text-muted-foreground hover:h-9 hover:bg-card hover:text-foreground",
            )}
          >
            {tb.label}
            {tb.count === undefined ? null : (
              <span
                className={cn(
                  "inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 font-tabular text-[0.625rem] font-semibold tabular-nums",
                  active
                    ? "bg-primary/12 text-primary"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {tb.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
