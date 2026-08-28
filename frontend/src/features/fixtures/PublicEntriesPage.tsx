import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  Download,
  Printer,
  RotateCcw,
  School,
  Search,
} from "lucide-react";
import { tournamentsApi, type PublicEntryInstitution } from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/Select";
import { Dialog } from "@/components/ui/dialog";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { TeamCrest } from "@/components/ui/TeamCrest";
import { PublicViewerHeader } from "@/features/live/PublicViewerHeader";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { BoardBand, Chip, FilterFab } from "./publicTournamentViews";
import {
  buildBands,
  buildColumns,
  cellCount,
  entriesCsv,
  sportTotals,
  visibleRows,
  type MatrixColumn,
  type SortKey,
} from "./entriesMatrix";

/**
 * Public ENTRIES tab — who is in what.
 *
 * The match centre answers "what is being played" and Standings answers "who
 * is winning". Neither answers the question a parent, a coach and a visiting
 * school ask first: **is my school in this, and in which events** (owner
 * 2026-08-22).
 *
 * **It reads ENTRIES, not fixtures**, so it is right the moment a school
 * registers, before any draw exists, and it cannot drop a school whose
 * category never produced a match (a bye, a walkover, a single-entry event).
 *
 * **A cell carries the COUNT, not just a tick.** A school with two pairs in
 * Open Boys Doubles has entered twice, and a tick would flatten that into the
 * same mark as one entry — which is exactly the number a coach is counting.
 * Not entered is a quiet dash: a red cross in two thirds of the grid is alarm
 * colour for the ordinary case of a school not doing a sport.
 *
 * **It is ONE section** (owner 2026-08-25): heading, totals, filters and the
 * sheet live in the same panel, and every number on screen — row totals, the
 * column footer, the CSV — is counted from the columns CURRENTLY VISIBLE, so a
 * filtered board cannot contradict itself.
 */

/** A grid cell: the entry count, or the quiet gap. */
function Cell({
  count,
  school,
  competition,
  names,
}: {
  count: number;
  school: string;
  competition: string;
  names: string[];
}): React.ReactElement {
  if (count <= 0) {
    return (
      <td className="border-b border-l border-border/60 px-2 py-2 text-center align-middle transition-colors group-hover:bg-accent/60">
        <span className="sr-only">
          {t("{school} is not entered in {competition}")
            .replace("{school}", school)
            .replace("{competition}", competition)}
        </span>
        <span aria-hidden="true" className="text-sm text-muted-foreground/35">
          &ndash;
        </span>
      </td>
    );
  }
  return (
    <td
      className="border-b border-l border-border/60 bg-success-muted/40 px-2 py-2 text-center align-middle transition-colors group-hover:bg-accent/60"
      data-testid="entry-cell"
    >
      <span className="sr-only">
        {(count === 1
          ? t("{school} is entered in {competition}")
          : t("{school} has {n} entries in {competition}")
        )
          .replace("{school}", school)
          .replace("{competition}", competition)
          .replace("{n}", String(count))}
      </span>
      <span
        aria-hidden="true"
        title={names.join(", ")}
        className={cn(
          "inline-flex h-6 min-w-6 items-center justify-center gap-0.5 rounded-full px-1.5",
          "bg-success/15 text-xs font-semibold text-success",
        )}
      >
        {count > 1 ? (
          <span className="font-tabular">{count}</span>
        ) : (
          <Check className="h-3.5 w-3.5" strokeWidth={3} />
        )}
      </span>
    </td>
  );
}

