// Pure logic for the OBS broadcast scoreboard overlay
// (/overlay/t/:slug/:id/court/:court). Everything a live event depends on —
// which match is on this court, which of the six board states applies, who is
// serving, whether a payload arrived out of order, whether a flag is safely
// derivable — is a function here, so the page component stays a dumb renderer
// and the whole contract is unit-testable.
//
// Nothing in this file reads a sport KEY to decide anything: the two layouts
// come from `sport_meta.family`, and every per-sport nuance (how many game
// slots to draw, whether a cap makes a "setting up to N" call, whether serve
// is derivable at all) is read off the RESOLVED scoring rules. The score and
// rule maths is shared with the scorer console rather than reimplemented.

import {
  changeEndsPrompt,
  serveOfTurn,
  serveTurn,
  type ServeRules,
} from "@/features/matches/console/serve";
import {
  gamePointSide,
  setProgress,
  setTargets,
  setsWon,
  type SetRow,
  type SetScoring,
} from "@/features/matches/console/shared";
import { t } from "@/lib/t";

/** Statuses that put a match ON the court right now. */
export const LIVE_STATUSES = new Set(["live", "half_time"]);
/** Statuses that end a match with a result to show. */
export const FINAL_STATUSES = new Set(["completed", "walkover"]);

/** How long the result card holds after a match ends before the board falls
 * through to up-next/idle. */
export const FINAL_HOLD_MS = 60_000;

/** Degradation ladder. Under FEED_FRESH_MS the board shows the LIVE dot;
 * between the two it keeps the score but drops the dot (no false "we are
 * live" claim); past FEED_STALE_MS an amber dot says the feed is old. The
 * board NEVER blanks and NEVER falls back to 0-0 — a blank bug reads to
 * viewers as a broken stream. */
export const FEED_FRESH_MS = 5_000;
export const FEED_STALE_MS = 20_000;

export type FeedLevel = "fresh" | "quiet" | "stale";

export function feedLevel(ageMs: number): FeedLevel {
  if (ageMs < FEED_FRESH_MS) return "fresh";
  if (ageMs < FEED_STALE_MS) return "quiet";
  return "stale";
}

/** One side of a fixture, as both the public schedule and the live snapshot
 * expose it. */
export interface OverlaySide {
  id?: string;
  name: string;
  short_name?: string;
  /** Signed crest URL, "" when the team has no badge. The board draws it in a
   * fixed box (see `.ov-crest` in overlay.css) so a badge that arrives late
   * cannot reflow a graphic that is being captured. */
  crest?: string;
}

/** The slice of a public-schedule row the overlay renders from. Deliberately
 * structural (not the full `PublicScheduleMatch`) so tests build small
 * fixtures and a future `Court` entity can widen it without a rewrite. */
export interface OverlayMatch {
  id: string;
  status: string;
  venue: string;
  scheduled_at: string | null;
  home: OverlaySide | null;
  away: OverlaySide | null;
  home_score: number | null;
  away_score: number | null;
  sport?: string;
  set_scores?: number[][];
  current_period?: string;
  leaf_label?: string;
  group_label?: string;
}

/** Resolved scoring rules from the live snapshot: the console's `SetScoring`
 * plus the serve block the indicator needs. */
export type OverlayScoring =
  | (NonNullable<SetScoring> & {
      serve?: {
        serves_per_turn?: number;
        alternate_every_point?: boolean;
        change_ends_at?: { regular?: number; deciding?: number } | null;
      } | null;
    })
  | null;

// ---------------------------------------------------------------------------
// Court lookup — the ONE swap point
// ---------------------------------------------------------------------------

/** Court identity, normalised. Venue strings reach the database from
 * spreadsheet imports as often as from the UI, so "Court 2" and "court 2 "
 * are one court; everything else compares exactly. */
