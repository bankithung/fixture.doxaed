import { useCallback, useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { liveApi } from "@/api/live";
import { tournamentsApi, type ControlRoomPayload } from "@/api/tournaments";
import { qk } from "@/lib/queryKeys";
import { useEventStream } from "@/lib/useEventStream";

/** Debounce window for tick-driven invalidation — a goal + its score tick
 * land together; one refetch covers the burst. */
const TICK_DEBOUNCE_MS = 500;

/** Heavy derived aggregates (standings, leaders, suspensions) refresh at
 * most this often under tick load. During parallel set-sport play every
 * point tap ticks tournament-wide; refetching FIVE aggregates per client
 * per tap was the confirmed Dimapur-scale hazard (scale-stress finding) —
 * the hot board stays sub-second while the derived tables trail by at most
 * this window. */
const HEAVY_THROTTLE_MS = 10_000;

/** Polling cadence while the SSE stream is down/unavailable (graceful
 * degradation — exactly the public page's pre-SSE behavior). */
const FALLBACK_POLL_MS = 60_000;

export interface ControlRoom {
  query: UseQueryResult<ControlRoomPayload>;
  /** True while the SSE stream is delivering (header shows the live badge);
   * false = degraded, the 60 s poll is carrying updates. */
  live: boolean;
}

/**
 * The cockpit's data loop (control room spec §3.1): the day-view aggregate
 * plus a subscription to the tournament's public SSE tick stream. Any tick
 * invalidates the control-room + match/standings queries (debounced), so the
 * authed aggregate refetch carries the data — ticks are ids only. While the
 * stream is down the query falls back to a 60 s poll.
 */
export function useControlRoom(
  tournamentId: string,
  day: string | null,
): ControlRoom {
  const qc = useQueryClient();
  // Previous-render stream health drives the poll fallback; the first render
  // (no stream yet) polls, then the open stream switches polling off.
  const [live, setLive] = useState(false);

  const query = useQuery({
    queryKey: [...qk.controlRoom(tournamentId), day ?? ""],
    queryFn: () => tournamentsApi.controlRoom(tournamentId, day ?? undefined),
    // Switching days keeps the current board on screen (dimmed via
    // isPlaceholderData) instead of collapsing to a skeleton; the new
    // day's content swaps in when it lands.
    placeholderData: keepPreviousData,
    refetchInterval: live ? false : FALLBACK_POLL_MS,
  });

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastHeavy = useRef(0);
  const onTick = useCallback(() => {
    if (timer.current) return; // a refetch is already queued for this burst
    timer.current = setTimeout(() => {
      timer.current = null;
      // HOT path: the board itself, sub-second.
      qc.invalidateQueries({ queryKey: qk.controlRoom(tournamentId) });
      qc.invalidateQueries({ queryKey: qk.matches(tournamentId) });
      // HEAVY derived aggregates trail on a throttle (leader boards still
      // read live to a human; five refetches per point tap did not).
      const now = Date.now();
      if (now - lastHeavy.current >= HEAVY_THROTTLE_MS) {
        lastHeavy.current = now;
        qc.invalidateQueries({ queryKey: qk.standings(tournamentId) });
        qc.invalidateQueries({ queryKey: ["t-leaders", tournamentId] });
        qc.invalidateQueries({ queryKey: ["t-suspensions", tournamentId] });
      }
    }, TICK_DEBOUNCE_MS);
  }, [qc, tournamentId]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // The stream URL needs the slug, which the aggregate itself carries.
  const slug = query.data?.tournament.slug ?? null;
  const { connected } = useEventStream(
    slug ? liveApi.streamUrl(slug, tournamentId) : null,
    onTick,
  );
  useEffect(() => {
    setLive(connected);
  }, [connected]);

  return { query, live };
}
