import { describe, expect, it } from "vitest";
import { categoryKpis } from "../TeamsTab";
import type { TeamRow } from "@/api/tournaments";

function team(over: Partial<TeamRow>): TeamRow {
  return {
    id: "x", name: "N", short_name: "", school: "", institution_id: "i",
    pool: "", sport: "", leaf_key: "", status: "registered", player_count: 0,
    ...over,
  };
}

const SEPAK = "Sepak Takraw — u-14 — boys — 3v3";
const TT = "Table Tennis — open — girls — 2v2";

describe("categoryKpis", () => {
  it("groups by leaf, counts distinct schools + players, sorts by label", () => {
    const rows = [
      team({ leaf_key: "st.u14.boys.1v1", pool: SEPAK, institution_id: "a", player_count: 4 }),
      team({ leaf_key: "st.u14.boys.1v1", pool: SEPAK, institution_id: "b", player_count: 3 }),
      team({ leaf_key: "st.u14.boys.1v1", pool: SEPAK, institution_id: "a", player_count: 2 }),
      team({ leaf_key: "tt.u19.girls.2v2", pool: TT, institution_id: "c", player_count: 3 }),
    ];
    const k = categoryKpis(rows);
    expect(k).toHaveLength(2);
    // sorted by label: "Sepak…" before "Table…"
    expect(k[0]!.label).toContain("Sepak");
    expect(k[0]!.teams).toBe(3);
    expect(k[0]!.schools).toBe(2); // a + b distinct (a counted once)
    expect(k[0]!.players).toBe(9);
    expect(k[1]!.teams).toBe(1);
    expect(k[1]!.schools).toBe(1);
  });

  it("buckets uncategorized (blank leaf) rows together", () => {
    const k = categoryKpis([team({ leaf_key: "" }), team({ leaf_key: "" })]);
    expect(k).toHaveLength(1);
    expect(k[0]!.key).toBe("__uncategorized");
    expect(k[0]!.teams).toBe(2);
  });
});
