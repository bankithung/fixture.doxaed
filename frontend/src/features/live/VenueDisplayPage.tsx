import { useEffect, useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { liveApi } from "@/api/live";
import { tournamentsApi } from "@/api/tournaments";
import { useEventStream } from "@/lib/useEventStream";
import { liveSetView } from "@/lib/setDisplay";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

const LIVE = new Set(["live", "half_time"]);
const FINAL = new Set(["completed", "walkover"]);

/**
 * Venue PA / big-screen display (public-safe, no login): one giant board per
 * court showing what is ON now (live score), what was CALLED, and what is up
 * next. Point a TV or projector at /t/:slug/:id/display — SSE-live with a
 * 60s poll fallback. `?venue=Court 1` narrows to one court.
 */
export function VenueDisplayPage(): React.ReactElement {
  const { slug = "", id = "" } = useParams();
  const [params] = useSearchParams();
  const onlyVenue = params.get("venue");
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["public-schedule", id],
    queryFn: () => tournamentsApi.publicSchedule(slug, id),
    refetchInterval: 60_000,
  });
  useEventStream(slug && id ? liveApi.streamUrl(slug, id) : null, () => {
    qc.invalidateQueries({ queryKey: ["public-schedule", id] });
  });
  useEffect(() => {
    if (q.data) document.title = `${q.data.tournament.name} · ${t("Display")}`;
  }, [q.data]);

  const courts = useMemo(() => {
    const by = new Map<string, { on: MatchLike | null; next: MatchLike[] }>();
    const matches = (q.data?.matches ?? []) as MatchLike[];
    for (const m of matches) {
      const v = m.venue || t("Court");
      if (onlyVenue && v !== onlyVenue) continue;
      if (!by.has(v)) by.set(v, { on: null, next: [] });
      const slot = by.get(v)!;
      if (LIVE.has(m.status)) slot.on = m;
      else if (!FINAL.has(m.status) && m.status === "scheduled") slot.next.push(m);
    }
    for (const slot of by.values()) {
      slot.next.sort((a, b) =>
        (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? ""),
      );
      slot.next = slot.next.slice(0, 2);
    }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [q.data, onlyVenue]);

  if (q.isLoading || !q.data) {
    return (
      <div className="grid min-h-screen place-items-center bg-background">
        <p className="text-2xl text-muted-foreground">{t("Loading the board")}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">
          {q.data.tournament.name}
        </h1>
        <Clock />
      </header>
      <div
        className={cn(
          "grid gap-6",
          courts.length > 1 ? "lg:grid-cols-2 2xl:grid-cols-3" : "",
        )}
      >
        {courts.map(([venue, slot]) => (
          <section
            key={venue}
            className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm"
          >
            <div className="flex items-center justify-between border-b border-border px-6 py-3">
              <h2 className="text-2xl font-semibold">{venue}</h2>
              {slot.on ? (
                <span className="flex items-center gap-2 text-lg font-medium text-primary">
                  <span className="relative flex h-3 w-3">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                    <span className="relative inline-flex h-3 w-3 rounded-full bg-primary" />
                  </span>
                  {t("Live")}
                </span>
              ) : null}
            </div>
            {slot.on ? (
              (() => {
                const sv = liveSetView(slot.on);
                const chips = sv ? sv.finished : (slot.on.set_scores ?? []);
                return (
                  <div className="flex flex-col items-center gap-3 px-6 py-8">
                    <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-4">
                      <p className="truncate text-right text-3xl font-semibold">
                        {slot.on.home?.name ?? t("TBD")}
                      </p>
                      <p className="font-tabular text-6xl font-semibold">
                        {sv
                          ? `${sv.points[0]}-${sv.points[1]}`
                          : `${slot.on.home_score ?? 0}-${slot.on.away_score ?? 0}`}
                      </p>
                      <p className="truncate text-3xl font-semibold">
                        {slot.on.away?.name ?? t("TBD")}
                      </p>
                    </div>
                    {sv ? (
                      <p className="font-tabular text-2xl text-muted-foreground">
                        {t("Set")} {sv.setNo} · {t("Sets")} {sv.sets[0]}-{sv.sets[1]}
                        {chips.length > 0
                          ? `  ·  ${chips.map(([h, a]) => `${h}-${a}`).join("  ·  ")}`
                          : ""}
                      </p>
                    ) : chips.length > 0 ? (
                      <p className="font-tabular text-2xl text-muted-foreground">
                        {chips.map(([h, a]) => `${h}-${a}`).join("  ·  ")}
                      </p>
                    ) : null}
                  </div>
                );
              })()
            ) : (
              <p className="px-6 py-10 text-center text-2xl text-muted-foreground">
                {t("Court free")}
              </p>
            )}
            {slot.next.length > 0 ? (
              <div className="border-t border-border px-6 py-4">
                <p className="text-sm font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  {t("Up next")}
                </p>
                <ul className="mt-2 flex flex-col gap-1.5">
                  {slot.next.map((m) => (
                    <li key={m.id} className="flex items-baseline gap-3 text-xl">
                      <span className="w-16 shrink-0 font-tabular text-muted-foreground">
                        {m.scheduled_at
                          ? new Date(m.scheduled_at).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : ""}
                      </span>
                      <span className="truncate">
                        {m.home?.name ?? t("TBD")} {t("vs")} {m.away?.name ?? t("TBD")}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        ))}
      </div>
    </div>
  );
}

interface MatchLike {
  id: string;
  status: string;
  venue: string;
  scheduled_at: string | null;
  home: { name: string } | null;
  away: { name: string } | null;
  home_score: number | null;
  away_score: number | null;
  sport?: string;
  set_scores?: number[][];
}

function Clock(): React.ReactElement {
  const q = useQuery({
    queryKey: ["display-clock"],
    queryFn: () => Promise.resolve(new Date()),
    refetchInterval: 30_000,
  });
  return (
    <span className="font-tabular text-3xl text-muted-foreground">
      {(q.data ?? new Date()).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}
    </span>
  );
}
