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
  type PublicScheduleSide,
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

/** One group and the teams drawn into it. */
export type GroupLineup = {
  key: string;
  label: string;
  teams: PublicScheduleSide[];
};

/**
 * WHO IS IN WHICH GROUP, per competition (owner 2026-08-22).
 *
 * A group's membership is nowhere in the payload — it is only implied by that
 * group's matches — so a reader of the printed order of play had to
 * reconstruct it by scanning every row for names, which is exactly the
 * question a group stage is asked first ("which group are we in, and who do
 * we play?"). The lineup is read back off the fixture itself: home side then
 * away side of every group match in DRAW order (not the calendar's, so the
 * list never moves when the schedule is repaired), deduped by team id so a
 * team that plays four matches is named once.
 *
 * Knockout bands are skipped: nobody is in them yet, which is what the tree
 * says already.
 */
export function groupLineups(comp: Competition): GroupLineup[] {
  const out: GroupLineup[] = [];
  for (const g of comp.groups) {
    const ms = g.matches
      .filter((m) => m.stage !== "knockout")
      .sort(
        (a, b) =>
          (a.stage_no ?? 0) - (b.stage_no ?? 0) ||
          (a.round_no ?? 0) - (b.round_no ?? 0) ||
          (a.match_no ?? 0) - (b.match_no ?? 0),
      );
    if (ms.length === 0) continue;
    const teams = new Map<string, PublicScheduleSide>();
    for (const m of ms) {
      for (const side of [m.home, m.away]) {
        if (side && !teams.has(side.id)) teams.set(side.id, side);
      }
    }
    if (teams.size === 0) continue;
    out.push({ key: g.key, label: g.label, teams: [...teams.values()] });
  }
  return out;
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
 *   group_position        -> "Group A top 2" / "Best Non-Qualifier 1"
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

/** What a competition's spotlight is showing, and why. */
export type SpotlightKind = "live" | "next" | "done";

export interface Spotlight {
  match: PublicScheduleMatch;
  kind: SpotlightKind;
}

/** Sort key for a match on the clock. Unscheduled sorts last, because a match
 * with no time cannot be the one happening now or next. */
function whenOf(m: PublicScheduleMatch): number {
  const raw = m.scheduled_at ? Date.parse(m.scheduled_at) : NaN;
  return Number.isNaN(raw) ? Number.POSITIVE_INFINITY : raw;
}

/**
 * The ONE match a competition is about right now (owner 2026-08-26: "one
 * section above the groups that shows the current one or the next or
 * completed").
 *
 * The order is what a spectator standing at the court cares about, in that
 * order: what is on now, else what is on next, else how it ended. Nothing is
 * remembered between calls — the pick is derived from the payload, so a live
 * match that finishes stops being live and the NEXT one takes the spotlight on
 * the very next tick, which is what "once done we will show the next match"
 * means without any timer.
 *
 * `done` deliberately looks BACKWARD to the latest result rather than the
 * final: a competition still in its group stage has no final yet, and the last
 * thing played is the honest answer to "what happened".
 */
export function spotlightPick(
  matches: PublicScheduleMatch[],
): Spotlight | null {
  const live = matches
    .filter((m) => LIVE_STATUSES.has(m.status))
    .sort((a, b) => whenOf(a) - whenOf(b));
  if (live[0]) return { match: live[0], kind: "live" };

  const upcoming = matches
    .filter((m) => !LIVE_STATUSES.has(m.status) && !FINAL_STATUSES.has(m.status))
    // An unscheduled match is not "next" while a scheduled one exists, but it
    // is still better than nothing once every timed match has been played.
    .sort((a, b) => whenOf(a) - whenOf(b));
  if (upcoming[0]) return { match: upcoming[0], kind: "next" };

  const done = matches
    .filter((m) => FINAL_STATUSES.has(m.status))
    .sort((a, b) => whenOf(b) - whenOf(a));
  if (done[0]) return { match: done[0], kind: "done" };

  return null;
}

/** The match that follows the spotlight one, so a full-screen board can say
 * what is coming without the viewer touching anything. Null when the
 * spotlight is already the last word. */
export function spotlightNextUp(
  matches: PublicScheduleMatch[],
  current: PublicScheduleMatch,
): PublicScheduleMatch | null {
  const rest = matches
    .filter(
      (m) =>
        m.id !== current.id &&
        !LIVE_STATUSES.has(m.status) &&
        !FINAL_STATUSES.has(m.status),
    )
    .sort((a, b) => whenOf(a) - whenOf(b));
  return rest[0] ?? null;
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
