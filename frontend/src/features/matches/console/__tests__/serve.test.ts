import { describe, it, expect } from "vitest";
import {
  changeEndsPrompt,
  serveOfTurn,
  serveTurn,
  type ServeRules,
} from "../serve";

// ITTF: two serves a turn, every point from 10 all (target 11 so the deuce
// threshold is points minus 1, never a literal 10).
const TT: ServeRules = {
  serves_per_turn: 2,
  alternate_every_point: true,
  points: 11,
  change_ends_at: { deciding: 5 },
};

// Sepak legacy: blocks of three serves, rotation NEVER collapses to
// every-point, even deep in a deuce.
const SEPAK: ServeRules = {
  serves_per_turn: 3,
  alternate_every_point: false,
  points: 21,
  change_ends_at: { regular: 11, deciding: 8 },
};

describe("serveTurn", () => {
  it.each<[number, number, 0 | 1]>([
    // Pre-deuce: floor(total/2) blocks starting with the first server.
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [2, 0, 1],
    [1, 1, 1],
    [0, 2, 1],
    [2, 1, 1],
    [3, 1, 0], // total 4 -> third block -> back to the first server
    [2, 2, 0],
    [4, 1, 0],
    [4, 2, 1],
    [3, 3, 1],
    [9, 9, 1], // total 18, not yet 10 all
    [10, 9, 1], // one side at 10 is NOT deuce
    [9, 10, 1],
    // From 10 all (points-1 each): service alternates every point.
    [10, 10, 0],
    [11, 10, 1],
    [10, 11, 1],
    [11, 11, 0],
    [12, 11, 1],
    [11, 12, 1],
    [12, 12, 0],
  ])("TT %i-%i is served by side %i", (h, a, want) => {
    expect(serveTurn(h, a, TT, 0)).toBe(want);
  });

  it("TT respects the first server", () => {
    expect(serveTurn(0, 0, TT, 1)).toBe(1);
    expect(serveTurn(2, 0, TT, 1)).toBe(0);
    expect(serveTurn(10, 10, TT, 1)).toBe(1);
    expect(serveTurn(11, 10, TT, 1)).toBe(0);
  });

  it.each<[number, number, 0 | 1]>([
    // Blocks of three: totals 0-2 first server, 3-5 the other, 6-8 back.
    [0, 0, 0],
    [1, 0, 0],
    [2, 0, 0],
    [2, 1, 1],
    [3, 1, 1],
    [3, 2, 1],
    [4, 2, 0],
    [5, 2, 0],
    [4, 4, 0],
    [5, 4, 1], // total 9 opens the fourth block
    // Sepak legacy never switches to every-point rotation at deuce.
    [20, 20, 1], // total 40 -> block 13 -> odd
    [21, 20, 1],
    [21, 21, 0], // total 42 -> block 14 -> even
  ])("sepak %i-%i is served by side %i", (h, a, want) => {
    expect(serveTurn(h, a, SEPAK, 0)).toBe(want);
  });

  it("defaults to one serve per turn when the config is empty", () => {
    expect(serveTurn(0, 0, {}, 0)).toBe(0);
    expect(serveTurn(1, 0, {}, 0)).toBe(1);
    expect(serveTurn(1, 1, {}, 0)).toBe(0);
  });
});

describe("serveOfTurn", () => {
  it("counts the serve within a three-serve sepak turn", () => {
    expect(serveOfTurn(0, 0, SEPAK)).toBe(1);
    expect(serveOfTurn(1, 0, SEPAK)).toBe(2);
    expect(serveOfTurn(2, 0, SEPAK)).toBe(3);
    expect(serveOfTurn(2, 1, SEPAK)).toBe(1);
  });

  it("collapses to single serves once TT reaches deuce", () => {
    expect(serveOfTurn(1, 0, TT)).toBe(2);
    expect(serveOfTurn(10, 10, TT)).toBe(1);
    expect(serveOfTurn(11, 10, TT)).toBe(1);
  });
});

describe("changeEndsPrompt", () => {
  it("fires exactly when a side first reaches the regular trigger", () => {
    expect(changeEndsPrompt(1, 3, 11, 5, SEPAK)).toBe(true);
    expect(changeEndsPrompt(1, 3, 5, 11, SEPAK)).toBe(true);
    expect(changeEndsPrompt(2, 3, 11, 0, SEPAK)).toBe(true);
    expect(changeEndsPrompt(1, 3, 10, 5, SEPAK)).toBe(false);
    expect(changeEndsPrompt(1, 3, 12, 5, SEPAK)).toBe(false); // already past
    expect(changeEndsPrompt(1, 3, 11, 11, SEPAK)).toBe(false); // both there
  });

  it("uses the deciding trigger only in the deciding set", () => {
    expect(changeEndsPrompt(3, 3, 8, 3, SEPAK)).toBe(true);
    expect(changeEndsPrompt(3, 3, 3, 8, SEPAK)).toBe(true);
    expect(changeEndsPrompt(3, 3, 11, 3, SEPAK)).toBe(false);
    expect(changeEndsPrompt(2, 3, 8, 3, SEPAK)).toBe(false); // not deciding yet
  });

  it("TT has no mid-game trigger outside the deciding game", () => {
    expect(changeEndsPrompt(1, 5, 5, 3, TT)).toBe(false);
    expect(changeEndsPrompt(4, 5, 5, 3, TT)).toBe(false);
    expect(changeEndsPrompt(5, 5, 5, 3, TT)).toBe(true);
    expect(changeEndsPrompt(5, 5, 4, 3, TT)).toBe(false);
    expect(changeEndsPrompt(5, 5, 6, 3, TT)).toBe(false);
  });

  it("returns false when no trigger is configured", () => {
    expect(changeEndsPrompt(1, 3, 11, 5, {})).toBe(false);
    expect(
      changeEndsPrompt(1, 3, 11, 5, { change_ends_at: null }),
    ).toBe(false);
  });
});
