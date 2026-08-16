import { describe, expect, it } from "vitest";
import {
  allLeavesOf,
  buildCompetitionTree,
  compressToPrefixes,
  coveredBy,
  expandPrefixes,
  flattenTree,
  nodeState,
  toggleNode,
} from "../courtCompetitions";

// The real shape from `configuredLeaves` for the ANPSA tournament: table
// tennis carries a discipline level that sepak takraw does not, so the tree is
// deliberately ragged.
const OPTIONS = [
  { key: "table_tennis.u_14.boys.singles", label: "Table Tennis · U-14 · Boys · Singles" },
  { key: "table_tennis.u_14.boys.doubles", label: "Table Tennis · U-14 · Boys · Doubles" },
  { key: "table_tennis.u_14.girls.singles", label: "Table Tennis · U-14 · Girls · Singles" },
  { key: "table_tennis.u_14.girls.doubles", label: "Table Tennis · U-14 · Girls · Doubles" },
  { key: "table_tennis.open_category.boys.singles", label: "Table Tennis · Open Category · Boys · Singles" },
  { key: "table_tennis.open_category.boys.doubles", label: "Table Tennis · Open Category · Boys · Doubles" },
  { key: "table_tennis.open_category.girls.singles", label: "Table Tennis · Open Category · Girls · Singles" },
  { key: "table_tennis.open_category.girls.doubles", label: "Table Tennis · Open Category · Girls · Doubles" },
  { key: "sepak_takraw.u_14.boys", label: "Sepak Takraw · U-14 · Boys" },
  { key: "sepak_takraw.u_14.girls", label: "Sepak Takraw · U-14 · Girls" },
];

const TREE = buildCompetitionTree(OPTIONS);
const ALL = allLeavesOf(TREE);
const find = (key: string) => {
  const hit = flattenTree(TREE).find((n) => n.key === key);
  if (!hit) throw new Error(`no node ${key}`);
  return hit;
};

describe("buildCompetitionTree", () => {
  it("groups by sport, then category, then gender", () => {
    expect(TREE.map((n) => n.key)).toEqual(["table_tennis", "sepak_takraw"]);
    expect(TREE[0].label).toBe("Table Tennis");
    expect(TREE[0].children.map((n) => n.label)).toEqual([
      "U-14",
      "Open Category",
    ]);
    expect(find("table_tennis.u_14").children.map((n) => n.label)).toEqual([
      "Boys",
      "Girls",
    ]);
  });

  it("labels each node with its OWN segment, not the whole path", () => {
    expect(find("table_tennis.u_14.boys").label).toBe("Boys");
    expect(find("table_tennis.u_14.boys.singles").label).toBe("Singles");
  });

  it("carries every leaf under each node", () => {
    expect(find("table_tennis").leaves).toHaveLength(8);
    expect(find("table_tennis.u_14").leaves).toHaveLength(4);
    expect(find("sepak_takraw").leaves).toHaveLength(2);
  });

  it("handles a ragged tree — sepak's gender IS the leaf", () => {
    const boys = find("sepak_takraw.u_14.boys");
    expect(boys.children).toEqual([]);
    expect(boys.leaves).toEqual(["sepak_takraw.u_14.boys"]);
  });
});

describe("coveredBy", () => {
  it("matches self and descendants", () => {
    expect(coveredBy("table_tennis.u_14.boys.singles", "table_tennis")).toBe(true);
    expect(coveredBy("sepak_takraw.u_14.boys", "sepak_takraw.u_14.boys")).toBe(true);
  });

  it("is segment-aligned — a partial segment matches nothing", () => {
    // The whole point of the backend's rule: `u_1` is not `u_14`.
    expect(coveredBy("table_tennis.u_14.boys.singles", "table_tennis.u_1")).toBe(false);
  });
});

