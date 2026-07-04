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

export function resolveLineupView(
  sportKey: string,
  family: string,
): LineupViewModule {
  return BY_SPORT[sportKey] ?? BY_FAMILY[family] ?? FALLBACK;
}
