import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Lock } from "lucide-react";
import type { MatchRow } from "@/api/tournaments";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { MatchRepairMenu } from "./MatchRepairControls";

const FINAL = new Set(["completed", "walkover"]);

function meta(m: MatchRow): string {
  const parts: string[] = [];
  if (m.scheduled_at) {
    parts.push(
      new Date(m.scheduled_at).toLocaleString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
  }
  if (m.venue) parts.push(m.venue);
  return parts.join(" · ");
}

function Row({
  match,
  tournamentId,
  canRepair,
  siblings,
}: {
  match: MatchRow;
  tournamentId: string;
  canRepair: boolean;
  siblings: MatchRow[];
}): React.ReactElement {
  const done = FINAL.has(match.status);
  return (
    <li
      data-testid={`result-row-${match.id}`}
      className="flex items-center gap-2 border-t border-border py-1.5 text-sm first:border-t-0"
    >
      <span className="w-8 shrink-0 font-tabular text-[0.6875rem] text-muted-foreground">
        {t("R")}{match.round_no}
      </span>
      {match.locked_at ? (
        <span
          data-testid={`locked-${match.id}`}
          title={t("Pinned. Re-runs and delays won't move it.")}
          className="inline-flex shrink-0 items-center rounded-full bg-muted px-1 py-0.5 text-muted-foreground"
        >
          <Lock aria-hidden="true" className="h-3 w-3" />
          <span className="sr-only">{t("Slot locked")}</span>
        </span>
      ) : null}
      <span className="flex-1 truncate text-right font-medium">
        {match.home_team?.name ?? t("TBD")}
      </span>
      <span
        className={cn(
          "shrink-0 px-1 text-center font-tabular",
          done ? "font-semibold" : "text-xs text-muted-foreground",
        )}
      >
        {done ? `${match.home_score ?? 0} - ${match.away_score ?? 0}` : t("vs")}
      </span>
      <span className="flex-1 truncate font-medium">
        {match.away_team?.name ?? t("TBD")}
      </span>
      <span className="hidden shrink-0 font-tabular text-[0.6875rem] text-muted-foreground sm:inline">
        {meta(match)}
      </span>
      <Link
        to={routes.matchConsole(tournamentId, match.id)}
        className="shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-accent/40 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("Console")}
      </Link>
      {canRepair ? (
        <MatchRepairMenu
          tournamentId={tournamentId}
          match={match}
          siblings={siblings}
        />
      ) : null}
    </li>
  );
}

/**
 * Post-generation competition card (redesign §6 screen 6): the accepted draw
 * as READ-ONLY group tables / bracket pairings — score entry is NOT this
 * stage (it lives in the match console; each row links there). Renders inside
 * the hub's competition section once a draw exists.
 */
export function CompetitionResultCard({
  matches,
  tournamentId,
  canRepair = false,
}: {
  matches: MatchRow[];
  tournamentId: string;
  /** Schedule editors get the per-match repair menu (Move/Delay/Swap/Lock). */
  canRepair?: boolean;
}): React.ReactElement {
  const groups = useMemo(() => {
    const by = new Map<string, MatchRow[]>();
    for (const m of matches) {
      const key = m.group_label || (m.stage === "knockout" ? t("Bracket") : t("Matches"));
      if (!by.has(key)) by.set(key, []);
      by.get(key)!.push(m);
    }
    for (const ms of by.values()) {
      ms.sort((a, b) => a.round_no - b.round_no || a.match_no - b.match_no);
    }
    return [...by.entries()];
  }, [matches]);

  const played = matches.filter((m) => FINAL.has(m.status)).length;

  return (
    <div className="flex flex-col gap-3" data-testid="competition-result-card">
      <p className="font-tabular text-xs text-muted-foreground">
        {played} {t("of")} {matches.length} {t("played.")}{" "}
        {t("Scores are entered in the match console.")}
      </p>
      <div className={cn("grid gap-3", groups.length > 1 && "md:grid-cols-2")}>
        {groups.map(([label, ms]) => (
          <section
            key={label}
            className="rounded-lg border border-border bg-muted/20 px-3 py-2"
          >
            <h4 className="pb-1 text-xs font-semibold text-muted-foreground">
              {label}
            </h4>
            <ul>
              {ms.map((m) => (
                <Row
                  key={m.id}
                  match={m}
                  tournamentId={tournamentId}
                  canRepair={canRepair}
                  siblings={matches}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
