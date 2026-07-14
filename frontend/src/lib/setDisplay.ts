/** Shared live display logic for set sports (owner 2026-07-03).
 *
 * While a set-sport match is in play the HEADLINE score is the current set's
 * running points (that is what spectators watch move); sets won stay a
 * secondary "Sets h-a" line, and the running period reads "Set N". Football
 * period labels ("first half") never describe a set sport. Once a match is
 * final, home/away_score (sets won) become the headline again.
 */

export interface SetScoreish {
  status: string;
  /** Sport key; "" or missing = goal-based (football). */
  sport?: string | null;
  home_score?: number | null;
  away_score?: number | null;
  set_scores?: number[][] | null;
  /** Written once at kickoff (the sport's opening period) and advanced only by
   * football's half logic — for a set sport it stays "game_1" all match, so it
   * is NEVER the source of the running set number. See `livePeriodLabel`. */
  current_period?: string | null;
}

const IN_PLAY = new Set(["live", "half_time"]);

export function isSetSport(m: Pick<SetScoreish, "sport">): boolean {
  return Boolean(m.sport) && m.sport !== "football";
}

export interface LiveSetView {
  /** The running set's points — the headline score while in play. */
  points: [number, number];
  /** Completed sets, for the small chips. */
  finished: number[][];
  /** Sets won so far (the server mirrors these into home/away_score). */
  sets: [number, number];
  /** 1-based number of the set in play. */
  setNo: number;
}

/**
 * The period a live match is actually in — "game 2", "set 3", "first half".
 *
 * A set sport's running period is derived from `set_scores` (the same source
 * the scoring console counts games from), NEVER from `current_period`: that
 * column is written once at kickoff and only football's half logic advances it,
 * so starting game 2 left the board's pill reading "game 1" all match. Football
 * has no sets, so it still falls back to `current_period`.
 *
 * `term` is the sport's own word for a period ("Game" for table tennis) when the
 * caller has `sport_meta`; otherwise the noun is taken from `current_period`
 * ("game_1" → "game") so the wording stays the sport's own either way.
 */
export function livePeriodLabel(m: SetScoreish, term?: string): string | null {
  const view = liveSetView(m);
  const raw = m.current_period ?? "";
  if (view) {
    const noun = term || raw.replace(/_\d+$/, "").replace(/_/g, " ") || "set";
    return `${noun} ${view.setNo}`;
  }
  return raw ? raw.replace(/_/g, " ") : null;
}

/** Non-null exactly when a set-sport match is in play. */
export function liveSetView(m: SetScoreish): LiveSetView | null {
  if (!IN_PLAY.has(m.status) || !isSetSport(m)) return null;
  const rows = m.set_scores ?? [];
  const cur = rows.length > 0 ? rows[rows.length - 1] : [0, 0];
  return {
    points: [cur?.[0] ?? 0, cur?.[1] ?? 0],
    finished: rows.slice(0, -1),
    sets: [m.home_score ?? 0, m.away_score ?? 0],
    setNo: Math.max(rows.length, 1),
  };
}
