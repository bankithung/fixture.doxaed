import { Navigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { tournamentsApi } from "@/api/tournaments";
import { routes } from "@/lib/routes";

/** Each setup stage maps to the page where that stage's work happens. Once the
 * fixtures are generated (`ready`) the tournament becomes live-operations
 * software, so the landing is the control room — the ops home — not a setup
 * page (ops 2026-06-26). */
const STAGE_ROUTE: Record<string, (id: string) => string> = {
  setup: routes.tournamentSports,
  org_registration: routes.tournamentInstitutions,
  team_registration: routes.tournamentTeams,
  members: routes.tournamentMembers,
  fixtures: routes.tournamentFixtures,
  ready: routes.tournamentControl,
};

/**
 * Flow landing (the tournament index route). Opening a tournament drops you on
 * the CURRENT stage's page so setup reads as a followed flow, not a wall of tabs.
 * Once `ready`, it lands on the live control room (the operations home); an
 * unknown stage falls back to the overview (stepper) summary.
 */
export function FlowLanding(): React.ReactElement {
  const { id = "" } = useParams();
  const stageQ = useQuery({
    queryKey: ["tournament-stage", id],
    queryFn: () => tournamentsApi.stage(id),
  });

  if (stageQ.isLoading) {
    return (
      <div className="h-40 animate-pulse rounded-xl border border-border bg-muted" />
    );
  }
  const dest =
    STAGE_ROUTE[stageQ.data?.stage ?? ""]?.(id) ?? routes.tournamentOverview(id);
  return <Navigate to={dest} replace />;
}
