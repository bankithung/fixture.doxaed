import { describe, expect, it } from "vitest";
import { courtLabel, venueCourtOptions } from "../courts";

describe("courtLabel", () => {
  it("matches the backend court-suffix format (U+00B7 middle dot)", () => {
    // Must stay byte-identical to scheduler.court_venue_name — the court string
    // is what double-book / capacity checks key off.
    expect(courtLabel("Hall", 2)).toBe("Hall · T2");
    expect(courtLabel("MP Ground", 1)).toBe("MP Ground · T1");
  });
});

describe("venueCourtOptions", () => {
  it("expands a multi-court venue into one entry per court", () => {
    expect(venueCourtOptions({ name: "Hall", count: 3 })).toEqual([
      "Hall · T1",
      "Hall · T2",
      "Hall · T3",
    ]);
  });

  it("leaves a single-court venue bare", () => {
    expect(venueCourtOptions({ name: "Hall", count: 1 })).toEqual(["Hall"]);
    expect(venueCourtOptions({ name: "Hall" })).toEqual(["Hall"]);
    expect(venueCourtOptions({ name: "Hall", count: 0 })).toEqual(["Hall"]);
  });
});
