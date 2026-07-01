import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type {
  ControlRoomMatch,
  ControlRoomVenue,
  MatchRow as MatchRowT,
} from "@/api/tournaments";
import { t } from "@/lib/t";
import { useBreakpoint } from "@/lib/useBreakpoint";
import {
  FINAL,
  IN_PLAY,
  isCalled,
  needsAttention,
  type SlotDelay,
  delayFor,
} from "./format";
import { MatchRow } from "./MatchRow";
import { MatchTile } from "./MatchTile";
import type { ControlRoomPerms } from "./MatchActionsMenu";

export type BoardGroup = "court" | "time";
export type BoardFilter = "all" | "attention" | "live" | "scheduled" | "done";

/** Quick-filter predicate over a single match. */
function passesFilter(m: ControlRoomMatch, f: BoardFilter): boolean {
  switch (f) {
    case "attention":
      return needsAttention(m);
    case "live":
      return IN_PLAY.has(m.status);
    case "scheduled":
      return m.status === "scheduled";
    case "done":
      return FINAL.has(m.status) || m.status === "completed";
    default:
      return true;
  }
}

/** Free-text search over the fields a searcher would type. */
function passesSearch(m: ControlRoomMatch, q: string): boolean {
  if (!q) return true;
  const hay = [
    m.home_team?.name,
    m.away_team?.name,
    m.venue,
    m.leaf_label,
    m.group_label,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((tok) => hay.includes(tok));
}

const byKickoff = (a: ControlRoomMatch, b: ControlRoomMatch): number =>
  (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? "") ||
  a.id.localeCompare(b.id);

/** A collapsible court group (replaces the old VenueLane) — keeps the
 * lane-<venue> testid on its wrapper so layout tests resolve. Any group with a
 * live or called match is force-open. */
function CourtGroup({
  venue,
  matches,
  timeZone,
  tournamentId,
  perms,
  delays,
  siblingsOf,
  isMobile,
}: {
  venue: string;
  matches: ControlRoomMatch[];
  timeZone: string;
  tournamentId: string;
  perms: ControlRoomPerms;
  delays: Map<string, SlotDelay>;
  siblingsOf: (m: ControlRoomMatch) => MatchRowT[];
  isMobile: boolean;
}): React.ReactElement {
  const forceOpen = matches.some((m) => IN_PLAY.has(m.status) || isCalled(m));
  const [open, setOpen] = useState(true);
  const expanded = open || forceOpen;
  const live = matches.filter((m) => IN_PLAY.has(m.status)).length;
  const done = matches.filter((m) => FINAL.has(m.status) || m.status === "completed").length;

  return (
    <section data-testid={`lane-${venue || "unassigned"}`} className="flex flex-col">
      <button
        type="button"
        onClick={() => !forceOpen && setOpen((o) => !o)}
        aria-expanded={expanded}
        className="flex items-center gap-2 border-b border-border bg-muted/60 px-3 py-1.5 text-left"
      >
        {expanded ? (
          <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate text-xs font-semibold">
          {venue || t("No court yet")}
        </span>
        {live > 0 ? (
          <span className="relative flex h-2 w-2" aria-label={t("Live now")}>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
        ) : null}
        <span className="ml-auto font-tabular text-[0.6875rem] text-muted-foreground">
          {done}/{matches.length}
        </span>
      </button>
      {expanded
        ? isMobile
          ? (
            <div className="flex flex-col gap-2 py-2">
              {matches.map((m) => (
                <MatchTile
                  key={m.id}
                  match={m}
                  timeZone={timeZone}
                  tournamentId={tournamentId}
                  siblings={siblingsOf(m)}
                  perms={perms}
                  delayMinutes={delayFor(delays, m)}
                />
              ))}
            </div>
          )
          : matches.map((m) => (
              <MatchRow
                key={m.id}
                match={m}
                timeZone={timeZone}
                tournamentId={tournamentId}
                siblings={siblingsOf(m)}
                perms={perms}
                delayMinutes={delayFor(delays, m)}
                showCourt={false}
              />
            ))
        : null}
    </section>
  );
}

/**
 * THE BOARD — the whole day's matches as one dense, filterable surface (the
 * redesign's single source of truth, replacing the venue-lane grid + queue
 * rail). Group-by=Court renders collapsible sticky court sections; Group-by=Time
 * renders one flat chronological list across every court (the true cross-court
 * "up next"). Mobile falls back to the card stack (the codified table→card rule).
 */
export function BoardTable({
  venues,
  timeZone,
  tournamentId,
  perms,
  delays,
  siblingsOf,
  group,
  filter,
  query,
}: {
  venues: ControlRoomVenue[];
  timeZone: string;
  tournamentId: string;
  perms: ControlRoomPerms;
  delays: Map<string, SlotDelay>;
  siblingsOf: (m: ControlRoomMatch) => MatchRowT[];
  group: BoardGroup;
  filter: BoardFilter;
  query: string;
}): React.ReactElement {
  const { isMobile } = useBreakpoint();

  const keep = (m: ControlRoomMatch): boolean =>
    passesFilter(m, filter) && passesSearch(m, query);

  const flat = useMemo(
    () => venues.flatMap((v) => v.matches).filter(keep).sort(byKickoff),
    [venues, filter, query],
  );

  if (flat.length === 0) {
    return (
      <div
        data-testid="board-empty"
        className="flex min-h-40 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border bg-secondary/40 text-center"
      >
        <p className="text-sm font-medium">{t("No matches for these filters")}</p>
        <p className="text-xs text-muted-foreground">
          {t("Clear the filters or search to see the full day.")}
        </p>
      </div>
    );
  }

  return (
    <div
      data-testid="board"
      role="table"
      className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
    >
      {group === "court"
        ? venues
            .map((v) => ({ v, ms: v.matches.filter(keep).sort(byKickoff) }))
            .filter(({ ms }) => ms.length > 0)
            .map(({ v, ms }) => (
              <CourtGroup
                key={v.venue || "unassigned"}
                venue={v.venue}
                matches={ms}
                timeZone={timeZone}
                tournamentId={tournamentId}
                perms={perms}
                delays={delays}
                siblingsOf={siblingsOf}
                isMobile={isMobile}
              />
            ))
        : isMobile
          ? (
            <div className="flex flex-col gap-2 p-2">
              {flat.map((m) => (
                <MatchTile
                  key={m.id}
                  match={m}
                  timeZone={timeZone}
                  tournamentId={tournamentId}
                  siblings={siblingsOf(m)}
                  perms={perms}
                  delayMinutes={delayFor(delays, m)}
                />
              ))}
            </div>
          )
          : flat.map((m) => (
              <MatchRow
                key={m.id}
                match={m}
                timeZone={timeZone}
                tournamentId={tournamentId}
                siblings={siblingsOf(m)}
                perms={perms}
                delayMinutes={delayFor(delays, m)}
                showCourt
              />
            ))}
    </div>
  );
}
