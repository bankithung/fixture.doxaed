/** Steps of the asked-ONCE GlobalSetupWizard (redesign §6 screen 2). */
export const GLOBAL_SETUP_STEPS = [
  { key: "calendar", label: "Calendar" },
  { key: "venues", label: "Venues" },
  { key: "defaults", label: "Defaults" },
  { key: "review", label: "Review" },
] as const;

/** Step indexes the hub's readiness deep-links open the wizard at. */
export const SETUP_STEP = { calendar: 0, venues: 1, defaults: 2 } as const;
