import { describe, expect, it, vi } from "vitest";
import type { PreviewMatch } from "@/api/tournaments";
import { buildRows, fmtClock, linesWithBreaks, occupancyByCourt } from "../previewGrid";
import {
  downloadPreviewCsv,
  openPreviewCourtGridPdf,
  openPreviewPdf,
  previewCourtGridHtml,
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

// One school has a badge, the other has none — the two halves of the rule in
// a single row.
const CRESTS = new Map([["t1", "https://crest.example/t1.png"]]);
const CREST_ROWS = buildRows([m({ ref: "c1" })], NAMES, [], CRESTS);
const POINTER_ROWS = buildRows(
  [
    m({
      ref: "c2",
      stage: "knockout",
      group_label: "",
      round_no: 2,
      home: { source: { type: "winner_of", ref: "c1" } },
      away: { source: { type: "winner_of", ref: "c3" } },
    }),
  ],
  NAMES,
  [],
  CRESTS,
);

describe("crests on the printed run sheet", () => {
  const html = previewPdfHtml({
    rows: CREST_ROWS,
    sort: null,
    groupBy: "none",
    meta: META,
  });

  it("prints the badge of a team that has one", () => {
    expect(html).toContain('src="https://crest.example/t1.png"');
    expect(html).toContain("border-radius:50%");
  });

  it("prints NO image tag for the side whose team has no badge", () => {
    // A printed sheet cannot fall back to initials and cannot recover from a
    // 404 — a missing crest must leave no tag at all, or the paper carries a
    // broken-image icon.
    expect(html.match(/<img/g) ?? []).toHaveLength(1);
    expect(html).toContain("Lorna's School");
  });

  it("prints no image for a side nobody has qualified for yet", () => {
    const ko = previewPdfHtml({
      rows: POINTER_ROWS,
      sort: null,
      groupBy: "none",
      meta: META,
    });
    expect(ko).toContain("Winner of");
    expect(ko).not.toContain("<img");
  });

  it("still escapes the team name that carries a badge", () => {
    const evil = previewPdfHtml({
      rows: buildRows(
        [m({ ref: "x1" })],
        new Map([["t1", "<script>x</script>"]]),
        [],
        CRESTS,
      ),
      sort: null,
      groupBy: "none",
      meta: META,
    });
    expect(evil).not.toContain("<script>x</script>");
    expect(evil).toContain("&lt;script&gt;");
    expect(evil).toContain('src="https://crest.example/t1.png"');
  });
});

describe("crests on the printed court grid", () => {
  it("puts the badge in the team block, and nothing where there is none", () => {
    const html = previewCourtGridHtml({ rows: CREST_ROWS, meta: META });
    expect(html).toContain('src="https://crest.example/t1.png"');
    expect(html.match(/<img/g) ?? []).toHaveLength(1);
  });

  it("puts a badge on the still-without-a-time list too", () => {
    const untimed = buildRows([m({ ref: "u1" })], NAMES, ["u1"], CRESTS);
    const html = previewCourtGridHtml({ rows: untimed, meta: META });
    expect(html).toContain("Still without a time");
    expect(html).toContain('src="https://crest.example/t1.png"');
  });

  it("prints no image for an unresolved side", () => {
    const html = previewCourtGridHtml({ rows: POINTER_ROWS, meta: META });
    expect(html).not.toContain("<img");
  });
});

/** A fake `<img>` in the printed tab, with its listeners captured. */
function fakeWindow(imageCount: number) {
  const listeners: { load: (() => void)[]; error: (() => void)[] } = {
    load: [],
    error: [],
  };
  const imgs = Array.from({ length: imageCount }, () => ({
    complete: false,
    addEventListener: (ev: "load" | "error", fn: () => void) =>
      listeners[ev].push(fn),
  }));
  const w = {
    document: {
      write: vi.fn(),
      close: vi.fn(),
      querySelectorAll: vi.fn(() => imgs),
    },
    focus: vi.fn(),
    print: vi.fn(),
  };
  return { w, listeners };
}

describe("the print race", () => {
  it("holds the dialog until every crest has decoded", () => {
    vi.useFakeTimers();
    const { w, listeners } = fakeWindow(2);
    const open = vi.spyOn(window, "open").mockReturnValue(w as unknown as Window);

    openPreviewPdf({ rows: CREST_ROWS, sort: null, groupBy: "none", meta: META });

    // The naive 250ms timeout would already have printed here, with the
    // badges still in flight.
    vi.advanceTimersByTime(300);
    expect(w.print).not.toHaveBeenCalled();

    listeners.load[0]!();
    vi.advanceTimersByTime(300);
    expect(w.print).not.toHaveBeenCalled();

    listeners.load[1]!();
    vi.runAllTimers();
    // Once, never twice: the ceiling must not fire a second dialog.
    expect(w.print).toHaveBeenCalledTimes(1);

    open.mockRestore();
    vi.useRealTimers();
  });

  it("prints anyway when a crest never arrives", () => {
    vi.useFakeTimers();
    const { w } = fakeWindow(1);
    const open = vi.spyOn(window, "open").mockReturnValue(w as unknown as Window);

    openPreviewCourtGridPdf({ rows: CREST_ROWS, meta: META });
    vi.advanceTimersByTime(1600);
    expect(w.print).toHaveBeenCalledTimes(1);

    open.mockRestore();
    vi.useRealTimers();
  });

  it("a broken crest settles the wait like any other", () => {
    vi.useFakeTimers();
    const { w, listeners } = fakeWindow(1);
    const open = vi.spyOn(window, "open").mockReturnValue(w as unknown as Window);

    openPreviewPdf({ rows: CREST_ROWS, sort: null, groupBy: "none", meta: META });
    listeners.error[0]!();
    vi.advanceTimersByTime(100);
    expect(w.print).toHaveBeenCalledTimes(1);

    open.mockRestore();
    vi.useRealTimers();
  });
});
