import { Navigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { tournamentsApi } from "@/api/tournaments";
import { routes } from "@/lib/routes";

/** Each setup stage maps to the page where that stage's work happens. */
const STAGE_ROUTE: Record<string, (id: string) => string> = {
  setup: routes.tournamentSports,
  org_registration: routes.tournamentInstitutions,
  team_registration: routes.tournamentTeams,
  members: routes.tournamentMembers,
  fixtures: routes.tournamentFixtures,
};

/**
 * Flow landing (the tournament index route). Opening a tournament drops you on
 * the CURRENT stage's page so setup reads as a followed flow, not a wall of tabs.
 * "ready"/unknown → the overview (stepper) summary. The stepper + Continue live
 * on /overview, reachable any time from the sidebar.
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
