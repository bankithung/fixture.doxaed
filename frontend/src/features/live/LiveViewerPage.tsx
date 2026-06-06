import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { liveApi } from "@/api/live";
import { ThemeToggle } from "@/features/theme/ThemeToggle";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

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
    refetchInterval: 5000,
  });

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-14 items-center gap-2 border-b border-border bg-card px-4 sm:px-6">
        <Link
          to={routes.landing()}
          className="flex items-center gap-2 rounded-md font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
            F
          </span>
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
          <p role="alert" className="rounded-xl border border-border bg-card p-6 text-center text-sm text-destructive">
            {t("This match could not be loaded.")}
          </p>
        ) : (
          (() => {
            const { match, events } = query.data;
            const sm = statusMeta(match.status);
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
                      {match.current_period
                        ? ` · ${t(match.current_period.replace(/_/g, " "))}`
                        : ""}
                    </span>
                  </div>
                  <div className="relative mt-6 grid grid-cols-[1fr_auto_1fr] items-center gap-4">
                    <div className="text-right text-lg font-semibold sm:text-xl">{home}</div>
                    <div className="font-tabular text-5xl font-semibold tabular-nums sm:text-6xl">
                      {match.home_score ?? 0}
                      <span className="mx-2 text-muted-foreground">–</span>
                      {match.away_score ?? 0}
                    </div>
                    <div className="text-left text-lg font-semibold sm:text-xl">{away}</div>
                  </div>
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
                            <span className="text-muted-foreground">— {e.player}</span>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  )}
                </section>

                <p className="text-center text-xs text-muted-foreground">
                  {t("Updates automatically every few seconds.")}
                </p>
              </>
            );
          })()
        )}
      </main>
    </div>
  );
}
