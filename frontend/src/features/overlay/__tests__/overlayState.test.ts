import { describe, expect, it } from "vitest";
import {
  boardVersion,
  feedLevel,
  flagFor,
  gameView,
  isBetweenGames,
  matchesOnCourt,
  maxScoreDigits,
  nextRallyServe,
  panelGeometry,
  parseScale,
  pickCourtMatches,
  selectOverlayState,
  serveView,
  shouldApply,
  sideCode,
  sideLabel,
  type OverlayMatch,
  type OverlayScoring,
} from "../overlayState";

// Resolved rules exactly as the backend's SportDefinition registry ships
// them. The overlay never names a sport — every difference below is a
// difference in the RULES.
const TT: OverlayScoring = {
  best_of: 3,
  points: 11,
  win_by: 2,
  cap: null,
  serve: { serves_per_turn: 2, alternate_every_point: true },
};
const SEPAK_LEGACY: OverlayScoring = {
  best_of: 3,
  points: 21,
  win_by: 2,
  cap: 25,
  deciding: { points: 15, win_by: 2, cap: 17 },
  serve: {
    serves_per_turn: 3,
    alternate_every_point: false,
    change_ends_at: { regular: 11, deciding: 8 },
  },
};
const SEPAK_2024: OverlayScoring = {
  best_of: 3,
  points: 15,
  win_by: 2,
  cap: 17,
  deciding: { points: 15, win_by: 2, cap: 17 },
  serve: {
    serves_per_turn: 1,
    alternate_every_point: true,
    change_ends_at: { deciding: 8 },
  },
};
/** Rally-scored: no `serve` block at all. */
const VOLLEYBALL: OverlayScoring = {
  best_of: 5,
  points: 25,
  win_by: 2,
  cap: null,
  deciding: { points: 15, win_by: 2, cap: null },
};
const BADMINTON: OverlayScoring = {
  best_of: 3,
  points: 21,
  win_by: 2,
  cap: 30,
  deciding: { points: 21, win_by: 2, cap: 30 },
};

function match(over: Partial<OverlayMatch> = {}): OverlayMatch {
  return {
    id: "m1",
    status: "live",
    venue: "Court 1",
    scheduled_at: "2026-08-03T04:00:00Z",
    home: { id: "h", name: "Alpha School", short_name: "ALP" },
    away: { id: "a", name: "Bravo School", short_name: "BRA" },
    home_score: 0,
    away_score: 0,
    set_scores: [],
    current_period: "game_1",
    leaf_label: "Table Tennis · U-16 · Boys",
    ...over,
  };
}

describe("court lookup", () => {
  it("filters to one court and tolerates spreadsheet whitespace/case", () => {
    const all = [
      match({ id: "a", venue: "Court2 · T3" }),
      match({ id: "b", venue: "Court 1" }),
      match({ id: "c", venue: " court2 · T3 " }),
    ];
    expect(matchesOnCourt(all, "Court2 · T3").map((m) => m.id)).toEqual([
      "a",
      "c",
    ]);
    expect(matchesOnCourt(all, "Court 1").map((m) => m.id)).toEqual(["b"]);
    expect(matchesOnCourt(all, "Court 9")).toEqual([]);
  });

  it("picks THIS court's live match when several courts are live at once", () => {
    const all = [
      match({ id: "c1-live", venue: "Court 1", status: "live" }),
      match({ id: "c2-live", venue: "Court 2", status: "live" }),
      match({ id: "c3-live", venue: "Court 3", status: "live" }),
      match({ id: "c2-next", venue: "Court 2", status: "scheduled",
        scheduled_at: "2026-08-03T06:00:00Z" }),
      match({ id: "c2-done", venue: "Court 2", status: "completed",
        scheduled_at: "2026-08-03T02:00:00Z" }),
      match({ id: "c1-next", venue: "Court 1", status: "scheduled",
        scheduled_at: "2026-08-03T05:00:00Z" }),
    ];
    const picked = pickCourtMatches(all, "Court 2");
    expect(picked.live?.id).toBe("c2-live");
    expect(picked.next?.id).toBe("c2-next");
    expect(picked.final?.id).toBe("c2-done");
  });

  it("takes the earliest scheduled slot as up-next and the latest result as final", () => {
    const all = [
      match({ id: "late", venue: "C", status: "scheduled",
        scheduled_at: "2026-08-03T09:00:00Z" }),
      match({ id: "early", venue: "C", status: "scheduled",
        scheduled_at: "2026-08-03T07:00:00Z" }),
      match({ id: "old", venue: "C", status: "completed",
        scheduled_at: "2026-08-03T01:00:00Z" }),
      match({ id: "recent", venue: "C", status: "walkover",
        scheduled_at: "2026-08-03T05:00:00Z" }),
    ];
    const picked = pickCourtMatches(all, "C");
    expect(picked.next?.id).toBe("early");
    expect(picked.final?.id).toBe("recent");
    expect(picked.live).toBeNull();
  });
});

