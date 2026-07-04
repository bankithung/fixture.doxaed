import type { ComponentType } from "react";
import { FlatLineups } from "./FlatLineups";
import { FootballLineups } from "./FootballLineups";
import { SepakLineups } from "./SepakLineups";
import { TTLineups } from "./TTLineups";
import type { LineupViewProps } from "./types";

/** View-only mirror of the console registry
 * (features/matches/console/registry.ts): a sport-keyed module always beats
 * the family fallback; anything else gets the flat list. */
const BY_SPORT: Record<string, ComponentType<LineupViewProps>> = {
  football: FootballLineups,
  sepak_takraw: SepakLineups,
  table_tennis: TTLineups,
};

const BY_FAMILY: Record<string, ComponentType<LineupViewProps>> = {
  timed: FootballLineups,
};

export function resolveLineupView(
  sportKey: string,
  family: string,
): ComponentType<LineupViewProps> {
  return BY_SPORT[sportKey] ?? BY_FAMILY[family] ?? FlatLineups;
}
