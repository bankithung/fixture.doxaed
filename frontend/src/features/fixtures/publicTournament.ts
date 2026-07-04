import { useCallback, useEffect, useRef } from "react";
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { liveApi } from "@/api/live";
import {
  tournamentsApi,
  type PublicSchedulePayload,
  type PublicScheduleMatch,
  type StandingsGroup,
} from "@/api/tournaments";
import { isSetSport } from "@/lib/setDisplay";
import { t } from "@/lib/t";
import { useEventStream } from "@/lib/useEventStream";

/** Shared data + label logic for the public tournament panel (Matches /
 * Standings / Knockout). All three tabs read the SAME two queries (identical
 * keys, 30 s staleTime) so switching tabs is an instant cache hit,
 * Google-sports-panel style; the SSE tick invalidates both so every tab
 * advances live. Presentational pieces live in publicTournamentViews.tsx. */

export const LIVE_STATUSES = new Set([
  "live",
  "half_time",
  "extra_time",
  "penalties",
]);
export const FINAL_STATUSES = new Set(["completed", "walkover"]);

export interface PublicTournamentData {
  scheduleQ: UseQueryResult<PublicSchedulePayload>;
  standingsQ: UseQueryResult<{ groups: StandingsGroup[] }>;
  connected: boolean;
  /** undefined until the schedule loads; then whether ANY knockout-stage
   * match exists (the Knockout tab hides when false). */
  hasKnockout: boolean | undefined;
}

/** The one shared fetch behind the public tabs: SSE tick stream (debounced
 * invalidation) + schedule and standings queries with a poll fallback. */
export function usePublicTournament(
  slug: string,
  id: string,
): PublicTournamentData {
  const qc = useQueryClient();

  const tickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTick = useCallback(() => {
    if (tickTimer.current) return;
    tickTimer.current = setTimeout(() => {
      tickTimer.current = null;
      qc.invalidateQueries({ queryKey: ["public-schedule", slug, id] });
      qc.invalidateQueries({ queryKey: ["public-standings", slug, id] });
      qc.invalidateQueries({ queryKey: ["public-leaders", id] });
    }, 500);
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

  const scheduleQ = useQuery({
    queryKey: ["public-schedule", slug, id],
    queryFn: () => tournamentsApi.publicSchedule(slug, id),
    staleTime: 30_000,
    refetchInterval: connected ? false : 60_000,
  });
  const standingsQ = useQuery({
    queryKey: ["public-standings", slug, id],
    queryFn: () => tournamentsApi.publicStandings(slug, id),
    enabled: scheduleQ.data !== undefined,
    retry: false,
    staleTime: 30_000,
    refetchInterval: connected ? false : 60_000,
  });

  const hasKnockout = scheduleQ.data
    ? scheduleQ.data.matches.some((m) => m.stage === "knockout")
    : undefined;

  return { scheduleQ, standingsQ, connected, hasKnockout };
}

/** Competition labels arrive joined by separators ("Sepak Takraw — U-14 —
 * Boys"); a raw dashed string is the #1 design tell, so we split into segments
 * and chip them. Internal hyphens with no surrounding spaces ("U-14") survive
 * the split and are tidied to "U14" at render. */
const LABEL_SEP = /\s+[·–—|/-]+\s+/;

export function splitLabel(label: string): string[] {
  return label
    .split(LABEL_SEP)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The sport segment (first label part), used to group + label competitions. */
export function sportOf(
  m: Pick<PublicScheduleMatch, "leaf_label" | "sport">,
): string {
  const parts = splitLabel(m.leaf_label);
  if (parts.length) return parts[0];
  if (m.sport) {
    return m.sport.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return t("Other");
}

/** "Sepak Takraw — U-14 — Boys — Group A" minus the competition prefix →
 * "Group A". The leaf chips already carry the competition, so when the group
 * label adds nothing beyond the leaf we render NOTHING — never the raw
 * dashed chain (it duplicated every chip row). */
export function shortGroup(groupLabel: string, leafLabel: string): string {
  if (!groupLabel || groupLabel === leafLabel) return "";
  const last = splitLabel(groupLabel).pop()?.trim() ?? "";
  if (!last || (leafLabel && leafLabel.endsWith(last))) return "";
  return last;
}

export type Group = {
  key: string;
  label: string;
  matches: PublicScheduleMatch[];
  standing?: StandingsGroup;
};
export type Competition = {
  key: string;
  label: string;
  sport: string;
  /** Sport-native standings columns ("target" = set sports). */
  family: "timed" | "target";
  teamCount: number;
  liveCount: number;
  groups: Group[];
  matches: PublicScheduleMatch[];
};

export function buildCompetitions(
  matches: PublicScheduleMatch[],
  standingsGroups: StandingsGroup[] | undefined,
): Competition[] {
  const stMap = new Map<string, StandingsGroup>();
  for (const g of standingsGroups ?? []) {
    if (g.group_label) stMap.set(g.group_label, g);
  }
  const byLeaf = new Map<string, PublicScheduleMatch[]>();
  for (const m of matches) {
    const key = m.leaf_key || "_";
    if (!byLeaf.has(key)) byLeaf.set(key, []);
    byLeaf.get(key)!.push(m);
  }
  const comps: Competition[] = [];
  for (const [key, ms] of byLeaf) {
    const label = ms[0]?.leaf_label || t("Competition");
    const byGroup = new Map<string, PublicScheduleMatch[]>();
    for (const m of ms) {
      const gk = m.group_label || (m.stage === "knockout" ? "__ko" : "__other");
      if (!byGroup.has(gk)) byGroup.set(gk, []);
      byGroup.get(gk)!.push(m);
    }
    const groups: Group[] = [...byGroup.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([gk, gms]) => ({
        key: gk,
        label:
          gk === "__ko"
            ? t("Knockout")
            : gk === "__other"
              ? t("Fixtures")
              : shortGroup(gk, label) || gk,
        matches: gms,
        standing: gk.startsWith("__") ? undefined : stMap.get(gk),
      }));
    const teams = new Set<string>();
    let live = 0;
    for (const m of ms) {
      if (m.home) teams.add(m.home.id);
      if (m.away) teams.add(m.away.id);
      if (LIVE_STATUSES.has(m.status)) live++;
    }
    // Family off the leaf key's sport segment (the match sport key backstops
    // leaves without a keyed sport prefix).
    const sportKey = (ms[0]?.leaf_key ?? "").split(".")[0] || ms[0]?.sport || "";
    comps.push({
      key,
      label,
      sport: ms[0] ? sportOf(ms[0]) : "",
      family: isSetSport({ sport: sportKey }) ? "target" : "timed",
      teamCount: teams.size,
      liveCount: live,
      groups,
      matches: ms,
    });
  }
  return comps.sort((a, b) => a.label.localeCompare(b.label));
}
