import { t } from "@/lib/t";
import { BenchList, EmptySide, SideHeader } from "./shared";
import { splitRoles, type LineupSideView, type LineupViewProps } from "./types";

/** Table tennis: 1-2 players per side as large name cards ("Pair" when it is
 * a doubles pairing). No court diagram, the players ARE the lineup. */
function Side({ side }: { side: LineupSideView | null }): React.ReactElement {
  if (!side || side.entries.length === 0) {
    return (
      <div className="flex flex-col gap-2 p-4">
        {side ? <SideHeader side={side} /> : null}
        <EmptySide />
      </div>
    );
  }
  const { starters, bench, unroled } = splitRoles(side.entries);
  const players = starters.length > 0 ? starters : unroled;
  return (
    <div className="flex flex-col gap-3 p-4" data-testid="lineup-tt-side">
      <SideHeader side={side} />
      {players.length === 2 ? (
        <span className="w-fit rounded-md bg-primary/10 px-2 py-0.5 text-[0.6875rem] font-medium uppercase tracking-wide text-primary">
          {t("Pair")}
        </span>
      ) : null}
      <div className="flex flex-col gap-2">
        {players.map((p) => (
          <div
            key={p.player_id}
            className="flex items-center gap-3 rounded-xl border border-border bg-background px-4 py-3"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary/10 font-tabular text-sm font-semibold text-primary">
              {p.shirt_no != null ? p.shirt_no : p.name.charAt(0)}
            </span>
            <span className="min-w-0 truncate text-base font-semibold">
              {p.name}
            </span>
          </div>
        ))}
      </div>
      <BenchList bench={bench} />
    </div>
  );
}

export function TTLineups({ home, away }: LineupViewProps): React.ReactElement {
  return (
    <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
      <Side side={home} />
      <Side side={away} />
    </div>
  );
}
