import { describe, expect, it } from "vitest";
import type { PreviewMatch } from "@/api/tournaments";
import {
  applyFilters,
  buildRows,
  buildCourtGrid,
  courtSummary,
  matchRefLabels,
  EMPTY_FILTERS,
  groupRows,
  facetsFor,
  linesWithBreaks,
  occupancyByCourt,
  sortRows,
  toCsv,
} from "../previewGrid";

function m(over: Partial<PreviewMatch> & { ref: string }): PreviewMatch {
  return {
    leaf_key: "table_tennis.u_14.boys.1v1",
    stage: "group",
    group_label: "Table Tennis · U-14 · Boys · Singles · Group A",
    round_no: 1,
    home: { team_id: "t1" },
    away: { team_id: "t2" },
    scheduled_at: "2026-08-16T13:59:00",
    venue: "T1",
    duration_minutes: 20,
    ...over,
  } as PreviewMatch;
}

const NAMES = new Map([
  ["t1", "Amazing School"],
  ["t2", "Lorna's School"],
  ["t3", "Grace Academy"],
]);

const MATCHES: PreviewMatch[] = [
  m({ ref: "p1" }),
  m({
    ref: "p2",
    leaf_key: "sepak_takraw.u_14.girls.3v3",
    group_label: "Sepak Takraw · U-14 · Girls · Group B",
    venue: "Court A",
    scheduled_at: "2026-08-16T15:24:00",
    duration_minutes: 15,
    home: { team_id: "t3" },
  }),
  m({
    ref: "p3",
    stage: "knockout",
    group_label: "",
    round_no: 2,
    scheduled_at: null,
    venue: "",
    duration_minutes: null,
    away: { source: { type: "winner_of", ref: "p1" } },
  }),
];

const ROWS = buildRows(MATCHES, NAMES, ["p3"]);

describe("buildRows", () => {
  it("resolves every column, including the end time and the group", () => {
    const r = ROWS[0]!;
    expect(r.start).toBe("13:59");
    expect(r.end).toBe("14:19");
    expect(r.dayLabel).toMatch(/Aug 16/);
    expect(r.sportLabel).toBe("Table Tennis");
    expect(r.categoryLabel).toBe("U-14 · Boys · Singles");
    expect(r.group).toBe("Group A");
    expect(r.home).toBe("Amazing School");
    expect(r.placed).toBe(true);
  });

  it("marks an unplaced match instead of pretending it has a slot", () => {
    const r = ROWS[2]!;
    expect(r.placed).toBe(false);
    expect(r.start).toBe("");
    expect(r.dayLabel).toBe("No date yet");
    // Typed pointers read in plain words — and name a match on the page,
    // never the internal plan ref (owner 2026-08-19).
    expect(r.away).toBe("Winner of Round 1");
    expect(r.away).not.toContain("p1");
    // A knockout row never mislabels its leaf tail as a group.
    expect(r.group).toBe("");
    expect(r.stageLabel).toBe("Knockout");
  });
});

describe("applyFilters", () => {
  it("searches teams, courts and competitions", () => {
    expect(applyFilters(ROWS, { ...EMPTY_FILTERS, q: "grace" }).map((r) => r.ref)).toEqual([
      "p2",
    ]);
    expect(applyFilters(ROWS, { ...EMPTY_FILTERS, q: "court a" }).map((r) => r.ref)).toEqual([
      "p2",
    ]);
  });

  it("narrows by sport and by status", () => {
    expect(
      applyFilters(ROWS, { ...EMPTY_FILTERS, sport: "sepak_takraw" }).map((r) => r.ref),
    ).toEqual(["p2"]);
    expect(
      applyFilters(ROWS, { ...EMPTY_FILTERS, status: "unplaced" }).map((r) => r.ref),
    ).toEqual(["p3"]);
  });

  it("combines filters (every one must pass)", () => {
    expect(
      applyFilters(ROWS, { ...EMPTY_FILTERS, sport: "sepak_takraw", status: "unplaced" }),
    ).toHaveLength(0);
  });
});

describe("facetsFor", () => {
  it("counts each value so a pick tells you what you would get", () => {
    const sports = facetsFor(ROWS, EMPTY_FILTERS, "sport");
    expect(sports.map((s) => [s.label, s.count])).toEqual([
      ["Sepak Takraw", 1],
      ["Table Tennis", 2],
    ]);
  });

  it("counts a facet against the OTHER filters, not its own", () => {
    const f = { ...EMPTY_FILTERS, sport: "table_tennis" };
    // Its own filter is ignored, so every sport stays pickable...
    expect(facetsFor(ROWS, f, "sport")).toHaveLength(2);
    // ...but the venue facet only offers the courts table tennis uses.
    expect(facetsFor(ROWS, f, "venue").map((v) => v.value)).toEqual([
      "T1",
      "Unassigned venue",
    ]);
  });
});

