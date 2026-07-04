import { Navigate, useParams } from "react-router-dom";
import { routes } from "@/lib/routes";

/**
 * The old /t/:slug/:id/live scoreboard is retired: live matches lift into the
 * pinned "Now playing" band on the Matches tab, so shared and bookmarked live
 * links land there instead of a dead page.
 */
export function PublicLiveRedirect(): React.ReactElement {
  const { slug = "", id = "" } = useParams();
  return <Navigate to={routes.publicSchedule(slug, id)} replace />;
}
