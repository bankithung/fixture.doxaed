import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { liveApi } from "@/api/live";
import { tournamentsApi } from "@/api/tournaments";
import { fmtKickoff } from "@/features/controlroom/format";
import { useEventStream } from "@/lib/useEventStream";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import {
  boardVersion,
  clockSkewMs,
  elapsedSeconds,
  flagFor,
  fmtClock,
  gameView,
  nextRallyServe,
  panelGeometry,
  parseScale,
  pickCourtMatches,
  readOverlayCache,
  selectOverlayState,
  serveView,
  shouldApply,
  sideCode,
  sideLabel,
  writeOverlayCache,
  type BoardVersion,
  type OverlayKind,
  type OverlayMatch,
  type OverlayScoring,
  type RallyServe,
} from "./overlayState";
import "./overlay.css";

/** Unconditional poll floor. It runs whatever the stream is doing, and turns
 * the worst failure in the system — a silently frozen scorebug burned into a
 * live stream — into a <=10 s blip. Six courts is 0.6 req/s. */
const POLL_MS = 10_000;
/** With the stream down we tighten it, so the freshness ladder has real
 * resolution instead of flickering the LIVE dot on every poll cycle. */
const POLL_DEGRADED_MS = 4_000;

/**
 * OBS broadcast scoreboard overlay — `/overlay/t/:slug/:id/court/:court`.
 *
 * A URL an operator pastes ONCE into an OBS Browser Source per court and
 * never touches again. It follows whatever match is live on that court and
 * renders a scorebug that gets composited over the camera feed and burned
 * into the stream. Public, unauthenticated, outside the app shell.
 *
 * No outbound links exist on this page, by design: a link is a `Referer` leak
 * vector and there is nothing here to navigate to anyway.
 *
 * a11y NOTE FOR A LATER REVIEWER — do not "fix" this:
 * WCAG does not apply to this page and it is exempt on purpose. There is no
 * interactive element, no focus order, no keyboard path and no human reading
 * this DOM: the only consumer is a headless Chromium that screenshots the
 * page into a video frame. The root is `aria-hidden`, the cursor is hidden,
 * focus rings and text selection are suppressed, and colours are fixed
 * broadcast literals rather than theme tokens (see overlay.css). Adding ARIA
 * roles, focus styling or theme awareness here would only add ways for the
 * graphic to change unexpectedly mid-stream.
 *
 * Query params: `?scale=1.25` (canvas multiplier; 1280x720 is 0.667),
 * `?side=left|right` (anchor corner) and `?server=away` (which side opened
 * the match, for the rules-derived serve indicator).
 */
