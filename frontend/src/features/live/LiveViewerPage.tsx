import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { liveApi } from "@/api/live";
import { ThemeToggle } from "@/features/theme/ThemeToggle";
import { routes } from "@/lib/routes";
import { liveSetView } from "@/lib/setDisplay";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { BrandLogo } from "@/components/ui/BrandLogo";

const OVERLINE =
  "text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground";

function statusMeta(status: string): { label: string; cls: string; live: boolean } {
  const live = status === "live" || status === "half_time" || status.startsWith("live");
  if (live)
    return { label: status === "half_time" ? "Half time" : "Live", cls: "bg-primary/15 text-primary", live: true };
  if (status === "completed")
    return { label: "Full time", cls: "bg-accent text-accent-foreground", live: false };
  return { label: status.replace(/_/g, " "), cls: "bg-secondary text-secondary-foreground", live: false };
}

/**
 * Public, read-only fan scoreboard (no login). Polls the public snapshot
 * endpoint every 5s. Renders its own minimal chrome since it lives outside
 * the authenticated AppShell.
 */
export function LiveViewerPage(): React.ReactElement {
  const { matchId = "" } = useParams();
  const query = useQuery({
    queryKey: ["live", matchId],
    queryFn: () => liveApi.snapshot(matchId),
    // A shared link to a finished match should not poll forever.
    refetchInterval: (q) =>
      q.state.data &&
      ["completed", "walkover", "cancelled"].includes(q.state.data.match.status)
        ? false
        : 5000,
  });
  useEffect(() => {
    const m = query.data?.match;
    if (m) {
      document.title = `${m.home_team?.name ?? "TBD"} ${m.home_score ?? 0}-${m.away_score ?? 0} ${m.away_team?.name ?? "TBD"} · Fixture`;
    }
  }, [query.data]);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-14 items-center gap-2 border-b border-border bg-card px-4 sm:px-6">
        <Link
          to={routes.landing()}
          className="flex items-center gap-2 rounded-md font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <BrandLogo className="h-7 w-7 rounded-lg" />
          {t("Fixture")}
        </Link>
        <span className="ml-2 text-sm text-muted-foreground">{t("Live")}</span>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
        {query.isLoading ? (
          <div className="h-48 animate-pulse rounded-2xl border border-border bg-card" />
        ) : query.isError || !query.data ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card p-6 text-center">
            <p role="alert" className="text-sm text-destructive">
              {t("This match could not be loaded.")}
            </p>
            <button
              type="button"
              onClick={() => query.refetch()}
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent"
            >
              {t("Retry")}
            </button>
          </div>
        ) : (
          (() => {
            const { match, events } = query.data;
            const sm = statusMeta(match.status);
            const setView = liveSetView(match);
            const home = match.home_team?.name ?? t("TBD");
            const away = match.away_team?.name ?? t("TBD");
            return (
              <>
                {/* Scoreboard */}
                <section className="relative overflow-hidden rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8">
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded-full bg-primary/10 blur-3xl"
                  />
                  <div className="relative flex items-center justify-center">
                    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium", sm.cls)}>
                      {sm.live ? (
                        <span className="relative flex h-2 w-2">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                        </span>
                      ) : null}
                      {t(sm.label)}
                      {setView
                        ? ` · ${t("Set")} ${setView.setNo}`
                        : match.current_period
                          ? ` · ${t(match.current_period.replace(/_/g, " "))}`
                          : ""}
                    </span>
                  </div>
                  <div
                    aria-live="polite"
                    className="relative mt-6 grid grid-cols-[1fr_auto_1fr] items-center gap-4"
                  >
                    <div className="text-right text-lg font-semibold sm:text-xl">{home}</div>
                    <div className="font-tabular text-5xl font-semibold tabular-nums sm:text-6xl">
                      {setView ? setView.points[0] : (match.home_score ?? 0)}
                      <span className="mx-2 text-muted-foreground">-</span>
                      {setView ? setView.points[1] : (match.away_score ?? 0)}
                    </div>
                    <div className="text-left text-lg font-semibold sm:text-xl">{away}</div>
                  </div>
                  {setView ? (
                    <p className="relative mt-2 text-center font-tabular text-sm text-muted-foreground">
                      {t("Sets")} {setView.sets[0]}-{setView.sets[1]}
                    </p>
                  ) : null}
                  {(() => {
                    const chips = setView
                      ? setView.finished
                      : (match.set_scores ?? []);
                    return chips.length > 0 ? (
                      <div className="relative mt-3 flex flex-wrap justify-center gap-1.5">
                        {chips.map((sset, i) => (
                          <span
                            key={i}
                            className="rounded-md bg-muted px-2 py-0.5 font-tabular text-xs text-muted-foreground"
                          >
                            {sset[0]}-{sset[1]}
                          </span>
                        ))}
                      </div>
                    ) : null;
                  })()}
                  {match.home_pens != null && match.away_pens != null ? (
                    <p className="relative mt-2 text-center font-tabular text-xs text-muted-foreground">
                      {t("Pens")} {match.home_pens}-{match.away_pens}
                    </p>
                  ) : null}
                </section>

                {/* Timeline */}
                <section className="rounded-2xl border border-border bg-card shadow-sm">
                  <div className="border-b border-border px-5 py-3">
                    <h2 className={OVERLINE}>{t("Match timeline")}</h2>
                  </div>
                  {events.length === 0 ? (
                    <p className="px-5 py-8 text-center text-sm text-muted-foreground">
                      {t("No events yet.")}
                    </p>
                  ) : (
                    <ol className="flex flex-col">
                      {events.map((e) => (
                        <li
                          key={e.sequence_no}
                          className="flex items-center gap-3 border-t border-border px-5 py-2.5 first:border-t-0 text-sm"
                        >
                          <span className="w-10 shrink-0 text-right font-tabular text-muted-foreground">
                            {e.minute != null ? `${e.minute}'` : `#${e.sequence_no}`}
                          </span>
                          <span className="font-medium capitalize">
                            {e.type.replace(/_/g, " ")}
                          </span>
                          {e.player ? (
                            <span className="text-muted-foreground">· {e.player}</span>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  )}
                </section>

                {(match.home_team?.players?.length ?? 0) > 0 ||
                (match.away_team?.players?.length ?? 0) > 0 ? (
                  <section className="rounded-2xl border border-border bg-card shadow-sm">
                    <div className="border-b border-border px-5 py-3">
                      <h2 className={OVERLINE}>{t("Line-ups")}</h2>
                    </div>
                    <div className="grid grid-cols-2 divide-x divide-border">
                      {[match.home_team, match.away_team].map((team, i) => (
                        <div key={i} className="flex flex-col gap-1 p-4">
                          <p className="truncate text-xs font-semibold">
                            {team?.name ?? t("TBD")}
                          </p>
                          <ul className="flex flex-col gap-0.5">
                            {(team?.players ?? []).map((pl) => (
                              <li key={pl.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <span className="w-6 shrink-0 font-tabular">
                                  {pl.jersey_no ? `#${pl.jersey_no}` : ""}
                                </span>
                                <span className="truncate">{pl.name}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </section>
                ) : null}

                <p className="text-center text-xs text-muted-foreground">
                  {sm.live ? t("Updates automatically.") : t("Final result.")}
                </p>
              </>
            );
          })()
        )}
      </main>
    </div>
  );
}
