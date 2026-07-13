import { useEffect, useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  buildCompetitions,
  usePublicTournament,
  type Competition,
} from "@/features/fixtures/publicTournament";
import {
  Bookmark,
  GroupTable,
} from "@/features/fixtures/publicTournamentViews";
import { splitLabel } from "@/features/fixtures/publicTournament";
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
  const [params, setParams] = useSearchParams();
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

  // Every competition that has a table, grouped by sport.
  const all = useMemo(() => {
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

  // Sport + category filter (owner 2026-07-13: a 20-competition tournament
  // stacked every table on one page). Kept in the URL so a filtered view is
  // shareable; an unknown value falls back to showing everything.
  const sportParam = params.get("sport") ?? "";
  const compParam = params.get("comp") ?? "";
  const sport = all.some(([s]) => s === sportParam) ? sportParam : "";
  const compsOfSport = useMemo(
    () => (sport ? (all.find(([s]) => s === sport)?.[1] ?? []) : []),
    [all, sport],
  );
  const comp = compsOfSport.some((c) => c.key === compParam) ? compParam : "";

  const setFilter = (next: { sport?: string; comp?: string }): void => {
    const p = new URLSearchParams(params);
    const s = next.sport ?? sport;
    const c = next.comp ?? "";
    if (s) p.set("sport", s);
    else p.delete("sport");
    if (c) p.set("comp", c);
    else p.delete("comp");
    setParams(p, { replace: true });
  };

  const sections = useMemo(
    () =>
      all
        .filter(([s]) => !sport || s === sport)
        .map(
          ([s, comps]) =>
            [s, comp ? comps.filter((c) => c.key === comp) : comps] as [
              string,
              Competition[],
            ],
        ),
    [all, sport, comp],
  );

  const loading =
    scheduleQ.isLoading || (scheduleQ.data !== undefined && standingsQ.isLoading);

  return (
    <div className="flex min-h-screen flex-col">
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
        ) : all.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <p className="text-sm font-medium">{t("No group tables yet.")}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("Tables appear when the draw places teams into groups.")}
            </p>
          </div>
        ) : (
          /* ONE combined sheet: sport bookmarks on top, category bookmarks
             inside, every table in the same panel with a clear rule between
             categories (owner 2026-07-13). */
          <div data-testid="standings-board" className="flex flex-col">
            <div
              role="tablist"
              aria-label={t("Sports")}
              className="flex flex-wrap items-end gap-1 overflow-x-auto px-2"
            >
              <Bookmark
                testid="standings-sport-all"
                active={!sport}
                onClick={() => setFilter({ sport: "", comp: "" })}
                label={t("All sports")}
                count={all.reduce((n, [, comps]) => n + comps.length, 0)}
              />
              {all.map(([s, comps]) => (
                <Bookmark
                  key={s}
                  testid={`standings-sport-pick-${s}`}
                  active={sport === s}
                  onClick={() => setFilter({ sport: s, comp: "" })}
                  label={s}
                  count={comps.length}
                />
              ))}
            </div>

            <div className="flex flex-col gap-5 rounded-xl rounded-tl-none border border-border bg-card p-4 shadow-sm sm:p-5">
              {sport && compsOfSport.length > 1 ? (
                <div
                  role="tablist"
                  aria-label={t("Categories")}
                  className="flex flex-wrap items-center gap-1.5 border-b border-border pb-3"
                >
                  <Bookmark
                    testid="standings-comp-all"
                    active={!comp}
                    onClick={() => setFilter({ comp: "" })}
                    label={t("All categories")}
                  />
                  {compsOfSport.map((c) => (
                    <Bookmark
                      key={c.key}
                      testid={`standings-comp-pick-${c.key}`}
                      active={comp === c.key}
                      onClick={() => setFilter({ comp: c.key })}
                      label={splitLabel(c.label).slice(1).join(" ") || c.label}
                    />
                  ))}
                </div>
              ) : null}

              {sections.map(([s, comps]) => (
                <section
                  key={s}
                  data-testid={`standings-sport-${s}`}
                  className="flex flex-col gap-5"
                >
                  {!sport ? (
                    <h2 className="text-base font-semibold">{s}</h2>
                  ) : null}
                  {comps.map((c) => (
                    <div
                      key={c.key}
                      data-testid={`standings-comp-${c.key}`}
                      className="flex flex-col overflow-hidden rounded-xl border border-border"
                    >
                      {/* Each category is its OWN titled block: a real
                          heading on a tinted band, not tiny chips. */}
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted/60 px-4 py-2.5">
                        <h3 className="text-sm font-semibold">
                          {splitLabel(c.label).slice(1).join(" · ") || c.label}
                        </h3>
                        <span className="font-tabular text-xs text-muted-foreground">
                          {c.groups.length}{" "}
                          {c.groups.length === 1 ? t("group") : t("groups")}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 items-start gap-x-6 gap-y-5 p-4 xl:grid-cols-2">
                        {c.groups.map((g) => (
                          <div key={g.key} className="flex flex-col">
                            <h4 className="pb-1 text-xs font-semibold uppercase tracking-wide text-primary">
                              {g.label}
                            </h4>
                            <div className="overflow-hidden rounded-lg border border-border">
                              <GroupTable
                                rows={g.standing!.rows}
                                family={c.family}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
