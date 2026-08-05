import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { liveApi } from "@/api/live";
import { tournamentsApi } from "@/api/tournaments";
import { useEventStream } from "@/lib/useEventStream";
import { t } from "@/lib/t";
import {
  boardVersion,
  clockSkewMs,
  nextRallyServe,
  pickCourtMatches,
  readOverlayCache,
  selectOverlayState,
  shouldApply,
  writeOverlayCache,
  type BoardVersion,
  type FeedLevel,
  type OverlayMatch,
  type OverlayScoring,
  type RallyServe,
} from "./overlayState";
import type { BoardProps, BoardView } from "./OverlayBoard";

/**
 * THE live wiring behind a court's broadcast board, and the only copy of it.
 *
 * One court in, one fully-assembled `<Board>` prop bag out: the SSE tick
 * stream, the polling floor underneath it, the out-of-order guard, the clock
 * skew, the rally-serve tracker, the six-state selection and the cold-start
 * cache. Extracted from `OverlayPage` so the phone camera page
 * (`CameraBroadcastPage`) shows *the same numbers from the same feed* rather
 * than a second implementation that can disagree with it mid-match.
 *
 * Both consumers are broadcast surfaces, so the behaviour here is tuned for
 * air, not for a browser tab: never blank, never fall back to 0-0, and prefer
 * an honest "this is old" marker over a confident wrong answer.
 */

/** Unconditional poll floor. It runs whatever the stream is doing, and turns
 * the worst failure in the system — a silently frozen scorebug burned into a
 * live stream — into a <=10 s blip. Six courts is 0.6 req/s. */
const POLL_MS = 10_000;
/** With the stream down we tighten it, so the freshness ladder has real
 * resolution instead of flickering the LIVE dot on every poll cycle. */
const POLL_DEGRADED_MS = 4_000;

export interface CourtBoardInput {
  slug: string;
  id: string;
  court: string;
  /** Which side opened the match, for the rules-derived serve indicator. */
  firstServer: 0 | 1;
}

/** Everything `<Board>` needs, plus the two readings a host page puts on its
 * root element for diagnosis (`data-state` / `data-feed`) and the stream's
 * own health. */
export interface CourtBoard extends BoardProps {
  feed: FeedLevel;
  /** True while the SSE stream is open. */
  connected: boolean;
}

