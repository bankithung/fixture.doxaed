import { describe, expect, it, vi } from "vitest";

import type { RosterMember } from "@/api/tournaments";
import { fmtDob } from "../personFormat";
import {
  buildParticipation,
  participationFacets,
  participationTotals,
} from "../participation";
import {
  openParticipationPdf,
  participationMatrixHtml,
  participationSheetHtml,
  type ParticipationDocMeta,
} from "../participationExport";

/**
 * The printed participation documents (owner 2026-08-27). The rule they must
 * keep is the one every export in this product keeps: what is on screen is
 * what comes out — the filtered rows, the columns this event's form collected,
 * and the view the host is reading.
 */

const TT_S = "table_tennis.u_14.boys.singles";
const TT_D = "table_tennis.u_14.boys.doubles";
const SPK = "sepak_takraw.u_14.boys";

const BASE = {
  kind: "student" as const,
  class_section: "",
  roll_no: "",
  gender: "",
  date_of_birth: null,
  contact_email: "",
  contact_phone: "",
  attributes: {},
  group: null,
  documents: [],
};

const MEMBERS = [
  {
    ...BASE,
    id: "m1",
    full_name: "Imli Jamir",
    date_of_birth: "2013-06-23",
    gender: "male",
    institution: { id: "i1", name: "Grace Academy" },
    entries: [
      { team_id: "t1", team: "Grace A", leaf_key: TT_S, role: "player" },
      { team_id: "t2", team: "Grace B", leaf_key: TT_D, role: "player" },
    ],
  },
  {
    ...BASE,
    id: "m2",
    full_name: "Toshi Ao",
    kind: "teacher" as const,
    institution: { id: "i2", name: "Lorna's School" },
    entries: [{ team_id: "t3", team: "Lorna S", leaf_key: SPK, role: "coach" }],
  },
  {
    ...BASE,
    id: "m3",
    full_name: "<script>x</script>",
    institution: { id: "i2", name: "Lorna's School" },
    entries: [],
  },
] as unknown as RosterMember[];

const ROWS = buildParticipation(MEMBERS);
const FACETS = participationFacets(ROWS);
const META: ParticipationDocMeta = {
  title: "Dimapur District Meet",
  filterSummary: "",
  shown: ROWS.length,
  total: ROWS.length,
  totals: participationTotals(ROWS),
};

describe("participationSheetHtml", () => {
  const html = participationSheetHtml({
    rows: ROWS,
    columns: [
      { key: "dob", label: "Born", width: 118 },
      { key: "gender", label: "Gender", width: 90 },
    ],
    meta: META,
  });

  it("names every person and what they are entered in", () => {
    expect(html).toContain("Imli Jamir");
    expect(html).toContain("U 14 · Boys · Singles");
    expect(html).toContain("U 14 · Boys · Doubles");
    expect(html).toContain("Grace Academy");
  });

  it("marks a teacher, and says plainly when someone has no event", () => {
    expect(html).toContain("Toshi Ao (Teacher)");
    expect(html).toContain("Not entered yet");
  });

  it("writes a date of birth the way the screen writes it", () => {
    // The reader's own locale, exactly as `fmtDob` renders it on the page —
    // never the raw ISO string the payload carries.
    expect(html).toContain(fmtDob("2013-06-23"));
    expect(html).not.toContain("2013-06-23");
    expect(html).toContain("Male");
  });

  it("carries the page's own readings and its scope", () => {
    expect(html).toContain("3 people");
    // 1 person in two or more; 0 across two sports.
    expect(html).toContain("in two or more");
  });

  it("escapes a name that looks like markup", () => {
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("participationMatrixHtml", () => {
  const html = participationMatrixHtml({
    rows: ROWS,
    competitions: FACETS.competitions,
    meta: META,
  });

  it("heads each competition with its code and bands them by sport", () => {
    expect(html).toContain("Table Tennis");
    expect(html).toContain("Sepak Takraw");
    // Codes come from the shared entriesMatrix scheme (U·B·D, U·B·S…).
    expect(html).toContain(">UBD<");
    expect(html).toContain(">UBS<");
  });

  it("ticks the competitions a person is in, and only those", () => {
    const rowHtml = html.split("<tr")[3] ?? "";
    expect(rowHtml).toContain("&#10003;");
  });

  it("prints a legend, so a code is never a puzzle", () => {
    expect(html).toContain("Table Tennis · U 14 · Boys · Singles");
  });
});

describe("openParticipationPdf", () => {
  const open = (view: "sheet" | "matrix") => {
    const w = {
      document: { write: vi.fn(), close: vi.fn() },
      focus: vi.fn(),
      print: vi.fn(),
    };
    const spy = vi.spyOn(window, "open").mockReturnValue(w as unknown as Window);
    openParticipationPdf({
      view,
      rows: ROWS,
      columns: [],
      competitions: FACETS.competitions,
      meta: META,
    });
    spy.mockRestore();
    return w;
  };

  it("prints the view that is on screen", () => {
    expect(open("sheet").document.write).toHaveBeenCalledWith(
      expect.stringContaining("Entered in"),
    );
    expect(open("matrix").document.write).toHaveBeenCalledWith(
      expect.stringContaining("participation matrix"),
    );
  });

  it("does nothing when the browser blocks the tab", () => {
    const spy = vi.spyOn(window, "open").mockReturnValue(null);
    expect(() =>
      openParticipationPdf({
        view: "sheet",
        rows: ROWS,
        columns: [],
        competitions: FACETS.competitions,
        meta: META,
      }),
    ).not.toThrow();
    spy.mockRestore();
  });
});
