import { describe, expect, it } from "vitest";
import type { ControlRoomMatch, ScheduleChangeEntry } from "@/api/tournaments";
import { delayFor, delayMap } from "../format";

const TZ = "Asia/Kolkata";

function entry(over: Partial<ScheduleChangeEntry>): ScheduleChangeEntry {
  return {
    match_id: "m1",
    match_label: "Alpha vs Bravo",
    leaf_key: "table_tennis.open.boys.singles",
    changed_at: "2026-08-27T06:00:00Z",
    actor: null,
    kind: "delayed",
    old: { scheduled_at: "2026-08-28T09:00:00+05:30", venue: "Audi · T1" },
    new: { scheduled_at: "2026-08-28T09:25:00+05:30", venue: "Audi · T1" },
    reason: "",
    batch_id: "b1",
    ...over,
  } as ScheduleChangeEntry;
}

function match(over: Partial<ControlRoomMatch>): ControlRoomMatch {
  return {
    id: "m1",
    scheduled_at: "2026-08-28T09:25:00+05:30",
    status: "scheduled",
    ...over,
  } as ControlRoomMatch;
}

describe("delayMap", () => {
  it("chips a same-day push with the minutes it moved by", () => {
    const delays = delayMap([entry({})], TZ);
    expect(delayFor(delays, match({}))).toBe(25);
  });

  it("ignores a rain-day shift — a re-plan is not running late", () => {
    // The reported bug: Shift a day moved 63 matches Aug 17 to Aug 28, and
    // every row read "+15840 min" with the band claiming "63 running late".
    const delays = delayMap(
      [
        entry({
          kind: "day_shifted",
          old: { scheduled_at: "2026-08-17T09:00:00+05:30", venue: "Audi · T1" },
          new: { scheduled_at: "2026-08-28T09:00:00+05:30", venue: "Audi · T1" },
        }),
      ],
      TZ,
    );
    expect(
      delayFor(delays, match({ scheduled_at: "2026-08-28T09:00:00+05:30" })),
    ).toBeNull();
  });

  it("ignores a scheduler re-run onto a later slot", () => {
    const delays = delayMap([entry({ kind: "engine_rerun" })], TZ);
    expect(delayFor(delays, match({}))).toBeNull();
  });

  it("ignores a move onto another day in the TOURNAMENT's clock", () => {
    // Same UTC day, different tournament-local day (invariant 14).
    const delays = delayMap(
      [
        entry({
          old: { scheduled_at: "2026-08-28T23:50:00+05:30", venue: "Audi · T1" },
          new: { scheduled_at: "2026-08-29T00:20:00+05:30", venue: "Audi · T1" },
        }),
      ],
      TZ,
    );
    expect(
      delayFor(delays, match({ scheduled_at: "2026-08-29T00:20:00+05:30" })),
    ).toBeNull();
  });

  it("lets a re-plan supersede an older delay on the same match", () => {
    // Reverse-chrono feed: the day shift is newer, so the 25-minute push it
    // overwrote must not chip the match at its new date.
    const delays = delayMap(
      [
        entry({
          kind: "day_shifted",
          old: { scheduled_at: "2026-08-17T09:25:00+05:30", venue: "Audi · T1" },
          new: { scheduled_at: "2026-08-28T09:25:00+05:30", venue: "Audi · T1" },
        }),
        entry({ changed_at: "2026-08-16T06:00:00Z" }),
      ],
      TZ,
    );
    expect(delayFor(delays, match({}))).toBeNull();
  });

  it("drops the chip once the slot moves again", () => {
    const delays = delayMap([entry({})], TZ);
    expect(
      delayFor(delays, match({ scheduled_at: "2026-08-28T10:00:00+05:30" })),
    ).toBeNull();
  });

  it("ignores a pull-forward and a lock row", () => {
    const delays = delayMap(
      [
        entry({
          match_id: "m2",
          new: { scheduled_at: "2026-08-28T08:40:00+05:30", venue: "Audi · T1" },
        }),
        entry({ match_id: "m3", kind: "locked", old: null, new: null }),
      ],
      TZ,
    );
    expect(delayFor(delays, match({ id: "m2" }))).toBeNull();
    expect(delayFor(delays, match({ id: "m3" }))).toBeNull();
  });
});
