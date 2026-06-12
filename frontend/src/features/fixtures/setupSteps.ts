/** Steps of the asked-ONCE Step 1 wizard (UX clarity rebuild §4.2 — labels
 * recopied; keys/indices are frozen so deep-links keep working). */
export const GLOBAL_SETUP_STEPS = [
  { key: "calendar", label: "Dates" },
  { key: "venues", label: "Venues" },
  { key: "defaults", label: "Play times" },
  { key: "review", label: "Check & save" },
] as const;

/** Step indexes the hub's readiness deep-links open the wizard at. */
export const SETUP_STEP = { calendar: 0, venues: 1, defaults: 2 } as const;
