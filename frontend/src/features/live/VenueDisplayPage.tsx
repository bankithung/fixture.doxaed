import { useEffect, useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { liveApi } from "@/api/live";
import { tournamentsApi } from "@/api/tournaments";
import { TeamCrest } from "@/components/ui/TeamCrest";
import { WatchLiveLink } from "./WatchLiveLink";
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

  // The link currently applying to each court, keyed by the SAME display
  // string the match rows carry (`Court.name` is `Match.venue`).
  const courtLinks = useMemo(() => {
    const by = new Map<string, string>();
    for (const c of q.data?.courts ?? []) {
      if (c.watch_url) by.set(c.name, c.watch_url);
    }
    return by;
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
      <div className="grid min-h-screen place-items-center">
        <p className="text-2xl text-muted-foreground">{t("Loading the board")}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6 text-foreground">
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
            <div className="flex items-center gap-3 border-b border-border px-6 py-3">
              <h2 className="truncate text-2xl font-semibold">{venue}</h2>
              {/* Only rendered when this court actually resolves to a stream. */}
              <WatchLiveLink
                url={courtLinks.get(venue)}
                className="ml-auto shrink-0"
                testid={`watch-live-court-${venue}`}
                label={t("Watch {court} live on YouTube").replace("{court}", venue)}
              />
              {slot.on ? (
                <span
                  className={cn(
                    "flex shrink-0 items-center gap-2 text-lg font-medium text-primary",
                    !courtLinks.get(venue) && "ml-auto",
                  )}
                >
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
                    {/* Read from across a hall: a full-size badge against
                        each side of the score, which stays centred. */}
                    <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-4">
                      <p className="flex min-w-0 items-center justify-end gap-3 text-3xl font-semibold">
                        <span className="truncate">
                          {slot.on.home?.name ?? t("TBD")}
                        </span>
                        {slot.on.home ? (
                          <TeamCrest
                            src={slot.on.home.crest}
                            name={slot.on.home.name}
                            size="xl"
                          />
                        ) : null}
                      </p>
                      <p className="font-tabular text-6xl font-semibold">
                        {sv
                          ? `${sv.points[0]}-${sv.points[1]}`
                          : `${slot.on.home_score ?? 0}-${slot.on.away_score ?? 0}`}
                      </p>
                      <p className="flex min-w-0 items-center gap-3 text-3xl font-semibold">
                        {slot.on.away ? (
                          <TeamCrest
                            src={slot.on.away.crest}
                            name={slot.on.away.name}
                            size="xl"
                          />
                        ) : null}
                        <span className="truncate">
                          {slot.on.away?.name ?? t("TBD")}
                        </span>
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
                    <li key={m.id} className="flex items-center gap-3 text-xl">
                      <span className="w-16 shrink-0 font-tabular text-muted-foreground">
                        {m.scheduled_at
                          ? new Date(m.scheduled_at).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : ""}
                      </span>
                      {/* Small here on purpose: the queue is a list, and the
                          badge that has to carry the hall is the one above. */}
                      <span className="flex min-w-0 items-center gap-2">
                        {m.home ? (
                          <TeamCrest src={m.home.crest} name={m.home.name} size="sm" />
                        ) : null}
                        <span className="truncate">{m.home?.name ?? t("TBD")}</span>
                        <span className="shrink-0 text-muted-foreground">
                          {t("vs")}
                        </span>
                        {m.away ? (
                          <TeamCrest src={m.away.crest} name={m.away.name} size="sm" />
                        ) : null}
                        <span className="truncate">{m.away?.name ?? t("TBD")}</span>
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
  /** Signed crest URL rides along with the name (PublicScheduleSide). */
  home: { name: string; crest?: string } | null;
  away: { name: string; crest?: string } | null;
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