export function useCourtBoard({
  slug,
  id,
  court,
  firstServer,
}: CourtBoardInput): CourtBoard {
  const qc = useQueryClient();

  // When the stream last told us something — half of the freshness clock.
  const [tickedAt, setTickedAt] = useState(0);
  const { connected } = useEventStream(
    slug && id ? liveApi.streamUrl(slug, id) : null,
    () => {
      setTickedAt(Date.now());
      qc.invalidateQueries({ queryKey: ["overlay-schedule", slug, id] });
      qc.invalidateQueries({ queryKey: ["overlay-snapshot"] });
    },
  );

  const schedule = useQuery({
    queryKey: ["overlay-schedule", slug, id],
    queryFn: () => tournamentsApi.publicSchedule(slug, id),
    enabled: Boolean(slug && id),
    refetchInterval: connected ? POLL_MS : POLL_DEGRADED_MS,
  });

  const matches = useMemo(
    () => (schedule.data?.matches ?? []) as OverlayMatch[],
    [schedule.data],
  );
  const picked = useMemo(
    () => pickCourtMatches(matches, court),
    [matches, court],
  );

  // Hold the last APPLIED board so a replica answer that arrives after a
  // newer one cannot repaint the bug. Note this guards on payload identity +
  // fetch time, never on the score's direction: a VOID correction legitimately
  // lowers a score and must reach the broadcast.
  const liveMatch = useAppliedBoard(picked.live, schedule.dataUpdatedAt);

  // The snapshot resolves what the schedule cannot: the sport FAMILY that
  // picks the layout, the scoring rules the serve indicator and the flag pill
  // need, kickoff plus a server clock for the match clock, and broadcast short
  // names. It re-keys (an instant fetch) when the court's match changes.
  const focusId = liveMatch?.id ?? picked.final?.id ?? "";
  const snapshot = useQuery({
    queryKey: ["overlay-snapshot", focusId],
    queryFn: () => liveApi.snapshot(focusId),
    enabled: Boolean(focusId),
    refetchInterval: connected ? POLL_MS : POLL_DEGRADED_MS,
  });
  const snapMatch =
    snapshot.data?.match?.id === focusId ? snapshot.data.match : undefined;
  const scoring = (snapMatch?.scoring ?? null) as OverlayScoring;
  // A volunteer laptop is routinely minutes off; the clock runs on the
  // server's clock, re-synced on every snapshot.
  const skewMs = clockSkewMs(snapshot.data?.server_time, snapshot.dataUpdatedAt);

  // Layout comes from `sport_meta.family` — never a hardcoded sport check.
  // Until the snapshot lands we read the SHAPE of the score instead (a match
  // carrying per-game rows is a target sport), which is still data-driven.
  const shownMatch = liveMatch ?? picked.final ?? picked.next;
  const family: "timed" | "target" =
    snapMatch?.sport_meta?.family ??
    ((shownMatch?.set_scores?.length ?? 0) > 0 ? "target" : "timed");

  // One shared 2 s clock: enough to age out the result card and to cross the
  // freshness thresholds. The match clock does NOT ride on it — it animates
  // locally off rAF (see MatchClock), so nothing pushes a tick per second.
  const now = useNow(2_000);
  const finalSeenAt = useFinalHold(picked.final?.id ?? "", now);
  const confirmedAt = Math.max(schedule.dataUpdatedAt, tickedAt);
  // An OPEN stream is fresh by definition — we would learn of a change in
  // milliseconds. Do not age it out against the poll interval or the LIVE dot
  // blinks off between polls, which reads on air as a fault.
  const feedAgeMs = connected ? 0 : Math.max(0, now - confirmedAt);

  const state = selectOverlayState({
    picked: { live: liveMatch, final: picked.final, next: picked.next },
    now,
    feedAgeMs,
    finalSeenAt,
    scoring,
  });

  // Rally-scored sports (badminton, volleyball) only get a serve dot once a
  // point delta attributes a rally. Never persisted.
  const rally = useRallyServe(state.match, scoring);

  const tournamentName = schedule.data?.tournament.name ?? "";
  const cached = useColdStart(court, now);
  const view: BoardView =
    schedule.isPending && cached
      ? {
          // Boot from disk so the first frame is never blank or 0-0. It is
          // shown behind the amber dot: it is by definition unconfirmed.
          kind: cached.kind === "idle" ? "idle" : "stale",
          match: cached.match,
          family: cached.family,
          scoring: cached.scoring,
          periodTerm: cached.periodTerm,
          startedAt: cached.startedAt,
          tournamentName: cached.tournamentName,
        }
      : {
          kind: state.kind,
          match: state.match,
          family,
          scoring,
          periodTerm: snapMatch?.sport_meta?.terms?.period,
          startedAt: snapMatch?.started_at ?? null,
          tournamentName,
        };

  usePersistBoard(court, view, schedule.isPending);

  return {
    ...view,
    feed: state.feed,
    connected,
    feedFresh: state.feed === "fresh",
    stale: view.kind === "stale",
    courtLabel: court || t("Court"),
    timeZone: schedule.data?.tournament.time_zone ?? "UTC",
    firstServer,
    rally,
    skewMs,
    now,
  };
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** A shared wall clock. One interval, cleared on unmount and whenever the
 * cadence changes; state is a single number, so an 8-hour run holds nothing. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * Keeps the last APPLIED payload on screen when a newer one has already been
 * shown. See `boardVersion` for why the guard is signature + fetch time and
 * emphatically NOT the score's direction. One held row; nothing accumulates.
 *
 * The state is adjusted during render (React's documented "storing information
 * from previous renders" pattern) rather than in an effect, so an out-of-order
 * payload never gets a frame on air before being rejected.
 */
function useAppliedBoard<T extends OverlayMatch>(
  incoming: T | null,
  fetchedAt: number,
): T | null {
  const [held, setHeld] = useState<{ match: T; version: BoardVersion } | null>(
    null,
  );
  if (!incoming) {
    if (held !== null) setHeld(null);
    return null;
  }
  const version = boardVersion(incoming, fetchedAt);
  if (shouldApply(held?.version ?? null, version)) {
    if (held?.match !== incoming) setHeld({ match: incoming, version });
    return incoming;
  }
  return held?.match ?? incoming;
}

/** When the court's current final was FIRST seen, so the result card can hold
 * for a fixed beat and then let the board move on. One entry, replaced (never
 * appended) when a different match finishes. */
function useFinalHold(finalId: string, now: number): number | null {
  const [held, setHeld] = useState<{ id: string; at: number } | null>(null);
  if (!finalId) {
    if (held !== null) setHeld(null);
    return null;
  }
  if (held?.id !== finalId) {
    setHeld({ id: finalId, at: now });
    return now;
  }
  return held.at;
}

/** Observed serve for rally-scored sports. Only advances on a clean
 * one-point delta; any other change resets it to unknown. */
function useRallyServe(
  match: OverlayMatch | null,
  scoring: OverlayScoring,
): RallyServe | null {
  const [held, setHeld] = useState<RallyServe | null>(null);
  // Rules-derived sports never touch this path.
  if (!match || scoring?.serve) {
    if (held !== null) setHeld(null);
    return null;
  }
  const rows = match.set_scores ?? [];
  const cur = rows.length > 0 ? rows[rows.length - 1] : undefined;
  const points: [number, number] = [Number(cur?.[0]) || 0, Number(cur?.[1]) || 0];
  if (
    held &&
    held.matchId === match.id &&
    held.points[0] === points[0] &&
    held.points[1] === points[1]
  ) {
    return held;
  }
  const next = nextRallyServe(held, match.id, points);
  setHeld(next);
  return next;
}

/** The disk-cached board, read exactly once per mount. */
function useColdStart(court: string, now: number) {
  const [cached] = useState(() => readOverlayCache(court, now));
  return cached;
}

/** Persist the rendered board so the next cold start paints immediately. One
 * key per court, overwritten — never appended to. Shared by both broadcast
 * surfaces on purpose: a phone that reloads mid-match paints the score OBS
 * last saw for that court, and vice versa. */
function usePersistBoard(
  court: string,
  view: BoardView,
  booting: boolean,
): void {
  // The effect sees every render but writes only when the board actually
  // CHANGED — not on every 2 s tick. The guard lives in a ref read inside the
  // effect, never during render.
  const lastWritten = useRef("");
  const signature =
    view.match == null
      ? `idle:${view.kind}`
      : `${view.match.id}:${view.kind}:${view.match.home_score}:${view.match.away_score}:${JSON.stringify(view.match.set_scores ?? [])}`;
  useEffect(() => {
    if (booting || !view.match) return;
    if (lastWritten.current === signature) return;
    lastWritten.current = signature;
    writeOverlayCache({
      v: 2,
      court,
      savedAt: Date.now(),
      kind: view.kind,
      match: view.match,
      family: view.family,
      scoring: view.scoring,
      periodTerm: view.periodTerm,
      startedAt: view.startedAt,
      tournamentName: view.tournamentName,
    });
  }, [court, signature, booting, view]);
}
