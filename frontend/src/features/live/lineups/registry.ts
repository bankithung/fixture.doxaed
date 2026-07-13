import type { ComponentType } from "react";
import { FlatLineups } from "./FlatLineups";
import { FootballLineups } from "./FootballLineups";
import { SepakLineups } from "./SepakLineups";
import { TTLineups } from "./TTLineups";
import type { LineupViewProps } from "./types";

/** A pluggable, view-only per-sport lineup surface for the public hub.
 * Mirrors the console registry (features/matches/console/registry.ts):
 * a sport-keyed module always beats the family fallback; anything else
 * gets the flat list. */
export interface LineupViewModule {
  Lineups: ComponentType<LineupViewProps>;
}

const BY_SPORT: Record<string, LineupViewModule> = {
  football: { Lineups: FootballLineups },
  sepak_takraw: { Lineups: SepakLineups },
  table_tennis: { Lineups: TTLineups },
};

const BY_FAMILY: Record<string, LineupViewModule> = {
  timed: { Lineups: FootballLineups },
};

const FALLBACK: LineupViewModule = { Lineups: FlatLineups };

/** Selectable on-court slots per sport, for the console's team sheet. Empty
 * = the sport has no fixed positions (the court fills in roster order). */
const SLOTS_BY_SPORT: Record<string, { key: string; label: string }[]> = {
  sepak_takraw: [
    { key: "tekong", label: "Tekong" },
    { key: "left_inside", label: "Left inside" },
    { key: "right_inside", label: "Right inside" },
  ],
  football: [
    { key: "gk", label: "Goalkeeper" },
    { key: "def", label: "Defence" },
    { key: "mid", label: "Midfield" },
    { key: "fwd", label: "Attack" },
  ],
};

export function slotsForSport(
  sportKey: string,
): { key: string; label: string }[] {
  return SLOTS_BY_SPORT[sportKey] ?? [];
}

export function resolveLineupView(
  sportKey: string,
  family: string,
): LineupViewModule {
  return BY_SPORT[sportKey] ?? BY_FAMILY[family] ?? FALLBACK;
}