describe("selectOverlayState — the six boards", () => {
  const base = { now: 1_000_000, feedAgeMs: 0, finalSeenAt: null, scoring: TT };

  it("idle when the court has nothing", () => {
    const s = selectOverlayState({
      ...base,
      picked: { live: null, final: null, next: null },
    });
    expect(s.kind).toBe("idle");
    expect(s.match).toBeNull();
  });

  it("up-next when only a scheduled match remains", () => {
    const next = match({ id: "n", status: "scheduled" });
    const s = selectOverlayState({
      ...base,
      picked: { live: null, final: null, next },
    });
    expect(s.kind).toBe("up-next");
    expect(s.match?.id).toBe("n");
  });

  it("live while a match is in play", () => {
    const live = match({ set_scores: [[7, 5]] });
    const s = selectOverlayState({
      ...base,
      picked: { live, final: null, next: null },
    });
    expect(s.kind).toBe("live");
  });

  it("between-games once the game on the table is legally won", () => {
    const live = match({ set_scores: [[11, 7]], home_score: 1, away_score: 0 });
    const s = selectOverlayState({
      ...base,
      picked: { live, final: null, next: null },
    });
    expect(s.kind).toBe("between-games");
    expect(s.lastGame).toEqual([11, 7]);
  });

  it("stays LIVE at match point — a decided match is not between-games", () => {
    const live = match({
      set_scores: [[11, 7], [11, 5]],
      home_score: 2,
      away_score: 0,
    });
    const s = selectOverlayState({
      ...base,
      picked: { live, final: null, next: null },
    });
    expect(s.kind).toBe("live");
  });

  it("holds the result card for the final beat, then falls through to up-next", () => {
    const final = match({ id: "f", status: "completed", home_score: 3, away_score: 1 });
    const next = match({ id: "n", status: "scheduled" });
    const held = selectOverlayState({
      ...base,
      picked: { live: null, final, next },
      finalSeenAt: base.now - 30_000,
    });
    expect(held.kind).toBe("final");
    const expired = selectOverlayState({
      ...base,
      picked: { live: null, final, next },
      finalSeenAt: base.now - 61_000,
    });
    expect(expired.kind).toBe("up-next");
  });

  it("goes stale — never blank, never 0-0 — when the feed ages out", () => {
    const live = match({ set_scores: [[17, 14]] });
    const s = selectOverlayState({
      ...base,
      picked: { live, final: null, next: null },
      feedAgeMs: 25_000,
    });
    expect(s.kind).toBe("stale");
    // The last known score is still the thing being rendered.
    expect(s.match?.set_scores).toEqual([[17, 14]]);
    expect(s.feed).toBe("stale");
  });

  it("walks the degradation ladder: fresh -> quiet -> stale", () => {
    expect(feedLevel(0)).toBe("fresh");
    expect(feedLevel(4_999)).toBe("fresh");
    expect(feedLevel(5_000)).toBe("quiet");
    expect(feedLevel(19_999)).toBe("quiet");
    expect(feedLevel(20_000)).toBe("stale");
    // A quiet feed keeps the LIVE board (score on screen), it just stops
    // claiming the dot.
    const live = match({ set_scores: [[9, 9]] });
    const s = selectOverlayState({
      ...base,
      picked: { live, final: null, next: null },
      feedAgeMs: 9_000,
    });
    expect(s.kind).toBe("live");
    expect(s.feed).toBe("quiet");
  });

  it("never reads a finished game as between-games without resolved rules", () => {
    const live = match({ set_scores: [[11, 7]] });
    expect(isBetweenGames(live, null)).toBe(false);
    const s = selectOverlayState({
      ...base,
      picked: { live, final: null, next: null },
      scoring: null,
    });
    expect(s.kind).toBe("live");
  });
});

