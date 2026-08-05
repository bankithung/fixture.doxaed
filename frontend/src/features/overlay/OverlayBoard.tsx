import { useEffect, useRef, useState } from "react";
import { fmtKickoff } from "@/features/controlroom/format";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import {
  elapsedSeconds,
  flagFor,
  fmtClock,
  gameView,
  panelGeometry,
  serveView,
  sideCode,
  sideLabel,
  type OverlayKind,
  type OverlayMatch,
  type OverlayScoring,
  type RallyServe,
} from "./overlayState";

/**
 * THE broadcast scoreboard graphic — the six boards, and the only copy of them.
 *
 * Extracted from `OverlayPage` when a second surface needed the identical
 * picture: the phone camera page (`CameraBroadcastPage`) draws this same board
 * over a live `getUserMedia` feed so an operator can go live from the YouTube
 * app with no OBS. Two copies of a broadcast graphic drift — one gets the serve
 * fix, the other does not, and the difference only shows up on air — so both
 * pages mount THIS component, fed by `useCourtBoard`.
 *
 * Everything here is presentation. Which match, which of the six states, who is
 * serving and whether a payload is stale are decided in `overlayState.ts`; the
 * live wiring is in `useCourtBoard.ts`.
 *
 * a11y NOTE FOR A LATER REVIEWER — do not "fix" this: this subtree is a video
 * graphic, not UI. It carries no interactive element, no focus order and no
 * ARIA, its colours are fixed broadcast literals rather than theme tokens (see
 * overlay.css), and its only consumers are a headless Chromium screenshotting
 * frames and a phone screen being captured. The hosting page is responsible for
 * hiding it from assistive technology.
 */

export interface BoardView {
  kind: OverlayKind;
  match: OverlayMatch | null;
  family: "timed" | "target";
  scoring: OverlayScoring;
  periodTerm?: string;
  startedAt: string | null;
  tournamentName: string;
}

export interface BoardProps extends BoardView {
  feedFresh: boolean;
  stale: boolean;
  courtLabel: string;
  timeZone: string;
  firstServer: 0 | 1;
  rally: RallyServe | null;
  skewMs: number;
  now: number;
}

export function Board(props: BoardProps): React.ReactElement {
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
