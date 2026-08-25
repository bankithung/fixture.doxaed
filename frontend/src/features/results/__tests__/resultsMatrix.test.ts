import { describe, expect, it } from "vitest";
import type { PublicResultSchool } from "@/api/tournaments";
import {
  chartBars,
  leafMatchesPrefix,
  rankOf,
  resolveInclude,
  resultColumns,
  scopedTotals,
  tallyCsv,
  visibleSchools,
} from "../resultsMatrix";

const TT = "table_tennis.u_14.boys.singles";
const SEPAK = "sepak_takraw.u_14.boys";

const COLUMNS = resultColumns([
  {
    leaf_key: TT, sport_key: "table_tennis", sport_name: "Table Tennis",
    path: ["U-14", "Boys", "Singles"], label: "U-14 · Boys · Singles",
    status: "final", places: [],
  },
  {
    leaf_key: SEPAK, sport_key: "sepak_takraw", sport_name: "Sepak Takraw",
    path: ["U-14", "Boys"], label: "U-14 · Boys",
    status: "final", places: [],
  },
]);

const school = (
  id: string,
  name: string,
  results: PublicResultSchool["results"],
): PublicResultSchool => ({
  id, name, short_name: "", crest: "", medals: {}, points: 0, rank: 0, results,
});

const GOLD = { place: 1, points: 5, label: "Gold", team_name: "A" };
const SILVER = { place: 2, points: 3, label: "Silver", team_name: "B" };
const BRONZE = { place: 3, points: 2, label: "Bronze", team_name: "C" };

const ROWS = [
  school("i1", "Greenwood", { [TT]: [GOLD], [SEPAK]: [BRONZE] }),
  school("i2", "Pilgrim", { [TT]: [SILVER, BRONZE] }),
  school("i3", "Eden", {}),
];

describe("resultsMatrix", () => {
  it("totals a row from the columns it is given, never the whole meet", () => {
    expect(scopedTotals(ROWS[0]!, COLUMNS).points).toBe(7);
    const ttOnly = COLUMNS.filter((c) => c.leaf_key === TT);
    expect(scopedTotals(ROWS[0]!, ttOnly).points).toBe(5);
    expect(scopedTotals(ROWS[0]!, ttOnly).medals["3"]).toBeUndefined();
  });

  it("counts two placings from one school in one competition", () => {
    const totals = scopedTotals(ROWS[1]!, COLUMNS);
    expect(totals.points).toBe(5);
    expect(totals.count).toBe(2);
  });

  it("ranks by points, then by the medal counts, then leaves ties level", () => {
    const rows = [
      school("a", "Alpha", { [TT]: [GOLD] }),
      school("b", "Bravo", { [TT]: [GOLD] }),
      school("c", "Cavalry", { [TT]: [SILVER] }),
    ];
    const ordered = visibleSchools(rows, COLUMNS, { places: [1, 2, 3] });
    const ranks = rankOf(ordered, COLUMNS, [1, 2, 3]);
    expect(ranks.get("a")).toBe(1);
    expect(ranks.get("b")).toBe(1);
    expect(ranks.get("c")).toBe(3);
  });

  it("sorts by golds when asked, so one gold beats three silvers", () => {
    const rows = [
      school("a", "Alpha", { [TT]: [SILVER, SILVER, SILVER] }),
      school("b", "Bravo", { [TT]: [GOLD] }),
    ];
    expect(
      visibleSchools(rows, COLUMNS, { sort: "golds", places: [1, 2, 3] })[0]!.id,
    ).toBe("b");
    expect(
      visibleSchools(rows, COLUMNS, { sort: "points", places: [1, 2, 3] })[0]!.id,
    ).toBe("a");
  });

  it("keeps every school by default and drops the empty ones on request", () => {
    expect(visibleSchools(ROWS, COLUMNS, {}).map((r) => r.id)).toContain("i3");
    expect(
      visibleSchools(ROWS, COLUMNS, { medalistsOnly: true }).map((r) => r.id),
    ).not.toContain("i3");
  });

  it("charts only the schools that won something, scaled to the leader", () => {
    const bars = chartBars(visibleSchools(ROWS, COLUMNS, {}), COLUMNS);
    expect(bars.map((b) => b.id)).toEqual(["i1", "i2"]);
    expect(bars[0]!.share).toBe(1);
    expect(bars[1]!.share).toBeCloseTo(5 / 7);
  });

  it("exports the columns on screen, so a filtered CSV agrees with it", () => {
    const ttOnly = COLUMNS.filter((c) => c.leaf_key === TT);
    const csv = tallyCsv(ttOnly, ROWS, [1, 2, 3], [
      { place: 1, label: "Gold" },
      { place: 2, label: "Silver" },
      { place: 3, label: "Bronze" },
    ]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "School,Table Tennis U-14 · Boys · Singles,Gold,Silver,Bronze,Points",
    );
    // Greenwood's sepak bronze is out of scope, so the row reports 5, not 7.
    expect(lines[1]).toBe("Greenwood,1,1,0,0,5");
    expect(lines[2]).toBe("Pilgrim,2 3,0,1,1,5");
  });

  it("matches a competition prefix segment by segment", () => {
    expect(leafMatchesPrefix("table_tennis.u_14", TT)).toBe(true);
    expect(leafMatchesPrefix("table_tennis.u_1", TT)).toBe(false);
    expect(leafMatchesPrefix("", TT)).toBe(false);
  });

  it("reads an empty group as every competition", () => {
    expect(resolveInclude([], [TT, SEPAK])).toEqual([TT, SEPAK]);
    expect(resolveInclude(["sepak_takraw"], [TT, SEPAK])).toEqual([SEPAK]);
  });
});
