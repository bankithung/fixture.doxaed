import { describe, expect, it } from "vitest";
import type { PreviewMatch } from "@/api/tournaments";
import { buildRows, type BlackoutWindow } from "../previewGrid";
import {
  competitionLoads,
  courtDayLoads,
  courtTotals,
  fmtDuration,
} from "../courtLoad";

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

/** One court playing 09:00-09:30, then again 12:30-12:45, on a day that runs
 * 08:00-18:00 with an opening ceremony and a lunch break configured. */
const MATCHES: PreviewMatch[] = [
  m({ ref: "p1", scheduled_at: "2026-08-17T09:00:00" }),
  m({ ref: "p2", scheduled_at: "2026-08-17T09:15:00" }),
  m({ ref: "p3", scheduled_at: "2026-08-17T12:30:00" }),
  // A second court, a different sport, a longer match.
  m({
    ref: "p4",
    leaf_key: "sepak_takraw.u_14.boys",
    group_label: "Sepak Takraw · U-14 · Boys · Group A",
    stage: "group",
    venue: "SPK · T1",
    scheduled_at: "2026-08-17T10:20:00",
    duration_minutes: 25,
  }),
  // Never placed: holds no court at all.
  m({ ref: "p5", scheduled_at: null, venue: "", duration_minutes: null }),
];

const ROWS = buildRows(MATCHES, NAMES, ["p5"]);

const BLACKOUTS: BlackoutWindow[] = [
  { from: "08:00", to: "09:00", date: "2026-08-17", label: "opening" },
  { from: "12:01", to: "12:30", days: [], label: "daily_break" },
];

describe("courtDayLoads", () => {
  const loads = courtDayLoads(ROWS, "08:00", "18:00", BLACKOUTS);

  it("gives every court that played its own row, sorted by day then court", () => {
    expect(loads.map((l) => l.court)).toEqual(["SPK · T1", "TT · T1"]);
  });

  it("counts only the minutes actually played as busy", () => {
    const tt = loads.find((l) => l.court === "TT · T1")!;
    expect(tt.matches).toBe(3);
    expect(tt.busyMinutes).toBe(45);
  });

  it("charges configured windows to breaks, not to free court", () => {
    const tt = loads.find((l) => l.court === "TT · T1")!;
    // 08:00-09:00 ceremony + 12:01-12:30 lunch = 89 minutes closed.
    expect(tt.breakMinutes).toBe(89);
    expect(tt.gaps.filter((g) => g.kind === "break").map((g) => g.label)).toEqual([
      "Opening ceremony",
      "Daily break",
    ]);
  });

  it("reports the unexplained idle time as free court", () => {
    const tt = loads.find((l) => l.court === "TT · T1")!;
    // Window 08:00-18:00 = 600. 45 played, 89 in breaks -> 466 free.
    expect(tt.freeMinutes).toBe(466);
    expect(tt.busyMinutes + tt.freeMinutes + tt.breakMinutes).toBe(600);
  });

  it("names the longest free stretch, which is what an organiser can fill", () => {
    const tt = loads.find((l) => l.court === "TT · T1")!;
    // 12:45 to 18:00 is the biggest hole.
    expect(tt.longestFree?.minutes).toBe(315);
  });

  it("measures utilisation against open hours, not the whole window", () => {
    const tt = loads.find((l) => l.court === "TT · T1")!;
    expect(tt.utilization).toBeCloseTo(45 / (45 + 466), 5);
  });

  it("widens its own window when play falls outside the configured day", () => {
    const early = courtDayLoads(
      buildRows([m({ ref: "q1", scheduled_at: "2026-08-17T07:00:00" })], NAMES, []),
      "08:00",
      "18:00",
      [],
    );
    expect(early[0]!.windowStart).toBe(7 * 60);
    expect(early[0]!.freeMinutes).toBe(660 - 15);
  });

  it("leaves an unplaced match off every court", () => {
    expect(loads.flatMap((l) => l.blocks).map((b) => b.ref)).not.toContain("p5");
  });
});

describe("courtTotals", () => {
  it("adds the courts up and points at the single biggest free block", () => {
    const totals = courtTotals(courtDayLoads(ROWS, "08:00", "18:00", BLACKOUTS));
    expect(totals.courts).toBe(2);
    expect(totals.courtDays).toBe(2);
    expect(totals.busyMinutes).toBe(45 + 25);
    // SPK · T1 plays 10:20-10:45 only, so 12:30-18:00 is the biggest single
    // reclaimable block anywhere — the lunch break splits the afternoon off.
    expect(totals.biggestFree?.gap.minutes).toBe(330);
    expect(totals.biggestFree?.court).toBe("SPK · T1");
  });
});

describe("competitionLoads", () => {
  const sports = competitionLoads(ROWS);

  it("rolls competitions up under their sport, heaviest sport first", () => {
    expect(sports.map((s) => s.sportKey)).toEqual([
      "table_tennis",
      "sepak_takraw",
    ]);
    expect(sports[0]!.minutes).toBe(45);
    expect(sports[1]!.minutes).toBe(25);
  });

  it("counts an unplaced match but charges it no court time", () => {
    const tt = sports[0]!.competitions[0]!;
    expect(tt.matches).toBe(4);
    expect(tt.scheduled).toBe(3);
    expect(tt.minutes).toBe(45);
    expect(tt.avgMinutes).toBe(15);
  });

  it("reports each competition's share of all court time", () => {
    const shares = sports.flatMap((s) => s.competitions).map((c) => c.share);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });

  it("counts the distinct days and courts a competition touches", () => {
    const tt = sports[0]!.competitions[0]!;
    expect(tt.days).toBe(1);
    expect(tt.courts).toBe(1);
  });
});

describe("fmtDuration", () => {
  it("reads in minutes under an hour and in hours above it", () => {
    expect(fmtDuration(0)).toBe("0 min");
    expect(fmtDuration(45)).toBe("45 min");
    expect(fmtDuration(60)).toBe("1h");
    expect(fmtDuration(135)).toBe("2h 15m");
  });
});
