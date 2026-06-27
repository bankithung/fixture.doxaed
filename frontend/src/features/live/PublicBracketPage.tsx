import { useCallback, useEffect, useMemo, useRef } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { liveApi } from "@/api/live";
import {
  tournamentsApi,
  type MatchRow,
  type PublicScheduleMatch,
} from "@/api/tournaments";
import { BracketView } from "@/features/tournaments/BracketView";
import { t } from "@/lib/t";
import { useEventStream } from "@/lib/useEventStream";
import { PublicViewerHeader } from "./PublicViewerHeader";

/** Public schedule row → the MatchRow shape BracketView renders (set-sport
 * winners already fall out of home/away_score = sets won). */
function toMatchRow(m: PublicScheduleMatch): MatchRow {
  const team = (s: PublicScheduleMatch["home"]) =>
    s ? { id: s.id, name: s.name, short_name: s.short_name } : null;
  return {
    id: m.id,
    stage: m.stage,
    group_label: m.group_label,
    round_no: m.round_no,
    match_no: m.match_no,
    status: m.status,
    home_team: team(m.home),
    away_team: team(m.away),
    home_score: m.home_score,
    away_score: m.away_score,
    sport: m.sport,
    set_scores: m.set_scores,
    leaf_key: m.leaf_key,
    venue: m.venue,
    scoring: null,
    scheduled_at: m.scheduled_at,
    home_pens: m.home_pens,
    away_pens: m.away_pens,
    stage_no: m.stage_no,
    // pass the typed pointers through so an unresolved slot shows "Group A #1"
    home_source: m.home_source,
    away_source: m.away_source,
  };
}

/**
 * Public, login-free KNOCKOUT BRACKET (R13): one connected tree per
 * competition, auto-updating over the public SSE tick stream as results land.
 * Reuses the same BracketView component the admin sees; no new backend (the
 * public schedule endpoint already serves every knockout match).
 */
export function PublicBracketPage(): React.ReactElement {
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
    refetchInterval: connected ? false : 60_000,
  });

  // One bracket per competition leaf (TT Singles, Sepak Takraw, …) — only the
  // knockout matches; the group stage lives on the Schedule tab's standings.
  const brackets = useMemo(() => {
    const byLeaf = new Map<
      string,
      { key: string; label: string; matches: MatchRow[] }
    >();
    for (const m of query.data?.matches ?? []) {
      if (m.stage !== "knockout") continue;
      const key = m.leaf_key || "_";
      if (!byLeaf.has(key)) {
        byLeaf.set(key, { key, label: m.leaf_label || t("Bracket"), matches: [] });
      }
      byLeaf.get(key)!.matches.push(toMatchRow(m));
    }
    return [...byLeaf.values()];
  }, [query.data]);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <PublicViewerHeader
        slug={slug}
        id={id}
        tournamentName={query.data?.tournament.name}
        active="bracket"
        connected={connected}
      />
      <main className="flex w-full flex-1 flex-col gap-8 px-4 py-6 sm:px-6 lg:px-8">
        {query.isLoading ? (
          <div className="h-48 animate-pulse rounded-xl bg-muted/40" />
        ) : brackets.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <p className="text-sm font-medium">
              {t("The knockout bracket appears here once the group stage finishes.")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("Follow the group tables on the Schedule tab in the meantime.")}
            </p>
          </div>
        ) : (
          brackets.map((b) => (
            <section
              key={b.key}
              data-testid={`bracket-${b.key}`}
              className="flex flex-col gap-3"
            >
              <h2 className="text-base font-semibold">{b.label}</h2>
              <div className="overflow-x-auto rounded-xl border border-border bg-card p-4">
                <BracketView matches={b.matches} />
              </div>
            </section>
          ))
        )}
      </main>
    </div>
  );
}
