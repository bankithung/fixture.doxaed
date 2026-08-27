import { describe, expect, it } from "vitest";

import type { MatchRow } from "@/api/tournaments";
import { publishedRows } from "../publishedExport";
import { matchNumbers } from "../publicTournament";

const m = (over: Partial<MatchRow> = {}): MatchRow => ({
  id: "11111111-1111-7111-8111-111111111111",
  stage: "knockout",
  group_label: "",
  round_no: 1,
  match_no: 1,
  status: "scheduled",
  home_team: { id: "t1", name: "Grace Academy TT-1" } as MatchRow["home_team"],
  away_team: { id: "t2", name: "Lorna's School TT-1" } as MatchRow["away_team"],
  home_score: null,
  away_score: null,
  sport: "table_tennis",
  set_scores: [],
  leaf_key: "table_tennis.u_14.boys.singles",
  venue: "Audi · T1",
  scoring: null,
  scheduled_at: "2026-08-28T03:30:00Z",
  duration_minutes: 10,
  ...over,
});

describe("publishedRows", () => {
  it("prints the tournament's wall clock, not the UTC instant", () => {
    const [row] = publishedRows([m()], "Asia/Kolkata");
    expect(row.start).toBe("09:00");
    expect(row.end).toBe("09:10");
    expect(row.day).toBe("2026-08-28");
  });

  it("rolls the day over when local time is past midnight", () => {
    const [row] = publishedRows(
      [m({ scheduled_at: "2026-08-28T19:30:00Z" })],
      "Asia/Kolkata",
    );
    expect(row.day).toBe("2026-08-29");
    expect(row.start).toBe("01:00");
  });

  it("leaves an unscheduled match without a time", () => {
    const [row] = publishedRows([m({ scheduled_at: null })], "Asia/Kolkata");
    expect(row.start).toBe("");
    expect(row.placed).toBe(false);
  });

  it("reads UTC unchanged", () => {
    const [row] = publishedRows([m()], "UTC");
    expect(row.start).toBe("03:30");
  });
});

/**
 * THE NUMBERS. A printed document and the public sheet must call the same
 * match by the same number — get the tie-break wrong and the document's own
 * "Winner of Match 18" points at a game the board calls M16 (owner
 * 2026-08-27, the sepak takraw quarter-finals).
 */
describe("publishedRows · numbering", () => {
  // Four quarter-finals of one competition, drawn in `match_no` order but
  // handed over in uuid order — which is the order a REST list can arrive in.
  const KO = [16, 17, 18, 19].map((no, i) =>
    m({
      id: `0000000${9 - i}-0000-7000-8000-00000000000${i}`,
      match_no: no,
      round_no: 2,
      leaf_key: "sepak_takraw.u_14.boys",
      stage: "knockout",
    }),
  );

  it("numbers a committed match exactly as the public schedule does", () => {
    const rows = publishedRows(KO, "Asia/Kolkata");
    const public_ = matchNumbers(KO);
    for (const r of rows) {
      expect(r.number).toBe(public_.get(r.ref));
    }
    // And the numbers are the draw's own order, not the uuid's.
    const byNo = new Map(KO.map((k) => [k.id, k.match_no]));
    const ordered = [...rows].sort((a, b) => a.number - b.number);
    expect(ordered.map((r) => byNo.get(r.ref))).toEqual([16, 17, 18, 19]);
  });

  it("points a bracket pointer at that same number", () => {
    const semi = m({
      id: "0000000a-0000-7000-8000-00000000000a",
      match_no: 20,
      round_no: 3,
      leaf_key: "sepak_takraw.u_14.boys",
      stage: "knockout",
      home_team: null,
      home_source: { type: "winner_of", match_id: KO[2]!.id },
    });
    const rows = publishedRows([...KO, semi], "Asia/Kolkata");
    const qf = rows.find((r) => r.ref === KO[2]!.id)!;
    const sf = rows.find((r) => r.ref === semi.id)!;
    expect(sf.home).toBe(`Winner of Match ${qf.number}`);
  });

  it("counts each competition from one", () => {
    const other = m({
      id: "0000000b-0000-7000-8000-00000000000b",
      match_no: 40,
      round_no: 1,
      leaf_key: "table_tennis.u_14.girls.singles",
      stage: "knockout",
    });
    const rows = publishedRows([...KO, other], "Asia/Kolkata");
    expect(rows.find((r) => r.ref === other.id)!.number).toBe(1);
  });
});
