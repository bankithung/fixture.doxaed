import { BenchList, EmptySide, PlayerRow, SideHeader } from "./shared";
import { splitRoles, type LineupSideView, type LineupViewProps } from "./types";

/** Timed-family (football) lineup view: two columns, starting XI first,
 * bench under a "Substitutes" label. The SVG pitch ships later (P5) once
 * formation + positional slots exist for football. */
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
  return (
    <div className="flex flex-col gap-3 p-4" data-testid="lineup-football-side">
      <SideHeader side={side} />
      {starters.length > 0 ? (
        <ul className="flex flex-col">
          {starters.map((e) => (
            <PlayerRow key={e.player_id} entry={e} />
          ))}
        </ul>
      ) : null}
      <BenchList bench={bench} />
      {unroled.length > 0 ? (
        <ul className="flex flex-col">
          {unroled.map((e) => (
            <PlayerRow key={e.player_id} entry={e} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function FootballLineups({ home, away }: LineupViewProps): React.ReactElement {
  return (
    <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
      <Side side={home} />
      <Side side={away} />
    </div>
  );
}