export function OverlayPage(): React.ReactElement {
  const { slug = "", id = "", court = "" } = useParams();
  const [params] = useSearchParams();
  const scale = parseScale(params.get("scale"));
  const sideParam = params.get("side");
  const firstServer: 0 | 1 = params.get("server") === "away" ? 1 : 0;
  const qc = useQueryClient();

  // The whole page is a broadcast graphic: strip the app's opaque body
  // background (and any focus/selection/cursor chrome) while it is mounted,
  // and put every one of those rules back on unmount so the SPA is unharmed.
  // The meta tags are the in-page half of the header hardening; the response
  // headers themselves belong in nginx (see docs/obs-overlay.md).
  useEffect(() => {
    const html = document.documentElement;
    html.setAttribute("data-obs-overlay", "");
    const metas = [
      metaTag("referrer", "no-referrer"),
      metaTag("robots", "noindex, nofollow"),
    ];
    return () => {
      html.removeAttribute("data-obs-overlay");
      for (const m of metas) m.remove();
    };
  }, []);

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

  const courtLabel = court || t("Court");
  useEffect(() => {
    document.title = `${courtLabel} · ${t("Overlay")}`;
  }, [courtLabel]);

  // Football's bug is centred unless the operator says otherwise; a target
  // board defaults to the top-left corner.
  const anchor =
    sideParam === "right"
      ? "right"
      : sideParam === "left"
        ? "left"
        : view.family === "timed"
          ? "center"
          : "left";

  return (
    <div
      // See the a11y note on the component: this subtree is deliberately
      // hidden from assistive technology — it is a video graphic, not UI.
      aria-hidden="true"
      data-testid="overlay-root"
      data-state={view.kind}
      data-family={view.family}
      data-feed={state.feed}
      className={cn(
        "ov",
        anchor === "right" && "ov--right",
        anchor === "center" && "ov--center",
      )}
      style={{ "--ov-scale": String(scale) } as React.CSSProperties}
    >
      <div className="ov-stack">
        <Board
          {...view}
          feedFresh={state.feed === "fresh"}
          stale={view.kind === "stale"}
          courtLabel={courtLabel}
          timeZone={schedule.data?.tournament.time_zone ?? "UTC"}
          firstServer={firstServer}
          rally={rally}
          skewMs={skewMs}
          now={now}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function metaTag(name: string, content: string): HTMLMetaElement {
  const el = document.createElement("meta");
  el.setAttribute("name", name);
  el.setAttribute("content", content);
  document.head.appendChild(el);
  return el;
}

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
 * key per court, overwritten — never appended to. */
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

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

interface BoardView {
  kind: OverlayKind;
  match: OverlayMatch | null;
  family: "timed" | "target";
  scoring: OverlayScoring;
  periodTerm?: string;
  startedAt: string | null;
  tournamentName: string;
}

interface BoardProps extends BoardView {
  feedFresh: boolean;
  stale: boolean;
  courtLabel: string;
  timeZone: string;
  firstServer: 0 | 1;
  rally: RallyServe | null;
  skewMs: number;
  now: number;
}

function Board(props: BoardProps): React.ReactElement {
  const { kind, match } = props;
  if (!match || kind === "idle") return <IdleBoard {...props} />;
  if (kind === "up-next") return <UpNextBoard {...props} match={match} />;
  return props.family === "target" ? (
    <TargetBug {...props} match={match} />
  ) : (
    <TimedBug {...props} match={match} />
  );
}

/** 1. idle — nothing on this court. Name the tournament and the court, and
 * otherwise stay out of the picture. */
function IdleBoard({
  tournamentName,
  courtLabel,
}: BoardProps): React.ReactElement {
  return (
    <div className="ov-panel ovQ" data-testid="overlay-idle">
      <div className="ov-head">
        <span className="ov-head__label" data-testid="overlay-court">
          {courtLabel}
        </span>
      </div>
      <div className="ovQ__row ovQ__row--home">
        <span className="ovQ__bar" />
        <span />
        <span className="ovQ__text">{tournamentName || t("Tournament")}</span>
      </div>
    </div>
  );
}

/** 2. up-next — who is on this court next, and when. */
function UpNextBoard(
  props: BoardProps & { match: OverlayMatch },
): React.ReactElement {
  const { match, timeZone, courtLabel } = props;
  return (
    <div className="ov-panel ovQ" data-testid="overlay-up-next">
      <div className="ov-head">
        <span className="ov-head__label">{t("Up next")}</span>
        <span className="ov-head__spacer" />
        <span className="ov-num" data-testid="overlay-kickoff">
          {fmtKickoff(match.scheduled_at, timeZone)}
        </span>
        <span className="ov-head__label">{match.leaf_label || courtLabel}</span>
      </div>
      <div className="ovQ__row ovQ__row--home">
        <span className="ovQ__bar" />
        <span />
        <span className="ovQ__text" data-testid="overlay-home-name">
          {sideLabel(match.home)}
        </span>
      </div>
      <div className="ovQ__row ovQ__row--away">
        <span className="ovQ__bar" />
        <span />
        <span className="ovQ__text" data-testid="overlay-away-name">
          {sideLabel(match.away)}
        </span>
      </div>
    </div>
  );
}

/** 3/4/5/6 for a TARGET sport (volleyball, table tennis, sepak takraw,
 * badminton): current game score large, per-game history, games won, serve. */
function TargetBug(
  props: BoardProps & { match: OverlayMatch },
): React.ReactElement {
  const { match, kind, scoring, firstServer, rally, periodTerm } = props;
  const gv = gameView(match);
  const geo = panelGeometry(scoring);
  const final = kind === "final";
  const serve = final ? null : serveView(match, scoring, firstServer, rally);
  const flag = kind === "live" ? flagFor(match, scoring, periodTerm) : null;
  const winner =
    final && gv.games[0] !== gv.games[1] ? (gv.games[0] > gv.games[1] ? 0 : 1) : null;
  // A finished match headlines games won; a running one headlines the points
  // in the game on the table (that is what spectators watch move).
  const big: [number, number] = final ? gv.games : gv.points;
  const rows = [0, 1] as const;
  return (
    <>
      <div
        className="ov-panel ovA"
        data-testid={final ? "overlay-final" : "overlay-scorebug"}
        style={
          {
            "--ovA-w": `${geo.widthPx}px`,
            "--ovA-hist": `${geo.historyPx}px`,
            "--ovA-pts": `${geo.pointsPx}px`,
          } as React.CSSProperties
        }
      >
        <HeadStrip {...props} />
        {rows.map((i) => {
          const side = i === 0 ? "home" : "away";
          const serving = serve?.side === i;
          return (
            <div
              key={side}
              className={cn(
                "ovA__row",
                `ovA__row--${side}`,
                serving && "ovA__row--serving",
                winner != null && winner !== i && "ovA__row--lost",
              )}
              data-testid={`overlay-${side}-row`}
            >
              {serving ? (
                <span
                  className="ovA__serve"
                  data-testid={`overlay-serving-${side}`}
                />
              ) : (
                <span />
              )}
              <span className="ovA__bar" />
              <span />
              <span className="ovA__name" data-testid={`overlay-${side}-name`}>
                {sideLabel(i === 0 ? match.home : match.away)}
              </span>
              <span className="ovA__hist" data-testid={`overlay-${side}-history`}>
                {gv.history.slice(-geo.slots).map((g, gi) => (
                  <span
                    key={gi}
                    className={cn(
                      "ovA__histCell",
                      (g?.[i] ?? 0) < (g?.[1 - i] ?? 0) && "ovA__histCell--lost",
                    )}
                  >
                    {g?.[i] ?? 0}
                  </span>
                ))}
              </span>
              <span className="ovA__won" data-testid={`overlay-${side}-games`}>
                <Digit value={gv.games[i]} slow />
              </span>
              <span className="ovA__pts" data-testid={`overlay-${side}-score`}>
                <Digit value={big[i]} />
              </span>
            </div>
          );
        })}
      </div>
      {flag ? (
        <div className="ov-flag" data-testid="overlay-flag" data-flag={flag.key}>
          {flag.text}
        </div>
      ) : null}
    </>
  );
}

/** 3/5/6 for a TIMED sport (football): goals plus a running match clock
 * derived from kickoff on the SERVER's clock. */
function TimedBug(
  props: BoardProps & { match: OverlayMatch },
): React.ReactElement {
  const { match, kind, startedAt, skewMs, feedFresh, stale } = props;
  const final = kind === "final";
  const period = final
    ? t("Full time")
    : (match.current_period ?? "").replace(/_/g, " ") || t("Live");
  // The clock only runs while the ball is in play; a stopped clock is dimmed
  // so nobody reads a paused number as a frozen stream.
  const stopped = match.status !== "live";
  return (
    <div
      className="ov-panel ovB"
      data-testid={final ? "overlay-final" : "overlay-scorebug"}
    >
      <div className="ovB__side ovB__side--home">
        <span className="ovB__bar" />
        <span />
        <span className="ovB__code" data-testid="overlay-home-name">
          {sideCode(match.home)}
        </span>
        <span className="ovB__score" data-testid="overlay-home-score">
          <Digit value={match.home_score ?? 0} />
        </span>
      </div>
      <div className="ovB__centre">
        <span className="ovB__period" data-testid="overlay-period">
          {/* Same degradation ladder as the target board, in the one strip
              this layout has. */}
          {final ? null : stale ? (
            <span className="ov-dot ov-dot--stale" data-testid="overlay-stale-dot" />
          ) : feedFresh ? (
            <span className="ov-dot" data-testid="overlay-live-dot" />
          ) : null}
          {period}
        </span>
        <MatchClock startedAt={startedAt} skewMs={skewMs} stopped={stopped} />
      </div>
      <div className="ovB__side ovB__side--away">
        <span className="ovB__score" data-testid="overlay-away-score">
          <Digit value={match.away_score ?? 0} />
        </span>
        <span className="ovB__code" data-testid="overlay-away-name">
          {sideCode(match.away)}
        </span>
        <span />
        <span className="ovB__bar" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function HeadStrip(props: BoardProps): React.ReactElement {
  const { kind, match, courtLabel, feedFresh, stale, periodTerm } = props;
  const gv = match ? gameView(match) : null;
  const final = kind === "final";
  const context = [courtLabel, match?.leaf_label || match?.group_label]
    .filter(Boolean)
    .join(" · ");
  const period =
    final || !gv
      ? null
      : kind === "between-games"
        ? `${periodTerm ?? t("Set")} ${gv.gameNo} ${t("complete")}`
        : `${periodTerm ?? t("Set")} ${gv.gameNo}`;
  return (
    <div className="ov-head">
      <span className="ov-head__label">{context}</span>
      {period ? (
        <span className="ov-num" data-testid="overlay-period">
          {period}
        </span>
      ) : null}
      <span className="ov-head__spacer" />
      {final ? (
        <span data-testid="overlay-final-label">
          {match?.status === "walkover" ? t("Walkover") : t("Final")}
        </span>
      ) : (
        <>
          {/* The degradation ladder: fresh shows the LIVE dot, a quiet feed
              drops it rather than claim liveness, an old feed goes amber. */}
          {stale ? (
            <span className="ov-dot ov-dot--stale" data-testid="overlay-stale-dot" />
          ) : feedFresh ? (
            <span className="ov-dot" data-testid="overlay-live-dot" />
          ) : null}
          <span>{t("Live")}</span>
        </>
      )}
    </div>
  );
}

/**
 * The match clock. Animated LOCALLY off `requestAnimationFrame` against the
 * server-synced offset, writing `textContent` on one node: no per-second push,
 * no React re-render per tick, and it interpolates smoothly straight through a
 * network hiccup instead of stuttering on air. One rAF loop, cancelled on
 * unmount.
 */
function MatchClock({
  startedAt,
  skewMs,
  stopped,
}: {
  startedAt: string | null;
  skewMs: number;
  stopped: boolean;
}): React.ReactElement {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let raf = 0;
    let last = "";
    const paint = (): void => {
      const s = elapsedSeconds(startedAt, Date.now(), skewMs);
      const text = s == null ? "--:--" : fmtClock(s);
      if (text !== last) {
        // textContent on ONE node, never innerHTML and never an append: this
        // is what keeps an 8-hour source flat instead of growing a DOM.
        node.textContent = text;
        last = text;
      }
      raf = requestAnimationFrame(paint);
    };
    paint();
    return () => cancelAnimationFrame(raf);
  }, [startedAt, skewMs]);
  // No JSX children, so React never touches the text the loop writes.
  return (
    <span
      ref={ref}
      className={cn("ovB__clock ov-num", stopped && "ovB__clock--stopped")}
      data-testid="overlay-clock"
    />
  );
}

/** One animated figure. The outgoing digit rises out while the incoming one
 * rises in (160 ms, 600 ms for a game won) — readable, and nothing moves the
 * panel itself. Exactly two nodes, replaced not appended. */
function Digit({
  value,
  slow,
}: {
  value: number;
  slow?: boolean;
}): React.ReactElement {
  const prev = usePreviousValue(value);
  return (
    <span className={cn("ov-digit", slow && "ov-digit--slow")}>
      {prev == null ? null : (
        <span key={`out-${prev}`} className="ov-digit__out" aria-hidden="true">
          {prev}
        </span>
      )}
      <span key={`in-${value}`} className="ov-digit__in">
        {value}
      </span>
    </span>
  );
}

/** The value before the current one, or null if it never changed. Two scalars
 * of state — no timers, nothing that grows over an 8-hour broadcast. */
function usePreviousValue(value: number): number | null {
  const [track, setTrack] = useState<{ cur: number; prev: number | null }>({
    cur: value,
    prev: null,
  });
  if (track.cur !== value) {
    setTrack({ cur: value, prev: track.cur });
    return track.cur;
  }
  return track.prev;
}