describe("cascading selection", () => {
  it("selecting a sport selects every competition under it", () => {
    const next = toggleNode(find("sepak_takraw"), new Set());
    expect([...next].sort()).toEqual([
      "sepak_takraw.u_14.boys",
      "sepak_takraw.u_14.girls",
    ]);
  });

  it("selecting a gender selects both disciplines under it", () => {
    const next = toggleNode(find("table_tennis.u_14.boys"), new Set());
    expect([...next].sort()).toEqual([
      "table_tennis.u_14.boys.doubles",
      "table_tennis.u_14.boys.singles",
    ]);
  });

  it("a parent reads partial until every child is on", () => {
    let sel = toggleNode(find("table_tennis.u_14.boys"), new Set());
    expect(nodeState(find("table_tennis.u_14"), sel)).toBe("partial");
    expect(nodeState(find("table_tennis"), sel)).toBe("partial");
    sel = toggleNode(find("table_tennis.u_14.girls"), sel);
    expect(nodeState(find("table_tennis.u_14"), sel)).toBe("on");
    // …but Open Category is still untouched.
    expect(nodeState(find("table_tennis"), sel)).toBe("partial");
  });

  it("toggling a fully-on node clears it", () => {
    const on = toggleNode(find("sepak_takraw"), new Set());
    expect(nodeState(find("sepak_takraw"), on)).toBe("on");
    expect(toggleNode(find("sepak_takraw"), on).size).toBe(0);
  });

  it("toggling a partial node fills it in rather than clearing", () => {
    const partial = toggleNode(find("sepak_takraw.u_14.boys"), new Set());
    const next = toggleNode(find("sepak_takraw"), partial);
    expect(nodeState(find("sepak_takraw"), next)).toBe("on");
  });
});

describe("prefix round-trip", () => {
  it("expands a sport prefix to its leaves", () => {
    expect(expandPrefixes(["sepak_takraw"], ALL)).toEqual(
      new Set(["sepak_takraw.u_14.boys", "sepak_takraw.u_14.girls"]),
    );
  });

  it("compresses a fully-selected subtree to the shallowest prefix", () => {
    const sel = toggleNode(find("table_tennis"), new Set());
    expect(compressToPrefixes(sel, TREE)).toEqual(["table_tennis"]);
  });

  it("compresses a partial selection to the group level actually chosen", () => {
    const sel = toggleNode(find("table_tennis.u_14"), new Set());
    expect(compressToPrefixes(sel, TREE)).toEqual(["table_tennis.u_14"]);
  });

  it("keeps individual leaves when only some of a group is on", () => {
    const sel = toggleNode(find("table_tennis.u_14.boys.singles"), new Set());
    expect(compressToPrefixes(sel, TREE)).toEqual([
      "table_tennis.u_14.boys.singles",
    ]);
  });

  it("round-trips stored -> leaves -> stored unchanged", () => {
    for (const stored of [
      ["table_tennis"],
      ["sepak_takraw"],
      ["table_tennis.u_14", "sepak_takraw.u_14.girls"],
      ["table_tennis.u_14.boys.singles"],
    ]) {
      expect(compressToPrefixes(expandPrefixes(stored, ALL), TREE)).toEqual(stored);
    }
  });

  it("collapses the flat eight-leaf value the old picker wrote", () => {
    // Exactly what is stored on TT · T1 today, minus the girls' half.
    const stored = OPTIONS.filter((o) => o.key.startsWith("table_tennis")).map(
      (o) => o.key,
    );
    expect(compressToPrefixes(expandPrefixes(stored, ALL), TREE)).toEqual([
      "table_tennis",
    ]);
  });

  it("drops a prefix whose sport is no longer in the tournament", () => {
    expect(expandPrefixes(["badminton"], ALL).size).toBe(0);
  });
});

describe("flattenTree", () => {
  it("returns depth-first rows", () => {
    const rows = flattenTree(TREE).map((n) => n.key);
    expect(rows[0]).toBe("table_tennis");
    expect(rows[1]).toBe("table_tennis.u_14");
    expect(rows[2]).toBe("table_tennis.u_14.boys");
    expect(rows[3]).toBe("table_tennis.u_14.boys.singles");
  });

  it("hides the children of a collapsed group", () => {
    const rows = flattenTree(TREE, new Set(["table_tennis"])).map((n) => n.key);
    expect(rows).toEqual(["table_tennis", "sepak_takraw", "sepak_takraw.u_14",
      "sepak_takraw.u_14.boys", "sepak_takraw.u_14.girls"]);
  });
});
