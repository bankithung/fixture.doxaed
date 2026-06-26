/**
 * Court-label format — the SINGLE frontend source of truth, kept in lockstep
 * with the backend `scheduler.court_venue_name` (`backend/apps/fixtures/
 * services/scheduler.py`). The separator is U+00B7 MIDDLE DOT (never a hyphen
 * or em/en-dash). Court identity is encoded in the `Match.venue` string (there
 * is no separate court column), so THIS exact label is what the court picker
 * submits and what the server's double-book / court-capacity checks key off —
 * a mismatched separator would silently let two matches share one court.
 */
export function courtLabel(base: string, index: number): string {
  return `${base} · T${index}`;
}

/**
 * The selectable court display names for a venue: a multi-court venue
 * (`count > 1`) expands to one entry per parallel court ("Hall · T1"…), a
 * single-court venue stays bare. Mirrors the backend `expand_venues`.
 */
export function venueCourtOptions(v: { name: string; count?: number }): string[] {
  const n = Math.max(1, v.count ?? 1);
  if (n <= 1) return [v.name];
  return Array.from({ length: n }, (_, i) => courtLabel(v.name, i + 1));
}
