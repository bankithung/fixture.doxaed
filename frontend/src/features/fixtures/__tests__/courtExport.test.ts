import { describe, expect, it, vi } from "vitest";
import type { PreviewMatch } from "@/api/tournaments";
import { buildRows, type BlackoutWindow } from "../previewGrid";
import { competitionLoads, courtDayLoads } from "../courtLoad";
import {
  courtCsv,
  courtPdfHtml,
  downloadCourtCsv,
  openCourtPdf,
} from "../courtExport";
import type { PreviewExportMeta } from "../previewExport";

function m(over: Partial<PreviewMatch> & { ref: string }): PreviewMatch {
  return {
    leaf_key: "table_tennis.u_14.boys.singles",
    stage: "knockout",
    group_label: "Table Tennis · U-14 · Boys · Singles",
    round_no: 1,
    home: { team_id: "t1" },
    away: { team_id: "t2" },
    scheduled_at: "2026-08-17T09:00:00",
    venue: "TT · T1",
    duration_minutes: 15,
    ...over,
  } as PreviewMatch;
}

const NAMES = new Map([
  ["t1", "Amazing School"],
  ["t2", "Lorna's School"],
]);

const MATCHES: PreviewMatch[] = [
  m({ ref: "p1", scheduled_at: "2026-08-17T09:00:00" }),
  m({ ref: "p2", scheduled_at: "2026-08-17T09:15:00" }),
  m({
    ref: "p3",
    leaf_key: "sepak_takraw.u_14.boys",
    group_label: "Sepak Takraw · U-14 · Boys · Group A",
    stage: "group",
    venue: "SPK · T1",
    scheduled_at: "2026-08-17T10:20:00",
    duration_minutes: 25,
  }),
  // Never placed: holds no court and is charged no minutes.
  m({ ref: "p4", scheduled_at: null, venue: "", duration_minutes: null }),
];

const BLACKOUTS: BlackoutWindow[] = [
  { from: "12:01", to: "12:30", days: [], label: "daily_break" },
];

const ROWS = buildRows(MATCHES, NAMES, ["p4"]);
const LOADS = courtDayLoads(ROWS, "08:00", "18:00", BLACKOUTS);
const SPORTS = competitionLoads(ROWS);

const META: PreviewExportMeta = {
  title: "All competitions",
  filterSummary: "Day: Mon, Aug 17",
  shown: 4,
  total: 12,
  groupLabel: "Day and court",
  unplaced: 1,
};

describe("courtCsv", () => {
  const csv = courtCsv(LOADS, SPORTS);
  const lines = csv.split("\n");

  it("writes both tables, told apart by the Section column", () => {
    expect(lines[0]!.startsWith("Section,Day,Court,Sport,Competition,From,To")).toBe(
      true,
    );
    expect(lines.filter((l) => l.startsWith("Court day,"))).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith("Competition,"))).toHaveLength(2);
    // Every free stretch and every configured break is its own row.
    expect(lines.filter((l) => l.startsWith("Court free,")).length).toBeGreaterThan(0);
    expect(lines.filter((l) => l.startsWith("Break,")).length).toBeGreaterThan(0);
  });

  it("carries the court's own readings on its row", () => {
    const tt = lines.find((l) => l.includes("TT · T1") && l.startsWith("Court day,"))!;
    // 09:00-09:30 played on a 08:00-18:00 day with a 29 min break configured.
    expect(tt).toContain("8:00 AM");
    expect(tt).toContain("6:00 PM");
    expect(tt).toContain(",30,"); // minutes played
  });

  it("charges an unplaced match no court minutes but still counts it", () => {
    const row = lines.find(
      (l) => l.startsWith("Competition,") && l.includes("U-14 · Boys · Singles"),
    )!;
    expect(row).toContain("without a time");
  });
});

describe("courtPdfHtml", () => {
  const html = courtPdfHtml({ loads: LOADS, sports: SPORTS, meta: META });

  it("prints the headline readings and what the filters were", () => {
    expect(html).toContain("Court time used");
    expect(html).toContain("Utilisation");
    expect(html).toContain("Day: Mon, Aug 17");
    expect(html).toContain("Trial run. This schedule is not published yet.");
  });

  it("draws each court's day AND writes every free stretch in words", () => {
    // The picture alone would print blank wherever background graphics are
    // off, so the words are not optional.
    expect(html).toContain("TT · T1");
    expect(html).toContain("SPK · T1");
    expect(html).toContain('class="bar"');
    expect(html).toContain("Free:");
    expect(html).toContain("9:30 AM");
  });

  it("names the break you configured rather than calling it idle court", () => {
    expect(html).toContain("Break you set");
  });

  it("carries the by-competition table with its total row", () => {
    expect(html).toContain("Court time by competition");
    expect(html).toContain("U-14 · Boys · Singles");
    expect(html).toContain("All competitions");
  });

  it("escapes anything a court name could smuggle in", () => {
    const evil = courtPdfHtml({
      loads: courtDayLoads(
        buildRows([m({ ref: "x1", venue: "<script>x</script>" })], NAMES),
        "08:00",
        "18:00",
      ),
      sports: [],
      meta: META,
    });
    expect(evil).not.toContain("<script>x</script>");
    expect(evil).toContain("&lt;script&gt;");
  });

  it("says so plainly when nothing has a time yet", () => {
    const empty = courtPdfHtml({ loads: [], sports: [], meta: META });
    expect(empty).toContain("No scheduled matches to measure court time from.");
  });
});

describe("openCourtPdf / downloadCourtCsv", () => {
  it("writes the report into a new tab and raises the print dialog", () => {
    vi.useFakeTimers();
    const w = {
      document: { write: vi.fn(), close: vi.fn() },
      focus: vi.fn(),
      print: vi.fn(),
    };
    const open = vi.spyOn(window, "open").mockReturnValue(w as unknown as Window);

    openCourtPdf({ loads: LOADS, sports: SPORTS, meta: META });
    expect(w.document.write).toHaveBeenCalledWith(
      expect.stringContaining("Court time by competition"),
    );
    vi.runAllTimers();
    expect(w.print).toHaveBeenCalled();

    open.mockRestore();
    vi.useRealTimers();
  });

  it("downloads the court report under its own dated name", () => {
    const click = vi.fn();
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:court");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const anchor = document.createElement("a");
    anchor.click = click;
    const el = vi.spyOn(document, "createElement").mockReturnValue(anchor);

    downloadCourtCsv(LOADS, SPORTS, META);
    expect(click).toHaveBeenCalled();
    expect(anchor.download).toMatch(
      /^fixture-court-time-all-competitions-\d{4}-\d{2}-\d{2}\.csv$/,
    );

    el.mockRestore();
    create.mockRestore();
    revoke.mockRestore();
  });
});
