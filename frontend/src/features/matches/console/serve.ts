// Pure serve and change-ends derivations for the native set-sport consoles
// (P2: sepak takraw, table tennis). Everything is a function of the CURRENT
// set score plus the resolved `scoring.serve` rules, so the indicator can
// never drift from the score, even after corrections.

export interface ServeRules {
  /** Serves one side takes before service passes (sepak legacy 3, TT 2). */
  serves_per_turn?: number;
  /** ITTF deuce rule: once both sides reach target minus 1, service
   * alternates every point (Law 2.13.3). */
  alternate_every_point?: boolean;
  /** The set target (`scoring.points`) — anchors the deuce threshold at
   * target minus 1 (10 in an 11-point game). */
  points?: number;
  change_ends_at?: { regular?: number; deciding?: number } | null;
}

function perTurnOf(serve: ServeRules): number {
  const n = Math.floor(serve.serves_per_turn ?? 1);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function deuceAt(serve: ServeRules): number {
  const target = Math.floor(serve.points ?? 11);
  return Math.max(1, target - 1);
}

function inDeuce(homePts: number, awayPts: number, serve: ServeRules): boolean {
  const at = deuceAt(serve);
  return Boolean(serve.alternate_every_point) && homePts >= at && awayPts >= at;
}

/** Which side (0 home, 1 away) serves the CURRENT rally.
 *
 * Blocks of `serves_per_turn` alternate starting with `firstServer`. When
 * `alternate_every_point` and both sides have reached target minus 1
 * (deuce), service alternates every point from that moment: the turns
 * before deuce count normally, then each further point adds a turn. With
 * `alternate_every_point` false (sepak legacy) the block rotation applies
 * throughout, deuce or not. */
export function serveTurn(
  homePts: number,
  awayPts: number,
  serve: ServeRules,
  firstServer: 0 | 1,
): 0 | 1 {
  const perTurn = perTurnOf(serve);
  const total = Math.max(0, homePts) + Math.max(0, awayPts);
  if (inDeuce(homePts, awayPts, serve)) {
    const preDeucePoints = deuceAt(serve) * 2;
    const turnsBefore = Math.floor(preDeucePoints / perTurn);
    const after = total - preDeucePoints;
    return ((firstServer + turnsBefore + after) % 2) as 0 | 1;
  }
  return ((firstServer + Math.floor(total / perTurn)) % 2) as 0 | 1;
}

/** 1-based position within the current service turn ("Serve N of M").
 * Once every-point alternation kicks in (deuce), each turn is one serve. */
export function serveOfTurn(
  homePts: number,
  awayPts: number,
  serve: ServeRules,
): number {
  if (inDeuce(homePts, awayPts, serve)) return 1;
  const total = Math.max(0, homePts) + Math.max(0, awayPts);
  return (total % perTurnOf(serve)) + 1;
}

/** True exactly when a side FIRST reaches the change-ends trigger:
 * `change_ends_at.regular` in a non-deciding set, `change_ends_at.deciding`
 * in the deciding set (`setNo === bestOf`). The leader must sit exactly ON
 * the trigger with the other side still below it, so the prompt fires once
 * at the moment of reaching and not again at level scores. */
export function changeEndsPrompt(
  setNo: number,
  bestOf: number,
  homePts: number,
  awayPts: number,
  serve: ServeRules,
): boolean {
  const at =
    setNo === bestOf
      ? serve.change_ends_at?.deciding
      : serve.change_ends_at?.regular;
  if (at == null || at <= 0) return false;
  const hi = Math.max(homePts, awayPts);
  const lo = Math.min(homePts, awayPts);
  return hi === at && lo < at;
}
