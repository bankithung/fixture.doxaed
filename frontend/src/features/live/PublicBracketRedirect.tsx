import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { routes } from "@/lib/routes";

/**
 * The standalone /t/:slug/:id/bracket page is retired: the knockout draw is a
 * scope INSIDE the match centre now (owner 2026-08-21), so nobody has to leave
 * the matches to follow it. Shared links, QR cards and bookmarks still land on
 * the same board — the old page's `sport` / `comp` selection carries over to
 * the board's own params.
 */
export function PublicBracketRedirect(): React.ReactElement {
  const { slug = "", id = "" } = useParams();
  const [params] = useSearchParams();
  const next = new URLSearchParams({ comp: "knockout" });
  const sport = params.get("sport");
  const leaf = params.get("comp");
  if (sport) next.set("kosport", sport);
  if (leaf) next.set("kocomp", leaf);
  return (
    <Navigate to={`${routes.publicSchedule(slug, id)}?${next}`} replace />
  );
}
