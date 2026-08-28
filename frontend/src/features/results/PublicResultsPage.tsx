import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Download, Printer, RotateCcw, Search, Trophy } from "lucide-react";
import { tournamentsApi } from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/Select";
import { Dialog } from "@/components/ui/dialog";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { PublicViewerHeader } from "@/features/live/PublicViewerHeader";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import {
  BoardBand,
  Chip,
  FilterFab,
  Segment,
} from "@/features/fixtures/publicTournamentViews";
import { ChampionsView } from "./ChampionsView";
import { medalColumn } from "./MedalChip";
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

/** A headline number. Compact on a phone — four 2xl numerals were taking the
 * whole first screen before a single result was visible (owner 2026-08-26). */
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
    <div className="flex items-baseline gap-1.5 sm:flex-col sm:items-start sm:gap-0">
      <span className="font-tabular text-base font-semibold sm:text-2xl">
        {value}
      </span>
      <span className="text-[0.6875rem] text-muted-foreground sm:text-xs">
        {label}
      </span>
      {hint ? (
        <span className="hidden text-[0.6875rem] text-muted-foreground/80 sm:block">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function PublicResultsPage(): React.ReactElement {
  const { slug = "", id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { isMobile } = useBreakpoint();
  const [sheetOpen, setSheetOpen] = useState(false);

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

  /* The filter controls are authored once and rendered into whichever surface
     fits: an inline bar on a desk, a bottom drawer on a phone. Three sport
     chips wrapped onto three lines of a 360px screen, which is what a sticky
     "Filters" button exists to prevent (owner 2026-08-25). */
  const rowCount = `${view === "students" ? students.length : schools.length} ${
    view === "students" ? t("students") : t("schools")
  }`;
  const activeFilters = [
    sport ? 1 : 0,
    search.trim() ? 1 : 0,
    medalistsOnly ? 1 : 0,
    sortParam && sortParam !== "points" ? 1 : 0,
  ].reduce((a, b) => a + b, 0);

  const searchField = (
    <div className="relative min-w-[10rem] flex-1 sm:max-w-xs">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        value={search}
        onChange={(e) => setParam({ q: e.target.value || null })}
        aria-label={
          view === "students" ? t("Search students") : t("Search schools")
        }
        placeholder={
          view === "students" ? t("Search students") : t("Search schools")
        }
        data-testid="results-search"
        className={cn("pl-8", isMobile && "h-11")}
      />
    </div>
  );

  const sortSelect = (
    <Select
      size={isMobile ? "lg" : "sm"}
      value={view === "students" ? studentSort : tallySort}
      onChange={(v) => setParam({ sort: v === "points" ? null : v })}
      aria-label={t("Sort")}
      className={isMobile ? "w-full" : "w-40"}
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
  );

  const medallistsToggle = (
    <label
      className={cn(
        "flex items-center gap-2 text-xs text-muted-foreground",
        isMobile && "h-11 text-sm",
      )}
    >
      <input
        type="checkbox"
        checked={medalistsOnly}
        onChange={(e) => setParam({ medalists: e.target.checked ? "1" : null })}
        data-testid="results-medalists-only"
        className="h-4 w-4 rounded border-border accent-primary"
      />
      {t("Medallists only")}
    </label>
  );

  const sportChips = (
    <div
      role="tablist"
      aria-label={t("Sports")}
      className="flex flex-wrap items-center gap-1.5 print:hidden"
    >
      <Chip
        testid="results-sport-all"
        active={!sport}
        onClick={() => setParam({ sport: null })}
        label={t("All sports")}
        count={allColumns.length}
      />
      {bands.map((b) => (
        <Chip
          key={b.sportKey}
          testid={`results-sport-${b.sportKey}`}
          active={sport === b.sportKey}
          onClick={() => setParam({ sport: b.sportKey })}
          label={b.sportName}
          count={b.columns.length}
        />
      ))}
    </div>
  );

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
      {/* ONE section (owner 2026-08-25). The heading, the totals, the view
          switcher, the filters and the sheet itself are one board: read across
          four floating cards, a medal tally is four things rather than one. */}
      <main className="flex w-full max-w-full min-w-0 flex-1 flex-col p-0 sm:px-6 sm:py-4 lg:px-8">
       <section className="flex w-full min-w-0 flex-col border-y border-border bg-card print:border-0 sm:rounded-xl sm:border sm:shadow-sm">
        {/* The Matches page's band (owner 2026-08-28): tournament name and a
            one-line count, no per-tab title — the tab strip says "Results". */}
        <BoardBand
          title={tournamentName}
          testid="results-indicator"
          meta={
            totals
              ? `${totals.decided} ${t("of")} ${totals.competitions} ${
                  totals.competitions === 1
                    ? t("competition decided")
                    : t("competitions decided")
                }`
              : null
          }
          actions={
            <>
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
            </>
          }
        />
        <p className="hidden px-3 pt-3 text-xs text-muted-foreground print:block">
          {tournamentName} · {t("Medal tally, points and category champions")}
        </p>
        <div className="flex flex-col gap-4 p-3 sm:p-5">

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
            <div
              data-testid="results-summary"
              className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border pb-2 sm:gap-x-8 sm:gap-y-3 sm:pb-3"
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
              <div className="flex w-full flex-wrap items-center gap-1.5 sm:ml-auto sm:w-auto sm:gap-2">
                {ladder.map((l) => (
                  <span
                    key={l.place}
                    className={cn(
                      "rounded-lg px-2.5 py-1 text-xs",
                      medalColumn(l.place).head,
                    )}
                    data-testid={`ladder-${l.place}`}
                  >
                    <span className="font-semibold">{l.label || l.place}</span>{" "}
                    <span className="font-tabular">
                      {l.points} {t("pts")}
                    </span>
                  </span>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-4">
              <div
                role="tablist"
                aria-label={t("Results views")}
                className="flex flex-wrap gap-1 self-start rounded-lg bg-muted p-1 print:hidden"
              >
                <Segment
                  testid="results-view-tally"
                  active={view === "tally"}
                  onClick={() => setParam({ view: null })}
                  label={t("Medal tally")}
                  count={q.data.schools.length}
                />
                <Segment
                  testid="results-view-champions"
                  active={view === "champions"}
                  onClick={() => setParam({ view: "champions" })}
                  label={t("Champions")}
                  count={q.data.groups.length}
                />
                <Segment
                  testid="results-view-students"
                  active={view === "students"}
                  onClick={() => setParam({ view: "students" })}
                  label={t("Students")}
                  count={q.data.students.length}
                />
              </div>

              <div className="flex flex-col gap-4">
                {view !== "champions" && !isMobile ? (
                  <div className="flex flex-wrap items-center gap-3 print:hidden">
                    {searchField}
                    {sortSelect}
                    {medallistsToggle}
                    <span
                      className="font-tabular text-xs text-muted-foreground"
                      data-testid="results-row-count"
                    >
                      {rowCount}
                    </span>
                  </div>
                ) : null}

                {view === "tally" ? (
                  <>
                    {!isMobile ? sportChips : null}

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

                    <details
                      open={!isMobile}
                      className="flex flex-col gap-2 border-t border-border pt-3"
                    >
                      <summary className="cursor-pointer text-xs text-muted-foreground print:hidden">
                        {t("Column codes")} ({columns.length})
                      </summary>
                      <div
                        className="mt-2 flex flex-wrap gap-x-5 gap-y-2"
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
                    </details>
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
        </div>
       </section>

      {/* The match centre's floating pill, on every board (owner 2026-08-26).
          A full-width bar walled off the bottom edge and covered the last row
          of the sheet. */}
      {isMobile && q.data && view !== "champions" ? (
        <FilterFab
          testid="results-filters-open"
          onClick={() => setSheetOpen(true)}
          label={rowCount}
          count={activeFilters}
          icon={Trophy}
        />
      ) : null}

      <Dialog
        open={isMobile && sheetOpen}
        onOpenChange={setSheetOpen}
        variant="sheet"
        ariaLabel={t("Filter the results")}
      >
        <div data-testid="results-filter-sheet" className="flex flex-col gap-4">
          <span
            aria-hidden="true"
            className="mx-auto h-1 w-10 shrink-0 rounded-full bg-border"
          />
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">{t("Filters")}</h2>
            {activeFilters > 0 ? (
              <button
                type="button"
                data-testid="results-sheet-reset"
                onClick={() =>
                  setParam({
                    sport: null,
                    q: null,
                    medalists: null,
                    sort: null,
                  })
                }
                className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary"
              >
                <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
                {t("Reset")}
              </button>
            ) : null}
          </div>

          {searchField}

          {view === "tally" ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                {t("Sport")}
              </span>
              {sportChips}
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <span className="text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {t("Sort")}
            </span>
            {sortSelect}
          </div>

          {medallistsToggle}

          <Button
            data-testid="results-sheet-apply"
            className="h-12 w-full text-base"
            onClick={() => setSheetOpen(false)}
          >
            {t("Show")} {rowCount}
          </Button>
        </div>
      </Dialog>
      </main>
    </div>
  );
}
