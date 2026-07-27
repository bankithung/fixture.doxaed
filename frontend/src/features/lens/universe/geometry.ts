/**
 * Pure layout maths for the album "universe" — the school orbit (stage one)
 * and the photo sphere it zooms into (stage two). No React and no DOM: the
 * geometry is the part worth unit-testing, and keeping it here leaves the
 * components as thin transform writers.
 */

export interface DomeSlot {
  /** Longitude about the sphere's vertical axis, degrees (0 faces the viewer). */
  lon: number;
  /** Latitude, degrees; positive is up. */
  lat: number;
  /** Index into the caller's photo list. Small albums repeat, big ones sample. */
  photo: number;
  /** Latitude band, 0 = top. Lets the caller stagger reveal delays. */
  band: number;
}

/** Fewer tiles than this and the ball reads bald; more and cheap phones stutter. */
const MIN_TILES = 24;
const MAX_TILES = 161;
/** Odd band counts keep an equator row — the row the eye actually lands on. */
const BANDS = [5, 7, 9];
/** How far toward the poles tiles reach. Past ~62° a tile is so foreshortened
 *  it reads as a sliver, which looked like damage rather than curvature; the
 *  bare cap it leaves is only ever seen by rotating the ball onto its end. */
const MAX_LAT = 62;

/** Latitude of a band, top (0) to bottom. */
export function bandLat(band: number, bands: number): number {
  if (bands <= 1) return 0;
  return MAX_LAT - (band * (2 * MAX_LAT)) / (bands - 1);
}

/** Equator columns for a band count: one column per row-height of arc, so
 *  tiles come out roughly square. */
function columnsFor(bands: number): number {
  return Math.max(6, Math.round((180 * (bands - 1)) / MAX_LAT));
}

/**
 * Columns in one band. A circle of latitude has radius `R·cos(lat)`, so column
 * count has to fall away with the cosine for tile spacing to stay even — keep
 * the equator's count at the poles and the caps pile into overlapping
 * shingles.
 */
export function bandColumns(band: number, bands: number, columns: number): number {
  const c = Math.cos((bandLat(band, bands) * Math.PI) / 180);
  return Math.max(3, Math.round(columns * c));
}

/** Total tiles a band count yields. */
export function domeCapacity(bands: number): number {
  const columns = columnsFor(bands);
  let n = 0;
  for (let b = 0; b < bands; b += 1) n += bandColumns(b, bands, columns);
  return n;
}

export interface DomePlan {
  slots: DomeSlot[];
  /** Equator columns — the caller sizes tiles from the arc between them. */
  columns: number;
  bands: number;
}

/**
 * Lay `photoCount` photos over a sphere. Aims for roughly two tiles per photo
 * so the ball looks full without any one shot dominating; a photo repeats when
 * the album is small and the list is sampled evenly when it is larger than the
 * tile budget (the grid view is the one that promises every photo).
 */
export function planDome(photoCount: number): DomePlan {
  if (photoCount <= 0) return { slots: [], columns: 0, bands: 0 };
  const target = Math.min(MAX_TILES, Math.max(MIN_TILES, photoCount * 2));
  const bands =
    BANDS.find((b) => domeCapacity(b) >= target) ?? BANDS[BANDS.length - 1];
  const columns = columnsFor(bands);

  const slots: DomeSlot[] = [];
  for (let b = 0; b < bands; b += 1) {
    const cols = bandColumns(b, bands, columns);
    // No half-step stagger between bands: with square tiles it opened a
    // diamond-shaped hole between every four neighbours, and the ball read as
    // a broken paper lantern. Bands already fall out of step with each other
    // because their column counts differ.
    for (let c = 0; c < cols; c += 1) {
      slots.push({
        lon: (c * 360) / cols,
        lat: bandLat(b, bands),
        band: b,
        photo: 0,
      });
    }
  }

  // Close the poles. The grid stops at MAX_LAT so no tile foreshortens into a
  // sliver, which leaves a bare cap — harmless until someone drags the ball
  // onto its end, which is exactly what "rotate in every direction" invites.
  // A three-tile ring plus one tile on the pole itself covers it.
  const capLat = 90 - (90 - MAX_LAT) / 2;
  for (const sign of [1, -1]) {
    const band = sign > 0 ? 0 : bands - 1;
    for (let c = 0; c < 3; c += 1) {
      slots.push({ lon: (c * 360) / 3, lat: sign * capLat, band, photo: 0 });
    }
    slots.push({ lon: 0, lat: sign * 90, band, photo: 0 });
  }

  const n = slots.length;
  for (let i = 0; i < n; i += 1) {
    slots[i].photo =
      photoCount <= n ? i % photoCount : Math.floor((i * photoCount) / n);
  }
  return { slots, columns, bands };
}

export interface OrbitSlot {
  /** Ring index, 0 = innermost. */
  ring: number;
  /** Angle on the ring at t=0, degrees. */
  angle: number;
  /** Ring radius as a fraction of the stage's half-size. */
  radius: number;
  /** Seconds for one lap. Outer rings run slower, as they should. */
  period: number;
}

/**
 * Place one planet per school. Rings are chosen by headcount rather than
 * filled to a fixed capacity: eight schools want one generous ring, twenty
 * want three, and nothing in between should look like a mistake.
 */
export function planOrbit(count: number): OrbitSlot[] {
  if (count <= 0) return [];
  const rings = count <= 8 ? 1 : count <= 18 ? 2 : 3;
  const radii = rings === 1 ? [0.66] : rings === 2 ? [0.44, 0.86] : [0.32, 0.63, 0.94];
  const periods = rings === 1 ? [64] : rings === 2 ? [48, 84] : [42, 68, 100];

  // Share the schools out in proportion to circumference, so planet spacing
  // stays even from the inner ring to the outer one.
  const weight = radii.reduce((a, r) => a + r, 0);
  const per = radii.map((r) => Math.max(1, Math.round((count * r) / weight)));
  let over = per.reduce((a, n) => a + n, 0) - count;
  for (let i = per.length - 1; i >= 0 && over !== 0; i -= 1) {
    const take = Math.min(per[i] - 1, over);
    if (over > 0 && take > 0) {
      per[i] -= take;
      over -= take;
    } else if (over < 0) {
      per[i] -= over;
      over = 0;
    }
  }

  const slots: OrbitSlot[] = [];
  per.forEach((n, ring) => {
    for (let i = 0; i < n; i += 1) {
      slots.push({
        ring,
        // A per-ring twist keeps planets off a single radial line.
        angle: (i * 360) / n + ring * 17,
        radius: radii[ring],
        period: periods[ring],
      });
    }
  });
  return slots.slice(0, count);
}