describe("sortRows", () => {
  it("defaults to play order and sinks untimed matches to the bottom", () => {
    expect(sortRows(ROWS, null).map((r) => r.ref)).toEqual(["p1", "p2", "p3"]);
  });

  it("sorts a column both ways", () => {
    expect(sortRows(ROWS, { key: "home", dir: "asc" }).map((r) => r.home)[0]).toBe(
      "Amazing School",
    );
    expect(sortRows(ROWS, { key: "home", dir: "desc" }).map((r) => r.home)[0]).toBe(
      "Grace Academy",
    );
  });
});

describe("linesWithBreaks", () => {
  const court = (over: Partial<PreviewMatch> & { ref: string }): PreviewMatch =>
    m({ venue: "Court 1", duration_minutes: 30, ...over });
  const g1 = court({ ref: "g1", scheduled_at: "2026-08-16T09:00:00" });
  const g2 = court({ ref: "g2", scheduled_at: "2026-08-16T10:30:00" });

  it("shows the configured break where the court is idle for it", () => {
    const rows = buildRows([g1, g2], NAMES);
    const busy = occupancyByCourt([g1, g2]).get("2026-08-16|Court 1") ?? [];
    const lines = linesWithBreaks(rows, busy, [
      { from: "09:30", to: "10:30", days: [], label: "daily_break" },
    ]);
    expect(lines.map((l) => l.kind)).toEqual(["match", "break", "match"]);
    expect(lines[1]).toMatchObject({
      from: "09:30", to: "10:30", minutes: 60, label: "Daily break",
    });
  });

  it("draws nothing for an idle court with no break configured", () => {
    const rows = buildRows([g1, g2], NAMES);
    const busy = occupancyByCourt([g1, g2]).get("2026-08-16|Court 1") ?? [];
    expect(linesWithBreaks(rows, busy).map((l) => l.kind)).toEqual([
      "match",
      "match",
    ]);
  });

  it("shows no break when another category fills the gap", () => {
    const filler = court({
      ref: "k1",
      scheduled_at: "2026-08-16T09:30:00",
      duration_minutes: 60,
    });
    const rows = buildRows([g1, g2], NAMES);
    const busy = occupancyByCourt([g1, g2, filler]).get("2026-08-16|Court 1") ?? [];
    // Even with the break configured: the court is playing, not resting.
    expect(
      linesWithBreaks(rows, busy, [
        { from: "09:30", to: "10:30", days: [], label: "daily_break" },
      ]).map((l) => l.kind),
    ).toEqual(["match", "match"]);
  });
});

describe("toCsv", () => {
  it("writes a header and quotes anything with a comma", () => {
    const csv = toCsv(buildRows([m({ ref: "p9", venue: "Hall A, upstairs" })], NAMES));
    const [head, row] = csv.split("\n");
    expect(head).toContain("Start,End,Minutes,Venue");
    expect(row).toContain('"Hall A, upstairs"');
    expect(row).toContain("Amazing School");
  });
});


describe("a court heading says what is played on it", () => {
  // Owner 2026-08-19: "when group by court, in the heading of the court name
  // can add the sport name and category too". A court name alone says nothing.
  /** One match per (leaf, label) pair, all on the same court — the payload
   * shape a knockout actually has: a middot label carrying its sport. */
  const onCourt = (
    labels: [leaf: string, label: string][],
  ): ReturnType<typeof buildRows> =>
    buildRows(
      labels.map(([leaf, label], i) =>
        m({ ref: `c${i}`, venue: "Audi · T1", leaf_key: leaf, group_label: label }),
      ),
      NAMES,
    );
  const TT = "table_tennis";

  it("names the sport and each competition on that court", () => {
    const rows = onCourt([
      [`${TT}.u_14.boys.singles`, "Table Tennis · U-14 · Boys · Singles"],
      [`${TT}.open.boys.doubles`, "Table Tennis · Open Category · Boys · Doubles"],
    ]);
    const [band] = groupRows(rows, "venue");
    expect(band!.label).toBe("Audi · T1");
    expect(band!.sub).toContain("Table Tennis:");
    expect(band!.sub).toContain("U-14 · Boys · Singles");
    expect(band!.sub).toContain("Open Category · Boys · Doubles");
    // The sport heads its own list; it is not repeated per category.
    expect(band!.sub.match(/Table Tennis/g)).toHaveLength(1);
  });

  it("says a competition once however many matches it has there", () => {
    const rows = onCourt([
      [`${TT}.u_14.boys.singles`, "Table Tennis · U-14 · Boys · Singles"],
      [`${TT}.u_14.boys.singles`, "Table Tennis · U-14 · Boys · Singles"],
    ]);
    const sub = groupRows(rows, "venue")[0]!.sub;
    expect(sub.match(/U-14 · Boys · Singles/g)).toHaveLength(1);
  });

  it("counts the rest rather than running off the row", () => {
    const rows = onCourt([
      [`${TT}.a`, "Table Tennis · A"],
      [`${TT}.b`, "Table Tennis · B"],
      [`${TT}.c`, "Table Tennis · C"],
      [`${TT}.d`, "Table Tennis · D"],
      [`${TT}.e`, "Table Tennis · E"],
    ]);
    expect(groupRows(rows, "venue")[0]!.sub).toContain("+2");
  });

  it("keeps two sports on one court apart, each with its own list", () => {
    const sub = courtSummary(
      onCourt([
        [`${TT}.u_14.boys.singles`, "Table Tennis · U-14 · Boys · Singles"],
        ["sepak_takraw.u_14.girls", "Sepak Takraw · U-14 · Girls"],
      ]),
    );
    expect(sub).toContain("Table Tennis:");
    expect(sub).toContain("Sepak Takraw:");
  });

  it("leaves the other groupings' headings alone", () => {
    const rows = onCourt([
      [`${TT}.u_14.boys.singles`, "Table Tennis · U-14 · Boys · Singles"],
    ]);
    expect(groupRows(rows, "day")[0]!.sub).toBe("");
    // Day-and-court still reads day over court, as it always did.
    expect(groupRows(rows, "day_venue")[0]!.sub).toBe("Audi · T1");
  });
});

