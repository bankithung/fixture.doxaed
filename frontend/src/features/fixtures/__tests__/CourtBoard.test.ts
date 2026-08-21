import { describe, expect, it } from "vitest";
import { type PublicScheduleMatch } from "@/api/tournaments";
import { buildCourtLanes, courtDefaultFits } from "../CourtBoard";

/** The court board's model. Lane ORDER is the thing worth pinning: an
 * organiser reads the lanes the way the venue is laid out, so "Audi T10" must
 * never sort in front of "Audi T2", and a match with no court is not a lane. */

function m(
  id: string,
  venue: string,
  at: string | null,
  status = "scheduled",
): PublicScheduleMatch {
  return {
    id,
    leaf_key: "tt.u14",
    leaf_label: "Table Tennis · U14",
    stage: "knockout",
    group_label: "",
    round_no: 1,
    match_no: 1,
    status,
    day: "2026-08-17",
    scheduled_at: at,
    venue,
    home: null,
    away: null,
    home_score: null,
    away_score: null,
    home_pens: null,
    away_pens: null,
    sport: "table_tennis",
    set_scores: [],
    current_period: "",
  };
}

describe("buildCourtLanes", () => {
  it("follows the payload's own court order, then numeric name order", () => {
    const matches = [
      m("a", "Mph · T2", "2026-08-17T04:00:00Z"),
      m("b", "Audi · T10", "2026-08-17T04:00:00Z"),
      m("c", "Audi · T2", "2026-08-17T04:00:00Z"),
      m("d", "Side Hall", "2026-08-17T04:00:00Z"),
    ];
    // The venue materialises its courts in its own order; the payload carries
    // it, so the board reads left to right the way the hall is laid out.
    const courts = [
      { id: "1", name: "Audi · T2", watch_url: null, is_streaming: false },
      { id: "2", name: "Audi · T10", watch_url: null, is_streaming: false },
      { id: "3", name: "Mph · T2", watch_url: null, is_streaming: false },
    ];
    expect(buildCourtLanes(matches, courts).map((l) => l.name)).toEqual([
      "Audi · T2",
      "Audi · T10",
      "Mph · T2",
      // Unknown to the court list: behind the named ones, not dropped.
      "Side Hall",
    ]);
  });

  it("collates numerically when the payload names no courts", () => {
    const matches = [
      m("a", "Table 10", null),
      m("b", "Table 2", null),
      m("c", "Table 1", null),
    ];
    expect(buildCourtLanes(matches, undefined).map((l) => l.name)).toEqual([
      "Table 1",
      "Table 2",
      "Table 10",
    ]);
  });

  it("parks matches with no court last, under their own heading", () => {
    const lanes = buildCourtLanes(
      [m("a", "", null), m("b", "Audi · T1", "2026-08-17T04:00:00Z")],
      undefined,
    );
    expect(lanes.map((l) => l.name)).toEqual(["Audi · T1", "No court yet"]);
  });

  it("orders each lane by kick-off and counts what it has played", () => {
    const lanes = buildCourtLanes(
      [
        m("late", "Audi · T1", "2026-08-17T06:00:00Z"),
        m("early", "Audi · T1", "2026-08-17T04:00:00Z", "completed"),
        m("mid", "Audi · T1", "2026-08-17T05:00:00Z", "live"),
      ],
      undefined,
    );
    expect(lanes[0]!.matches.map((x) => x.id)).toEqual(["early", "mid", "late"]);
    expect(lanes[0]!.played).toBe(1);
    expect(lanes[0]!.live).toBe(1);
  });
});

describe("courtDefaultFits", () => {
  it("earns the default only when the day runs on more than one court", () => {
    expect(courtDefaultFits([m("a", "Audi · T1", null)])).toBe(false);
    expect(
      courtDefaultFits([m("a", "Audi · T1", null), m("b", "Audi · T2", null)]),
    ).toBe(true);
    // A day nothing is assigned on is one big "No court yet" pile, not a board.
    expect(courtDefaultFits([m("a", "", null), m("b", "", null)])).toBe(false);
  });
});
