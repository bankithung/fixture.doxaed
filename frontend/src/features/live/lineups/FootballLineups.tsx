import { BenchList, EmptySide, PlayerRow, SideHeader } from "./shared";
import { t } from "@/lib/t";
import { splitRoles, type LineupEntryView, type LineupSideView, type LineupViewProps } from "./types";

/** Bucket a starter into a pitch line off positional_role free text.
 * Unknown roles fall through to a balanced default shape. */
function lineOf(e: LineupEntryView): "gk" | "def" | "mid" | "fwd" | null {
  const r = (e.positional_role || "").toLowerCase();
  if (!r) return null;
  if (/gk|goal|keeper/.test(r)) return "gk";
  if (/def|back|cb|lb|rb|sweeper/.test(r)) return "def";
  if (/mid|cm|dm|am|cdm|cam/.test(r)) return "mid";
  if (/fw|for|st|strik|wing|lw|rw|cf/.test(r)) return "fwd";
  return null;
}

/** Arrange starters into GK/DEF/MID/FWD lines. Role text wins; the rest
 * fill a balanced shape (1-4-4-2 style for 11, proportional for fewer). */
function lines(starters: LineupEntryView[]): LineupEntryView[][] {
  const gk: LineupEntryView[] = [];
  const def: LineupEntryView[] = [];
  const mid: LineupEntryView[] = [];
  const fwd: LineupEntryView[] = [];
  const rest: LineupEntryView[] = [];
  for (const e of starters) {
    const l = lineOf(e);
    if (l === "gk") gk.push(e);
    else if (l === "def") def.push(e);
    else if (l === "mid") mid.push(e);
    else if (l === "fwd") fwd.push(e);
    else rest.push(e);
  }
  // Fill gaps from the unroled pool: keeper first, then defence, midfield,
  // attack in a rough 4-4-2 proportion of whatever remains.
  if (gk.length === 0 && rest.length > 0) gk.push(rest.shift()!);
  while (rest.length > 0) {
    const remaining = rest.length;
    const defWant = Math.ceil(remaining * 0.4);
    const midWant = Math.ceil((remaining - defWant) * 0.66);
    def.push(...rest.splice(0, defWant));
    mid.push(...rest.splice(0, midWant));
    fwd.push(...rest.splice(0));
  }
  return [gk, def, mid, fwd].filter((l) => l.length > 0);
}

function Dot({ entry }: { entry: LineupEntryView }): React.ReactElement {
  return (
    <div
      className="flex w-14 flex-col items-center gap-0.5"
      data-testid={`pitch-player-${entry.player_id}`}
    >
      <span className="grid h-8 w-8 place-items-center rounded-full border border-primary/40 bg-card text-xs font-semibold shadow-sm">
        {entry.shirt_no != null ? entry.shirt_no : (entry.name[0] ?? "")}
      </span>
      <span className="w-full truncate text-center text-[0.625rem] leading-tight text-muted-foreground">
        {entry.name.split(" ").slice(-1)[0]}
      </span>
    </div>
  );
}

/** One team's half: the keeper nearest that team's goal line, attack
 * toward the centre. `flip` renders the away side mirrored. */
function Half({
  side,
  flip,
}: {
  side: LineupSideView;
  flip: boolean;
}): React.ReactElement {
  // No confirmed XI yet -> place the roster instead (balanced shape), so
  // the pitch always draws once players exist.
  const { starters, unroled } = splitRoles(side.entries);
  const onPitch = starters.length > 0 ? starters : unroled;
  const rows = lines(onPitch.slice(0, 11));
  const ordered = flip ? rows : [...rows].reverse();
  return (
    <div
      className={
        "flex flex-1 flex-col justify-between gap-1 py-3 " +
        (flip ? "" : "")
      }
      data-testid={flip ? "pitch-away-half" : "pitch-home-half"}
    >
      {ordered.map((row, i) => (
        <div key={i} className="flex items-start justify-evenly">
          {row.map((e) => (
            <Dot key={e.player_id} entry={e} />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The football PITCH (owner ask: "football pitch ui with the players"):
 * both confirmed XIs on one vertical pitch — home attacking upward from the
 * bottom, away mirrored at the top — lines inferred from positional roles
 * with a balanced 4-4-2 fallback, shirt-number dots, surname captions.
 * Benches and any unroled roster entries list below. Token colors only.
 */
export function FootballLineups({ home, away }: LineupViewProps): React.ReactElement {
  const homeStarters = home ? splitRoles(home.entries).starters : [];
  const awayStarters = away ? splitRoles(away.entries).starters : [];
  const drawPitch = homeStarters.length > 0 || awayStarters.length > 0;

  return (
    <div className="flex flex-col">
      {drawPitch ? (
        <div className="p-4">
          <div
            data-testid="football-pitch"
            className="relative flex min-h-[26rem] flex-col overflow-hidden rounded-xl border border-border bg-primary/5"
          >
            {/* Markings: halfway line, centre circle, both boxes. */}
            <div aria-hidden="true" className="pointer-events-none absolute inset-0">
              <div className="absolute left-0 right-0 top-1/2 border-t border-border" />
              <div className="absolute left-1/2 top-1/2 h-16 w-16 -translate-x-1/2 -translate-y-1/2 rounded-full border border-border" />
              <div className="absolute left-1/2 top-0 h-10 w-32 -translate-x-1/2 rounded-b-md border border-t-0 border-border" />
              <div className="absolute bottom-0 left-1/2 h-10 w-32 -translate-x-1/2 rounded-t-md border border-b-0 border-border" />
            </div>
            {away ? <Half side={away} flip /> : <div className="flex-1" />}
            {home ? <Half side={home} flip={false} /> : <div className="flex-1" />}
          </div>
          {/* Side captions under the pitch. */}
          <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>{away ? `${away.teamName} (${t("top")})` : ""}</span>
            <span>{home ? `${home.teamName} (${t("bottom")})` : ""}</span>
          </div>
        </div>
      ) : null}

      {/* Benches + roster fallback, per side. */}
      <div className="grid grid-cols-1 divide-y divide-border border-t border-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        <ListSide side={home} />
        <ListSide side={away} />
      </div>
    </div>
  );
}


function ListSide({ side }: { side: LineupSideView | null }): React.ReactElement {
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
      <BenchList bench={bench} />
      {/* Roster fallback: no confirmed sheet means no pitch rows either. */}
      {starters.length === 0 && unroled.length > 0 ? (
        <ul className="flex flex-col">
          {unroled.map((e) => (
            <PlayerRow key={e.player_id} entry={e} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
