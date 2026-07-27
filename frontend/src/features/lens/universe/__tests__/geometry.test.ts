import { describe, expect, it } from "vitest";
import { bandColumns, bandLat, domeCapacity, planDome, planOrbit } from "../geometry";

describe("planDome", () => {
  it("has nothing to lay out for an empty album", () => {
    expect(planDome(0).slots).toEqual([]);
    expect(planDome(0).columns).toBe(0);
  });

  it("keeps every tile on the sphere", () => {
    for (const n of [1, 7, 24, 40, 90, 300]) {
      const { slots } = planDome(n);
      expect(slots.length).toBeGreaterThan(0);
      // A DOM budget, not a suggestion: these are live <img> elements.
      expect(slots.length).toBeLessThanOrEqual(170);
      for (const s of slots) {
        expect(s.lat).toBeGreaterThanOrEqual(-90);
        expect(s.lat).toBeLessThanOrEqual(90);
        expect(s.lon).toBeGreaterThanOrEqual(0);
        expect(s.lon).toBeLessThan(360);
        expect(s.photo).toBeGreaterThanOrEqual(0);
        expect(s.photo).toBeLessThan(n);
      }
    }
  });

  it("shows every photo when the album fits the ball, repeating to fill it", () => {
    const { slots } = planDome(9);
    const used = new Set(slots.map((s) => s.photo));
    expect([...used].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    // Nine photos do not make a sphere on their own — repetition is the point.
    expect(slots.length).toBeGreaterThan(9);
  });

  it("samples across a big album rather than truncating the front of it", () => {
    const { slots } = planDome(400);
    const used = [...new Set(slots.map((s) => s.photo))].sort((a, b) => a - b);
    // The last photo is represented, which a naive `i % count` would never do.
    expect(used[0]).toBe(0);
    expect(used[used.length - 1]).toBeGreaterThan(390);
  });

  it("closes both poles, so rotating the ball onto its end shows no hole", () => {
    const lats = planDome(40).slots.map((s) => s.lat);
    expect(lats).toContain(90);
    expect(lats).toContain(-90);
  });

  it("grows the grid with the album, and thins columns toward the poles", () => {
    expect(planDome(10).bands).toBe(5);
    expect(planDome(30).bands).toBe(7);
    expect(planDome(120).bands).toBe(9);
    expect(domeCapacity(5)).toBeLessThan(domeCapacity(7));

    const bands = 7;
    const equator = bandColumns(3, bands, 17);
    const cap = bandColumns(0, bands, 17);
    expect(bandLat(3, bands)).toBe(0);
    expect(cap).toBeLessThan(equator);
    expect(cap).toBeGreaterThanOrEqual(3);
  });
});

describe("planOrbit", () => {
  it("places exactly one planet per school", () => {
    for (const n of [1, 3, 8, 9, 18, 19, 40]) {
      expect(planOrbit(n)).toHaveLength(n);
    }
    expect(planOrbit(0)).toEqual([]);
  });

  it("adds rings as the field grows, and slows the outer ones down", () => {
    const rings = (n: number): number =>
      new Set(planOrbit(n).map((s) => s.ring)).size;
    expect(rings(6)).toBe(1);
    expect(rings(14)).toBe(2);
    expect(rings(24)).toBe(3);

    const three = planOrbit(24);
    const inner = three.find((s) => s.ring === 0)!;
    const outer = three.find((s) => s.ring === 2)!;
    expect(outer.radius).toBeGreaterThan(inner.radius);
    expect(outer.period).toBeGreaterThan(inner.period);
  });

  it("spreads planets around each ring instead of stacking them", () => {
    const outer = planOrbit(24).filter((s) => s.ring === 2);
    const angles = new Set(outer.map((s) => s.angle));
    expect(angles.size).toBe(outer.length);
    for (const s of planOrbit(24)) {
      expect(s.radius).toBeGreaterThan(0);
      expect(s.period).toBeGreaterThan(0);
    }
  });
});
