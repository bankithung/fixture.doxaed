import { useCallback, useEffect, useMemo, useRef } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { liveApi } from "@/api/live";
import { tournamentsApi, type PublicScheduleMatch } from "@/api/tournaments";
import { t } from "@/lib/t";
import { cn } from "@/lib/tailwind";
import { useEventStream } from "@/lib/useEventStream";
import { PublicViewerHeader } from "./PublicViewerHeader";

const LIVE_STATUSES = new Set(["live", "half_time", "extra_time", "penalties"]);

function periodLabel(m: PublicScheduleMatch): string {
  if (m.status === "half_time") return t("Half time");
  if (m.status === "extra_time") return t("Extra time");
  if (m.status === "penalties") return t("Penalties");
  const p = (m.current_period || "").replace(/_/g, " ").trim();
  return p ? p.replace(/\b\w/g, (c) => c.toUpperCase()) : t("Live");
}

/** One big, glanceable live score card. */
function LiveCard({ m }: { m: PublicScheduleMatch }): React.ReactElement {
  const side = (
    name: string | undefined,
    score: number | null,
    pens: number | null,
    lead: boolean,
  ) => (
    <div className="flex items-center justify-between gap-3">
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-base sm:text-lg",
          lead ? "font-semibold text-foreground" : "text-muted-foreground",
        )}
      >
        {name ?? t("TBD")}
      </span>
      <span className="flex items-baseline gap-1">
        {pens != null ? (
          <span className="font-tabular text-xs text-muted-foreground">
            ({pens})
          </span>
        ) : null}
        <span className="font-tabular text-3xl font-bold tabular-nums sm:text-4xl">
          {score ?? 0}
        </span>
      </span>
    </div>
  );
  const hs = m.home_score ?? 0;
  const as = m.away_score ?? 0;
  const sets = m.sport && m.set_scores?.length ? m.set_scores : null;
  return (
    <div
      data-testid={`live-card-${m.id}`}
      className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 shadow-sm"
    >
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">{m.leaf_label || t("Match")}</span>
        <span className="flex items-center gap-1.5 font-medium text-destructive">
          <span className="h-2 w-2 animate-pulse rounded-full bg-destructive" />
          {periodLabel(m)}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {side(m.home?.name, m.home_score, m.home_pens, hs >= as)}
        {side(m.away?.name, m.away_score, m.away_pens, as >= hs)}
      </div>
      {sets ? (
        <div className="flex flex-wrap gap-1.5 border-t border-border pt-2 font-tabular text-xs text-muted-foreground">
          {sets.map((s, i) => (
            <span key={i} className="rounded bg-muted px-1.5 py-0.5">
              {s[0]}–{s[1]}
            </span>
          ))}
        </div>
      ) : null}
      {m.venue ? (
        <p className="text-xs text-muted-foreground">{m.venue}</p>
      ) : null}
    </div>
  );
}

/**
 * Public, login-free LIVE SCOREBOARD (R13): every in-play match across the
 * whole tournament, big and glanceable, auto-updating over the public SSE tick
 * stream with a 30 s poll fallback. Sits beside the schedule + bracket tabs.
 */
export function PublicLiveScoreboardPage(): React.ReactElement {
  const { slug = "", id = "" } = useParams();
  const qc = useQueryClient();

  const tickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTick = useCallback(() => {
    if (tickTimer.current) return;
    tickTimer.current = setTimeout(() => {
      tickTimer.current = null;
      qc.invalidateQueries({ queryKey: ["public-schedule", slug, id] });
    }, 400);
  }, [qc, slug, id]);
  useEffect(
    () => () => {
      if (tickTimer.current) clearTimeout(tickTimer.current);
    },
    [],
  );
  const { connected } = useEventStream(
    slug && id ? liveApi.streamUrl(slug, id) : null,
    onTick,
  );

  const query = useQuery({
    queryKey: ["public-schedule", slug, id],
    queryFn: () => tournamentsApi.publicSchedule(slug, id),
    refetchInterval: connected ? false : 30_000,
  });

  const { live, upNext } = useMemo(() => {
    const all = query.data?.matches ?? [];
    const liveMatches = all.filter((m) => LIVE_STATUSES.has(m.status));
    const upcoming = all
      .filter((m) => m.status === "scheduled" && m.scheduled_at)
      .sort((a, b) => (a.scheduled_at! < b.scheduled_at! ? -1 : 1))
      .slice(0, 6);
    return { live: liveMatches, upNext: upcoming };
  }, [query.data]);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <PublicViewerHeader
        slug={slug}
        id={id}
        tournamentName={query.data?.tournament.name}
        active="live"
        connected={connected}
      />
      <main className="flex w-full flex-1 flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold">{t("Live now")}</h1>
          <span className="font-tabular text-sm text-muted-foreground">
            {live.length}
          </span>
        </div>

        {query.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-28 animate-pulse rounded-xl bg-muted/40" />
            ))}
          </div>
        ) : live.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <p className="text-sm font-medium">{t("No matches are live right now.")}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("This page updates the moment a match kicks off.")}
            </p>
          </div>
        ) : (
          <div
            data-testid="live-grid"
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          >
            {live.map((m) => (
              <LiveCard key={m.id} m={m} />
            ))}
          </div>
        )}

        {upNext.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-muted-foreground">
              {t("Up next")}
            </h2>
            <ul className="flex flex-col gap-1.5">
              {upNext.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm"
                >
                  <span className="font-tabular text-xs text-muted-foreground">
                    {m.scheduled_at
                      ? new Date(m.scheduled_at).toLocaleTimeString(undefined, {
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : ""}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {m.home?.name ?? t("TBD")} {t("vs")} {m.away?.name ?? t("TBD")}
                  </span>
                  <span className="hidden truncate text-xs text-muted-foreground sm:block">
                    {m.venue}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>
    </div>
  );
}
