import { Lock, Radio } from "lucide-react";
import type { ControlRoomMatch, MatchRow as MatchRowT } from "@/api/tournaments";
import { LeafLabel } from "@/features/fixtures/LeafLabel";
import { liveSetView } from "@/lib/setDisplay";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { FINAL, IN_PLAY, fmtKickoff, isOverdue } from "./format";
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
}: {
  match: ControlRoomMatch;
  timeZone: string;
  tournamentId: string;
  siblings: MatchRowT[];
  perms: ControlRoomPerms;
  delayMinutes?: number | null;
  showCourt?: boolean;
}): React.ReactElement {
  const showScore = IN_PLAY.has(match.status) || FINAL.has(match.status);
  const live = IN_PLAY.has(match.status);
  const overdue = isOverdue(match);
  const grp = groupSuffix(match.leaf_label, match.group_label);

  return (
    <div
      role="row"
      data-testid={`tile-${match.id}`}
      className={cn(
        "group flex items-center gap-3 border-b border-border px-4 py-2.5 text-xs transition-colors last:border-b-0 hover:bg-secondary/40",
        live && "border-l-2 border-l-primary",
      )}
    >
      <div className="w-[6.25rem] shrink-0">
        <StatusPill match={match} />
      </div>

      <div className="flex w-16 shrink-0 items-center gap-1 font-tabular text-foreground">
        {fmtKickoff(match.scheduled_at, timeZone)}
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
