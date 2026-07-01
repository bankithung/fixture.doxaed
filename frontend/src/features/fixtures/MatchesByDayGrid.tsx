import { useMemo } from "react";
import { Coffee } from "lucide-react";
import type { PreviewMatch } from "@/api/tournaments";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { sideName } from "./sideName";
import { LeafLabel } from "./LeafLabel";
import { competitionLabel } from "./previewFilters";
import { shortGroupName } from "./groupSlotLabel";

/** Token-only accent palette — one left-border colour per competition so
 * multi-sport days stay scannable (no hardcoded hex, design system rule). */
export const LEAF_ACCENTS = [
  "border-l-primary",
  "border-l-info",
  "border-l-success",
  "border-l-warning",
  "border-l-destructive",
] as const;

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function fmtTime(iso: string): string {
  // Preview times are tournament-local wall clock (invariant 14) — show the
  // wall-clock value verbatim, never viewer-TZ shifted.
  return iso.slice(11, 16);
}

/** start ("…T09:30") + minutes → "09:50" wall clock (no Date math, no TZ). */
function addMinutes(iso: string, mins: number): string {
  const [h, m] = iso.slice(11, 16).split(":").map(Number);
  const total = h * 60 + m + mins;
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** Wall-clock "…T11:30" → minutes since midnight (for gap math). */
function toMinutes(iso: string): number {
  const [h, m] = iso.slice(11, 16).split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

// An idle stretch of this many minutes or more (nothing on the court) is a break.
const BREAK_MIN = 30;

/** minutes since midnight → "11:30". */
function fromMinutes(min: number): string {
  return `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(
    min % 60,
  ).padStart(2, "0")}`;
}

/** The idle sub-windows of [start, end) once every busy interval is removed —
 * so a gap between two shown matches that is only PARTLY filled by other
 * categories still surfaces its genuinely-empty stretches. */
function idleWindows(
  start: number,
  end: number,
  busy: [number, number][],
): [number, number][] {
  const clipped = busy
    .map(([s, e]): [number, number] => [Math.max(s, start), Math.min(e, end)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const idle: [number, number][] = [];
  let cursor = start;
  for (const [s, e] of clipped) {
    if (s > cursor) idle.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < end) idle.push([cursor, end]);
  return idle;
}

/** A visible "no play" gap between two matches on the same court, so the
 * organiser can SEE when the break is instead of inferring it from a time jump. */
function BreakRow({
  from,
  to,
  minutes,
}: {
  from: string;
  to: string;
  minutes: number;
}): React.ReactElement {
  return (
    <div className="my-1 flex items-center gap-2" title={`${t("Break")} ${from} to ${to}`}>
      <span className="h-px flex-1 bg-warning/30" />
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-warning/40 bg-warning-muted px-3 py-1">
        <Coffee aria-hidden="true" className="h-3.5 w-3.5 text-warning" />
        <span className="text-xs font-semibold text-foreground">{t("Break")}</span>
        <span className="font-tabular text-xs text-muted-foreground">
          {from}-{to} · {minutes} {t("min")}
        </span>
      </span>
      <span className="h-px flex-1 bg-warning/30" />
    </div>
  );
}

/** Render a court's matches in play order, inserting a BreakRow only where the
 * COURT is genuinely idle: the next shown match starts BREAK_MIN+ minutes later
 * AND no other match (from the full `busy` occupancy — every category + stage on
 * that court) fills the gap. This is what stops a filtered view (one category)
 * from inventing "breaks" for time the court is actually busy with others. */
function withBreaks(
  ms: PreviewMatch[],
  busy: [number, number][],
  renderMatch: (m: PreviewMatch) => React.ReactElement,
): React.ReactElement[] {
  const out: React.ReactElement[] = [];
  ms.forEach((m, i) => {
    out.push(renderMatch(m));
    const next = ms[i + 1];
    if (next && m.scheduled_at && next.scheduled_at && m.duration_minutes != null) {
      const gapStart = toMinutes(m.scheduled_at) + m.duration_minutes;
      const gapEnd = toMinutes(next.scheduled_at);
      idleWindows(gapStart, gapEnd, busy).forEach(([s, e], j) => {
        if (e - s >= BREAK_MIN) {
          out.push(
            <BreakRow key={`brk-${m.ref}-${j}`} from={fromMinutes(s)} to={fromMinutes(e)} minutes={e - s} />,
          );
        }
      });
    }
  });
  return out;
}

export function MatchChip({
  match,
  accent,
  teamNames,
  showCompetition = true,
}: {
  match: PreviewMatch;
  accent: string;
  teamNames: ReadonlyMap<string, string>;
  /** Show the competition pills + group chip. True on the by-day grid (a court
   * mixes competitions); false inside a by-group card whose heading already
   * names the competition and group. */
  showCompetition?: boolean;
}): React.ReactElement {
  const start = match.scheduled_at;
  const dur = match.duration_minutes ?? null;
  // Only real group-stage matches carry a "Group A" tag (knockout/league rows
  // would otherwise mis-read the last leaf segment as a group).
  const groupTag =
    match.stage !== "knockout" && /group/i.test(match.group_label ?? "")
      ? `${t("Group")} ${shortGroupName(match.group_label)}`
      : "";
  return (
    <div
      data-testid={`chip-${match.ref}`}
      className={cn(
        "flex flex-col gap-1 rounded-lg border border-border border-l-2 bg-card px-2.5 py-2 shadow-sm",
        accent,
      )}
    >
      {/* meta: kickoff (and end) time, round, length */}
      <div className="flex items-center gap-1.5">
        <span className="font-tabular text-xs font-semibold">
          {start ? fmtTime(start) : "—"}
          {start && dur ? (
            <span className="font-normal text-muted-foreground">
              {" – "}
              {addMinutes(start, dur)}
            </span>
          ) : null}
        </span>
        {match.round_no ? (
          <span className="font-tabular text-[0.625rem] text-muted-foreground">
            {t("R")}
            {match.round_no}
          </span>
        ) : null}
        {dur ? (
          <span
            data-testid={`chip-${match.ref}-duration`}
            className="ml-auto rounded-full bg-muted px-1.5 py-px font-tabular text-[0.625rem] font-medium text-muted-foreground"
            title={t("Match length")}
          >
            {dur} {t("min")}
          </span>
        ) : null}
      </div>
      {/* the headline: the two sides, each on its own line so long school names
          stay readable instead of overflowing a "X vs Y" row */}
      <div className="flex flex-col gap-0.5 text-sm leading-snug">
        <span className="truncate font-medium">
          {sideName(match.home, teamNames)}
        </span>
        <span className="truncate font-medium">
          {sideName(match.away, teamNames)}
        </span>
      </div>
      {/* competition as colour pills + a clean group chip — never the raw
          em-dash leaf string */}
      {showCompetition ? (
        <div className="flex flex-wrap items-center gap-1 pt-0.5">
          <LeafLabel label={competitionLabel(match)} size="sm" />
          {groupTag ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[0.625rem] font-medium text-muted-foreground">
              {groupTag}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The dry-run preview's days × venues grid (redesign §6 screen 5): one band
 * per day, one column per venue used that day, competition-coloured chips.
 * Stacks into a flat time-ordered list on mobile (useBreakpoint).
 */
export function MatchesByDayGrid({
  matches,
  teamNames,
  occupancy,
}: {
  matches: PreviewMatch[];
  /** team_id → display name (the preview carries ids only). */
  teamNames: ReadonlyMap<string, string>;
  /** ALL scheduled matches (every category + stage) on these courts, so a break
   * only shows when the court is truly free — not when the filtered-out matches
   * (other categories, the knockout) are using it. Defaults to `matches`. */
  occupancy?: PreviewMatch[];
}): React.ReactElement {
  const { isMobile } = useBreakpoint();

  // Busy intervals [startMin, endMin] per `${day}|${venue}` from the FULL
  // occupancy — the truth about when each court is in use.
  const busyByCourt = useMemo(() => {
    const map = new Map<string, [number, number][]>();
    for (const m of occupancy ?? matches) {
      if (!m.scheduled_at || m.duration_minutes == null) continue;
      const key = `${m.scheduled_at.slice(0, 10)}|${m.venue || t("Unassigned venue")}`;
      const s = toMinutes(m.scheduled_at);
      const arr = map.get(key);
      if (arr) arr.push([s, s + m.duration_minutes]);
      else map.set(key, [[s, s + m.duration_minutes]]);
    }
    return map;
  }, [occupancy, matches]);

  const { days, accentOf } = useMemo(() => {
    const scheduled = matches
      .filter((m) => m.scheduled_at)
      .sort((a, b) => (a.scheduled_at! < b.scheduled_at! ? -1 : 1));
    const byDay = new Map<string, Map<string, PreviewMatch[]>>();
    const accents = new Map<string, string>();
    for (const m of scheduled) {
      if (!accents.has(m.leaf_key)) {
        accents.set(m.leaf_key, LEAF_ACCENTS[accents.size % LEAF_ACCENTS.length]);
      }
      const day = m.scheduled_at!.slice(0, 10);
      const venue = m.venue || t("Unassigned venue");
      if (!byDay.has(day)) byDay.set(day, new Map());
      const venues = byDay.get(day)!;
      if (!venues.has(venue)) venues.set(venue, []);
      venues.get(venue)!.push(m);
    }
    return {
      days: [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
      accentOf: (leaf: string) => accents.get(leaf) ?? LEAF_ACCENTS[0],
    };
  }, [matches]);

  if (days.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("No matches were scheduled in this preview.")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {days.map(([day, venues]) => (
        <section
          key={day}
          data-testid={`day-${day}`}
          className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
        >
          <h3 className="border-b border-border bg-muted/40 px-4 py-2 text-sm font-semibold">
            {fmtDay(day)}
            <span className="ml-2 font-tabular text-xs font-normal text-muted-foreground">
              {[...venues.values()].reduce((n, ms) => n + ms.length, 0)}{" "}
              {t("matches")}
            </span>
          </h3>
          {isMobile ? (
            <div className="flex flex-col gap-2 px-3 py-3">
              {[...venues.entries()].flatMap(([venue, ms]) =>
                withBreaks(ms, busyByCourt.get(`${day}|${venue}`) ?? [], (m) => (
                  <div key={m.ref} className="flex flex-col gap-0.5">
                    <MatchChip match={m} accent={accentOf(m.leaf_key)} teamNames={teamNames} />
                    <span className="px-1 text-[0.6875rem] text-muted-foreground">
                      {venue}
                    </span>
                  </div>
                )),
              )}
            </div>
          ) : (
            <div
              className="grid gap-3 px-4 py-3"
              style={{
                gridTemplateColumns: `repeat(${Math.min(venues.size, 4)}, minmax(0, 1fr))`,
              }}
            >
              {[...venues.entries()].map(([venue, ms]) => (
                <div key={venue} className="flex min-w-0 flex-col gap-1.5">
                  <h4 className="truncate text-xs font-medium text-muted-foreground">
                    {venue}
                  </h4>
                  {withBreaks(ms, busyByCourt.get(`${day}|${venue}`) ?? [], (m) => (
                    <MatchChip
                      key={m.ref}
                      match={m}
                      accent={accentOf(m.leaf_key)}
                      teamNames={teamNames}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
