import { useEffect, useMemo } from "react";
import { useParams } from "react-router-dom";
import {
  buildCompetitions,
  usePublicTournament,
  type Competition,
} from "@/features/fixtures/publicTournament";
import {
  GroupTable,
  LabelChips,
} from "@/features/fixtures/publicTournamentViews";
import { t } from "@/lib/t";
import { PublicViewerHeader } from "./PublicViewerHeader";

/**
 * Public STANDINGS tab (Google-panel style): every competition's group tables
 * in one place, grouped by sport. Columns are sport-native (a table tennis or
 * sepak table reads P W L Sets +/-, never a draw column). Reads the same
 * schedule + standings queries as the Matches and Knockout tabs, so switching
 * tabs is instant and the SSE tick keeps every table live.
 */
export function PublicStandingsPage(): React.ReactElement {
  const { slug = "", id = "" } = useParams();
  const { scheduleQ, standingsQ, connected, hasKnockout } = usePublicTournament(
    slug,
    id,
  );

  const tournamentName = scheduleQ.data?.tournament.name;
  useEffect(() => {
    if (tournamentName) {
      document.title = `${tournamentName} · ${t("Standings")}`;
    }
  }, [tournamentName]);

  // Sport → competitions → groups that actually have a standings table.
  const sections = useMemo(() => {
    const comps = buildCompetitions(
      scheduleQ.data?.matches ?? [],
      standingsQ.data?.groups,
    )
      .map((c) => ({
        ...c,
        groups: c.groups.filter((g) => (g.standing?.rows.length ?? 0) > 0),
      }))
      .filter((c) => c.groups.length > 0);
    const bySport = new Map<string, Competition[]>();
    for (const c of comps) {
      if (!bySport.has(c.sport)) bySport.set(c.sport, []);
      bySport.get(c.sport)!.push(c);
    }
    return [...bySport.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [scheduleQ.data, standingsQ.data]);

  const loading =
    scheduleQ.isLoading || (scheduleQ.data !== undefined && standingsQ.isLoading);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <PublicViewerHeader
        slug={slug}
        id={id}
        tournamentName={tournamentName}
        active="standings"
        connected={connected}
        showKnockout={hasKnockout !== false}
      />
      <main className="flex w-full flex-1 flex-col gap-8 px-4 py-6 sm:px-6 lg:px-8">
        {loading ? (
          <div aria-busy="true" className="h-48 animate-pulse rounded-xl bg-muted/40" />
        ) : scheduleQ.isError ? (
          <p
            role="alert"
            className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground"
          >
            {t("These standings are not available.")}
          </p>
        ) : sections.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <p className="text-sm font-medium">{t("No group tables yet.")}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("Tables appear when the draw places teams into groups.")}
            </p>
          </div>
        ) : (
          sections.map(([sport, comps]) => (
            <section
              key={sport}
              data-testid={`standings-sport-${sport}`}
              className="flex flex-col gap-4"
            >
              <h2 className="text-base font-semibold">{sport}</h2>
              {comps.map((c) => (
                <div
                  key={c.key}
                  data-testid={`standings-comp-${c.key}`}
                  className="flex flex-col gap-2"
                >
                  <LabelChips label={c.label} omitSport />
                  <div className="grid grid-cols-1 items-start gap-x-8 gap-y-4 xl:grid-cols-2">
                    {c.groups.map((g) => (
                      <div
                        key={g.key}
                        className="overflow-hidden rounded-lg border border-border bg-card"
                      >
                        <h3 className="border-b border-border px-4 py-2 text-sm font-semibold">
                          {g.label}
                        </h3>
                        <GroupTable rows={g.standing!.rows} family={c.family} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </section>
          ))
        )}
      </main>
    </div>
  );
}
