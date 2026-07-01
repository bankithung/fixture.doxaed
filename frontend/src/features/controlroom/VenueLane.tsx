import { useState } from "react";
import { ChevronDown, ChevronRight, MapPin } from "lucide-react";
import type { ControlRoomMatch, MatchRow } from "@/api/tournaments";
import { t } from "@/lib/t";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { IN_PLAY, isCalled, type SlotDelay, delayFor } from "./format";
import { MatchTile } from "./MatchTile";
import type { ControlRoomPerms } from "./MatchActionsMenu";

/** How many upcoming matches a lane shows before folding the rest behind a toggle. */
const LANE_CAP = 6;

/**
 * One venue's lane for the selected day (spec §1.1): a NOW slot (the in-play
 * match, else the called one) followed by the NEXT list in kick-off order.
 * Desktop = one column of the lanes grid; mobile = a collapsible section
 * (lanes with something happening start open).
 */
export function VenueLane({
  venue,
  matches,
  timeZone,
  tournamentId,
  perms,
  delays,
  siblingsOf,
}: {
  venue: string;
  matches: ControlRoomMatch[];
  timeZone: string;
  tournamentId: string;
  perms: ControlRoomPerms;
  delays: Map<string, SlotDelay>;
  /** Same-competition matches across all lanes (swap candidates). */
  siblingsOf: (m: ControlRoomMatch) => MatchRow[];
}): React.ReactElement {
  const { isMobile } = useBreakpoint();
  const now =
    matches.find((m) => IN_PLAY.has(m.status)) ??
    matches.find((m) => isCalled(m)) ??
    null;
  // Mobile accordion: lanes with a NOW slot start open.
  const [open, setOpen] = useState(now !== null);
  // Busy courts run 20+ slots a day; show the next handful and fold the rest
  // behind a toggle so the lane stays a professional height, not a wall.
  const [showAll, setShowAll] = useState(false);
  const expanded = !isMobile || open;
  const rest = now === null ? matches : matches.filter((m) => m.id !== now.id);
  const visibleRest = showAll ? rest : rest.slice(0, LANE_CAP);
  const liveCount = matches.filter((m) => IN_PLAY.has(m.status)).length;

  const header = (
    <>
      <MapPin aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
      <h3 className="truncate text-sm font-semibold">
        {venue || t("Unassigned venue")}
      </h3>
      {liveCount > 0 ? (
        <span className="relative flex h-2 w-2" aria-label={t("Live now")}>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
        </span>
      ) : null}
      <span className="rounded-full bg-muted px-2 py-0.5 font-tabular text-xs text-muted-foreground">
        {matches.length}
      </span>
    </>
  );

  return (
    <section
      data-testid={`lane-${venue || "unassigned"}`}
      className="flex min-w-0 flex-col gap-2"
    >
      {isMobile ? (
        <button
          type="button"
          aria-expanded={open}
          data-testid={`lane-toggle-${venue || "unassigned"}`}
          className="flex items-center gap-2 text-left"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? (
            <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          {header}
        </button>
      ) : (
        <div className="flex items-center gap-2">{header}</div>
      )}

      {expanded ? (
        <div className="flex flex-col gap-2">
          {now ? (
            <>
              <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                {t("Now")}
              </p>
              <MatchTile
                match={now}
                timeZone={timeZone}
                tournamentId={tournamentId}
                siblings={siblingsOf(now)}
                perms={perms}
                highlight
                delayMinutes={delayFor(delays, now)}
              />
              {rest.length > 0 ? (
                <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  {t("Next")}
                </p>
              ) : null}
            </>
          ) : null}
          {visibleRest.map((m) => (
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
          {rest.length > LANE_CAP ? (
            <button
              type="button"
              data-testid={`lane-more-${venue || "unassigned"}`}
              onClick={() => setShowAll((o) => !o)}
              className="mt-0.5 self-start rounded-md px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {showAll ? t("Show fewer") : `${t("Show all")} ${rest.length}`}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
