import { describe, expect, it } from "vitest";
import type { RosterMember } from "@/api/tournaments";
import {
  applyParticipationFilters,
  buildParticipation,
  detailColumns,
  detailText,
  EMPTY_PARTICIPATION_FILTERS,
  participationCsv,
  participationFacets,
  participationTotals,
  sortParticipation,
  sportOf,
} from "../participation";

function member(over: Partial<RosterMember> & { id: string }): RosterMember {
  return {
    full_name: "Imli Jamir",
    kind: "student",
    class_section: "8-A",
    roll_no: "12",
    gender: "",
    date_of_birth: null,
    contact_email: "",
    contact_phone: "",
    attributes: {},
    documents: [],
    institution: { id: "i1", name: "Grace Academy" },
    group: null,
    entries: [],
    ...over,
  } as RosterMember;
}

const TT_BOYS = "table_tennis.u_14.boys.singles";
const TT_DOUBLES = "table_tennis.u_14.boys.doubles";
const SPK = "sepak_takraw.u_14.boys";

const MEMBERS: RosterMember[] = [
  // In two competitions of ONE sport.
  member({
    id: "m1",
    full_name: "Imli Jamir",
    entries: [
      { team_id: "t1", team: "Grace A", leaf_key: TT_BOYS, role: "player" },
      { team_id: "t2", team: "Grace B", leaf_key: TT_DOUBLES, role: "player" },
    ],
  }),
  // In two DIFFERENT sports — the harder clash.
  member({
    id: "m2",
    full_name: "Toshi Ao",
    class_section: "9-B",
    roll_no: "3",
    institution: { id: "i2", name: "Lorna's School" },
    entries: [
      { team_id: "t3", team: "Lorna A", leaf_key: TT_BOYS, role: "player" },
      { team_id: "t4", team: "Lorna S", leaf_key: SPK, role: "player" },
    ],
  }),
  // In exactly one.
  member({
    id: "m3",
    full_name: "Aben Kikon",
    class_section: "7-C",
    roll_no: "21",
    entries: [
      { team_id: "t1", team: "Grace A", leaf_key: TT_BOYS, role: "player" },
    ],
  }),
  // Declared but not on any team yet.
  member({ id: "m4", full_name: "Nino Longkumer", roll_no: "8", entries: [] }),
  // A teacher, in charge of two teams.
  member({
    id: "m5",
    full_name: "Mr Ao",
    kind: "teacher",
    class_section: "",
    roll_no: "",
    entries: [
      { team_id: "t1", team: "Grace A", leaf_key: TT_BOYS, role: "in_charge" },
      { team_id: "t4", team: "Lorna S", leaf_key: SPK, role: "in_charge" },
    ],
  }),
];

const ROWS = buildParticipation(MEMBERS);
const row = (id: string) => ROWS.find((r) => r.id === id)!;

describe("buildParticipation", () => {
  it("names the sport and the category separately, so a table can carry each", () => {
    const e = row("m1").entries[0]!;
    expect(e.sportKey).toBe("table_tennis");
    expect(e.sportLabel).toBe("Table Tennis");
    expect(e.categoryLabel).toBe("U 14 · Boys · Singles");
  });

  it("counts competitions, and separates one sport from two", () => {
    expect(row("m1").events).toBe(2);
    expect(row("m1").multiInOneSport).toBe(true);
    expect(row("m1").multiAcrossSports).toBe(false);

    expect(row("m2").events).toBe(2);
    expect(row("m2").multiAcrossSports).toBe(true);
    expect(row("m2").sports).toEqual(["table_tennis", "sepak_takraw"]);
  });

  it("counts a person once per competition, not once per row", () => {
    // A teacher who is also a player in the same competition is not a clash
    // with themselves.
    const both = buildParticipation([
      member({
        id: "x",
        entries: [
          { team_id: "t1", team: "A", leaf_key: TT_BOYS, role: "player" },
          { team_id: "t1", team: "A", leaf_key: TT_BOYS, role: "in_charge" },
        ],
      }),
    ])[0]!;
    expect(both.events).toBe(1);
    expect(both.multiInOneSport).toBe(false);
  });

  it("keeps someone with no team as a real row, not a gap", () => {
    expect(row("m4").events).toBe(0);
    expect(row("m4").entries).toEqual([]);
  });
});

describe("participationTotals", () => {
  it("leads with the number the draw cares about", () => {
    const totals = participationTotals(ROWS);
    expect(totals.people).toBe(5);
    expect(totals.multi).toBe(3); // m1, m2, m5
    expect(totals.multiAcrossSports).toBe(2); // m2, m5
    expect(totals.unentered).toBe(1); // m4
    expect(totals.busiest).toBe(2);
  });
});