export function normalizeCourt(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

/**
 * THE court lookup, and deliberately the only one.
 *
 * A court is identified TODAY by the free-text `venue` string a fixture
 * carries — the route's `:court` param is that string, URL-encoded. A
 * first-class `Court` entity is landing separately: when it does, this single
 * function becomes `m.court_id === court` (or a resolver call) and nothing
 * else in the overlay changes. Do not inline a venue comparison anywhere
 * else.
 */
export function matchesOnCourt<T extends { venue: string }>(
  matches: readonly T[],
  court: string,
): T[] {
  const want = normalizeCourt(court);
  return matches.filter((m) => normalizeCourt(m.venue) === want);
}

function byTime(a: OverlayMatch, b: OverlayMatch): number {
  return (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? "");
}

/** What this court has: what is on now, what finished last, what is next. */
export interface CourtMatches<T> {
  live: T | null;
  final: T | null;
  next: T | null;
}

export function pickCourtMatches<T extends OverlayMatch>(
  matches: readonly T[],
  court: string,
): CourtMatches<T> {
  const on = matchesOnCourt(matches, court);
  const live = on.filter((m) => LIVE_STATUSES.has(m.status)).sort(byTime);
  const finals = on.filter((m) => FINAL_STATUSES.has(m.status)).sort(byTime);
  const next = on.filter((m) => m.status === "scheduled").sort(byTime);
  return {
    // Two live matches on one court is an ops error, not a broadcast
    // decision: show the earlier slot and stay deterministic.
    live: live[0] ?? null,
    final: finals[finals.length - 1] ?? null,
    next: next[0] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Score shape
// ---------------------------------------------------------------------------

function rowsOf(m: Pick<OverlayMatch, "set_scores">): SetRow[] {
  return (m.set_scores ?? []).map(
    (r) => [String(r?.[0] ?? ""), String(r?.[1] ?? "")] as SetRow,
  );
}

function currentPoints(m: Pick<OverlayMatch, "set_scores">): [number, number] {
  const rows = m.set_scores ?? [];
  const cur = rows.length > 0 ? rows[rows.length - 1] : undefined;
  return [Number(cur?.[0]) || 0, Number(cur?.[1]) || 0];
}

/** The numbers a target-sport board shows. */
export interface GameView {
  /** Points in the game on the table right now (the BIG number). */
  points: [number, number];
  /** Completed games, oldest first (the per-game history slots). */
  history: number[][];
  /** Games/sets won — the server mirrors these into home/away_score. */
  games: [number, number];
  /** 1-based number of the game in play. */
  gameNo: number;
}

export function gameView(m: OverlayMatch): GameView {
  const rows = m.set_scores ?? [];
  return {
    points: currentPoints(m),
    history: rows.slice(0, -1),
    games: [m.home_score ?? 0, m.away_score ?? 0],
    gameNo: Math.max(rows.length, 1),
  };
}

/** How many game-history slots the panel reserves — read off `best_of`, never
 * off a sport key, so a best-of-7 table-tennis rubber gets seven and a
 * best-of-3 takraw match gets three. Clamped to the drawn range. */
export function historySlots(scoring: OverlayScoring): number {
  const bo = Math.floor(scoring?.best_of ?? 3);
  if (!Number.isFinite(bo)) return 3;
  return Math.min(7, Math.max(3, bo));
}

/**
 * How many digits the points column must hold, from the RESOLVED rules —
 * never from an assumed 21 or 30. BWF moves to games of 15 (cap 21) on
 * 2027-01-04 and the ISTAF regimes already disagree with each other, so every
 * constant here comes off `scoring`.
 *
 * An UNCAPPED deuce (ITTF 11-up runs until someone leads by two) can pass the
 * target indefinitely, so an uncapped rule gets a digit of headroom rather
 * than clipping a 3-digit score on air.
 */
export function maxScoreDigits(scoring: OverlayScoring): number {
  const reg = setTargets(scoring, false);
  const dec = setTargets(scoring, true);
  // A capped rule cannot pass its cap. An uncapped one can run on at deuce,
  // so budget twice the target — comfortably past any real 11-up game without
  // reserving a column that stays empty all tournament.
  const top = Math.max(reg.cap ?? reg.points * 2, dec.cap ?? dec.points * 2);
  if (!(top > 0)) return 2;
  return Math.min(3, Math.max(2, String(Math.floor(top)).length));
}

/** Panel geometry, authored at 1920x1080. The canonical best-of-5 / 2-digit
 * board is exactly the specified 820 x 162: header 30 + two rows of 66, with
 * columns 30 (serve) + 12 (bar) + 12 (gap) + 360 (name) + 240 (history) + 72
 * (games won) + 94 (points). Only the history and points columns move. */
export interface PanelGeometry {
  slots: number;
  historyPx: number;
  pointsPx: number;
  widthPx: number;
}

export function panelGeometry(scoring: OverlayScoring): PanelGeometry {
  const slots = historySlots(scoring);
  const historyPx = slots * 48;
  // 35px per tabular digit at the drawn 58px/800 weight, plus 24px of gutter:
  // two digits land on the specified 94px.
  const pointsPx = maxScoreDigits(scoring) * 35 + 24;
  return {
    slots,
    historyPx,
    pointsPx,
    widthPx: 30 + 12 + 12 + 360 + historyPx + 72 + pointsPx,
  };
}

/**
 * True when the game on the board has been legally WON but the match has not
 * been decided — the explicit between-games beat the scorer console calls
 * `awaitingNext`. Uses the console's own `setsWon`, so the board and the
 * console agree about what "the game ended" means.
 *
 * Returns false whenever the rules are unknown: without a target score every
 * un-tied row would read as a finished game and the board would sit in
 * between-games all match.
 */
export function isBetweenGames(
  m: Pick<OverlayMatch, "set_scores">,
  scoring: OverlayScoring,
): boolean {
  if (!scoring || (scoring.points ?? 0) <= 0) return false;
  const rows = rowsOf(m);
  if (rows.length === 0) return false;
  const [h, a] = setsWon(rows, scoring);
  const [ph, pa] = setsWon(rows.slice(0, -1), scoring);
  if (h + a <= ph + pa) return false;
  const need = Math.floor((scoring.best_of ?? 3) / 2) + 1;
  return h < need && a < need;
}

// ---------------------------------------------------------------------------
// Serve indicator
// ---------------------------------------------------------------------------

export interface ServeView {
  /** 0 home, 1 away. Side only — never a player. Table-tennis doubles would
   * need a four-player rotation and badminton doubles a court-side rotation
   * to name an individual, and neither is worth being wrong about on air. */
  side: 0 | 1;
  /** 1-based serve within the current turn (rules-derived sports only). */
  serveNo: number;
  /** Serves per turn under the resolved rules. */
  perTurn: number;
  /** How we know: "rules" = a pure function of the score, "rally" = observed
   * from a point delta between two snapshots. */
  source: "rules" | "rally";
}

/**
 * Who serves next in a RALLY-scored game, observed rather than derived.
 *
 * Badminton and volleyball hand service to whoever won the last rally, which
 * a snapshot of `set_scores` cannot tell you. So we watch the delta between
 * consecutive snapshots: exactly one side up by exactly one means that side
 * won the rally and therefore serves. Anything else — a cold start, a new
 * game, a missed poll, both sides moving, a correction — resets to unknown
 * and the indicator disappears.
 *
 * This state is deliberately NEVER persisted: a guessed serve restored from
 * localStorage after an OBS restart is exactly the confident-wrong-answer an
 * umpire spots instantly.
 */
export interface RallyServe {
  matchId: string;
  points: [number, number];
  /** Side that won the last attributable rally; null = unknown, hide. */
  side: 0 | 1 | null;
}

export function nextRallyServe(
  prev: RallyServe | null,
  matchId: string,
  points: [number, number],
): RallyServe {
  if (!prev || prev.matchId !== matchId) return { matchId, points, side: null };
  const dh = points[0] - prev.points[0];
  const da = points[1] - prev.points[1];
  if (dh === 0 && da === 0) return { matchId, points, side: prev.side };
  if (dh === 1 && da === 0) return { matchId, points, side: 0 };
  if (da === 1 && dh === 0) return { matchId, points, side: 1 };
  // Unattributable: a new game resetting to 0-0, a gap that swallowed points,
  // a correction. Absence is honest; a guess is not.
  return { matchId, points, side: null };
}

function serveRulesOf(
  scoring: OverlayScoring,
  gameNo: number,
): ServeRules | null {
  const serve = scoring?.serve;
  if (!serve) return null;
  const bestOf = scoring?.best_of ?? 3;
  // The deciding game can carry its own target (takraw 15 vs 21), and the
  // target anchors the deuce threshold.
  const target = setTargets(scoring, gameNo === bestOf).points;
  if (target <= 0) return null;
  return {
    serves_per_turn: serve.serves_per_turn ?? 1,
    alternate_every_point: serve.alternate_every_point ?? false,
    points: target,
    change_ends_at: serve.change_ends_at ?? null,
  };
}

/**
 * The serve indicator. Two honest paths, and no third.
 *
 * 1. RULES. When the resolved rules carry a `serve` block, service rotates by
 *    total points played and IS a pure function of the score: table tennis
 *    (2-point blocks, every point from 10-10), sepak takraw legacy (3-point
 *    blocks) and ISTAF 2024 (single service, every point). The console's own
 *    `serveTurn`/`serveOfTurn` compute it, so the board can never disagree
 *    with the umpire's console.
 * 2. RALLY. Badminton and volleyball give service to whoever won the last
 *    rally and ship with NO `serve` block. They are only shown once a point
 *    delta has attributed a rally (see `nextRallyServe`), and hidden again
 *    the moment attribution breaks.
 *
 * Otherwise null — hide it. A wrong serve arrow burned into a live broadcast
 * is worse than no arrow: an umpire or coach spots it instantly and it
 * discredits the whole scorebug.
 *
 * `firstServer` is who opened the match (0 home) for the rules path. The
 * board cannot know the toss — the console keeps it on the scorer's own phone
 * — so it defaults to home and an operator can flip it with `?server=away`.
 */
export function serveView(
  m: Pick<OverlayMatch, "set_scores">,
  scoring: OverlayScoring,
  firstServer: 0 | 1,
  rally: RallyServe | null,
): ServeView | null {
  const rows = m.set_scores ?? [];
  const rules = serveRulesOf(scoring, Math.max(rows.length, 1));
  const [h, a] = currentPoints(m);
  if (rules) {
    return {
      side: serveTurn(h, a, rules, firstServer),
      serveNo: serveOfTurn(h, a, rules),
      perTurn: Math.max(1, Math.floor(rules.serves_per_turn ?? 1)),
      source: "rules",
    };
  }
  if (rally && rally.side != null && rally.points[0] === h && rally.points[1] === a) {
    return { side: rally.side, serveNo: 1, perTurn: 1, source: "rally" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Flag pill
// ---------------------------------------------------------------------------

export type FlagKey =
  | "match_point"
  | "game_point"
  | "setting_up"
  | "change_ends";

export interface OverlayFlag {
  key: FlagKey;
  text: string;
}

/**
 * The one flag pill under the panel, chosen by descending priority.
 *
 * Every call is derived DETERMINISTICALLY from the running score and the
 * resolved rules — the overlay stays a dumb renderer and a browser hiccup can
 * never invent a match point. Anything not derivable from a score snapshot
 * (time-out, interval, suspension) is deliberately not built: we omit rather
 * than guess.
 */
export function flagFor(
  m: Pick<OverlayMatch, "set_scores">,
  scoring: OverlayScoring,
  periodTerm?: string,
): OverlayFlag | null {
  if (!scoring || (scoring.points ?? 0) <= 0) return null;
  const rows = rowsOf(m);
  if (rows.length === 0) return null;
  const prog = setProgress(rows, scoring, 3);
  if (prog.decided) return null;
  const [h, a] = currentPoints(m);
  const deciding = prog.setNo === prog.bestOf;
  const term = (periodTerm ?? t("Set")).toUpperCase();

  const gp = gamePointSide(h, a, scoring, deciding);
  if (gp != null) {
    const won = gp === 0 ? prog.homeSets : prog.awaySets;
    return won + 1 >= prog.need
      ? { key: "match_point", text: t("Match point").toUpperCase() }
      : { key: "game_point", text: `${term} ${t("point").toUpperCase()}` };
  }

  // "Setting up to N": a CAPPED game that has reached deuce, so the cap is
  // now what decides it (takraw 14-14 → 17). Read off the rules, so the
  // ISTAF-2024 preset says 17 and the legacy preset says 25 with no sport
  // check anywhere.
  const rule = setTargets(scoring, deciding);
  const at = rule.points - 1;
  if (rule.cap != null && at > 0 && h >= at && a >= at) {
    return { key: "setting_up", text: `${t("Setting up to")} ${rule.cap}` };
  }

  const serveRules = serveRulesOf(scoring, prog.setNo);
  if (
    serveRules &&
    changeEndsPrompt(prog.setNo, prog.bestOf, h, a, serveRules)
  ) {
    return { key: "change_ends", text: t("Change ends").toUpperCase() };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Out-of-order guard
// ---------------------------------------------------------------------------

/**
 * The version of a rendered board: the exact tuple the coordinator specified —
 * `(match_id, status, current_period, home_score, away_score, set_scores)` —
 * paired with the fetch time that produced it.
 *
 * WHY NOT A SEQUENCE NUMBER, and why NOT the score direction:
 *
 *  - `MatchEvent.sequence_no` would be the ideal version vector, but the live
 *    snapshot only carries the last 30 events and, decisively,
 *    `update_set_progress` (the live tap path for every target sport) writes
 *    `set_scores` directly with an AuditEvent and appends NO MatchEvent. A
 *    sequence guard would therefore freeze every volleyball/TT/takraw board
 *    after its first update. Revisit once the server exposes a max sequence
 *    that advances for set progress too.
 *  - Guarding on "the score went down" is actively WRONG. A score decrease is
 *    legitimate: it is a VOID correction, which is the entire reason this
 *    platform is event-sourced. A direction guard is precisely the bug that
 *    makes corrections invisible on air.
 *
 * So: a payload is applied when it DIFFERS from the applied one and was
 * fetched no earlier. Same-signature payloads are no-ops (no re-render churn,
 * no animation replay), and a stale replica answer that arrives after a newer
 * one is rejected on fetch time alone — in whichever direction the score moved.
 */
export interface BoardVersion {
  matchId: string;
  signature: string;
  fetchedAt: number;
}

export function boardVersion(m: OverlayMatch, fetchedAt: number): BoardVersion {
  return {
    matchId: m.id,
    signature: JSON.stringify([
      m.status,
      m.current_period ?? "",
      m.home_score,
      m.away_score,
      m.set_scores ?? [],
    ]),
    fetchedAt,
  };
}

/** Whether `next` should replace `applied` on screen. A different match
 * always wins (versions are per-match and do not compare across fixtures). */
export function shouldApply(
  applied: BoardVersion | null,
  next: BoardVersion,
): boolean {
  if (!applied || applied.matchId !== next.matchId) return true;
  if (applied.signature === next.signature) return false;
  return next.fetchedAt >= applied.fetchedAt;
}

// ---------------------------------------------------------------------------
// The six states
// ---------------------------------------------------------------------------

export type OverlayKind =
  | "idle"
  | "up-next"
  | "live"
  | "between-games"
  | "final"
  | "stale";

export interface OverlayStateInput<T extends OverlayMatch> {
  /** Already resolved for this court (the page passes a live match that has
   * been through the out-of-order guard). */
  picked: CourtMatches<T>;
  now: number;
  /** Milliseconds since the server last CONFIRMED what we are showing. */
  feedAgeMs: number;
  /** When the current final was first observed (null = none held). */
  finalSeenAt: number | null;
  /** Resolved rules for the focused match, when the snapshot has landed. */
  scoring: OverlayScoring;
}

export interface OverlayStateResult<T> {
  kind: OverlayKind;
  match: T | null;
  /** The game that just ended (between-games only). */
  lastGame: number[] | null;
  /** Where the feed sits on the degradation ladder. */
  feed: FeedLevel;
}

/**
 * Which of the six boards to render. Order matters: a live match always wins,
 * a dead feed never blanks it, and the result card holds for FINAL_HOLD_MS
 * before the court goes back to advertising what is next.
 */
export function selectOverlayState<T extends OverlayMatch>(
  input: OverlayStateInput<T>,
): OverlayStateResult<T> {
  const { picked, now, feedAgeMs, finalSeenAt, scoring } = input;
  const feed = feedLevel(feedAgeMs);

  if (picked.live) {
    // NEVER blank, NEVER 0-0: an old feed keeps the last known score on
    // screen behind an amber dot instead of falling back to another state.
    if (feed === "stale") {
      return { kind: "stale", match: picked.live, lastGame: null, feed };
    }
    if (isBetweenGames(picked.live, scoring)) {
      const rows = picked.live.set_scores ?? [];
      return {
        kind: "between-games",
        match: picked.live,
        lastGame: rows.length > 0 ? (rows[rows.length - 1] ?? null) : null,
        feed,
      };
    }
    return { kind: "live", match: picked.live, lastGame: null, feed };
  }
  if (picked.final && finalSeenAt != null && now - finalSeenAt < FINAL_HOLD_MS) {
    return { kind: "final", match: picked.final, lastGame: null, feed };
  }
  if (picked.next) {
    return { kind: "up-next", match: picked.next, lastGame: null, feed };
  }
  return { kind: "idle", match: null, lastGame: null, feed };
}

// ---------------------------------------------------------------------------
// Small display helpers
// ---------------------------------------------------------------------------

/** Broadcast name for a target-sport row: the short name when it is a real
 * abbreviation, otherwise the full name, ellipsised at the drawn width. A
 * one-character "short name" is a placeholder, not a broadcast label. */
export function sideLabel(
  side: OverlaySide | null | undefined,
  maxChars = 22,
): string {
  const short = (side?.short_name ?? "").trim();
  const full = (side?.name ?? "").trim();
  const pick = short.length >= 2 ? short : full || t("TBD");
  return pick.length > maxChars ? `${pick.slice(0, maxChars - 1)}…` : pick;
}

/** The side's badge URL, "" when it has none (or the side is still TBD).
 * `TeamCrest` turns an empty one into the team's initials, so a school with no
 * upload gets a legible tile rather than a hole in the row. */
export function sideCrest(side: OverlaySide | null | undefined): string {
  return (side?.crest ?? "").trim();
}

/** Broadcast code for a timed-sport row: the curated short name, else the
 * initials of a three-word club name, else the first three letters. */
export function sideCode(side: OverlaySide | null | undefined): string {
  const short = (side?.short_name ?? "").trim();
  if (short.length >= 2) return short.slice(0, 4).toUpperCase();
  const full = (side?.name ?? "").trim();
  if (!full) return t("TBD");
  const words = full.split(/\s+/).filter(Boolean);
  if (words.length >= 3) {
    return words
      .map((w) => w[0] ?? "")
      .join("")
      .slice(0, 3)
      .toUpperCase();
  }
  return full.slice(0, 3).toUpperCase();
}

/**
 * How far this browser's clock is AHEAD of (negative) or BEHIND (positive)
 * the server's, from a snapshot that carries `server_time`. A volunteer
 * laptop or a rented broadcast box is routinely minutes off; without this the
 * match clock would go on air wrong. Zero when the server does not say.
 */
export function clockSkewMs(
  serverTime: string | null | undefined,
  receivedAt: number,
): number {
  if (!serverTime || !(receivedAt > 0)) return 0;
  const s = new Date(serverTime).getTime();
  if (!Number.isFinite(s)) return 0;
  return s - receivedAt;
}

/** Whole seconds since kickoff on the SERVER's clock, or null when there is
 * no usable stamp. */
export function elapsedSeconds(
  startedAt: string | null | undefined,
  now: number,
  skewMs = 0,
): number | null {
  if (!startedAt) return null;
  const s = Math.floor((now + skewMs - new Date(startedAt).getTime()) / 1000);
  return Number.isFinite(s) && s >= 0 ? s : null;
}

/** mm:ss, h:mm:ss past the hour. A forgotten "live" match gets a compact
 * figure instead of a wall of digits (same rule as the scorer console). */
export function fmtClock(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h >= 100) return `${h}h`;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** `?scale=` is operator input pasted into OBS; clamp it so a typo cannot
 * blow the graphic off the canvas or shrink it to nothing. All geometry is
 * authored at 1920x1080, so 1280x720 is `?scale=0.667`. */
export function parseScale(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(4, Math.max(0.4, n));
}

/** `?side=left|right` — the anchor corner the operator asked for, or null for
 * "let the sport decide". Anything unrecognised is null, never an error: this
 * is a URL somebody may have retyped. */
export function parseSide(raw: string | null): "left" | "right" | null {
  return raw === "left" || raw === "right" ? raw : null;
}

/** `?server=away` — which side opened the match, for the rules-derived serve
 * indicator. Home (0) is the default because the board cannot know the toss. */
export function parseFirstServer(raw: string | null): 0 | 1 {
  return raw === "away" ? 1 : 0;
}

/** Where the panel sits. Football's bug is centred unless the operator says
 * otherwise; a target board defaults to the top-left corner. Shared by every
 * broadcast surface so a court looks the same however it is being filmed. */
export function boardAnchor(
  side: "left" | "right" | null,
  family: "timed" | "target",
): "left" | "right" | "center" {
  if (side) return side;
  return family === "timed" ? "center" : "left";
}

// ---------------------------------------------------------------------------
// Cold-start cache
// ---------------------------------------------------------------------------

/**
 * The last board this court rendered, kept in `localStorage` so an OBS
 * restart (or a browser-source reload) paints the known score immediately
 * instead of a blank frame or a 0-0. A blank bug reads to viewers as a broken
 * stream, which is the failure this exists to prevent.
 *
 * Deliberately NOT cached: serve state. A guessed serve arrow restored from
 * disk is a confident wrong answer; the rally tracker starts from unknown.
 */
export interface OverlayCache {
  v: 2;
  court: string;
  savedAt: number;
  kind: OverlayKind;
  match: OverlayMatch;
  family: "timed" | "target";
  scoring: OverlayScoring;
  periodTerm?: string;
  startedAt: string | null;
  tournamentName: string;
}

/** Older than this and the cache is worse than idle — yesterday's score on a
 * morning stream is a bug the operator will not spot. */
export const CACHE_MAX_AGE_MS = 6 * 60 * 60_000;

const cacheKey = (court: string): string =>
  `fixture.overlay.v2.${normalizeCourt(court)}`;

export function readOverlayCache(court: string, now: number): OverlayCache | null {
  try {
    const raw = localStorage.getItem(cacheKey(court));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OverlayCache;
    if (parsed?.v !== 2 || normalizeCourt(parsed.court) !== normalizeCourt(court)) {
      return null;
    }
    if (!(now - parsed.savedAt < CACHE_MAX_AGE_MS)) return null;
    return parsed;
  } catch {
    // Storage blocked or corrupt — the board simply starts from the network.
    return null;
  }
}

export function writeOverlayCache(cache: OverlayCache): void {
  try {
    localStorage.setItem(cacheKey(cache.court), JSON.stringify(cache));
  } catch {
    // Quota or private mode: the overlay works, it just cold-starts blank.
  }
}
