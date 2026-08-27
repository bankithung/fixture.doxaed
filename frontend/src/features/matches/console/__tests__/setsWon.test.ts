import { describe, expect, it } from "vitest";
import { setsWon, setProgress, winningScore } from "../shared";
import type { SetRow, SetScoring } from "../shared";

const TT: SetScoring = { best_of: 5, points: 11, win_by: 2, cap: null };
const SEPAK: SetScoring = {
  best_of: 3, points: 15, win_by: 2, cap: 17,
  deciding: { points: 15, win_by: 2, cap: 17 },
};

describe("a side that has not scored yet is 0, not unknown", () => {
  // The console writes only the side that was tapped, so the other cell stays
  // "". setsWon used to skip the whole row on ONE blank cell, so a game at
  // 11-0 was never seen as won: the between-games lock never armed and the
  // scorer could tap on for ever (owner 2026-08-27, seen live at 32-0).
  it("counts a whitewash game as won", () => {
    expect(setsWon([["11", ""]] as SetRow[], TT)).toEqual([1, 0]);
    expect(setsWon([["", "11"]] as SetRow[], TT)).toEqual([0, 1]);
    expect(setsWon([["15", ""]] as SetRow[], SEPAK)).toEqual([1, 0]);
  });

  it("locks the board the moment a whitewash game is won", () => {
    // setNo stays 1 and the game counts, which is what arms `awaitingNext`
    const p = setProgress([["11", ""]] as SetRow[], TT, 5);
    expect(p.homeSets).toBe(1);
    expect(p.decided).toBe(false); // best of 5 -> still needs 3
  });

  it("still treats a completely untouched row as not played", () => {
    expect(setsWon([["", ""]] as SetRow[], TT)).toEqual([0, 0]);
    expect(setsWon([["11", "9"], ["", ""]] as SetRow[], TT)).toEqual([1, 0]);
  });

  it("does not award a game that is still being played", () => {
    expect(setsWon([["10", ""]] as SetRow[], TT)).toEqual([0, 0]);
    expect(setsWon([["11", "10"]] as SetRow[], TT)).toEqual([0, 0]); // deuce
    expect(setsWon([["14", ""]] as SetRow[], SEPAK)).toEqual([0, 0]);
    expect(setsWon([["16", "15"]] as SetRow[], SEPAK)).toEqual([0, 0]);
  });
});

describe("winningScore mirrors the server ceiling", () => {
  it("table tennis: 11, or two clear once past 9", () => {
    expect(winningScore(0, 11, 2, null)).toBe(11);
    expect(winningScore(9, 11, 2, null)).toBe(11);
    expect(winningScore(10, 11, 2, null)).toBe(12);
    expect(winningScore(11, 11, 2, null)).toBe(13);
    expect(winningScore(28, 11, 2, null)).toBe(30);
  });

  it("sepak: 15, two clear past 13, never above the 17 ceiling", () => {
    expect(winningScore(0, 15, 2, 17)).toBe(15);
    expect(winningScore(13, 15, 2, 17)).toBe(15);
    expect(winningScore(14, 15, 2, 17)).toBe(16);
    expect(winningScore(15, 15, 2, 17)).toBe(17);
    expect(winningScore(16, 15, 2, 17)).toBe(17);
  });

  it("is unbounded when the rules are unknown", () => {
    expect(winningScore(5, 0, 2, null)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("a whitewash game survives the whole pipeline", () => {
  // 11-0, 0-11, 11-0, 0-11, 11-0 reached the server as ONE game, because the
  // recorder dropped every row with a blank cell, and came back as "the games
  // do not match the best-of rule" (owner 2026-08-27).
  const played = (rows: SetRow[]) =>
    rows
      .filter(([h, a]) => h !== "" || a !== "")
      .map(([h, a]) => [Number(h || 0), Number(a || 0)]);

  it("keeps every played game in the recorded payload", () => {
    const rows: SetRow[] = [
      ["11", "0"], ["", "11"], ["11", ""], ["", "11"], ["11", ""],
    ];
    expect(played(rows)).toEqual([
      [11, 0], [0, 11], [11, 0], [0, 11], [11, 0],
    ]);
    expect(setsWon(rows, TT)).toEqual([3, 2]);
  });

  it("still drops rows that were never played", () => {
    const rows: SetRow[] = [["11", "0"], ["11", "2"], ["11", "5"], ["", ""], ["", ""]];
    expect(played(rows)).toEqual([[11, 0], [11, 2], [11, 5]]);
    expect(setsWon(rows, TT)).toEqual([3, 0]);
  });
});
