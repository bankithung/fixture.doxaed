import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { liveApi } from "@/api/live";
import {
  tournamentsApi,
  type MatchSource,
  type PublicRosterPlayer,
  type PublicSchedulePayload,
  type PublicScheduleMatch,
  type StandingsGroup,
} from "@/api/tournaments";
import { groupPositionLabel } from "./groupSlotLabel";
import { isSetSport } from "@/lib/setDisplay";
import { t } from "@/lib/t";
import { useEventStream } from "@/lib/useEventStream";

/** Shared data + label logic for the public tournament pages (Matches, which
 * carries the knockout draw as a scope of its own, and Standings). Both read
 * the SAME two queries (identical keys, 30 s staleTime) so switching is an
 * instant cache hit, Google-sports-panel style; the SSE tick invalidates both
 * so every view advances live. Presentational pieces live in
 * publicTournamentViews.tsx. */

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

  return { scheduleQ, standingsQ, connected };
}

/** Team id -> the names that team entered. Empty (never undefined) for a team
 * with no roster published, so a caller can render "no team sheet" instead of
 * a blank. */
export type RosterIndex = Map<string, PublicRosterPlayer[]>;

/** Every team's line-up, fetched ONLY when someone asks for the printed
 * fixture. It is a second request over the whole tournament, and the screen
 * never needs it — the fixture on screen is read by team.
 *
 * `enabled` stays true once flipped, so the print document survives in the DOM
 * and a second Print is instant. */
export function usePublicRosters(
  slug: string,
  id: string,
  enabled: boolean,
): { rosters: RosterIndex; settled: boolean } {
  const q = useQuery({
    queryKey: ["public-rosters", slug, id],
    queryFn: () => tournamentsApi.publicRosters(slug, id),
    enabled: enabled && Boolean(slug && id),
    retry: false,
    // Rosters change when a school edits its entry, not every tick, and a
    // reprint minutes later must not re-fetch the whole tournament.
    staleTime: 5 * 60_000,
  });
  const rosters = useMemo(() => {
    const map: RosterIndex = new Map();
    for (const team of q.data?.teams ?? []) map.set(team.id, team.players);
    return map;
  }, [q.data]);
  // "Settled", not "loaded": a tournament whose rosters fail to load still
  // prints — the detailed pass says "No team sheet" rather than holding the
  // dialog shut.
  return { rosters, settled: !enabled || q.isFetched || q.isError };
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
              // `|| gk` used to leak the raw "Sepak Takraw · U-14 · Boys"
              // blob as a heading whenever the group label added nothing to
              // the competition label — which is every knockout band.
              : shortGroup(gk, label) ||
                (gms.some((m) => m.stage === "knockout")
                  ? t("Knockout")
                  : t("Fixtures")),
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

/**
 * The NUMBER printed against every match, counted WITHIN its own competition —
 * the same number the generated fixture sheet carries (owner 2026-08-19, see
 * `previewGrid.matchNumbers`), so "Winner of match 5" can be found by eye on
 * any surface that prints it.
 *
 * The order is the DRAW's, not the calendar's — competition, then stage, then
 * round, then the match's place in that round — so a number never moves when
 * the schedule is repaired. `match_no` is the tournament-wide sequence the
 * generator hands out in emission order, which is exactly the tie-break the
 * preview reads off its `ref`; the two therefore agree match for match.
 */
export function matchNumbers(
  matches: readonly PublicScheduleMatch[],
): Map<string, number> {
  const order = [...matches].sort(
    (a, b) =>
      (a.leaf_key || "").localeCompare(b.leaf_key || "") ||
      (a.stage || "").localeCompare(b.stage || "") ||
      (a.stage_no ?? 0) - (b.stage_no ?? 0) ||
      (a.round_no ?? 0) - (b.round_no ?? 0) ||
      (a.match_no ?? 0) - (b.match_no ?? 0) ||
      a.id.localeCompare(b.id),
  );
  const perLeaf = new Map<string, number>();
  const out = new Map<string, number>();
  for (const m of order) {
    const key = m.leaf_key || "_";
    const n = (perLeaf.get(key) ?? 0) + 1;
    perLeaf.set(key, n);
    out.set(m.id, n);
  }
  return out;
}

/**
 * Who a side is when no team has reached it yet. A slot must SAY what it is
 * waiting on — "TBD" alone tells a parent nothing, and the whole point of the
 * typed pointers (invariant 9) is that the answer is known:
 *   winner_of / loser_of  -> "Winner of M12" / "Loser of M12"
 *   group_position        -> "Group A top 2" / "Best loser 1"
 * Returns null only when the pointer genuinely names nothing.
 */
export function slotLabel(
  src: MatchSource | null | undefined,
  numbers: Map<string, number>,
): string | null {
  if (!src) return null;
  if (src.type === "group_position") return groupPositionLabel(src);
  if (src.type === "winner_of" || src.type === "loser_of") {
    const ref = src.match_id ?? (src as Record<string, unknown>).ref;
    const n = ref != null ? numbers.get(String(ref)) : undefined;
    if (n == null) return null;
    return src.type === "loser_of"
      ? `${t("Loser of M")}${n}`
      : `${t("Winner of M")}${n}`;
  }
  return null;
}

/** The side that won, once one has: `null` while a match is unplayed, live or
 * drawn. Walkovers count — a walkover HAS a winner. */
export function winnerOf(
  m: PublicScheduleMatch,
): PublicScheduleMatch["home"] | null {
  if (!FINAL_STATUSES.has(m.status)) return null;
  const h = m.home_score ?? 0;
  const a = m.away_score ?? 0;
  if (h === a) {
    // A drawn knockout is decided on penalties, never left without a winner.
    const hp = m.home_pens;
    const ap = m.away_pens;
    if (hp == null || ap == null || hp === ap) return null;
    return hp > ap ? m.home : m.away;
  }
  return h > a ? m.home : m.away;
}
