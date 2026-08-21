import { useMemo } from "react";
import {
  type PublicCourtLink,
  type PublicScheduleMatch,
} from "@/api/tournaments";
import { WatchLiveLink } from "@/features/live/WatchLiveLink";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { FINAL_STATUSES, LIVE_STATUSES } from "./publicTournament";
import { LivePulse, MatchCard } from "./publicMatchCard";

/**
 * The order of play for ONE day, grouped by COURT — the default view of the
 * public match centre.
 *
 * A tournament day is a physical thing: five tables running side by side, each
 * with its own queue. "When does my daughter play, and where do I stand" is
 * answered by the court's running order, and a purely time-ordered list buries
 * it: at 09:00 five matches start at once and the court is a word in small grey
 * text. One lane per court, each in kick-off order, IS the board pinned up at
 * the venue.
 *
 * It only earns the default when there is more than one court (see
 * `courtDefaultFits`); on a single-court day a lane is the day list with an
 * extra heading.
 */

const UNASSIGNED = " unassigned";

export interface CourtLane {
  key: string;
  name: string;
  matches: PublicScheduleMatch[];
  live: number;
  played: number;
  link: PublicCourtLink | undefined;
}

/** Court display names carry a number ("Audi T2"), so a plain sort puts T10
 * before T2. Numeric collation keeps a lane list in the order the venue uses. */
function byName(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export function buildCourtLanes(
  matches: PublicScheduleMatch[],
  courts: PublicCourtLink[] | undefined,
): CourtLane[] {
  const byCourt = new Map<string, PublicScheduleMatch[]>();
  for (const m of matches) {
    const key = m.venue || UNASSIGNED;
    if (!byCourt.has(key)) byCourt.set(key, []);
    byCourt.get(key)!.push(m);
  }
  // The payload's court list is the venue's own order (materialised per venue,
  // expanded name and all); anything it does not name falls in behind it.
  const rank = new Map<string, number>();
  (courts ?? []).forEach((c, i) => rank.set(c.name, i));
  const links = new Map((courts ?? []).map((c) => [c.name, c]));

  return [...byCourt.entries()]
    .sort(([a], [b]) => {
      // Matches with no court at all always sit last: they are not a lane.
      if (a === UNASSIGNED) return 1;
      if (b === UNASSIGNED) return -1;
      const ra = rank.get(a);
      const rb = rank.get(b);
      if (ra != null && rb != null) return ra - rb;
      if (ra != null) return -1;
      if (rb != null) return 1;
      return byName(a, b);
    })
    .map(([key, ms]) => {
      const ordered = [...ms].sort((x, y) =>
        (x.scheduled_at ?? "~") < (y.scheduled_at ?? "~") ? -1 : 1,
      );
      return {
        key,
        name: key === UNASSIGNED ? t("No court yet") : key,
        matches: ordered,
        live: ordered.filter((m) => LIVE_STATUSES.has(m.status)).length,
        played: ordered.filter((m) => FINAL_STATUSES.has(m.status)).length,
        link: links.get(key),
      };
    });
}

/** Court grouping is only worth the extra headings when the day actually runs
 * on more than one court. */
export function courtDefaultFits(matches: PublicScheduleMatch[]): boolean {
  const seen = new Set<string>();
  for (const m of matches) if (m.venue) seen.add(m.venue);
  return seen.size > 1;
}

function Lane({
  lane,
  timeZone,
}: {
  lane: CourtLane;
  timeZone: string;
}): React.ReactElement {
  // "Next up" marks the first match on this court that has not been played and
  // is not already on: the one question a lane exists to answer.
  const nextId = lane.matches.find(
    (m) => !FINAL_STATUSES.has(m.status) && !LIVE_STATUSES.has(m.status),
  )?.id;
  const done = lane.played === lane.matches.length;
  return (
    <section
      data-testid={`court-lane-${lane.name}`}
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card",
        lane.live > 0 && "border-primary/40 ring-1 ring-primary/20",
      )}
    >
      {/* Sticky so the court stays named while a long queue scrolls past it. */}
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-muted px-3 py-2 sm:px-4">
        {lane.live > 0 ? <LivePulse /> : null}
        <h3 className="min-w-0 truncate text-sm font-semibold">{lane.name}</h3>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <WatchLiveLink
            url={lane.link?.is_streaming ? lane.link.watch_url : null}
            variant="ghost"
            className="h-6 px-1.5 text-[0.6875rem] text-primary hover:bg-primary/10"
            testid={`watch-court-${lane.name}`}
            label={`${t("Watch live")} ${lane.name}`}
          />
          <span className="font-tabular text-xs text-muted-foreground">
            {done
              ? t("All played")
              : `${lane.played}/${lane.matches.length} ${t("played")}`}
          </span>
        </span>
      </div>
      <ul className="divide-y divide-border">
        {lane.matches.map((m) => (
          <MatchCard
            key={m.id}
            match={m}
            timeZone={timeZone}
            labels="court"
            flag={m.id === nextId ? t("Next up") : undefined}
          />
        ))}
      </ul>
    </section>
  );
}

/** One day's matches as one lane per court. */
export function CourtBoard({
  day,
  matches,
  timeZone,
  courts,
}: {
  day: string;
  matches: PublicScheduleMatch[];
  timeZone: string;
  courts: PublicCourtLink[] | undefined;
}): React.ReactElement {
  const lanes = useMemo(
    () => buildCourtLanes(matches, courts),
    [matches, courts],
  );

  if (lanes.length === 0) {
    return (
      <p className="p-6 text-center text-sm text-muted-foreground">
        {t("No matches on this day.")}
      </p>
    );
  }
  return (
    <div
      data-testid={`public-day-${day}`}
      // Lanes are independent queues, so they tile and each keeps its own
      // height (`items-start`); a phone gets one full-width lane at a time.
      className="grid grid-cols-1 items-start gap-3 p-3 sm:p-4 lg:grid-cols-2 2xl:grid-cols-3"
    >
      {lanes.map((lane) => (
        <Lane key={lane.key} lane={lane} timeZone={timeZone} />
      ))}
    </div>
  );
}
