import { BenchList, EmptySide, PlayerRow, SideHeader } from "./shared";
import { splitRoles, type LineupSideView, type LineupViewProps } from "./types";

/** Generic fallback: a flat starters-then-bench list per side, for any sport
 * without a native lineup visual. */
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
    <div className="flex flex-col gap-3 p-4" data-testid="lineup-flat-side">
      <SideHeader side={side} />
      {starters.length > 0 || unroled.length > 0 ? (
        <ul className="flex flex-col">
          {[...starters, ...unroled].map((e) => (
            <PlayerRow key={e.player_id} entry={e} />
          ))}
        </ul>
      ) : null}
      <BenchList bench={bench} />
    </div>
  );
}

export function FlatLineups({ home, away }: LineupViewProps): React.ReactElement {
  return (
    <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
      <Side side={home} />
      <Side side={away} />
    </div>
  );
}
