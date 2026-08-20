import { describe, expect, it, vi } from "vitest";
import type { PreviewMatch } from "@/api/tournaments";
import { buildDrawBrackets, buildDrawSheet } from "../drawModel";
import { downloadDrawCsv, drawCsv, drawPdfHtml, openDrawPdf } from "../drawExport";
import type { PreviewExportMeta } from "../previewExport";

function m(over: Partial<PreviewMatch> & { ref: string }): PreviewMatch {
  return {
    leaf_key: "sepak_takraw.u_14.boys",
    stage: "group",
    group_label: "Sepak Takraw · U-14 · Boys · Group A",
    round_no: 1,
    home: { team_id: "t1" },
    away: { team_id: "t2" },
    scheduled_at: "2026-08-17T09:00:00",
    venue: "SPK · T1",
    duration_minutes: 25,
    ...over,
  } as PreviewMatch;
}

const NAMES = new Map([
  ["t1", "Amazing School"],
  ["t2", "Lorna's School"],
  ["t3", "Grace Academy"],
  ["t4", "Christ School"],
]);
const CRESTS = new Map([["t1", "https://crest.example/t1.png"]]);

/** A group competition with two groups, and a knockout one where a team gets
 * a bye into the semi-final. */
const MATCHES: PreviewMatch[] = [
  m({ ref: "p1", home: { team_id: "t1" }, away: { team_id: "t2" } }),
  m({
    ref: "p2",
    group_label: "Sepak Takraw · U-14 · Boys · Group B",
    home: { team_id: "t3" },
    away: { team_id: "t4" },
  }),
  // Knockout: round 1 is one match, round 2 (the final) takes a team that
  // never played round 1 — an entry bye.
  m({
    ref: "p3",
    leaf_key: "table_tennis.open.girls.doubles",
    group_label: "Table Tennis · Open Category · Girls · Doubles",
    stage: "knockout",
    round_no: 1,
    home: { team_id: "t1" },
    away: { team_id: "t2" },
    scheduled_at: "2026-08-17T10:00:00",
  }),
  m({
    ref: "p4",
    leaf_key: "table_tennis.open.girls.doubles",
    group_label: "Table Tennis · Open Category · Girls · Doubles",
    stage: "knockout",
    round_no: 2,
    home: { team_id: "t3" },
    away: { source: { type: "winner_of", ref: "p3" } },
    scheduled_at: "2026-08-18T08:00:00",
  }),
];

const META: PreviewExportMeta = {
  title: "All competitions",
  filterSummary: "Sport: Sepak Takraw",
  shown: 4,
  total: 10,
  groupLabel: "Day and court",
  unplaced: 2,
};

const LEAVES = buildDrawSheet(MATCHES, NAMES, CRESTS);
const BRACKETS = buildDrawBrackets(MATCHES, NAMES, CRESTS);

describe("buildDrawSheet", () => {
  it("lists every team once, under its own group and slot", () => {
    const sepak = LEAVES.find((l) => l.leafKey === "sepak_takraw.u_14.boys")!;
    expect(sepak.label).toBe("Sepak Takraw · U-14 · Boys");
    expect(sepak.groupCount).toBe(2);
    expect(sepak.lines.map((l) => [l.group, l.slot, l.school])).toEqual([
      ["Group A", 1, "Amazing School"],
      ["Group A", 2, "Lorna's School"],
      ["Group B", 1, "Christ School"],
      ["Group B", 2, "Grace Academy"],
    ]);
  });

  it("files a knockout-only competition under one entry list", () => {
    const tt = LEAVES.find((l) => l.leafKey === "table_tennis.open.girls.doubles")!;
    expect(tt.groupCount).toBe(1);
    expect(tt.lines.every((l) => l.group === "Entry list")).toBe(true);
  });

  it("carries the badge of a team that has one, and no badge otherwise", () => {
    const sepak = LEAVES.find((l) => l.leafKey === "sepak_takraw.u_14.boys")!;
    expect(sepak.lines.find((l) => l.school === "Amazing School")!.crest).toBe(
      "https://crest.example/t1.png",
    );
    expect(sepak.lines.find((l) => l.school === "Lorna's School")!.crest).toBe("");
  });
});