export function PublicEntriesPage(): React.ReactElement {
  const { slug = "", id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { isMobile } = useBreakpoint();
  const [sheetOpen, setSheetOpen] = useState(false);

  const q = useQuery({
    queryKey: ["public-entries", slug, id],
    queryFn: () => tournamentsApi.publicEntries(slug, id),
    // Entries change when a school registers, not on a match tick, so this
    // tab does not ride the SSE stream the score tabs do.
    staleTime: 5 * 60_000,
  });

  const tournamentName = q.data?.tournament.name;
  useEffect(() => {
    if (tournamentName) {
      document.title = `${tournamentName} · ${t("Schools")}`;
    }
  }, [tournamentName]);

  const columns = useMemo(
    () => buildColumns(q.data?.competitions ?? []),
    [q.data],
  );
  const bands = useMemo(() => buildBands(columns), [columns]);
  const allRows = useMemo(() => q.data?.institutions ?? [], [q.data]);

  // Sport, sort AND the search ride the URL, so a filtered board is shareable
  // exactly as it looks. An unknown value falls back to everything.
  const sportParam = params.get("sport") ?? "";
  const sport = bands.some((b) => b.sportKey === sportParam) ? sportParam : "";
  const sortParam = params.get("sort") ?? "";
  const sort: SortKey = (["name", "entries", "competitions"] as const).includes(
    sortParam as SortKey,
  )
    ? (sortParam as SortKey)
    : "name";
  const search = params.get("q") ?? "";

  const setParam = (next: Record<string, string | null>): void => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    setParams(p, { replace: true });
  };

  const shownBands = useMemo(
    () => (sport ? bands.filter((b) => b.sportKey === sport) : bands),
    [bands, sport],
  );
  const shownColumns = useMemo(
    () => shownBands.flatMap((b) => b.columns),
    [shownBands],
  );
  const rows = useMemo(
    () => visibleRows(allRows, columns, { search, sport, sort }),
    [allRows, columns, search, sport, sort],
  );
  const totalsBySport = useMemo(
    () => sportTotals(allRows, bands),
    [allRows, bands],
  );

  const downloadCsv = (): void => {
    if (!q.data) return;
    const blob = new Blob([entriesCsv(shownColumns, rows)], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug || "tournament"}-schools.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /** Entries a row holds inside the columns currently on screen. */
  const shownTotals = (
    row: PublicEntryInstitution,
  ): { teams: number; comps: number } => {
    let teams = 0;
    let comps = 0;
    for (const c of shownColumns) {
      const n = cellCount(row, c.leaf_key);
      if (n > 0) {
        teams += n;
        comps += 1;
      }
    }
    return { teams, comps };
  };

  /** Schools entered in one competition, counted from the ROWS ON SCREEN so
   * the footer can never disagree with the rows above it. */
  const columnSchools = (col: MatrixColumn): number =>
    rows.reduce((n, r) => n + (cellCount(r, col.leaf_key) > 0 ? 1 : 0), 0);

  /* Authored once, rendered into whichever surface fits: an inline bar on a
     desk, a bottom drawer on a phone. Three sport chips, a search box, a sort
     select and a count stacked four rows deep on a 360px screen (owner
     2026-08-25). */
  const activeFilters =
    (sport ? 1 : 0) + (search.trim() ? 1 : 0) + (sort !== "name" ? 1 : 0);

  const searchField = (
    <div className="relative min-w-[10rem] flex-1 sm:max-w-xs">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        value={search}
        onChange={(e) => setParam({ q: e.target.value || null })}
        aria-label={t("Search schools")}
        placeholder={t("Search schools")}
        data-testid="entries-search"
        className={cn("pl-8", isMobile && "h-11")}
      />
    </div>
  );

  const sortSelect = (
    <Select
      size={isMobile ? "lg" : "sm"}
      value={sort}
      onChange={(v) => setParam({ sort: v === "name" ? null : v })}
      aria-label={t("Sort schools")}
      className={isMobile ? "w-full" : "w-40"}
      options={[
        { value: "name", label: t("School name") },
        { value: "entries", label: t("Most entries") },
        { value: "competitions", label: t("Most competitions") },
      ]}
    />
  );

  const sportChips = (
    <div
      role="tablist"
      aria-label={t("Sports")}
      className="flex flex-wrap items-center gap-1.5 print:hidden"
    >
      <Chip
        testid="entries-sport-all"
        active={!sport}
        onClick={() => setParam({ sport: null })}
        label={t("All sports")}
        count={columns.length}
      />
      {bands.map((b) => (
        <Chip
          key={b.sportKey}
          testid={`entries-sport-pick-${b.sportKey}`}
          active={sport === b.sportKey}
          onClick={() => setParam({ sport: b.sportKey })}
          label={b.sportName}
          count={b.columns.length}
        />
      ))}
    </div>
  );

  const stick =
    "min-w-[9rem] max-w-[11rem] sm:w-64 sm:min-w-64 sm:max-w-64 lg:w-80 lg:min-w-80 lg:max-w-80";

  return (
    <div className="flex min-h-screen flex-col print-doc">
      <PublicViewerHeader
        slug={slug}
        id={id}
        tournamentName={tournamentName}
        active="entries"
        connected={false}
      />
      <main className="flex w-full max-w-full min-w-0 flex-1 flex-col p-0 sm:px-6 sm:py-4 lg:px-8">
        {/* ONE section, built like the Matches page (owner 2026-08-28): the
            tournament name is its header band, and totals, filters and the
            sheet sit straight under it — edge to edge on a phone. */}
        <section className="flex w-full min-w-0 flex-col border-y border-border bg-card print:border-0 sm:rounded-xl sm:border sm:shadow-sm">
          <BoardBand
            title={tournamentName}
            testid="entries-indicator"
            meta={
              q.data
                ? `${q.data.totals.schools} ${t("schools")} · ${q.data.totals.competitions} ${t("competitions")} · ${q.data.totals.teams} ${t("entries")}`
                : null
            }
            actions={
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={downloadCsv}
                  data-testid="entries-csv"
                >
                  <Download className="mr-1.5 h-4 w-4" />
                  {t("CSV")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => window.print()}
                  data-testid="entries-print"
                >
                  <Printer className="mr-1.5 h-4 w-4" />
                  {t("Print / PDF")}
                </Button>
              </>
            }
          />
          <p className="hidden px-3 pt-3 text-xs text-muted-foreground print:block">
            {tournamentName} · {t("Which competitions each school entered")}
          </p>
          <div className="flex flex-col gap-4 p-3 sm:p-5">

          {q.isLoading ? (
            <div
              aria-busy="true"
              className="h-64 animate-pulse rounded-lg bg-muted/40"
            />
          ) : q.isError || !q.data ? (
            <p
              role="alert"
              className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground"
            >
              {t("These entries are not available.")}
            </p>
          ) : allRows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <p className="text-sm font-medium">{t("No schools yet.")}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("Schools appear here as soon as they register.")}
              </p>
            </div>
          ) : (
            <>
              <div
                data-testid="entries-summary"
                className="grid grid-cols-3 gap-3 border-b border-border pb-3 sm:flex sm:flex-wrap sm:items-center sm:gap-x-6 sm:gap-y-3"
              >
                <div className="flex flex-col">
                  <span className="font-tabular text-xl font-semibold sm:text-2xl">
                    {q.data.totals.schools}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t("Schools")}
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className="font-tabular text-xl font-semibold sm:text-2xl">
                    {q.data.totals.competitions}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t("Competitions")}
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className="font-tabular text-xl font-semibold sm:text-2xl">
                    {q.data.totals.teams}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t("Entries")}
                  </span>
                </div>
                <div className="col-span-3 flex w-full flex-wrap gap-2 sm:ml-auto sm:w-auto">
                  {totalsBySport.map((s) => (
                    <span
                      key={s.sportKey}
                      data-testid={`entries-sport-total-${s.sportKey}`}
                      className="flex items-baseline gap-1.5 rounded-lg bg-muted px-2.5 py-1 text-xs"
                    >
                      <span className="font-medium">{s.sportName}</span>
                      <span className="font-tabular text-muted-foreground">
                        {s.schools} {t("schools")} · {s.teams} {t("entries")}
                      </span>
                    </span>
                  ))}
                </div>
              </div>

              {!isMobile ? (
                <>
                  {sportChips}
                  <div className="flex flex-wrap items-center gap-3 print:hidden">
                    {searchField}
                    {sortSelect}
                    <span
                      className="font-tabular text-xs text-muted-foreground"
                      data-testid="entries-row-count"
                    >
                      {rows.length}{" "}
                      {rows.length === 1 ? t("school") : t("schools")}
                    </span>
                  </div>
                </>
              ) : null}

              {rows.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {t("No school matches that search.")}
                </p>
              ) : (
                /* A matrix stays a matrix on a phone: it scrolls sideways with
                   the school column pinned, because collapsing it to cards
                   would destroy the one thing a grid is for.

                   `relative` is load-bearing: the cells carry `sr-only`
                   spans, which are `position: absolute`, and an absolutely
                   positioned box is clipped by the scroller only when the
                   scroller is its containing block. Without it every span
                   escaped to the page, the document grew to the sheet's
                   38rem, the whole phone page scrolled sideways and the
                   fixed Filter pill drifted with the layout viewport. */
                <div className="relative min-w-0 -mx-3 overflow-x-auto sm:mx-0">
                  <table
                    data-testid="entries-matrix"
                    className="w-full min-w-[38rem] sm:min-w-[46rem] border-separate border-spacing-0 text-[clamp(0.7rem,0.62rem+0.28vw,0.95rem)]"
                  >
                    <caption className="sr-only">
                      {t(
                        "Which competitions each school has entered, with the number of entries in each",
                      )}
                    </caption>
                    <thead>
                      <tr>
                        <th
                          rowSpan={2}
                          scope="col"
                          className={cn(
                            "sm:sticky sm:left-0 sm:z-10 border-b border-r border-border bg-card px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground",
                            stick,
                          )}
                        >
                          {t("School")}
                        </th>
                        {shownBands.map((b) => (
                          <th
                            key={b.sportKey}
                            colSpan={b.columns.length}
                            scope="colgroup"
                            data-testid={`entries-band-${b.sportKey}`}
                            className="border-b border-l border-border bg-primary/10 px-2 py-1.5 text-center text-xs font-semibold text-primary"
                          >
                            {b.sportName}
                          </th>
                        ))}
                        <th
                          rowSpan={2}
                          scope="col"
                          className="border-b border-l border-border bg-card px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                        >
                          {t("Entries")}
                        </th>
                      </tr>
                      <tr>
                        {shownColumns.map((c) => (
                          <th
                            key={c.leaf_key}
                            scope="col"
                            title={`${c.sport_name} · ${c.title}`}
                            data-testid={`entries-col-${c.leaf_key}`}
                            className="border-b border-l border-border bg-muted/50 px-2 py-2 text-center font-tabular text-xs font-semibold"
                          >
                            {c.code}
                            <span className="sr-only">
                              {" "}
                              {c.sport_name} {c.title}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => {
                        const totals = shownTotals(row);
                        /* The stripe is repeated on the pinned cell: it needs
                           an opaque background of its own, and leaving it
                           plain breaks the banding down the one column a
                           reader uses to keep their place. */
                        const stripe = i % 2 ? "bg-muted/20" : "bg-card";
                        return (
                          <tr
                            key={row.id}
                            data-testid={`entries-row-${row.id}`}
                            className={cn("group", i % 2 && "bg-muted/20")}
                          >
                            <th
                              scope="row"
                              className={cn(
                                "sm:sticky sm:left-0 sm:z-[5] border-b border-r border-border px-3 py-2 text-left font-normal transition-colors group-hover:bg-accent",
                                stripe,
                                stick,
                              )}
                            >
                              <Link
                                to={routes.publicSchool(slug, id, row.id)}
                                title={row.name}
                                className="flex items-center gap-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                <TeamCrest
                                  src={row.crest}
                                  name={row.name}
                                  size="md"
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-sm font-medium group-hover:text-primary">
                                    {row.name}
                                  </span>
                                  {row.region ? (
                                    <span className="block truncate text-[0.6875rem] text-muted-foreground">
                                      {row.region}
                                    </span>
                                  ) : null}
                                </span>
                              </Link>
                            </th>
                            {shownColumns.map((c) => (
                              <Cell
                                key={c.leaf_key}
                                count={cellCount(row, c.leaf_key)}
                                school={row.name}
                                competition={`${c.sport_name} ${c.title}`}
                                names={row.entries[c.leaf_key]?.names ?? []}
                              />
                            ))}
                            <td className="border-b border-l border-border px-3 py-2 text-right transition-colors group-hover:bg-accent/60">
                              <span className="font-tabular text-sm font-semibold">
                                {totals.teams}
                              </span>
                              <span className="block font-tabular text-[0.6875rem] text-muted-foreground">
                                {totals.comps}{" "}
                                {totals.comps === 1 ? t("event") : t("events")}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th
                          scope="row"
                          className={cn(
                            "sm:sticky sm:left-0 sm:z-[5] border-r border-border bg-card px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground",
                            stick,
                          )}
                        >
                          {t("Schools entered")}
                        </th>
                        {shownColumns.map((c) => (
                          <td
                            key={c.leaf_key}
                            data-testid={`entries-total-${c.leaf_key}`}
                            className="border-l border-border px-2 py-2 text-center font-tabular text-xs text-muted-foreground"
                          >
                            {columnSchools(c)}
                          </td>
                        ))}
                        <td className="border-l border-border px-3 py-2 text-right font-tabular text-xs text-muted-foreground">
                          {rows.reduce((n, r) => n + shownTotals(r).teams, 0)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}

              <details
                open={!isMobile}
                className="border-t border-border pt-3"
              >
                <summary className="cursor-pointer text-xs text-muted-foreground print:hidden">
                  {t("Column codes")} ({shownColumns.length})
                </summary>
                <div
                  className="mt-2 flex flex-wrap gap-x-5 gap-y-2"
                  data-testid="entries-legend"
                >
                  {shownColumns.map((c) => (
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
                        <span className="font-tabular">
                          {columnSchools(c)}{" "}
                          {columnSchools(c) === 1 ? t("school") : t("schools")}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            </>
          )}
          </div>
        </section>

      {isMobile && q.data && allRows.length > 0 ? (
        <FilterFab
          testid="entries-filters-open"
          onClick={() => setSheetOpen(true)}
          label={`${rows.length} ${rows.length === 1 ? t("school") : t("schools")}`}
          count={activeFilters}
          icon={School}
        />
      ) : null}

      <Dialog
        open={isMobile && sheetOpen}
        onOpenChange={setSheetOpen}
        variant="sheet"
        ariaLabel={t("Filter the schools")}
      >
        <div data-testid="entries-filter-sheet" className="flex flex-col gap-4">
          <span
            aria-hidden="true"
            className="mx-auto h-1 w-10 shrink-0 rounded-full bg-border"
          />
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">{t("Filters")}</h2>
            {activeFilters > 0 ? (
              <button
                type="button"
                data-testid="entries-sheet-reset"
                onClick={() => setParam({ sport: null, q: null, sort: null })}
                className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary"
              >
                <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
                {t("Reset")}
              </button>
            ) : null}
          </div>

          {searchField}

          <div className="flex flex-col gap-1.5">
            <span className="text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {t("Sport")}
            </span>
            {sportChips}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {t("Sort")}
            </span>
            {sortSelect}
          </div>

          <Button
            data-testid="entries-sheet-apply"
            className="h-12 w-full text-base"
            onClick={() => setSheetOpen(false)}
          >
            {t("Show")} {rows.length}{" "}
            {rows.length === 1 ? t("school") : t("schools")}
          </Button>
        </div>
      </Dialog>
      </main>
    </div>
  );
}