describe("the court grid: time down, courts across", () => {
  // Owner 2026-08-19, from a layout they sent: a list makes an official scan
  // for their court; this puts the court above their head.
  const at = (over: Partial<PreviewMatch> & { ref: string }): PreviewMatch =>
    m({ group_label: "", ...over });

  it("gives one row per start time and one column per court", () => {
    const rows = buildRows(
      [
        at({ ref: "a", venue: "T1", scheduled_at: "2026-08-16T08:00:00" }),
        at({ ref: "b", venue: "T2", scheduled_at: "2026-08-16T08:00:00" }),
        at({ ref: "c", venue: "T1", scheduled_at: "2026-08-16T08:20:00" }),
      ],
      NAMES,
    );
    const [day] = buildCourtGrid(rows);
    expect(day!.courts).toEqual(["T1", "T2"]);
    expect(day!.slots.map((s) => s.start)).toEqual(["08:00", "08:20"]);
    // The 8:20 row has T1 busy and T2 idle — an empty cell, not a shifted one.
    expect(day!.slots[1]!.cells[0]).not.toBeNull();
    expect(day!.slots[1]!.cells[1]).toBeNull();
  });

  it("keeps each day its own grid, in date order", () => {
    const rows = buildRows(
      [
        at({ ref: "b", venue: "T1", scheduled_at: "2026-08-17T09:00:00" }),
        at({ ref: "a", venue: "T1", scheduled_at: "2026-08-16T09:00:00" }),
      ],
      NAMES,
    );
    expect(buildCourtGrid(rows).map((d) => d.day)).toEqual([
      "2026-08-16",
      "2026-08-17",
    ]);
  });

  it("holds no cell for a match with no time", () => {
    const rows = buildRows(
      [at({ ref: "a", venue: "T1", scheduled_at: null })],
      NAMES,
      ["a"],
    );
    expect(buildCourtGrid(rows)).toEqual([]);
  });
});

describe("a bracket pointer names a match you can find", () => {
  // Owner 2026-08-19: "Winner of p109 — the name is confusing". p109 is an
  // internal plan reference; there is no p109 anywhere on the page.
  const ko = (ref: string, round: number): PreviewMatch =>
    m({ ref, round_no: round, stage: "knockout", group_label: "" });

  it("calls the last round the final and the one before it the semi-final", () => {
    const labels = matchRefLabels([
      ko("p1", 1), ko("p2", 1), ko("p3", 2), ko("p4", 2), ko("p5", 3),
    ]);
    expect(labels.get("p5")).toBe("the final");
    expect(labels.get("p3")).toBe("semi-final 1");
    expect(labels.get("p4")).toBe("semi-final 2");
    expect(labels.get("p1")).toBe("quarter-final 1");
  });

  it("drops the number when a round holds only one match", () => {
    const labels = matchRefLabels([ko("p1", 1), ko("p2", 2)]);
    expect(labels.get("p2")).toBe("the final");
    expect(labels.get("p1")).toBe("semi-final");
  });

  it("puts that name into the pointer instead of the raw ref", () => {
    const rows = buildRows(
      [
        ko("p1", 1), ko("p2", 1),
        m({
          ref: "p3", round_no: 2, stage: "knockout", group_label: "",
          home: { source: { type: "winner_of", ref: "p1" } },
          away: { source: { type: "loser_of", ref: "p2" } },
        } as Partial<PreviewMatch> & { ref: string }),
      ],
      NAMES,
    );
    const final = rows.find((r) => r.ref === "p3")!;
    expect(final.home).toBe("Winner of semi-final 1");
    expect(final.away).toBe("Loser of semi-final 2");
    expect(final.home).not.toContain("p1");
  });
});