describe("buildDrawBrackets", () => {
  const tt = BRACKETS.find((b) => b.leafKey === "table_tennis.open.girls.doubles")!;

  it("names the rounds the way an organiser does, not by number", () => {
    expect(tt.rounds.map((r) => r.label)).toEqual(["Semi-final", "Final"]);
  });

  it("resolves a pointer to the match it names, never the raw ref", () => {
    const final = tt.rounds[1]!.pairs[0]!;
    expect(final.away).toBe("Winner of Match 1");
    expect(final.home).toBe("Grace Academy");
    expect(final.when).toContain("Aug 18");
  });

  it("calls out the team that sat a round out", () => {
    expect(tt.byes).toEqual([
      { name: "Grace Academy", crest: "", round: 2, roundLabel: "Final" },
    ]);
  });

  it("leaves the group-stage competition out of the brackets entirely", () => {
    expect(BRACKETS.map((b) => b.leafKey)).toEqual([
      "table_tennis.open.girls.doubles",
    ]);
  });
});

describe("drawCsv", () => {
  const csv = drawCsv(LEAVES, BRACKETS);
  const lines = csv.split("\n");

  it("tells an entry line from a pairing by its own column", () => {
    expect(lines[0]).toBe(
      "Section,Competition,Group,Slot,Match,Round,Team 1,Team 2,Time",
    );
    expect(lines.filter((l) => l.startsWith("Entry,"))).toHaveLength(7);
    expect(lines.filter((l) => l.startsWith("Bracket,"))).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith("Bye,"))).toHaveLength(1);
  });

  it("quotes a name that carries a comma", () => {
    const withComma = drawCsv(
      buildDrawSheet(MATCHES, new Map([["t1", "St. Thomas, Nagagaon"]])),
      [],
    );
    expect(withComma).toContain('"St. Thomas, Nagagaon"');
  });
});

describe("drawPdfHtml", () => {
  const html = drawPdfHtml({ leaves: LEAVES, brackets: BRACKETS, meta: META });

  it("prints portrait, one section per competition", () => {
    expect(html).toContain("size: A4 portrait");
    expect(html).toContain("Sepak Takraw · U-14 · Boys");
    expect(html).toContain("Table Tennis · Open Category · Girls · Doubles");
    expect(html).toContain("4 teams · 2 groups");
  });

  it("states it is a trial run and what the filters were", () => {
    expect(html).toContain("Sport: Sepak Takraw");
    expect(html).toContain("Trial run. This schedule is not published yet.");
    expect(html).toContain("2 match(es) still have no time.");
  });

  it("prints the pairings under their round names, byes included", () => {
    expect(html).toContain("Semi-final");
    expect(html).toContain("Winner of Match 1");
    expect(html).toContain("Byes");
  });

  it("prints a badge only where there is one", () => {
    // Amazing School has a crest and appears in the entry list, the bracket
    // and nowhere else; Lorna's School has none and must carry no tag.
    expect(html).toContain('src="https://crest.example/t1.png"');
    expect(html).toContain("Lorna's School");
    expect(html.match(/<img/g)?.length).toBe(
      (html.match(/https:\/\/crest\.example\/t1\.png/g) ?? []).length,
    );
  });

  it("escapes anything a school name could smuggle in", () => {
    const evil = drawPdfHtml({
      leaves: buildDrawSheet(MATCHES, new Map([["t1", "<script>x</script>"]])),
      brackets: [],
      meta: META,
    });
    expect(evil).not.toContain("<script>x</script>");
    expect(evil).toContain("&lt;script&gt;");
  });

  it("says so plainly when the filters leave nothing", () => {
    const empty = drawPdfHtml({ leaves: [], brackets: [], meta: META });
    expect(empty).toContain("No groups in this preview.");
  });
});

describe("openDrawPdf / downloadDrawCsv", () => {
  it("writes the draw into a new tab and raises the print dialog", () => {
    vi.useFakeTimers();
    const w = {
      document: { write: vi.fn(), close: vi.fn() },
      focus: vi.fn(),
      print: vi.fn(),
    };
    const open = vi.spyOn(window, "open").mockReturnValue(w as unknown as Window);

    openDrawPdf({ leaves: LEAVES, brackets: BRACKETS, meta: META });
    expect(w.document.write).toHaveBeenCalledWith(
      expect.stringContaining("size: A4 portrait"),
    );
    vi.runAllTimers();
    expect(w.print).toHaveBeenCalled();

    open.mockRestore();
    vi.useRealTimers();
  });

  it("downloads the draw under its own dated name", () => {
    const click = vi.fn();
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:draw");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const anchor = document.createElement("a");
    anchor.click = click;
    const el = vi.spyOn(document, "createElement").mockReturnValue(anchor);

    downloadDrawCsv(LEAVES, BRACKETS, META);
    expect(click).toHaveBeenCalled();
    expect(anchor.download).toMatch(
      /^fixture-draw-all-competitions-\d{4}-\d{2}-\d{2}\.csv$/,
    );

    el.mockRestore();
    create.mockRestore();
    revoke.mockRestore();
  });
});
