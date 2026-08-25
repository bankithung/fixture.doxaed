import { useEffect, useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Download, Printer, Search } from "lucide-react";
import { tournamentsApi } from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/Select";
import { PublicViewerHeader } from "@/features/live/PublicViewerHeader";
import { Bookmark } from "@/features/fixtures/publicTournamentViews";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { ChampionsView } from "./ChampionsView";
import { PointsChart } from "./PointsChart";
import { StudentsView } from "./StudentsView";
import { TallyGrid } from "./TallyGrid";
import {
  chartBars,
  multiEventCount,
  resultBands,
  resultColumns,
  tallyCsv,
  visibleSchools,
  visibleStudents,
  type StudentSort,
  type TallySort,
} from "./resultsMatrix";

/**
 * Public RESULTS tab — the medal tally.
 *
 * Matches answers "what is being played", Standings "who is winning today" and
 * Schools "who is here". This answers the one a school takes home: **what did
 * we win**. It is modelled on the sheet ANPSA retype into Word after every meet
 * (schools down, one column per event, the placing in the cell), with the two
 * things the paper cannot do: the points that settle the argument, and the
 * students behind the medals.
 *
 * **Nothing here decides anything.** Placings are derived from the fixture on
 * the server the moment a final ends, so this page cannot disagree with the
 * bracket it came from, and one payload feeds all three views so they cannot
 * disagree with each other.
 *
 * The scoping rule the entries matrix got wrong is fixed here by construction:
 * every number on screen — row totals, column footer, grand total, the CSV — is
 * computed from the columns CURRENTLY VISIBLE, so a filtered sheet is
 * internally consistent.
 */

type View = "tally" | "champions" | "students";
const VIEWS: View[] = ["tally", "champions", "students"];

function Stat({
  value,
  label,
  hint,
}: {
  value: number | string;
  label: string;
  hint?: string;
}): React.ReactElement {
  return (
    <div className="flex flex-col">
      <span className="font-tabular text-2xl font-semibold">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
      {hint ? (
        <span className="text-[0.6875rem] text-muted-foreground/80">{hint}</span>
      ) : null}
    </div>
  );
}

