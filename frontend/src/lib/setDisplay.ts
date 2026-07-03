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
