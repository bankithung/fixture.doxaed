import { describe, expect, it } from "vitest";
import type {
  PublicEntryCompetition,
  PublicEntryInstitution,
} from "@/api/tournaments";
import {
  buildBands,
  buildColumns,
  cellCount,
  columnCodes,
  entriesCsv,
  pathCode,
  sportTotals,
  visibleRows,
} from "../entriesMatrix";

function comp(
  sportKey: string,
  sportName: string,
  path: string[],
  extra: Partial<PublicEntryCompetition> = {},
): PublicEntryCompetition {
  return {
    leaf_key: [sportKey, ...path.map((p) => p.toLowerCase())].join("."),
    sport_key: sportKey,
    sport_name: sportName,
    path,
    label: path.join(" · "),
    teams: 0,
    schools: 0,
    ...extra,
  };
}

function school(
  name: string,
  entries: Record<string, number>,
  extra: Partial<PublicEntryInstitution> = {},
): PublicEntryInstitution {
  const built: PublicEntryInstitution["entries"] = {};
  let teams = 0;
  for (const [key, n] of Object.entries(entries)) {
    built[key] = {
      teams: n,
      names: Array.from({ length: n }, (_, i) => `${name} ${i + 1}`),
    };
    teams += n;
  }
  return {
    id: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    short_name: "",
    region: "",
    crest: "",
    entries: built,
    team_count: teams,
    competition_count: Object.keys(entries).length,
    uncategorized: 0,
    ...extra,
  };
}

const TT_UBS = comp("table_tennis", "Table Tennis", ["U-14", "Boys", "Singles"]);
const TT_OBS = comp("table_tennis", "Table Tennis", [
  "Open Category",
  "Boys",
  "Singles",
]);
const SEPAK_B = comp("sepak_takraw", "Sepak Takraw", ["U-14", "Boys"]);
const SEPAK_G = comp("sepak_takraw", "Sepak Takraw", ["U-14", "Girls"]);
const COMPS = [TT_UBS, TT_OBS, SEPAK_B, SEPAK_G];

describe("pathCode", () => {
  it("takes the first LETTER of each category segment", () => {
    // "U-14" is one segment: its letter is U, never its digits — a code made
    // of numbers reads as a score, not a column name.
    expect(pathCode(["U-14", "Boys", "Singles"], "Table Tennis")).toBe("UBS");
    expect(pathCode(["Open Category", "Girls", "Doubles"], "Table Tennis")).toBe(
      "OGD",
    );
  });

  it("falls back to the sport's initials for a category-less sport", () => {
    expect(pathCode([], "Sepak Takraw")).toBe("ST");
  });

  it("skips a segment with no letters rather than emitting a blank", () => {
    expect(pathCode(["2026", "Boys"], "Table Tennis")).toBe("B");
  });
});

describe("columnCodes", () => {
  it("keeps every code unique so the legend can never map one code twice", () => {
    const clashing = [
      comp("table_tennis", "Table Tennis", ["U-14", "Boys", "Singles"]),
      comp("table_tennis", "Table Tennis", ["U-16", "Boys", "Singles"]),
    ];
    expect(columnCodes(clashing)).toEqual(["UBS", "UBS2"]);
  });
});

describe("buildBands", () => {
  it("groups columns into contiguous sport bands, in payload order", () => {
    const bands = buildBands(buildColumns(COMPS));
    expect(bands.map((b) => b.sportKey)).toEqual([
      "table_tennis",
      "sepak_takraw",
    ]);
    expect(bands[0]!.columns).toHaveLength(2);
    expect(bands[1]!.columns.map((c) => c.code)).toEqual(["UB", "UG"]);
  });
});

describe("visibleRows", () => {
  const columns = buildColumns(COMPS);
  const rows = [
    school("Zed School", { [TT_UBS.leaf_key]: 2, [SEPAK_B.leaf_key]: 1 }),
    school("Alpha School", { [SEPAK_B.leaf_key]: 1 }),
    school("Mid School", { [TT_OBS.leaf_key]: 3 }),
  ];

  it("sorts by school name by default", () => {
    expect(visibleRows(rows, columns).map((r) => r.name)).toEqual([
      "Alpha School",
      "Mid School",
      "Zed School",
    ]);
  });

  it("sorts by entry count, breaking ties by name", () => {
    expect(
      visibleRows(rows, columns, { sort: "entries" }).map((r) => r.name),
    ).toEqual(["Mid School", "Zed School", "Alpha School"]);
  });

  it("searches on name", () => {
    expect(
      visibleRows(rows, columns, { search: "alp" }).map((r) => r.name),
    ).toEqual(["Alpha School"]);
  });

  it("drops schools with nothing in the filtered sport", () => {
    // Mid School is table tennis only, so under a Sepak filter it is not a
    // participant — leaving an all-empty row in would read as a broken filter.
    expect(
      visibleRows(rows, columns, { sport: "sepak_takraw" }).map((r) => r.name),
    ).toEqual(["Alpha School", "Zed School"]);
  });

  it("ranks by the FILTERED sport's entries, not the whole tournament", () => {
    const ranked = visibleRows(rows, columns, {
      sport: "sepak_takraw",
      sort: "entries",
    });
    // Zed has 3 entries overall but only 1 in sepak, the same as Alpha, so
    // the tie falls back to the name.
    expect(ranked.map((r) => r.name)).toEqual(["Alpha School", "Zed School"]);
  });
});

describe("cellCount", () => {
  it("is 0 for a competition the school did not enter", () => {
    const row = school("Solo", { [TT_UBS.leaf_key]: 1 });
    expect(cellCount(row, TT_UBS.leaf_key)).toBe(1);
    expect(cellCount(row, SEPAK_G.leaf_key)).toBe(0);
  });
});

describe("sportTotals", () => {
  it("counts schools that entered anything in the sport, and their entries", () => {
    const bands = buildBands(buildColumns(COMPS));
    const rows = [
      school("A", { [TT_UBS.leaf_key]: 2, [SEPAK_B.leaf_key]: 1 }),
      school("B", { [TT_OBS.leaf_key]: 1 }),
    ];
    expect(sportTotals(rows, bands)).toEqual([
      {
        sportKey: "table_tennis",
        sportName: "Table Tennis",
        schools: 2,
        teams: 3,
      },
      {
        sportKey: "sepak_takraw",
        sportName: "Sepak Takraw",
        schools: 1,
        teams: 1,
      },
    ]);
  });
});

describe("entriesCsv", () => {
  it("writes FULL category names, not the codes (a spreadsheet has no legend)", () => {
    const columns = buildColumns(COMPS);
    const rows = [school("Comma, School", { [TT_UBS.leaf_key]: 2 })];
    const csv = entriesCsv(columns, rows);
    const [head, body] = csv.split("\n");
    expect(head).toContain("Table Tennis U-14 · Boys · Singles");
    expect(head).not.toContain("UBS");
    // A school name with a comma must not split into two columns.
    expect(body).toBe('"Comma, School",2,0,0,0,1,2');
  });
});