describe("serve indicator", () => {
  it("derives table tennis from the score (2-serve blocks)", () => {
    // 4-3 = 7 points played, blocks of 2 -> 4th block -> away serves, 2nd of 2.
    const v = serveView(match({ set_scores: [[4, 3]] }), TT, 0, null);
    expect(v).toEqual({ side: 1, serveNo: 2, perTurn: 2, source: "rules" });
    // At 10-10 ITTF alternates every point.
    expect(serveView(match({ set_scores: [[10, 10]] }), TT, 0, null)?.serveNo).toBe(1);
    // The opening server flips the whole rotation.
    expect(serveView(match({ set_scores: [[4, 3]] }), TT, 1, null)?.side).toBe(0);
  });

  it("derives sepak takraw from the score (3-serve blocks, legacy)", () => {
    // 5-2 = 7 points, blocks of 3 -> 3rd block -> home serves, 2nd of 3.
    const v = serveView(match({ set_scores: [[5, 2]] }), SEPAK_LEGACY, 0, null);
    expect(v).toEqual({ side: 0, serveNo: 2, perTurn: 3, source: "rules" });
    // 3-0: still inside the opening block.
    expect(serveView(match({ set_scores: [[3, 0]] }), SEPAK_LEGACY, 0, null)).toEqual({
      side: 1, serveNo: 1, perTurn: 3, source: "rules",
    });
  });

  it("derives ISTAF-2024 takraw (single service, alternating every point)", () => {
    expect(serveView(match({ set_scores: [[0, 0]] }), SEPAK_2024, 0, null)?.side).toBe(0);
    expect(serveView(match({ set_scores: [[1, 0]] }), SEPAK_2024, 0, null)?.side).toBe(1);
    expect(serveView(match({ set_scores: [[1, 1]] }), SEPAK_2024, 0, null)?.side).toBe(0);
  });

  it("HIDES serve for rally-scored sports on a cold start", () => {
    // Badminton and volleyball give service to whoever won the last rally,
    // which a snapshot cannot know. A wrong arrow on air is worse than none.
    expect(serveView(match({ set_scores: [[12, 9]] }), BADMINTON, 0, null)).toBeNull();
    expect(serveView(match({ set_scores: [[18, 20]] }), VOLLEYBALL, 0, null)).toBeNull();
  });

  it("shows rally-scored serve only once a one-point delta attributes it", () => {
    let rally = nextRallyServe(null, "m1", [12, 9]);
    expect(rally.side).toBeNull(); // cold start: unknown
    expect(serveView(match({ set_scores: [[12, 9]] }), BADMINTON, 0, rally)).toBeNull();

    rally = nextRallyServe(rally, "m1", [13, 9]); // home won the rally
    expect(serveView(match({ set_scores: [[13, 9]] }), BADMINTON, 0, rally)).toEqual({
      side: 0, serveNo: 1, perTurn: 1, source: "rally",
    });

    rally = nextRallyServe(rally, "m1", [13, 10]); // away won the rally
    expect(serveView(match({ set_scores: [[13, 10]] }), BADMINTON, 0, rally)?.side).toBe(1);
  });

  it("drops back to unknown after a gap, a reset or a correction", () => {
    const known = nextRallyServe(
      nextRallyServe(null, "m1", [5, 5]),
      "m1",
      [6, 5],
    );
    expect(known.side).toBe(0);
    // Two points at once (a missed poll) is unattributable.
    expect(nextRallyServe(known, "m1", [8, 5]).side).toBeNull();
    // A new game resetting to 0-0 is unattributable.
    expect(nextRallyServe(known, "m1", [0, 0]).side).toBeNull();
    // A correction that lowers the score is unattributable.
    expect(nextRallyServe(known, "m1", [5, 5]).side).toBeNull();
    // A different match never inherits the previous one's state.
    expect(nextRallyServe(known, "m2", [6, 5]).side).toBeNull();
    // No change at all keeps what we knew.
    expect(nextRallyServe(known, "m1", [6, 5]).side).toBe(0);
  });
});

describe("flag pill", () => {
  it("calls game point, then match point, from the rules", () => {
    expect(flagFor(match({ set_scores: [[10, 8]] }), TT, "Game")).toEqual({
      key: "game_point",
      text: "GAME POINT",
    });
    // One game up in a best-of-3: the next point takes the match.
    const decider = match({ set_scores: [[11, 5], [10, 8]] });
    expect(flagFor(decider, TT, "Game")?.key).toBe("match_point");
  });

  it("calls 'setting up to N' off the resolved cap, not a hardcoded number", () => {
    expect(flagFor(match({ set_scores: [[14, 14]] }), SEPAK_2024, "Set")).toEqual({
      key: "setting_up",
      text: "Setting up to 17",
    });
    // The legacy regime sets to a different number, from the same code path.
    expect(flagFor(match({ set_scores: [[20, 20]] }), SEPAK_LEGACY, "Set")?.text).toBe(
      "Setting up to 25",
    );
  });

  it("calls change ends at the rule's trigger", () => {
    expect(flagFor(match({ set_scores: [[11, 5]] }), SEPAK_LEGACY, "Set")).toEqual({
      key: "change_ends",
      text: "CHANGE ENDS",
    });
  });

  it("shows nothing when the rules are unknown or the match is decided", () => {
    expect(flagFor(match({ set_scores: [[10, 8]] }), null, "Game")).toBeNull();
    expect(flagFor(match({ set_scores: [] }), TT, "Game")).toBeNull();
    const done = match({ set_scores: [[11, 5], [11, 6]] });
    expect(flagFor(done, TT, "Game")).toBeNull();
  });
});

