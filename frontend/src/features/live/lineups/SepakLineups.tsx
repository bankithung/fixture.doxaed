import { t } from "@/lib/t";
import { cn } from "@/lib/tailwind";
import { BenchList, EmptySide, PlayerRow, SideHeader } from "./shared";
import {
  splitRoles,
  type LineupEntryView,
  type LineupSideView,
  type LineupViewProps,
} from "./types";

/** The three regu slots on a half court, net at the top: insides play the
 * front (near the net), the tekong serves from the back centre. */
const SLOTS: { key: string; label: string; cls: string }[] = [
  {
    key: "left_inside",
    label: "Left inside",
    cls: "left-[24%] top-[14%] -translate-x-1/2",
  },
  {
    key: "right_inside",
    label: "Right inside",
    cls: "left-[76%] top-[14%] -translate-x-1/2",
  },
  {
    key: "tekong",
    label: "Tekong",
    cls: "bottom-[10%] left-1/2 -translate-x-1/2",
  },
];

function CourtDot({
  entry,
  label,
}: {
  entry: LineupEntryView;
  label: string;
}): React.ReactElement {
  return (
    <div className="flex w-24 flex-col items-center gap-0.5">
      <span className="grid h-9 w-9 place-items-center rounded-full bg-primary font-tabular text-xs font-semibold text-primary-foreground">
        {entry.shirt_no != null ? entry.shirt_no : entry.name.charAt(0)}
      </span>
      <span className="w-full truncate text-center text-xs font-medium">
        {entry.name}
      </span>
      <span className="text-[0.625rem] uppercase tracking-wide text-muted-foreground">
        {t(label)}
      </span>
    </div>
  );
}

/** CSS-only half court: bordered rounded rect + centre line, regu placed by
 * positional_role. Falls back to an ordered list when roles are absent. */
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
  const onCourt = starters.length > 0 ? starters : unroled;
  // Declared regu slots win; everyone else fills the remaining slots in
  // order, so the court ALWAYS draws once players exist (a roster-only
  // side used to fall back to a plain list and the court never appeared).
  const bySlot = new Map<string, LineupEntryView>();
  const leftovers: LineupEntryView[] = [];
  for (const e of onCourt) {
    const slot = SLOTS.find(
      (s) => s.key === e.positional_role && !bySlot.has(s.key),
    );
    if (slot) bySlot.set(slot.key, e);
    else leftovers.push(e);
  }
  for (const slot of SLOTS) {
    if (!bySlot.has(slot.key) && leftovers.length > 0) {
      bySlot.set(slot.key, leftovers.shift()!);
    }
  }
  const placed = SLOTS.flatMap((slot) => {
    const entry = bySlot.get(slot.key);
    return entry ? [{ slot, entry }] : [];
  });
  return (
    <div className="flex flex-col gap-3 p-4" data-testid="lineup-sepak-side">
      <SideHeader side={side} />
      {placed.length > 0 ? (
        <div
          data-testid="sepak-court"
          role="img"
          aria-label={t("Court positions")}
          className="relative mx-auto aspect-[5/4] w-full max-w-[18rem] rounded-xl border-2 border-primary/40 bg-accent"
        >
          <span
            aria-hidden="true"
            className="absolute inset-x-0 top-1/2 h-px bg-primary/40"
          />
          {placed.map(({ slot, entry }) => (
            <div
              key={slot.key}
              data-testid={`court-slot-${slot.key}`}
              className={cn("absolute", slot.cls)}
            >
              <CourtDot entry={entry} label={slot.label} />
            </div>
          ))}
        </div>
      ) : (
        <ol className="flex flex-col">
          {onCourt.slice(0, 3).map((e) => (
            <PlayerRow key={e.player_id} entry={e} />
          ))}
        </ol>
      )}
      {leftovers.length > 0 ? (
        <ol className="flex flex-col">
          {leftovers.map((e) => (
            <PlayerRow key={e.player_id} entry={e} />
          ))}
        </ol>
      ) : null}
      <BenchList bench={bench} />
    </div>
  );
}

export function SepakLineups({ home, away }: LineupViewProps): React.ReactElement {
  return (
    <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
      <Side side={home} />
      <Side side={away} />
    </div>
  );
}
