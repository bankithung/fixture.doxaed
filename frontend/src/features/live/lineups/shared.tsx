import { CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import type { LineupEntryView, LineupSideView } from "./types";

/** Team header inside a lineup panel: name + confirmed tick. */
export function SideHeader({ side }: { side: LineupSideView }): React.ReactElement {
  return (
    <div className="flex items-center gap-2">
      <span className="min-w-0 truncate text-sm font-semibold">{side.teamName}</span>
      {side.confirmed ? (
        <span className="inline-flex items-center gap-1 text-[0.6875rem] font-medium text-success">
          <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" />
          {t("Confirmed")}
        </span>
      ) : null}
    </div>
  );
}

/** One player line: shirt number + name. Non-interactive by design. */
export function PlayerRow({
  entry,
  className,
}: {
  entry: LineupEntryView;
  className?: string;
}): React.ReactElement {
  return (
    <li className={cn("flex items-center gap-2 py-1 text-sm", className)}>
      <span className="w-7 shrink-0 text-right font-tabular text-xs text-muted-foreground">
        {entry.shirt_no != null ? entry.shirt_no : ""}
      </span>
      <span className="min-w-0 truncate">{entry.name}</span>
    </li>
  );
}

/** Bench block under its "Substitutes" label; renders nothing when empty. */
export function BenchList({
  bench,
}: {
  bench: LineupEntryView[];
}): React.ReactElement | null {
  if (bench.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {t("Substitutes")}
      </p>
      <ul className="flex flex-col">
        {bench.map((e) => (
          <PlayerRow key={e.player_id} entry={e} />
        ))}
      </ul>
    </div>
  );
}

/** Placeholder for a side whose sheet has nothing to show yet. */
export function EmptySide(): React.ReactElement {
  return (
    <p className="py-2 text-sm text-muted-foreground">
      {t("Not yet announced.")}
    </p>
  );
}
