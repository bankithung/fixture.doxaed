import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
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
    <div className="flex w-full flex-col gap-4 px-4 py-6 sm:px-6 lg:px-8">
      <Link
        to={routes.tournamentFixtures(id)}
        className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
        {t("Back to fixtures")}
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">{t("Bracket / flow view")}</h1>
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
