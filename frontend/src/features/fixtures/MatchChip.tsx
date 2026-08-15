import type { PreviewMatch } from "@/api/tournaments";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { addMinutes, clockOf } from "./previewGrid";
import { competitionLabel } from "./previewFilters";
import { shortGroupName } from "./groupSlotLabel";
import { LeafLabel } from "./LeafLabel";
import { sideName } from "./sideName";

/**
 * One previewed match as a card. The spreadsheet is the schedule surface now
 * (owner 2026-08-15); this chip survives inside the competition Draw panel,
 * where a group's fixtures read as cards beside its table of teams.
 */
export function MatchChip({
  match,
  accent,
  teamNames,
  showCompetition = true,
}: {
  match: PreviewMatch;
  accent: string;
  teamNames: ReadonlyMap<string, string>;
  /** Show the competition pills + group chip. False inside a group card whose
   * heading already names the competition and group. */
  showCompetition?: boolean;
}): React.ReactElement {
  const start = clockOf(match.scheduled_at);
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
          {start || "·"}
          {start && dur ? (
            <span className="font-normal text-muted-foreground">
              {" - "}
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
