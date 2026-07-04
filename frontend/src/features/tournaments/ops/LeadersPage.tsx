import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Award, Trophy } from "lucide-react";
import { tournamentsApi } from "@/api/tournaments";
import type {
  LeaderBoard,
  SportLeaders,
} from "@/features/live/SportLeaderBoards";
import { t } from "@/lib/t";

/** Shared table shell: slim header, hairline rows, tabular numbers. */
function StatCard({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="flex h-9 items-center gap-2 border-b border-border px-4">
        <h3 className="text-[13px] font-semibold tracking-tight">{title}</h3>
        {count != null ? (
          <span className="font-tabular text-xs text-muted-foreground">{count}</span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

const TH =
  "px-4 py-2 text-left text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground";
const TD = "px-4 py-2 text-sm";

/** One full board as a table (the panel shows top 3; this page shows all). */
function BoardTable({ board }: { board: LeaderBoard }): React.ReactElement {
  const isPlayer = board.subject === "player";
  return (
    <StatCard title={t(board.label)} count={board.rows.length}>
      {board.rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          {t("Fills automatically as results land.")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full" data-testid={`board-table-${board.key}`}>
            <thead className="border-b border-border">
              <tr>
                <th className={TH}>#</th>
                <th className={TH}>{isPlayer ? t("Player") : t("Team")}</th>
                {isPlayer ? <th className={TH}>{t("Team")}</th> : null}
                {!isPlayer ? (
                  <th className={`${TH} text-right`}>{t("Played")}</th>
                ) : null}
                <th className={`${TH} text-right`}>{t(board.label)}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {board.rows.map((r, i) => (
                <tr key={r.player_id ?? r.team_id ?? i}>
                  <td className={`${TD} w-10 font-tabular text-muted-foreground`}>
                    {i + 1}
                  </td>
                  <td className={`${TD} font-medium`}>
                    {isPlayer ? r.name : r.team_name}
                  </td>
                  {isPlayer ? (
                    <td className={`${TD} text-muted-foreground`}>
                      {r.team_name}
                    </td>
                  ) : null}
                  {!isPlayer ? (
                    <td className={`${TD} text-right font-tabular text-muted-foreground`}>
                      {r.played}
                    </td>
                  ) : null}
                  <td className={`${TD} text-right font-tabular font-semibold`}>
                    {r.value}
                    {r.detail ? (
                      <span className="ml-1.5 font-normal text-xs text-muted-foreground">
                        {r.detail}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </StatCard>
  );
}

/** One sport's full section: heading (multi-sport only) + its boards. */
function SportSection({
  sport,
  multi,
}: {
  sport: SportLeaders;
  multi: boolean;
}): React.ReactElement {
  return (
    <section aria-label={sport.name} className="flex flex-col gap-3">
      {multi ? (
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            {sport.name}
          </span>
          <span className="font-tabular text-xs text-muted-foreground">
            {sport.played} {t("played")}
          </span>
        </div>
      ) : null}
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        {sport.boards.map((b) => (
          <BoardTable key={b.key} board={b} />
        ))}
      </div>
    </section>
  );
}

/**
 * The full leader board (owner ask: the dashboard shows the top 5, this page
 * shows EVERYONE) — PER SPORT (P1.b): each sport renders its own boards from
 * the SportDefinition catalog; a single-sport tournament shows no sport
 * chrome. Live: refetches on a 60s cadence; the Today page's SSE tick also
 * invalidates ["t-leaders"].
 */
export function LeadersPage(): React.ReactElement {
  const { id = "" } = useParams();
  const q = useQuery({
    queryKey: ["t-leaders", id, "full"],
    queryFn: () => tournamentsApi.leaders(id, { full: true }),
    refetchInterval: 60_000,
  });
  const d = q.data;

  if (q.isLoading) {
    return (
      <div className="flex w-full flex-col gap-4" aria-busy="true">
        <div className="h-7 w-40 animate-pulse rounded bg-muted/60" />
        <div className="h-48 animate-pulse rounded-xl bg-muted/40" />
        <div className="h-48 animate-pulse rounded-xl bg-muted/40" />
      </div>
    );
  }

  const sports = d?.sports ?? [];
  const multi = sports.length > 1;

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-xl font-semibold tracking-tight">{t("Leaders")}</h2>
        {d ? (
          <span className="font-tabular text-xs text-muted-foreground">
            {d.played} {t("matches played")}
          </span>
        ) : null}
      </div>

      {!d || d.played === 0 ? (
        <section className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-border bg-card px-6 py-10 text-center">
          <Trophy aria-hidden="true" className="h-6 w-6 text-muted-foreground/40" />
          <p className="text-sm font-medium">{t("No results yet")}</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            {t(
              "Every sport's boards, team stats and badges appear here automatically once play starts.",
            )}
          </p>
        </section>
      ) : (
        <div className="flex flex-col gap-6">
          {sports.map((s) => (
            <SportSection key={s.sport} sport={s} multi={multi} />
          ))}

          <StatCard title={t("Badges")} count={d.latest_badges.length}>
            {d.latest_badges.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                {t("Badges are awarded automatically for standout results.")}
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2 lg:grid-cols-3">
                {d.latest_badges.map((b) => (
                  <Link
                    key={b.id}
                    to={`/cert/${b.id}`}
                    className="flex items-start gap-2.5 bg-card p-3 transition-colors hover:bg-accent"
                  >
                    <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary/10">
                      <Award aria-hidden="true" className="h-3.5 w-3.5 text-primary" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {b.name}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {b.subject}
                      </span>
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </StatCard>
        </div>
      )}
    </div>
  );
}
