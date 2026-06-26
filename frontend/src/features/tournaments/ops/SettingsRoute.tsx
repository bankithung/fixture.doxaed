import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { tournamentsApi } from "@/api/tournaments";
import { qk } from "@/lib/queryKeys";
import { SettingsTab } from "@/features/tournaments/tabs/SettingsTab";
import { OpsSettingsPage } from "./OpsSettingsPage";

/**
 * /settings route resolver. Once fixtures are generated (`ready`) the tournament
 * is live-operations software, so settings means the operations console
 * (identity, public links, audit, setup hatch, danger zone) — not the setup-era
 * scoring-rules editor, which stays for the pre-generation stages and is still
 * reachable from the ops Settings "Setup & configuration" hatch.
 */
export function SettingsRoute(): React.ReactElement {
  const { id = "" } = useParams();
  const stageQ = useQuery({
    queryKey: qk.stage(id),
    queryFn: () => tournamentsApi.stage(id),
  });

  if (stageQ.isLoading) {
    return (
      <div className="h-48 animate-pulse rounded-xl border border-border bg-card" />
    );
  }
  return stageQ.data?.stage === "ready" ? <OpsSettingsPage /> : <SettingsTab />;
}
