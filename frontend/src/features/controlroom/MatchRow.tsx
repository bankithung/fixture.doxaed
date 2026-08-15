import { Lock, Radio } from "lucide-react";
import type { ControlRoomMatch, MatchRow as MatchRowT } from "@/api/tournaments";
import { LeafLabel } from "@/features/fixtures/LeafLabel";
import { liveSetView } from "@/lib/setDisplay";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { FINAL, IN_PLAY, fmtKickoff, isOverdue, matchWinner } from "./format";
import { RowActions, type ControlRoomPerms } from "./MatchActionsMenu";
import { StatusPill, groupSuffix } from "./MatchTile";

/**
 * One match as a single dense table row (control-room "Board" redesign): status
 * pill · time · court · competition pills · teams · score · crew · actions. Keeps
 * data-testid tile-<id> on the row so the domain tests resolve here exactly as
 * they did the old card. `showCourt=false` in Court-grouped mode (the court is
 * the group header). Live rows carry a left primary rule; overdue slots get a
 * "late" tag; the whole row is one h-8-rhythm line.
 */
export function MatchRow({
  match,
  timeZone,
  tournamentId,
  siblings,
  perms,
  delayMinutes = null,
  showCourt = true,
  showTime = true,
  badges,
}: {
  match: ControlRoomMatch;
  timeZone: string;
  tournamentId: string;
  siblings: MatchRowT[];
  perms: ControlRoomPerms;
  delayMinutes?: number | null;
  showCourt?: boolean;
  /** `false` under a kickoff-time group header, which already states the time. */
  showTime?: boolean;
  /** Caller-owned chips rendered inline in the row (My tasks puts the viewer's
   * own seat here — "Scoring", "Referee" — which only the caller can know). */
  badges?: React.ReactNode;
}): React.ReactElement {
  const showScore = IN_PLAY.has(match.status) || FINAL.has(match.status);
  const live = IN_PLAY.has(match.status);
  const done = FINAL.has(match.status);
  const overdue = isOverdue(match);
  const grp = groupSuffix(match.leaf_label, match.group_label);
  const winner = matchWinner(match);

  return (
    <div
      role="row"
      data-testid={`tile-${match.id}`}
      data-done={done ? "true" : undefined}
      className={cn(
        "group flex items-center gap-3 border-b border-border px-4 py-2.5 text-xs transition-colors last:border-b-0",
        // A settled match reads green down the whole row, so a long day's
        // board shows at a glance what is finished (owner 2026-07-26). Its
        // own hover tint, or the generic one would win on specificity.
        done
          ? "bg-success-muted/50 hover:bg-success-muted/80"
          : "hover:bg-secondary/40",
        live && "border-l-2 border-l-primary",
      )}
    >
      <div className="w-[6.25rem] shrink-0">
        <StatusPill match={match} />
      </div>

      <div
        className={cn(
          "flex shrink-0 items-center gap-1 font-tabular text-foreground",
          showTime ? "w-16" : "w-auto",
        )}
      >
        {showTime ? fmtKickoff(match.scheduled_at, timeZone) : null}
        {overdue ? (
          <span
            data-testid={`overdue-${match.id}`}
            className="rounded bg-destructive/15 px-1 py-0.5 text-[0.625rem] font-medium text-destructive"
          >
            {t("late")}
          </span>
        ) : null}
      </div>

      {showCourt ? (
        <div className="w-24 shrink-0 truncate">
          {match.venue ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">
              {match.venue}
            </span>
          ) : (
            <span className="rounded bg-warning-muted px-1.5 py-0.5 text-[0.6875rem] font-medium text-warning">
              {t("No court")}
            </span>
          )}
        </div>
      ) : null}

      <div className="hidden w-56 shrink-0 items-center gap-1 overflow-hidden md:flex">
        <LeafLabel label={match.leaf_label} />
        {grp ? (
          <span className="shrink-0 rounded bg-secondary px-1 py-0.5 text-[0.625rem] font-medium text-secondary-foreground">
            {grp}
          </span>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-2 text-[13px]">
        <span className="truncate font-medium">
          {match.home_team?.name ?? t("TBD")}
        </span>
        <span className="shrink-0 text-[0.625rem] text-muted-foreground">{t("v")}</span>
        <span className="truncate font-medium">
          {match.away_team?.name ?? t("TBD")}
        </span>
      </div>

      {badges ? (
        <div className="flex shrink-0 items-center gap-1">{badges}</div>
      ) : null}

      <div className="w-16 shrink-0 text-right font-tabular">
        {showScore ? (
          (() => {
            // Live set sport: the current set's points are the score that
            // moves; sets won ride the hover title.
            const sv = liveSetView(match);
            return (
              <span
                className="font-semibold"
                title={
                  sv ? `${t("Sets")} ${sv.sets[0]}-${sv.sets[1]}` : undefined
                }
              >
                {sv
                  ? `${sv.points[0]} - ${sv.points[1]}`
                  : `${match.home_score ?? 0} - ${match.away_score ?? 0}`}
              </span>
            );
          })()
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
      </div>

      {/* Winner — the result you can scan (owner 2026-08-15). Blank until the
          match is settled; a level score reads "Draw". */}
      <div
        data-testid={`winner-${match.id}`}
        className="hidden w-32 shrink-0 truncate text-[0.6875rem] md:block"
      >
        {winner ? (
          <span
            title={winner.label}
            className={cn(
              "inline-block max-w-full truncate rounded px-1.5 py-0.5 font-medium",
              winner.side === "draw"
                ? "bg-muted text-muted-foreground"
                : "bg-success-muted text-success",
            )}
          >
            {winner.label}
          </span>
        ) : (
          <span className="text-muted-foreground/50">·</span>
        )}
      </div>

      <div className="hidden w-24 shrink-0 items-center gap-1 truncate text-[0.6875rem] text-muted-foreground lg:flex">
        {delayMinutes ? (
          <span
            data-testid={`delay-${match.id}`}
            className="rounded bg-warning-muted px-1 py-0.5 font-tabular font-medium text-warning"
          >
            +{delayMinutes}
          </span>
        ) : null}
        {match.locked_at ? (
          <Lock aria-label={t("Slot locked")} data-testid={`lock-${match.id}`} className="h-3 w-3 shrink-0" />
        ) : null}
        {match.scorer ? (
          <span data-testid={`crew-${match.id}`} className="inline-flex min-w-0 items-center gap-1">
            <Radio aria-hidden="true" className="h-3 w-3 shrink-0" />
            <span className="truncate">{match.scorer.name}</span>
          </span>
        ) : null}
      </div>

      <div className="shrink-0">
        <RowActions
          tournamentId={tournamentId}
          match={match}
          siblings={siblings}
          perms={perms}
        />
      </div>
    </div>
  );
}

/**
 * The sheet's column header — the same widths every MatchRow uses, so a long
 * board reads as a spreadsheet with named columns instead of an unlabelled
 * stack of lines (owner 2026-08-15). Render it once, above the first group
 * band of a list.
 */
export function MatchSheetHeader({
  showCourt = true,
  showTime = true,
  hasBadges = false,
}: {
  showCourt?: boolean;
  showTime?: boolean;
  /** The caller renders a badges cell in each row (My tasks' own seat). */
  hasBadges?: boolean;
}): React.ReactElement {
  const cell =
    "shrink-0 text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground";
  return (
    <div
      role="row"
      data-testid="match-sheet-header"
      className="sticky top-0 z-20 flex items-center gap-3 border-b border-border bg-muted px-4 py-1.5"
    >
      <span className={cn(cell, "w-[6.25rem]")}>{t("Status")}</span>
      {showTime ? <span className={cn(cell, "w-16")}>{t("Time")}</span> : null}
      {showCourt ? <span className={cn(cell, "w-24")}>{t("Court")}</span> : null}
      <span className={cn(cell, "hidden w-56 md:block")}>
        {t("Competition")}
      </span>
      <span className={cn(cell, "min-w-0 flex-1")}>{t("Match")}</span>
      {hasBadges ? <span className={cn(cell, "w-16")}>{t("Your seat")}</span> : null}
      <span className={cn(cell, "w-16 text-right")}>{t("Score")}</span>
      <span className={cn(cell, "hidden w-32 md:block")}>{t("Winner")}</span>
      <span className={cn(cell, "hidden w-24 lg:block")}>{t("Crew")}</span>
      <span className={cn(cell, "w-8")}>
        <span className="sr-only">{t("Actions")}</span>
      </span>
    </div>
  );
}
