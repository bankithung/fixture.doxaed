import { useMemo } from "react";
import {
  type PublicCourtLink,
  type PublicScheduleMatch,
} from "@/api/tournaments";
import { WatchLiveLink } from "@/features/live/WatchLiveLink";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { FINAL_STATUSES, LIVE_STATUSES } from "./publicTournament";
import { LivePulse } from "./publicMatchCard";
import { MatchSheet } from "./MatchSheet";

/**
 * The order of play for ONE day, ONE SHEET PER COURT — the default and main
 * view of the public match centre.
 *
 * A tournament day is a physical thing: five tables running side by side, each
 * with its own queue. "When does she play, and where do I stand" is answered
 * by a court's running order, and a single time-ordered list buries it — at
 * 09:00 five matches start at once and the court is a word in small grey text.
 * A court per sheet IS the board pinned up at the venue, and every court gets
 * the full width so its columns actually line up (owner 2026-08-21).
 *
 * Court grouping only earns the default when there is more than one court (see
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
  numbers,
  linkFor,
}: {
  lane: CourtLane;
  timeZone: string;
  numbers: Map<string, number>;
  linkFor?: (m: PublicScheduleMatch) => string;
}): React.ReactElement {
  const left = lane.matches.length - lane.played;
  // "Next up" is the first match on this court that has not been played and is
  // not already on — the one question a court's own sheet exists to answer.
  const nextId = lane.matches.find(
    (m) => !FINAL_STATUSES.has(m.status) && !LIVE_STATUSES.has(m.status),
  )?.id;
  return (
    <section
      data-testid={`court-lane-${lane.name}`}
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card",
        lane.live > 0 && "border-primary/40",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2 sm:px-4">
        {lane.live > 0 ? <LivePulse /> : null}
        <h3 className="min-w-0 truncate text-sm font-semibold">{lane.name}</h3>
        <span className="font-tabular text-xs text-muted-foreground">
          {lane.matches.length} {lane.matches.length === 1 ? t("match") : t("matches")}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-3">
          <WatchLiveLink
            url={lane.link?.is_streaming ? lane.link.watch_url : null}
            className="h-6 px-1.5 text-[0.6875rem] text-primary hover:bg-primary/10"
            testid={`watch-court-${lane.name}`}
            label={`${t("Watch live")} ${lane.name}`}
          />
          <span className="font-tabular text-xs text-muted-foreground">
            {left === 0
              ? t("All played")
              : `${lane.played}/${lane.matches.length} ${t("played")}`}
          </span>
        </span>
      </div>
      <MatchSheet
        matches={lane.matches}
        timeZone={timeZone}
        numbers={numbers}
        idScope={`court-${lane.name}`}
        nextId={nextId}
        linkFor={linkFor}
      />
    </section>
  );
}

/** One day's matches as one full-width sheet per court. */
export function CourtBoard({
  day,
  matches,
  timeZone,
  courts,
  numbers,
  linkFor,
}: {
  day: string;
  matches: PublicScheduleMatch[];
  timeZone: string;
  courts: PublicCourtLink[] | undefined;
  numbers: Map<string, number>;
  linkFor?: (m: PublicScheduleMatch) => string;
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
      // One court per row, full width: eight columns of a fixture sheet need
      // the whole panel, and two half-width sheets line up with nothing.
      className="flex flex-col gap-4 p-3 sm:p-4"
    >
      {lanes.map((lane) => (
        <Lane
          key={lane.key}
          lane={lane}
          timeZone={timeZone}
          numbers={numbers}
          linkFor={linkFor}
        />
      ))}
    </div>
  );
}
