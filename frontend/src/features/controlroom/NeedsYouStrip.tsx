import type { ControlRoomMatch, MatchRow as MatchRowT } from "@/api/tournaments";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import {
  IN_PLAY,
  fmtKickoff,
  isCalled,
  isOverdue,
  urgencyWeight,
} from "./format";
import { RowActions, type ControlRoomPerms } from "./MatchActionsMenu";
import { StatusPill } from "./MatchTile";

const CAP = 6;

/** One-line reason a match is in the strip (drives scanning). */
function reason(m: ControlRoomMatch): string {
  if (isOverdue(m)) return t("Awaiting result");
  if (IN_PLAY.has(m.status)) return t("Live now");
  if (isCalled(m)) return t("Called, not started");
  if (!m.venue) return t("No court assigned");
  return t("Needs attention");
}

/**
 * The ranked triage spine (grafted from the triage concept): lifts only the
 * matches that want an operator NOW — overdue, live, called, or missing a court
 * — above the board, each with its single state-chosen primary action so an
 * exception is zero moves to find and one move to act. Renders nothing when the
 * day is under control (the KPI strip already says "All caught up").
 */
export function NeedsYouStrip({
  matches,
  timeZone,
  tournamentId,
  perms,
  siblingsOf,
}: {
  matches: ControlRoomMatch[];
  timeZone: string;
  tournamentId: string;
  perms: ControlRoomPerms;
  siblingsOf: (m: ControlRoomMatch) => MatchRowT[];
}): React.ReactElement | null {
  const items = matches
    .filter((m) => urgencyWeight(m) > 0)
    .sort(
      (a, b) =>
        urgencyWeight(b) - urgencyWeight(a) ||
        (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? ""),
    );
  if (items.length === 0) return null;

  return (
    <section
      data-testid="needs-you"
      className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 shadow-sm"
    >
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">{t("Needs you now")}</h3>
        <span className="rounded-full bg-destructive/15 px-2 py-0.5 font-tabular text-xs font-medium text-destructive">
          {items.length}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-1.5 lg:grid-cols-2">
        {items.slice(0, CAP).map((m) => (
          <div
            key={m.id}
            className={cn(
              "flex items-center gap-2 rounded-lg border border-l-2 border-border bg-background/40 px-2.5 py-1.5",
              isOverdue(m)
                ? "border-l-destructive"
                : IN_PLAY.has(m.status)
                  ? "border-l-primary"
                  : "border-l-warning-foreground",
            )}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                <StatusPill match={m} idScope="needs-" />
                <span className="font-tabular">
                  {fmtKickoff(m.scheduled_at, timeZone)}
                </span>
                <span className="truncate">{reason(m)}</span>
              </div>
              <span className="truncate text-xs font-medium">
                {m.home_team?.name ?? t("TBD")} {t("v")}{" "}
                {m.away_team?.name ?? t("TBD")}
              </span>
            </div>
            <RowActions
              tournamentId={tournamentId}
              match={m}
              siblings={siblingsOf(m)}
              perms={perms}
              primary
              idScope="needs-"
              showRepair={false}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
