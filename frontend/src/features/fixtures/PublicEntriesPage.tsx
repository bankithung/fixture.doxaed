import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Check, Download, Printer, Search } from "lucide-react";
import { tournamentsApi, type PublicEntryInstitution } from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/Select";
import { TeamCrest } from "@/components/ui/TeamCrest";
import { PublicViewerHeader } from "@/features/live/PublicViewerHeader";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { Bookmark } from "./publicTournamentViews";
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
 * 2026-08-22). Reading that off the fixture meant scrolling 91 rows and
 * remembering; here it is one grid — schools down, competitions across.
 *
 * **It reads ENTRIES, not fixtures**, so it is right the moment a school
 * registers, before any draw exists, and it cannot drop a school whose
 * category never produced a match (a bye, a walkover, a single-entry event).
 *
 * **A cell carries the COUNT, not just a tick.** A school with two pairs in
 * Open Boys Doubles has entered twice, and a tick would flatten that into the
 * same mark as one entry — which is exactly the number a coach is counting.
 *
 * **Not entered is quiet, not an error.** A red cross in every empty cell (the
 * shape the reference sketch used) fills two thirds of the grid with alarm
 * colour for the ordinary case of a school not doing a sport. The ticks carry
 * the pattern; the gaps are a muted dash, and the row and column totals say
 * the same thing in numbers for anyone who cannot see the pattern at all.
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
      <td className="border-l border-border/60 px-2 py-2 text-center align-middle">
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
      className="border-l border-border/60 bg-success-muted/40 px-2 py-2 text-center align-middle"
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

/** The legend: every column code spelled out. A code is only readable with
 * one, and the counts beside it say how big each competition is. */