export function PublicResultsPage(): React.ReactElement {
  const { slug = "", id = "" } = useParams();
  const [params, setParams] = useSearchParams();

  const q = useQuery({
    queryKey: ["public-results", slug, id],
    queryFn: () => tournamentsApi.publicResults(slug, id),
    // A tally moves when a final ends, not on a score tick, so this tab does
    // not ride the SSE stream — but it must not go stale during a meet either.
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  const tournamentName = q.data?.tournament.name;
  useEffect(() => {
    if (tournamentName) document.title = `${tournamentName} · ${t("Results")}`;
  }, [tournamentName]);

  const setParam = (next: Record<string, string | null>): void => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    setParams(p, { replace: true });
  };

  const viewParam = (params.get("view") ?? "") as View;
  const view: View = VIEWS.includes(viewParam) ? viewParam : "tally";
  const search = params.get("q") ?? "";
  const sortParam = params.get("sort") ?? "";
  const medalistsOnly = params.get("medalists") === "1";

  const allColumns = useMemo(
    () => resultColumns(q.data?.competitions ?? []),
    [q.data],
  );
  const bands = useMemo(() => resultBands(allColumns), [allColumns]);
  const sportParam = params.get("sport") ?? "";
  const sport = bands.some((b) => b.sportKey === sportParam) ? sportParam : "";
  const shownBands = useMemo(
    () => (sport ? bands.filter((b) => b.sportKey === sport) : bands),
    [bands, sport],
  );
  const columns = useMemo(
    () => shownBands.flatMap((b) => b.columns),
    [shownBands],
  );

  const places = q.data?.awards.places ?? [1, 2, 3];
  const ladder = useMemo(() => q.data?.awards.ladder ?? [], [q.data]);
  const labelOf = (place: number): string =>
    ladder.find((l) => l.place === place)?.label || `${place}`;
  const competitionLabel = (leafKey: string): string => {
    const c = allColumns.find((x) => x.leaf_key === leafKey);
    return c ? `${c.sport_name} ${c.title}` : leafKey;
  };

  const tallySort: TallySort = (["points", "golds", "name"] as const).includes(
    sortParam as TallySort,
  )
    ? (sortParam as TallySort)
    : "points";
  const schools = useMemo(
    () =>
      visibleSchools(q.data?.schools ?? [], columns, {
        search,
        sort: tallySort,
        medalistsOnly,
        places,
      }),
    [q.data, columns, search, tallySort, medalistsOnly, places],
  );
  const bars = useMemo(
    () => chartBars(visibleSchools(q.data?.schools ?? [], columns, { places }), columns),
    [q.data, columns, places],
  );

  const studentSort: StudentSort = (["points", "events", "name"] as const).includes(
    sortParam as StudentSort,
  )
    ? (sortParam as StudentSort)
    : "points";
  const students = useMemo(
    () =>
      visibleStudents(q.data?.students ?? [], {
        search,
        sport,
        medalistsOnly,
        sort: studentSort,
      }),
    [q.data, search, sport, medalistsOnly, studentSort],
  );

  const downloadCsv = (): void => {
    if (!q.data) return;
    const blob = new Blob([tallyCsv(columns, schools, places, ladder)], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug || "tournament"}-results.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const totals = q.data?.totals;
  const decidedAll =
    !!totals && totals.competitions > 0 && totals.decided === totals.competitions;

  return (
    <div className="flex min-h-screen flex-col print-doc">
      <PublicViewerHeader
        slug={slug}
        id={id}
        tournamentName={tournamentName}
        active="results"
        connected={false}
      />
      <main className="flex w-full flex-1 flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
        {/* A real heading, and the only thing that survives onto paper: the
            print sheet must name the meet it is a tally of. */}
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              {t("Results")}
            </h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              <span className="hidden print:inline">
                {tournamentName}
                {" · "}
              </span>
              {totals
                ? `${totals.decided} ${t("of")} ${totals.competitions} ${
                    totals.competitions === 1
                      ? t("competition decided")
                      : t("competitions decided")
                  }`
                : t("Medal tally, points and category champions")}
            </p>
          </div>
          <div className="flex items-center gap-2 print:hidden">
            <Button
              size="sm"
              variant="outline"
              onClick={downloadCsv}
              data-testid="results-csv"
            >
              <Download className="mr-1.5 h-4 w-4" />
              {t("CSV")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => window.print()}
              data-testid="results-print"
            >
              <Printer className="mr-1.5 h-4 w-4" />
              {t("Print / PDF")}
            </Button>
          </div>
        </header>

        {q.isLoading ? (
          <div
            aria-busy="true"
            className="h-64 animate-pulse rounded-xl bg-muted/40"
          />
        ) : q.isError || !q.data ? (
          <p
            role="alert"
            className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground"
          >
            {t("These results are not available.")}
          </p>
        ) : !q.data.competitions.length ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <p className="text-sm font-medium">{t("No competitions yet.")}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("Results appear here as each competition finishes.")}
            </p>
          </div>
        ) : (
          <>
            <section
              data-testid="results-summary"
              className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-xl border border-border bg-card px-5 py-4 shadow-sm"
            >
              <Stat value={q.data.totals.medals} label={t("Medals awarded")} />
              <Stat value={q.data.totals.points} label={t("Points awarded")} />
              <Stat
                value={`${q.data.totals.decided}/${q.data.totals.competitions}`}
                label={t("Competitions decided")}
              />
              <Stat
                value={q.data.totals.students}
                label={t("Students")}
                hint={`${multiEventCount(q.data.students)} ${t("in more than one event")}`}
              />
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {ladder.map((l) => (
                  <span
                    key={l.place}
                    className="rounded-lg bg-muted px-2.5 py-1 text-xs"
                    data-testid={`ladder-${l.place}`}
                  >
                    <span className="font-medium">{l.label || l.place}</span>{" "}
                    <span className="font-tabular text-muted-foreground">
                      {l.points} {t("pts")}
                    </span>
                  </span>
                ))}
              </div>
            </section>

            <div className="flex flex-col print:block">
              <div
                role="tablist"
                aria-label={t("Results views")}
                className="flex flex-wrap items-end gap-1 overflow-x-auto px-2 print:hidden"
              >
                <Bookmark
                  testid="results-view-tally"
                  active={view === "tally"}
                  onClick={() => setParam({ view: null })}
                  label={t("Medal tally")}
                  count={q.data.schools.length}
                />
                <Bookmark
                  testid="results-view-champions"
                  active={view === "champions"}
                  onClick={() => setParam({ view: "champions" })}
                  label={t("Champions")}
                  count={q.data.groups.length}
                />
                <Bookmark
                  testid="results-view-students"
                  active={view === "students"}
                  onClick={() => setParam({ view: "students" })}
                  label={t("Students")}
                  count={q.data.students.length}
                />
              </div>

              <div className="flex flex-col gap-4 rounded-xl rounded-tl-none border border-border bg-card p-4 shadow-sm sm:p-5">
                {view !== "champions" ? (
                  <div className="flex flex-wrap items-center gap-3 print:hidden">
                    <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
                      <Search
                        aria-hidden="true"
                        className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                      />
                      <Input
                        value={search}
                        onChange={(e) =>
                          setParam({ q: e.target.value || null })
                        }
                        aria-label={
                          view === "students"
                            ? t("Search students")
                            : t("Search schools")
                        }
                        placeholder={
                          view === "students"
                            ? t("Search students")
                            : t("Search schools")
                        }
                        data-testid="results-search"
                        className="pl-8"
                      />
                    </div>
                    <Select
                      size="sm"
                      value={view === "students" ? studentSort : tallySort}
                      onChange={(v) =>
                        setParam({ sort: v === "points" ? null : v })
                      }
                      aria-label={t("Sort")}
                      className="w-40"
                      options={
                        view === "students"
                          ? [
                              { value: "points", label: t("Most points") },
                              { value: "events", label: t("Most events") },
                              { value: "name", label: t("Name") },
                            ]
                          : [
                              { value: "points", label: t("Most points") },
                              { value: "golds", label: t("Most golds") },
                              { value: "name", label: t("School name") },
                            ]
                      }
                    />
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={medalistsOnly}
                        onChange={(e) =>
                          setParam({ medalists: e.target.checked ? "1" : null })
                        }
                        data-testid="results-medalists-only"
                        className="h-4 w-4 rounded border-border accent-primary"
                      />
                      {t("Medallists only")}
                    </label>
                    <span
                      className="font-tabular text-xs text-muted-foreground"
                      data-testid="results-row-count"
                    >
                      {view === "students" ? students.length : schools.length}{" "}
                      {view === "students" ? t("students") : t("schools")}
                    </span>
                  </div>
                ) : null}

                {view === "tally" ? (
                  <>
                    <div
                      role="tablist"
                      aria-label={t("Sports")}
                      className="flex flex-wrap items-center gap-1 print:hidden"
                    >
                      <Bookmark
                        testid="results-sport-all"
                        active={!sport}
                        onClick={() => setParam({ sport: null })}
                        label={t("All sports")}
                        count={allColumns.length}
                      />
                      {bands.map((b) => (
                        <Bookmark
                          key={b.sportKey}
                          testid={`results-sport-${b.sportKey}`}
                          active={sport === b.sportKey}
                          onClick={() => setParam({ sport: b.sportKey })}
                          label={b.sportName}
                          count={b.columns.length}
                        />
                      ))}
                    </div>

                    {bars.length ? (
                      <div className="rounded-lg border border-border bg-muted/20 p-3 sm:p-4">
                        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {t("Points by school")}
                        </h2>
                        <PointsChart
                          bars={bars}
                          places={places}
                          labelOf={labelOf}
                        />
                      </div>
                    ) : (
                      <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
                        {t("No medal has been decided yet.")}
                      </p>
                    )}

                    {schools.length ? (
                      <TallyGrid
                        slug={slug}
                        id={id}
                        bands={shownBands}
                        columns={columns}
                        rows={schools}
                        places={places}
                        labelOf={labelOf}
                      />
                    ) : (
                      <p className="py-8 text-center text-sm text-muted-foreground">
                        {t("No school matches that search.")}
                      </p>
                    )}

                    <div className="flex flex-col gap-2 border-t border-border pt-3">
                      <div
                        className="flex flex-wrap gap-x-5 gap-y-2"
                        data-testid="results-legend"
                      >
                        {columns.map((c) => (
                          <div
                            key={c.leaf_key}
                            className="flex items-center gap-2 text-xs"
                          >
                            <span className="rounded bg-primary/10 px-1.5 py-0.5 font-tabular text-[0.6875rem] font-semibold text-primary">
                              {c.code}
                            </span>
                            <span className="text-muted-foreground">
                              <span className="text-foreground">{c.title}</span>
                              {" · "}
                              <span
                                className={cn(
                                  c.status === "final"
                                    ? "text-success"
                                    : c.status === "provisional"
                                      ? "text-warning"
                                      : undefined,
                                )}
                              >
                                {c.status === "final"
                                  ? t("decided")
                                  : c.status === "provisional"
                                    ? t("still playing")
                                    : t("not decided")}
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>
                      <p className="text-[0.6875rem] text-muted-foreground">
                        {ladder
                          .map((l) => `${l.label || l.place} = ${l.points}`)
                          .join(" · ")}
                        {" · "}
                        {t("a dash means no placing in that competition.")}
                        {decidedAll ? ` · ${t("Every competition is final.")}` : ""}
                      </p>
                    </div>
                  </>
                ) : view === "champions" ? (
                  <ChampionsView
                    groups={q.data.groups}
                    places={places}
                    labelOf={labelOf}
                    competitionLabel={competitionLabel}
                  />
                ) : (
                  <>
                    <StudentsView
                      students={students}
                      places={places}
                      labelOf={labelOf}
                    />
                    <p className="border-t border-border pt-3 text-[0.6875rem] text-muted-foreground">
                      {t(
                        "Every player of a winning team carries that team's full points. A school counts the medal once.",
                      )}
                    </p>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