describe("applyParticipationFilters", () => {
  const f = (over: Partial<typeof EMPTY_PARTICIPATION_FILTERS>) =>
    applyParticipationFilters(ROWS, { ...EMPTY_PARTICIPATION_FILTERS, ...over });

  it("finds exactly the people in more than one event", () => {
    expect(f({ events: "multi" }).map((r) => r.id)).toEqual(["m1", "m2", "m5"]);
  });

  it("narrows further to the ones spanning two sports", () => {
    expect(f({ events: "cross_sport" }).map((r) => r.id)).toEqual(["m2", "m5"]);
  });

  it("finds the people nobody has entered yet", () => {
    expect(f({ events: "none" }).map((r) => r.id)).toEqual(["m4"]);
  });

  it("filters by sport, competition, school and kind", () => {
    expect(f({ sport: "sepak_takraw" }).map((r) => r.id)).toEqual(["m2", "m5"]);
    expect(f({ competition: TT_DOUBLES }).map((r) => r.id)).toEqual(["m1"]);
    expect(f({ school: "Lorna's School" }).map((r) => r.id)).toEqual(["m2"]);
    expect(f({ kind: "teacher" }).map((r) => r.id)).toEqual(["m5"]);
  });

  it("searches name, class, roll and school together", () => {
    expect(f({ q: "9-B" }).map((r) => r.id)).toEqual(["m2"]);
    expect(f({ q: "grace" }).length).toBe(4);
    expect(f({ q: "toshi" }).map((r) => r.id)).toEqual(["m2"]);
  });

  it("combines filters rather than replacing them", () => {
    expect(f({ events: "multi", school: "Grace Academy" }).map((r) => r.id)).toEqual([
      "m1",
      "m5",
    ]);
  });
});

describe("participationFacets", () => {
  it("offers only the sports and competitions actually in use", () => {
    const facets = participationFacets(ROWS);
    expect(facets.sports.map((s) => s.value).sort()).toEqual([
      "sepak_takraw",
      "table_tennis",
    ]);
    expect(facets.competitions.map((c) => c.value).sort()).toEqual(
      [SPK, TT_DOUBLES, TT_BOYS].sort(),
    );
    expect(facets.schools.map((s) => s.value)).toEqual([
      "Grace Academy",
      "Lorna's School",
    ]);
  });
});

describe("sortParticipation", () => {
  it("sorts by event count with the busiest first, names breaking ties", () => {
    const sorted = sortParticipation(ROWS, "events", "desc");
    expect(sorted[0]!.events).toBe(2);
    expect(sorted[sorted.length - 1]!.id).toBe("m4");
  });

  it("sorts by name", () => {
    expect(sortParticipation(ROWS, "name", "asc")[0]!.name).toBe("Aben Kikon");
  });
});

describe("detailColumns", () => {
  it("shows the columns this form filled, and hides the ones it never asked", () => {
    // A roster-first event asks for a date of birth, a gender and a document
    // and never asks for a class or a roll number (owner 2026-08-19).
    const rows = buildParticipation([
      member({
        id: "d1",
        full_name: "Phirun Mech",
        class_section: "",
        roll_no: "",
        gender: "male",
        date_of_birth: "2013-04-02",
        documents: [
          { name: "birth.pdf", url: "/api/forms/uploads/x/", content_type: "application/pdf" },
        ],
      }),
    ]);
    const keys = detailColumns(rows).map((c) => c.key);
    expect(keys).toEqual(["dob", "age", "gender", "docs"]);
    expect(keys).not.toContain("class");
    expect(keys).not.toContain("roll");
  });

  it("keeps class and roll for a form that does ask for them", () => {
    const keys = detailColumns(ROWS).map((c) => c.key);
    expect(keys).toContain("class");
    expect(keys).toContain("roll");
    expect(keys).not.toContain("dob");
  });

  it("reads the age off the date of birth, and the papers by name", () => {
    const [row] = buildParticipation([
      member({
        id: "d2",
        date_of_birth: `${new Date().getFullYear() - 12}-01-01`,
        documents: [
          {
            name: "scan.pdf",
            label: "Aadhaar card",
            url: "/api/forms/uploads/y/",
            content_type: "application/pdf",
          },
        ],
      }),
    ]);
    expect(detailText(row!, "age")).toBe("12");
    expect(detailText(row!, "docs")).toBe("Aadhaar card");
  });
});

describe("participationCsv", () => {
  it("writes one column per competition, ticked where they are entered", () => {
    const facets = participationFacets(ROWS);
    const csv = participationCsv(ROWS, facets.competitions, detailColumns(ROWS));
    const [head, ...body] = csv.split("\n");
    expect(head).toContain("Events");
    // The export carries the same detail the sheet shows, so what an organizer
    // reads on screen is what lands in the file.
    expect(head).toContain("Class");
    // Every competition becomes a column, so a double entry reads across.
    for (const c of facets.competitions) expect(head).toContain(c.label);
    const imli = body.find((l) => l.startsWith("Imli Jamir"))!;
    expect(imli.split(",").filter((c) => c === "Yes")).toHaveLength(2);
  });

  it("quotes a value containing a comma", () => {
    const csv = participationCsv(
      buildParticipation([member({ id: "z", full_name: "Ao, Toshi" })]),
      [],
      [],
    );
    expect(csv).toContain('"Ao, Toshi"');
  });
});

describe("sportOf", () => {
  it("takes the leading segment, and nothing from an empty key", () => {
    expect(sportOf(TT_BOYS)).toBe("table_tennis");
    expect(sportOf("")).toBe("");
  });
});