function Legend({
  columns,
}: {
  columns: MatrixColumn[];
}): React.ReactElement {
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-2" data-testid="entries-legend">
      {columns.map((c) => (
        <div key={c.leaf_key} className="flex items-center gap-2 text-xs">
          <span className="rounded bg-primary/10 px-1.5 py-0.5 font-tabular text-[0.6875rem] font-semibold text-primary">
            {c.code}
          </span>
          <span className="text-muted-foreground">
            <span className="text-foreground">{c.title}</span>
            {" · "}
            <span className="font-tabular">
              {c.schools} {c.schools === 1 ? t("school") : t("schools")}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

export function PublicEntriesPage(): React.ReactElement {
  const { slug = "", id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState("");

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

  // Sport + sort ride the URL so a filtered board is shareable, exactly like
  // the match centre's scope. An unknown value falls back to everything.
  const sportParam = params.get("sport") ?? "";
  const sport = bands.some((b) => b.sportKey === sportParam) ? sportParam : "";
  const sortParam = params.get("sort") ?? "";
  const sort: SortKey = (["name", "entries", "competitions"] as const).includes(
    sortParam as SortKey,
  )
    ? (sortParam as SortKey)
    : "name";

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

  /** Entries a row holds inside the columns currently on screen — the number
   * the row's own total must show, or a sport filter would report the whole
   * tournament's count beside two visible ticks. */
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

  return (
    <div className="flex min-h-screen flex-col">
      <PublicViewerHeader
        slug={slug}
        id={id}
        tournamentName={tournamentName}
        active="entries"
        connected={false}
      />
      <main className="flex w-full flex-1 flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
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
            {t("These entries are not available.")}
          </p>
        ) : allRows.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <p className="text-sm font-medium">{t("No schools yet.")}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("Schools appear here as soon as they register.")}
            </p>
          </div>
        ) : (
          <>
            {/* What the whole board says in three numbers, then per sport —
                the summary a viewer reads before hunting for their school. */}
            <section
              data-testid="entries-summary"
              className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-xl border border-border bg-card px-5 py-4 shadow-sm"
            >
              <div className="flex flex-col">
                <span className="font-tabular text-2xl font-semibold">
                  {q.data.totals.schools}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("Schools")}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="font-tabular text-2xl font-semibold">
                  {q.data.totals.competitions}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("Competitions")}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="font-tabular text-2xl font-semibold">
                  {q.data.totals.teams}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("Entries")}
                </span>
              </div>
              <div className="ml-auto flex flex-wrap gap-2">
                {totalsBySport.map((s) => (
                  <span
                    key={s.sportKey}
                    data-testid={`entries-sport-total-${s.sportKey}`}
                    className="flex items-baseline gap-1.5 rounded-lg bg-muted px-3 py-1.5 text-xs"
                  >
                    <span className="font-medium">{s.sportName}</span>
                    <span className="font-tabular text-muted-foreground">
                      {s.schools} {t("schools")} · {s.teams} {t("entries")}
                    </span>
                  </span>
                ))}
              </div>
            </section>

            {/* Sport bookmarks sit ON the sheet, the same device the standings
                board uses, so the two public tabs read as one product. */}
            <div className="flex flex-col print:block">
              <div
                role="tablist"
                aria-label={t("Sports")}
                className="flex flex-wrap items-end gap-1 overflow-x-auto px-2 print:hidden"
              >
                <Bookmark
                  testid="entries-sport-all"
                  active={!sport}
                  onClick={() => setParam({ sport: null })}
                  label={t("All sports")}
                  count={columns.length}
                />
                {bands.map((b) => (
                  <Bookmark
                    key={b.sportKey}
                    testid={`entries-sport-pick-${b.sportKey}`}
                    active={sport === b.sportKey}
                    onClick={() => setParam({ sport: b.sportKey })}
                    label={b.sportName}
                    count={b.columns.length}
                  />
                ))}
              </div>

              <div className="flex flex-col gap-4 rounded-xl rounded-tl-none border border-border bg-card p-4 shadow-sm sm:p-5">
                <div className="flex flex-wrap items-center gap-3 print:hidden">
                  <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
                    <Search
                      aria-hidden="true"
                      className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      aria-label={t("Search schools")}
                      placeholder={t("Search schools")}
                      data-testid="entries-search"
                      className="pl-8"
                    />
                  </div>
                  <Select
                    size="sm"
                    value={sort}
                    onChange={(v) => setParam({ sort: v === "name" ? null : v })}
                    aria-label={t("Sort schools")}
                    className="w-44"
                    options={[
                      { value: "name", label: t("School name") },
                      { value: "entries", label: t("Most entries") },
                      { value: "competitions", label: t("Most competitions") },
                    ]}
                  />
                  <span
                    className="font-tabular text-xs text-muted-foreground"
                    data-testid="entries-row-count"
                  >
                    {rows.length}{" "}
                    {rows.length === 1 ? t("school") : t("schools")}
                  </span>
                  <div className="ml-auto flex items-center gap-2">
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
                  </div>
                </div>

                {rows.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    {t("No school matches that search.")}
                  </p>
                ) : (
                  /* A matrix stays a matrix on a phone: it scrolls sideways
                     with the school column pinned, because collapsing it to
                     cards would destroy the one thing a grid is for. */
                  <div className="-mx-4 overflow-x-auto sm:mx-0">
                    <table
                      data-testid="entries-matrix"
                      className="w-full min-w-[46rem] border-separate border-spacing-0 text-sm"
                    >
                      <caption className="sr-only">
                        {t(
                          "Which competitions each school has entered, with the number of entries in each",
                        )}
                      </caption>
                      <thead>
                        <tr>
                          {/* Bounded, not natural width: left to size itself
                              the school names take the whole of a phone and
                              the first tick sits off-screen, so the grid opens
                              on no data at all. */}
                          <th
                            rowSpan={2}
                            scope="col"
                            className="sticky left-0 z-20 w-52 min-w-52 max-w-52 border-b border-r border-border bg-card px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:w-72 sm:min-w-72 sm:max-w-72 lg:w-[23rem] lg:min-w-[23rem] lg:max-w-[23rem]"
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
                          return (
                            <tr
                              key={row.id}
                              data-testid={`entries-row-${row.id}`}
                              className={cn(
                                "group",
                                i % 2 ? "bg-muted/20" : undefined,
                              )}
                            >
                              <th
                                scope="row"
                                className="sticky left-0 z-10 w-52 min-w-52 max-w-52 border-b border-r border-border bg-card px-3 py-2 text-left font-normal sm:w-72 sm:min-w-72 sm:max-w-72 lg:w-[23rem] lg:min-w-[23rem] lg:max-w-[23rem]"
                              >
                                <Link
                                  to={routes.publicSchool(slug, id, row.id)}
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
                              <td className="border-b border-l border-border px-3 py-2 text-right">
                                <span className="font-tabular text-sm font-semibold">
                                  {totals.teams}
                                </span>
                                <span className="block font-tabular text-[0.6875rem] text-muted-foreground">
                                  {totals.comps}{" "}
                                  {totals.comps === 1
                                    ? t("event")
                                    : t("events")}
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
                            className="sticky left-0 z-10 w-52 min-w-52 max-w-52 border-r border-border bg-card px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:w-72 sm:min-w-72 sm:max-w-72 lg:w-[23rem] lg:min-w-[23rem] lg:max-w-[23rem]"
                          >
                            {t("Schools entered")}
                          </th>
                          {shownColumns.map((c) => (
                            <td
                              key={c.leaf_key}
                              data-testid={`entries-total-${c.leaf_key}`}
                              className="border-l border-border px-2 py-2 text-center font-tabular text-xs text-muted-foreground"
                            >
                              {c.schools}
                            </td>
                          ))}
                          <td className="border-l border-border px-3 py-2 text-right font-tabular text-xs text-muted-foreground">
                            {rows.reduce(
                              (n, r) => n + shownTotals(r).teams,
                              0,
                            )}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}

                <div className="border-t border-border pt-3">
                  <Legend columns={shownColumns} />
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
