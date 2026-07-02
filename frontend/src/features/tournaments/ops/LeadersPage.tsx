import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Award, Shield, Target, Trophy } from "lucide-react";
import { tournamentsApi } from "@/api/tournaments";
import { t } from "@/lib/t";

type TeamRow = {
  team_id: string;
  team_name: string;
  played: number;
  scored: number;
  conceded: number;
};

/** Shared table shell: slim header, hairline rows, tabular numbers. */
function StatCard({
  title,
  icon: Icon,
  count,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  count?: number;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="flex h-9 items-center gap-2 border-b border-border px-4">
        <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
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

/**
 * The full leader board (owner ask: the dashboard shows the top 5, this page
 * shows EVERYONE): every goal scorer, complete team attack/defence table,
 * and the full badge gallery with certificate links. Live: refetches on a
 * 60s cadence; the Today page's SSE tick also invalidates ["t-leaders"].
 */
export function LeadersPage(): React.ReactElement {
  const { id = "" } = useParams();
  const q = useQuery({
    queryKey: ["t-leaders", id, "full"],
    queryFn: () => tournamentsApi.leaders(id, { full: true }),
    refetchInterval: 60_000,
  });
  const d = q.data;

  // best_attack carries every team in full mode; derive the combined table.
  const teams: TeamRow[] = [...(d?.best_attack ?? [])].sort(
    (a, b) => b.scored - b.conceded - (a.scored - a.conceded) || b.scored - a.scored,
  );

  if (q.isLoading) {
    return (
      <div className="flex w-full flex-col gap-4" aria-busy="true">
        <div className="h-7 w-40 animate-pulse rounded bg-muted/60" />
        <div className="h-48 animate-pulse rounded-xl bg-muted/40" />
        <div className="h-48 animate-pulse rounded-xl bg-muted/40" />
      </div>
    );
  }

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
              "Every scorer, team stat and badge appears here automatically once play starts.",
            )}
          </p>
        </section>
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
          <StatCard
            title={t("Top scorers")}
            icon={Target}
            count={d.top_scorers.length}
          >
            {d.top_scorers.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                {t("No goal events yet. Set sports rank by points in the team table.")}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="border-b border-border">
                    <tr>
                      <th className={TH}>#</th>
                      <th className={TH}>{t("Player")}</th>
                      <th className={TH}>{t("Team")}</th>
                      <th className={`${TH} text-right`}>{t("Goals")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {d.top_scorers.map((s, i) => (
                      <tr key={s.player_id}>
                        <td className={`${TD} w-10 font-tabular text-muted-foreground`}>
                          {i + 1}
                        </td>
                        <td className={`${TD} font-medium`}>{s.name}</td>
                        <td className={`${TD} text-muted-foreground`}>
                          {s.team_name}
                        </td>
                        <td className={`${TD} text-right font-tabular font-semibold`}>
                          {s.goals}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </StatCard>

          <StatCard title={t("Team stats")} icon={Shield} count={teams.length}>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-border">
                  <tr>
                    <th className={TH}>{t("Team")}</th>
                    <th className={`${TH} text-right`}>{t("Played")}</th>
                    <th className={`${TH} text-right`}>{t("Scored")}</th>
                    <th className={`${TH} text-right`}>{t("Conceded")}</th>
                    <th className={`${TH} text-right`}>{t("Diff")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {teams.map((r) => {
                    const diff = r.scored - r.conceded;
                    return (
                      <tr key={r.team_id}>
                        <td className={`${TD} font-medium`}>{r.team_name}</td>
                        <td className={`${TD} text-right font-tabular text-muted-foreground`}>
                          {r.played}
                        </td>
                        <td className={`${TD} text-right font-tabular`}>{r.scored}</td>
                        <td className={`${TD} text-right font-tabular`}>{r.conceded}</td>
                        <td
                          className={`${TD} text-right font-tabular font-semibold ${
                            diff > 0
                              ? "text-success-foreground"
                              : diff < 0
                                ? "text-destructive"
                                : "text-muted-foreground"
                          }`}
                        >
                          {diff > 0 ? `+${diff}` : diff}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </StatCard>

          <div className="xl:col-span-2">
            <StatCard
              title={t("Badges")}
              icon={Award}
              count={d.latest_badges.length}
            >
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
        </div>
      )}
    </div>
  );
}