describe("out-of-order guard", () => {
  const m = match({ set_scores: [[7, 5]], home_score: 0, away_score: 0 });

  it("ignores a payload that resolved after a newer one", () => {
    const applied = boardVersion(m, 2_000);
    const older = boardVersion(match({ set_scores: [[6, 5]] }), 1_000);
    expect(shouldApply(applied, older)).toBe(false);
  });

  it("is a no-op for an identical payload (no repaint, no animation replay)", () => {
    const applied = boardVersion(m, 2_000);
    expect(shouldApply(applied, boardVersion(m, 3_000))).toBe(false);
  });

  it("APPLIES a score that goes down — that is a VOID correction, not staleness", () => {
    // The platform is event-sourced precisely so corrections exist. Guarding
    // on score direction is the bug that makes them invisible on air.
    const applied = boardVersion(m, 2_000);
    const corrected = boardVersion(match({ set_scores: [[6, 5]] }), 3_000);
    expect(shouldApply(applied, corrected)).toBe(true);
  });

  it("always applies a different match (versions do not compare across fixtures)", () => {
    const applied = boardVersion(m, 9_000);
    const other = boardVersion(match({ id: "m2", set_scores: [[0, 0]] }), 1_000);
    expect(shouldApply(applied, other)).toBe(true);
    expect(shouldApply(null, other)).toBe(true);
  });

  it("treats a status change as a change even at an identical score", () => {
    const applied = boardVersion(m, 1_000);
    const completed = boardVersion(
      match({ set_scores: [[7, 5]], status: "completed" }),
      2_000,
    );
    expect(shouldApply(applied, completed)).toBe(true);
  });
});

describe("panel geometry", () => {
  it("is the canonical 820 x 162 board for a best-of-5, 2-digit rule", () => {
    const geo = panelGeometry(VOLLEYBALL);
    expect(geo.slots).toBe(5);
    expect(geo.historyPx).toBe(240);
    expect(geo.pointsPx).toBe(94);
    expect(geo.widthPx).toBe(820);
  });

  it("grows the history column with best_of, never with a sport key", () => {
    expect(panelGeometry({ ...TT, best_of: 7 }).slots).toBe(7);
    expect(panelGeometry(TT).slots).toBe(3);
    expect(panelGeometry({ ...TT, best_of: 7 }).widthPx).toBeGreaterThan(
      panelGeometry(TT).widthPx,
    );
  });

  it("sizes the points column from the resolved cap/points (BWF 2027 safe)", () => {
    expect(maxScoreDigits(BADMINTON)).toBe(2); // 21 cap 30
    // BWF from 2027-01-04: games of 15, cap 21. Nothing hardcoded breaks.
    expect(maxScoreDigits({ best_of: 3, points: 15, win_by: 2, cap: 21 })).toBe(2);
    expect(maxScoreDigits(TT)).toBe(2); // 11 uncapped -> budget 22
    expect(maxScoreDigits({ best_of: 3, points: 100, win_by: 2, cap: 120 })).toBe(3);
    expect(maxScoreDigits(null)).toBe(2);
  });
});

describe("display helpers", () => {
  it("prefers a real short name and ellipsises an over-long one", () => {
    expect(sideLabel({ name: "Alpha School", short_name: "ALP" })).toBe("ALP");
    // A one-character 'short name' is a placeholder, not a broadcast label.
    expect(sideLabel({ name: "Alpha School", short_name: "A" })).toBe("Alpha School");
    // 22 drawn characters, the last of them the ellipsis.
    expect(sideLabel({ name: "A Very Long Institution Name Indeed" })).toBe(
      "A Very Long Instituti…",
    );
    expect(sideLabel(null)).toBe("TBD");
  });

  it("makes a compact code for the timed board", () => {
    expect(sideCode({ name: "Alpha School", short_name: "ALP" })).toBe("ALP");
    expect(sideCode({ name: "Government High School" })).toBe("GHS");
    expect(sideCode({ name: "Alpha" })).toBe("ALP");
  });

  it("reads the running game off set_scores", () => {
    const gv = gameView(
      match({ set_scores: [[11, 7], [9, 11], [4, 2]], home_score: 1, away_score: 1 }),
    );
    expect(gv.points).toEqual([4, 2]);
    expect(gv.history).toEqual([[11, 7], [9, 11]]);
    expect(gv.games).toEqual([1, 1]);
    expect(gv.gameNo).toBe(3);
  });

  it("clamps an operator's ?scale typo instead of losing the graphic", () => {
    expect(parseScale(null)).toBe(1);
    expect(parseScale("0.667")).toBeCloseTo(0.667);
    expect(parseScale("abc")).toBe(1);
    expect(parseScale("-3")).toBe(1);
    expect(parseScale("900")).toBe(4);
    expect(parseScale("0.01")).toBe(0.4);
  });
});
