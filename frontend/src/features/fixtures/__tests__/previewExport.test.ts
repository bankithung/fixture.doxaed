import { describe, expect, it, vi } from "vitest";
import type { PreviewMatch } from "@/api/tournaments";
import { buildRows, fmtClock, linesWithBreaks, occupancyByCourt } from "../previewGrid";
import {
  downloadPreviewCsv,
  openPreviewPdf,
  previewPdfHtml,
  type PreviewExportMeta,
} from "../previewExport";

function m(over: Partial<PreviewMatch> & { ref: string }): PreviewMatch {
  return {
    leaf_key: "table_tennis.u_14.boys.1v1",
    stage: "group",
    group_label: "Table Tennis · U-14 · Boys · Singles · Group A",
    round_no: 1,
    home: { team_id: "t1" },
    away: { team_id: "t2" },
    scheduled_at: "2026-08-17T13:59:00",
    venue: "T1",
    duration_minutes: 20,
    ...over,
  } as PreviewMatch;
}

const NAMES = new Map([
  ["t1", "Amazing School"],
  ["t2", "Lorna's School"],
]);

const ROWS = buildRows(
  [m({ ref: "p1" }), m({ ref: "p2", scheduled_at: "2026-08-17T15:24:00" })],
  NAMES,
);

const META: PreviewExportMeta = {
  title: "All competitions",
  filterSummary: "Sport: Table Tennis",
  shown: 2,
  total: 10,
  groupLabel: "Day and court",
  unplaced: 3,
};

describe("fmtClock", () => {
  it("reads the clock in 12 hours with am/pm", () => {
    expect(fmtClock("13:59")).toBe("1:59 PM");
    expect(fmtClock("09:05")).toBe("9:05 AM");
    expect(fmtClock("00:30")).toBe("12:30 AM");
    expect(fmtClock("12:00")).toBe("12:00 PM");
    expect(fmtClock("")).toBe("");
  });
});

describe("linesWithBreaks labels", () => {
  const g1 = m({ ref: "g1", scheduled_at: "2026-08-17T11:20:00", venue: "T1" });
  const g2 = m({ ref: "g2", scheduled_at: "2026-08-17T13:59:00", venue: "T1" });
  const rows = buildRows([g1, g2], NAMES);
  const busy = occupancyByCourt([g1, g2]).get("2026-08-17|T1") ?? [];

  it("draws the break you configured, with that window's own hours", () => {
    const lines = linesWithBreaks(rows, busy, [
      { from: "12:01", to: "12:30", days: [], label: "daily_break" },
    ]);
    expect(lines.map((l) => l.kind)).toEqual(["match", "break", "match"]);
    expect(lines[1]).toMatchObject({
      label: "Daily break",
      from: "12:01",
      to: "12:30",
      minutes: 29,
    });
  });

  it("stays quiet about a court that is merely idle", () => {
    // The court is free 11:40 to 13:59 but nothing was scheduled there — an
    // empty court is not a break and must not read like one.
    expect(linesWithBreaks(rows, busy, []).map((l) => l.kind)).toEqual([
      "match",
      "match",
    ]);
  });

  it("ignores a window that does not fall on this weekday", () => {
    // 2026-08-17 is a Monday; a Sunday-only window must not claim the gap.
    const lines = linesWithBreaks(rows, busy, [
      { from: "12:00", to: "13:00", days: ["sun"], label: "sunday_church" },
    ]);
    expect(lines.map((l) => l.kind)).toEqual(["match", "match"]);
  });

  it("shows a ceremony only on its own date", () => {
    const onDay = linesWithBreaks(rows, busy, [
      { from: "12:00", to: "13:00", date: "2026-08-17", label: "opening" },
    ]);
    expect(onDay[1]).toMatchObject({ label: "Opening ceremony" });
    const otherDay = linesWithBreaks(rows, busy, [
      { from: "12:00", to: "13:00", date: "2026-08-18", label: "opening" },
    ]);
    expect(otherDay.map((l) => l.kind)).toEqual(["match", "match"]);
  });
});

describe("previewPdfHtml", () => {
  const html = previewPdfHtml({
    rows: ROWS,
    sort: null,
    groupBy: "day_venue",
    meta: META,
  });

  it("prints landscape with a repeating header", () => {
    expect(html).toContain("size: A4 landscape");
    expect(html).toContain("display: table-header-group");
  });

  it("states what it is: the filters, the scope and the trial-run warning", () => {
    expect(html).toContain("All competitions");
    expect(html).toContain("Sport: Table Tennis");
    expect(html).toContain("2 of 10 matches");
    expect(html).toContain("Trial run. This schedule is not published yet.");
    expect(html).toContain("3 match(es) still have no time.");
  });

  it("writes the rows in 12-hour clock, banded by day and court", () => {
    expect(html).toContain("1:59 PM");
    expect(html).toContain("3:24 PM");
    expect(html).toContain("Amazing School");
    expect(html).toContain("2 matches"); // the band's own count
    expect(html).not.toContain("13:59");
  });

  it("escapes anything a school name could smuggle in", () => {
    const evil = previewPdfHtml({
      rows: buildRows([m({ ref: "x1" })], new Map([["t1", "<script>x</script>"]])),
      sort: null,
      groupBy: "none",
      meta: META,
    });
    expect(evil).not.toContain("<script>x</script>");
    expect(evil).toContain("&lt;script&gt;");
  });
});

describe("openPreviewPdf", () => {
  it("writes the document into a new tab and raises the print dialog", () => {
    vi.useFakeTimers();
    const w = {
      document: { write: vi.fn(), close: vi.fn() },
      focus: vi.fn(),
      print: vi.fn(),
    };
    const open = vi.spyOn(window, "open").mockReturnValue(w as unknown as Window);

    openPreviewPdf({ rows: ROWS, sort: null, groupBy: "day", meta: META });
    expect(w.document.write).toHaveBeenCalledWith(
      expect.stringContaining("size: A4 landscape"),
    );
    vi.runAllTimers();
    expect(w.print).toHaveBeenCalled();

    open.mockRestore();
    vi.useRealTimers();
  });

  it("does nothing when the browser blocks the tab", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    expect(() =>
      openPreviewPdf({ rows: ROWS, sort: null, groupBy: "day", meta: META }),
    ).not.toThrow();
    open.mockRestore();
  });
});

describe("downloadPreviewCsv", () => {
  it("downloads the visible rows as a dated file", () => {
    const click = vi.fn();
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:preview");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const anchor = document.createElement("a");
    anchor.click = click;
    const el = vi.spyOn(document, "createElement").mockReturnValue(anchor);

    downloadPreviewCsv(ROWS, META);
    expect(click).toHaveBeenCalled();
    expect(anchor.download).toMatch(/^fixture-preview-all-competitions-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(create).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("blob:preview");

    el.mockRestore();
    create.mockRestore();
    revoke.mockRestore();
  });
});
