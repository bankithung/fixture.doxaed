import type { ComponentType } from "react";
import {
  TargetSportConsole,
  type TargetSportConsoleProps,
} from "./TargetSportConsole";
import { SepakConsole } from "./SepakConsole";
import { TTConsole } from "./TTConsole";

/** A pluggable per-sport scoring surface. The chassis (MatchConsolePage)
 * keeps the header, event log, transitions and dialogs; the module owns the
 * scoreboard + score entry. */
export interface SportConsoleModule {
  Console: ComponentType<TargetSportConsoleProps>;
}

// Native per-sport consoles (P2 registers sepak_takraw / table_tennis here).
// A sport-keyed module always beats the family fallback.
const BY_SPORT: Record<string, SportConsoleModule> = {
  sepak_takraw: { Console: SepakConsole },
  table_tennis: { Console: TTConsole },
};

// Family fallbacks: any target/set sport without a native console gets the
// generic set surface. Timed sports have no module — the chassis renders its
// own football surface.
const BY_FAMILY: Record<string, SportConsoleModule> = {
  target: { Console: TargetSportConsole },
};

export function resolveConsole(
  sportKey: string,
  family: string,
): SportConsoleModule | null {
  return BY_SPORT[sportKey] ?? BY_FAMILY[family] ?? null;
}
