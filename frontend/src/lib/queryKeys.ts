import type { QueryClient } from "@tanstack/react-query";

/**
 * Central query-key factory. Every page/mutation MUST build tournament-scoped
 * keys from here so a change on one page invalidates the same cache another page
 * reads — the root cause of "I pressed save but it didn't reflect until refresh"
 * was two key families for the same data (e.g. ["forms"] vs ["t-forms"]).
 */
export const qk = {
  tournaments: () => ["tournaments"] as const,
  tournament: (id: string) => ["tournament", id] as const,
  stage: (id: string) => ["tournament-stage", id] as const,
  teams: (id: string) => ["t-teams", id] as const,
  institutions: (id: string) => ["t-institutions", id] as const,
  matches: (id: string) => ["t-matches", id] as const,
  standings: (id: string) => ["t-standings", id] as const,
  /** Form LIST for a tournament (the canonical key the forms feature uses). */
  forms: (tournamentId: string) => ["forms", tournamentId] as const,
  /** A single form (builder/public). */
  form: (formId: string) => ["form", formId] as const,
  disputes: (id: string) => ["disputes", id] as const,
  audit: (id: string) => ["audit", id] as const,
  settings: (id: string) => ["t-settings", id] as const,
  /** Workspace venue pool (fixture-engine redesign §2.3). */
  venues: (id: string) => ["t-venues", id] as const,
  /** Per-competition draw configuration layers (§2.1). */
  drawConfig: (id: string) => ["t-draw-config", id] as const,
  /** Server-computed fixture-readiness checklist (§5.1). */
  fixtureReadiness: (id: string) => ["t-fixture-readiness", id] as const,
};

/**
 * Invalidate EVERY tournament-scoped query so all open pages re-fetch after a
 * mutation. Call this from any mutation that changes tournament data (stage,
 * teams, institutions, fixtures, forms, scores) instead of hand-listing keys —
 * that hand-listing is what drifted and left pages stale.
 */
export function invalidateTournament(qc: QueryClient, id: string): void {
  const keys = [
    qk.tournament(id),
    qk.stage(id),
    qk.teams(id),
    qk.institutions(id),
    qk.matches(id),
    qk.standings(id),
    qk.forms(id),
    qk.disputes(id),
    qk.audit(id),
    qk.settings(id),
    qk.venues(id),
    qk.drawConfig(id),
    qk.fixtureReadiness(id),
  ];
  for (const key of keys) qc.invalidateQueries({ queryKey: key });
  // The tournaments hub may show this tournament's summary too.
  qc.invalidateQueries({ queryKey: qk.tournaments() });
}
