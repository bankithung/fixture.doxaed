import { describe, expect, it } from "vitest";
import type { ControlRoomMatch } from "@/api/tournaments";
import { matchWinner } from "../format";

function m(over: Partial<ControlRoomMatch>): ControlRoomMatch {
  return {
    id: "m1",
    stage: "group",
    group_label: "Group A",
    round_no: 1,
    match_no: 1,
    status: "completed",
    home_team: { id: "h", name: "Alpha FC", short_name: "ALP" },
    away_team: { id: "a", name: "Bravo FC", short_name: "BRA" },
    home_score: 0,
    away_score: 0,
    sport: "",
    set_scores: [],
    leaf_key: "football.u15",
    venue: "Main",
    scoring: null,
    scheduled_at: "2026-06-20T03:30:00Z",
    locked_at: null,
    home_pens: null,
    away_pens: null,
    current_period: "",
    called_at: null,
    leaf_label: "Football · U15",
    scorer: null,
    officials: [],
    ...over,
  } as ControlRoomMatch;
}

describe("matchWinner", () => {
  it("names the side that finished ahead", () => {
    expect(matchWinner(m({ home_score: 2, away_score: 1 }))).toEqual({
      label: "Alpha FC",
      side: "home",
    });
    expect(matchWinner(m({ home_score: 1, away_score: 3 }))).toEqual({
      label: "Bravo FC",
      side: "away",
    });
  });

  it("reads sets won for a set sport, the same way", () => {
    // home/away_score carry SETS won; the per-set points do not decide it.
    const tt = m({
      sport: "table_tennis",
      home_score: 3,
      away_score: 1,
      set_scores: [[11, 8], [9, 11], [11, 6], [11, 4]],
    });
    expect(matchWinner(tt)?.label).toBe("Alpha FC");
  });

  it("lets penalties settle a level score", () => {
    expect(
      matchWinner(m({ home_score: 1, away_score: 1, home_pens: 3, away_pens: 4 })),
    ).toEqual({ label: "Bravo FC", side: "away" });
  });

  it("calls a still-level match a draw", () => {
    expect(matchWinner(m({ home_score: 1, away_score: 1 }))).toEqual({
      label: "Draw",
      side: "draw",
    });
  });

  it("says nothing until the match is settled", () => {
    expect(matchWinner(m({ status: "scheduled", home_score: null, away_score: null }))).toBeNull();
    expect(matchWinner(m({ status: "live", home_score: 2, away_score: 0 }))).toBeNull();
  });

  it("counts a walkover as settled", () => {
    expect(
      matchWinner(m({ status: "walkover", home_score: 1, away_score: 0 }))?.label,
    ).toBe("Alpha FC");
  });
});
