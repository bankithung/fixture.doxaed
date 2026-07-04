/** View-only per-sport lineup modules for the public match hub (P6).
 * Mirrors the console registry idea (features/matches/console/registry.ts)
 * but read-only: the hub picks a module off sport_meta.key with a family
 * fallback; the module owns the visual (court, cards, XI list). */

export interface LineupEntryView {
  player_id: string;
  name: string;
  /** "starter" | "substitute" | "" (roster fallback carries no roles). */
  role: string;
  shirt_no: number | null;
  /** Sport slot, e.g. sepak takraw "tekong" | "left_inside" | "right_inside". */
  positional_role: string;
}

export interface LineupSideView {
  teamName: string;
  /** True when this is the confirmed team sheet (not the raw roster). */
  confirmed: boolean;
  entries: LineupEntryView[];
}

export interface LineupViewProps {
  home: LineupSideView | null;
  away: LineupSideView | null;
}

/** Starter/bench split; entries without a known role land in `unroled`
 * (the roster fallback path, rendered as a plain list). */
export function splitRoles(entries: LineupEntryView[]): {
  starters: LineupEntryView[];
  bench: LineupEntryView[];
  unroled: LineupEntryView[];
} {
  return {
    starters: entries.filter((e) => e.role === "starter"),
    bench: entries.filter((e) => e.role === "substitute"),
    unroled: entries.filter(
      (e) => e.role !== "starter" && e.role !== "substitute",
    ),
  };
}
