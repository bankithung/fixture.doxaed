import { describe, expect, it } from "vitest";
import { livePeriodLabel, liveSetView } from "../setDisplay";

/** A live table-tennis match part-way through game 2 (1-1 in games, 13-15 in
 * the running game). `current_period` is what the server wrote at kickoff and
 * never updated — the bug this module exists to absorb. */
const TT_GAME_2 = {
  status: "live",
  sport: "table_tennis",
  home_score: 1,
  away_score: 1,
  set_scores: [
    [11, 8],
    [13, 15],
  ],
  current_period: "game_1",
};

describe("livePeriodLabel", () => {
  it("counts the running game from set_scores, not the stale current_period", () => {
    // The board used to read "game 1" here all match long.
    expect(livePeriodLabel(TT_GAME_2)).toBe("game 2");
    expect(liveSetView(TT_GAME_2)?.setNo).toBe(2);
  });

  it("keeps the sport's own word for a period", () => {
    // From current_period ("game_1" → "game") when the caller has no sport_meta.
    expect(livePeriodLabel({ ...TT_GAME_2, set_scores: [[5, 3]] })).toBe(
      "game 1",
    );
    // From sport_meta's term when it does.
    expect(livePeriodLabel(TT_GAME_2, "Set")).toBe("Set 2");
    // And a sport that never wrote a period still reads sensibly.
    expect(livePeriodLabel({ ...TT_GAME_2, current_period: "" })).toBe("set 2");
  });

  it("falls back to current_period for football, which has no sets", () => {
    expect(
      livePeriodLabel({
        status: "live",
        sport: "football",
        set_scores: [],
        current_period: "second_half",
      }),
    ).toBe("second half");
  });

  it("is null when the match is not in play", () => {
    expect(livePeriodLabel({ ...TT_GAME_2, status: "scheduled" })).toBe(
      "game 1",
    );
    expect(
      livePeriodLabel({ status: "scheduled", sport: "football" }),
    ).toBeNull();
  });
});
