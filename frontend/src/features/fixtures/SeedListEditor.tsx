import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { t } from "@/lib/t";

export interface SeedTeam {
  id: string;
  name: string;
}

/**
 * Ordered seed list for `seeding: "seeded"` (redesign §6 screen 3): row 1 =
 * seed 1. Reorder with the Up/Down buttons (the mobile path) or focus a row
 * and press ArrowUp/ArrowDown — focus follows the moved team. Controlled:
 * the parent owns the order and persists it via the bulk seeds API on save.
 */
export function SeedListEditor({
  teams,
  onChange,
}: {
  /** Current order — index 0 is seed 1. */
  teams: SeedTeam[];
  onChange: (next: SeedTeam[]) => void;
}): React.ReactElement {
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);
  const [focusIdx, setFocusIdx] = useState<number | null>(null);

  // After a keyboard move the row re-renders at its new index — chase it.
  useEffect(() => {
    if (focusIdx === null) return;
    rowRefs.current[focusIdx]?.focus();
    setFocusIdx(null);
  }, [focusIdx, teams]);

  const move = (i: number, delta: -1 | 1, follow = false): void => {
    const j = i + delta;
    if (j < 0 || j >= teams.length) return;
    const next = [...teams];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
    if (follow) setFocusIdx(j);
  };

  return (
    <ul
      aria-label={t("Seed order — row 1 is the top seed")}
      className="flex flex-col gap-1"
    >
      {teams.map((tm, i) => (
        <li
          key={tm.id}
          ref={(el) => {
            rowRefs.current[i] = el;
          }}
          tabIndex={0}
          aria-label={t(`${tm.name} — seed ${i + 1}`)}
          data-testid={`seed-row-${i}`}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              move(i, -1, true);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              move(i, 1, true);
            }
          }}
          className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="w-6 shrink-0 text-right font-tabular text-xs text-muted-foreground">
            {i + 1}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">{tm.name}</span>
          <span className="flex shrink-0 gap-1">
            <button
              type="button"
              aria-label={t(`Move ${tm.name} up`)}
              disabled={i === 0}
              data-testid={`seed-up-${i}`}
              onClick={() => move(i, -1)}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-30"
            >
              <ChevronUp aria-hidden="true" className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label={t(`Move ${tm.name} down`)}
              disabled={i === teams.length - 1}
              data-testid={`seed-down-${i}`}
              onClick={() => move(i, 1)}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-30"
            >
              <ChevronDown aria-hidden="true" className="h-4 w-4" />
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}
