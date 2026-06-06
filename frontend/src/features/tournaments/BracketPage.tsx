import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { tournamentsApi } from "@/api/tournaments";
import { BracketView } from "./BracketView";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/** Full-width visual bracket / flow view of a tournament's fixtures. */
export function BracketPage(): React.ReactElement {
  const { id = "" } = useParams();
  const query = useQuery({
    queryKey: ["t-matches", id],
    queryFn: () => tournamentsApi.matches(id),
  });

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t("Bracket / flow view")}</h1>
        <Link
          to={routes.tournamentDetail(id)}
          className="text-sm font-medium text-primary hover:underline"
        >
          {t("← Back to tournament")}
        </Link>
      </div>
      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">{t("Loading...")}</p>
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t("Could not load fixtures.")}
        </p>
      ) : (
        <BracketView matches={query.data ?? []} />
      )}
    </div>
  );
}
