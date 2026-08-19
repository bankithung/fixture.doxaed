import { useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChevronsUpDown,
  Download,
  Search,
  SlidersHorizontal,
  UserSquare2,
} from "lucide-react";
import { tournamentsApi } from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ParticipationFilterDrawer } from "./ParticipationFilterDrawer";
import {
  ColumnResizer,
  measureColumn,
  useColumnWidths,
} from "@/components/ui/sheetColumns";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { useBreakpoint } from "@/lib/useBreakpoint";
import {
  ALL_DETAIL_COLUMNS,
  applyParticipationFilters,
  buildParticipation,
  detailColumns,
  detailText,
  EMPTY_PARTICIPATION_FILTERS,
  participationCsv,
  participationFacets,
  participationTotals,
  sortParticipation,
  type DetailColumn,
  type ParticipationFilters,
  type ParticipationRow,
  type ParticipationSortKey,
} from "./participation";
import { fmtDob, fmtGender } from "./personFormat";
import { FileChips } from "@/components/ui/FileChips";

/**
 * The participation workbench (owner 2026-08-17: "the host should have an
 * option to check the list of all students and where they are participating,
 * in which sports and categories, in a proper excel sheet table … and an
 * option to see if one student is participating in multiple games, so that we
 * can set the rules of the games to set up the fixture").
 *
 * It is a READING surface, deliberately: the Participants page owns adding and
 * withdrawing people, and doing both jobs in one place made neither read well.
 * This one answers a scheduling question, so it is built the way that question
 * is actually worked — a dense sheet you can sort, facet and export, with the
 * double entries findable rather than merely countable.
 *
 * Two views over the same filtered rows (ERP workbench, owner 2026-08-15 — one
 * section, everything inside it): the Sheet reads person by person, and the
 * Matrix is the literal grid, one column per competition, where a row with two
 * ticks IS the clash.
 */

/** The sheet's columns, in order, with the width each starts at. Everything
 * else about them (sorting, truncation, the resize handle) follows from this
 * one list, so a column is added here and nowhere else.
 *
 * The middle of the list is not fixed: the person-detail columns are whatever
 * the registration form actually collected (see `detailColumns`), so an event
 * that asks for a date of birth and a document shows those, and one that asks
 * for a class and a roll number shows THOSE.
 */
interface SheetColumn {
  key: string;
  label: string;
  width: number;
  sort?: ParticipationSortKey;
  align?: "right";
}

const NAME_COLUMN: SheetColumn = {
  key: "name",
  label: "Name",
  width: 210,
  sort: "name",
};

const TAIL_COLUMNS: SheetColumn[] = [
  { key: "school", label: "School", width: 190, sort: "school" },
  { key: "events", label: "Events", width: 84, sort: "events", align: "right" },
  { key: "entries", label: "Entered in", width: 420 },
];

const DEFAULT_WIDTHS: Record<string, number> = Object.fromEntries(
  [NAME_COLUMN, ...ALL_DETAIL_COLUMNS, ...TAIL_COLUMNS].map((c) => [
    c.key,
    c.width,
  ]),
);

/** The row-number gutter, exactly as a spreadsheet has one: it gives the eye
 * a fixed left edge to travel down and a way to say "row 14". */
const GUTTER = 46;

function SortIcon({ state }: { state: "asc" | "desc" | null }): React.ReactElement {
  const Icon = state === "asc" ? ArrowUp : state === "desc" ? ArrowDown : ChevronsUpDown;
  return (
    <Icon
      aria-hidden="true"
      className={cn("h-3 w-3", state ? "text-foreground" : "text-muted-foreground/50")}
    />
  );
}

/** One reading, and a filter: the numbers are the fastest way into the list,
 * so clicking one narrows to exactly the people it counted. */
function StatChip({
  label,
  value,
  active,
  tone,
  onClick,
  testid,
}: {
  label: string;
  value: number;
  active?: boolean;
  tone?: "warning" | "info";
  onClick?: () => void;
  testid: string;
}): React.ReactElement {
  const body = (
    <>
      <span className="font-tabular text-sm font-semibold">{value}</span>{" "}
      <span className="text-muted-foreground">{label}</span>
    </>
  );
  const cls = cn(
    "rounded-lg border px-3 py-1.5 text-xs transition-colors",
    active
      ? "border-primary bg-primary/10"
      : "border-border bg-muted/40",
    tone === "warning" && !active && "border-warning/40 bg-warning-muted/50",
    onClick && "hover:border-primary hover:bg-accent",
  );
  return onClick ? (
    <button type="button" data-testid={testid} aria-pressed={Boolean(active)} onClick={onClick} className={cls}>
      {body}
    </button>
  ) : (
    <span data-testid={testid} className={cls}>
      {body}
    </span>
  );
}

/** The competitions one person is in, as chips. Two chips is the whole point,
 * so a second chip is tinted rather than left to be counted. */
function Chips({
  row,
  /** Cards wrap; a sheet row is ONE line, and the way to see the rest is to
   * widen the column, exactly as a spreadsheet behaves. */
  wrap = false,
}: {
  row: ParticipationRow;
  wrap?: boolean;
}): React.ReactElement {
  if (!row.entries.length) {
    return (
      <span className="text-xs text-muted-foreground">{t("Not entered yet")}</span>
    );
  }
  return (
    <span className={cn("flex gap-1", wrap ? "flex-wrap" : "flex-nowrap")}>
      {row.entries.map((e) => (
        <span
          key={`${e.teamId}-${e.role}`}
          title={`${e.competition} · ${e.team}`}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs",
            row.events > 1 ? "bg-warning-muted text-warning-foreground" : "bg-secondary",
          )}
        >
          <span className="text-muted-foreground">{e.sportLabel}</span>
          {e.categoryLabel ? <span>{e.categoryLabel}</span> : null}
        </span>
      ))}
    </span>
  );
}

/** The same detail on a phone card, where it reads as a sentence fragment
 * rather than a column: the units come back, because there is no heading above
 * the number to supply them. */
function cardDetail(row: ParticipationRow, column: DetailColumn): string {
  const v = detailText(row, column.key);
  if (!v) return "";
  if (column.key === "dob") return fmtDob(v);
  if (column.key === "age") return `${v} ${t("yrs")}`;
  if (column.key === "gender") return fmtGender(v);
  return v;
}

/** One person-detail cell. The column decides how the value reads: a date is
 * written the way the squad panel writes it, an age is a number the eye can
 * scan down for a u-14 problem, and a document is the file itself rather than
 * a count — the whole reason an organizer opens this list is to check what a
 * school actually sent. */
function DetailCell({
  column,
  row,
  cell,
}: {
  column: DetailColumn;
  row: ParticipationRow;
  cell: string;
}): React.ReactElement {
  if (column.key === "docs") {
    return (
      <td data-col="docs" className={cn(cell, "overflow-hidden")}>
        {row.documents.length ? (
          <FileChips files={row.documents} className="flex-nowrap gap-1" />
        ) : (
          <span className="text-muted-foreground">·</span>
        )}
      </td>
    );
  }
  const raw = detailText(row, column.key);
  const text =
    column.key === "dob"
      ? raw
        ? fmtDob(raw)
        : ""
      : column.key === "gender"
        ? fmtGender(raw)
        : raw;
  // An age that reads too old for the competition is worth catching by eye,
  // so it is the one detail allowed to raise its voice.
  const numeric = column.key === "age" || column.key === "roll" ||
    column.key === "phone" || column.key === "dob";
  return (
    <td
      data-col={column.key}
      className={cn(
        cell,
        "text-muted-foreground",
        numeric && "font-tabular",
        column.align === "right" && "text-right",
      )}
      title={text || undefined}
    >
      <span className="block truncate">{text || "·"}</span>
    </td>
  );
}

export function ParticipationPage(): React.ReactElement {
  const { id = "" } = useParams();
  return <ParticipationWorkbench tournamentId={id} />;
}

export function ParticipationWorkbench({
  tournamentId,
  /** Embedded inside another page: drop the outer page padding and the back
   * link, since the host page already frames it. */
  embedded = false,
}: {
  tournamentId: string;
  embedded?: boolean;
}): React.ReactElement {
  const id = tournamentId;
  const { isMobile } = useBreakpoint();
  const [filters, setFilters] = useState<ParticipationFilters>(
    EMPTY_PARTICIPATION_FILTERS,
  );
  const [sort, setSort] = useState<{ key: ParticipationSortKey; dir: "asc" | "desc" }>(
    { key: "events", dir: "desc" },
  );
  const [view, setView] = useState<"sheet" | "matrix">("sheet");
  const [drawer, setDrawer] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const { widths, setWidth, resetWidths, resized } = useColumnWidths(
    `participation-columns:${id}`,
    DEFAULT_WIDTHS,
  );
  const autoFit = (key: string): void => {
    const px = measureColumn(sheetRef.current, key);
    if (px) setWidth(key, px);
  };

  // The whole roster in one read: every filter here is a question about the
  // set as a whole ("who is in two"), so paging it server-side would only be
  // able to answer about a page.
  const q = useQuery({
    queryKey: ["tournament-roster", id, "participation"],
    queryFn: () => tournamentsApi.roster(id),
    enabled: Boolean(id),
    retry: false,
  });

  const all = useMemo(
    () => buildParticipation(q.data?.members ?? []),
    [q.data],
  );
  const facets = useMemo(() => participationFacets(all), [all]);
  const totals = useMemo(() => participationTotals(all), [all]);
  // What this event's form actually asked each school for. Read off the WHOLE
  // roster, so filtering to one school never makes a column vanish mid-read.
  const detail = useMemo(() => detailColumns(all), [all]);
  const sheetColumns = useMemo(
    () => [NAME_COLUMN, ...detail, ...TAIL_COLUMNS],
    [detail],
  );
  const sheetWidth =
    GUTTER + sheetColumns.reduce((n, c) => n + (widths[c.key] ?? c.width), 0);
  const rows = useMemo(
    () => sortParticipation(applyParticipationFilters(all, filters), sort.key, sort.dir),
    [all, filters, sort],
  );
  // The matrix only ever shows the competitions still in play after filtering:
  // a grid of empty columns is harder to read, not more complete.
  const columns = useMemo(() => {
    const live = new Set(rows.flatMap((r) => r.entries.map((e) => e.leafKey)));
    return facets.competitions.filter((c) => live.has(c.value));
  }, [rows, facets]);

  // The box names what it actually searches, which depends on what this
  // event's form collected — promising "class, roll" to a host whose schools
  // were never asked for either is a lie the placeholder can avoid.
  const searchLabel = useMemo(() => {
    const extra = detail
      .filter((c) => c.key === "class" || c.key === "roll" || c.key === "phone")
      .map((c) => t(c.label).toLowerCase());
    return extra.length
      ? `${t("Search a name")}, ${extra.join(", ")} ${t("or school")}`
      : t("Search a name or school");
  }, [detail]);

  const set = (patch: Partial<ParticipationFilters>): void =>
    setFilters((f) => ({ ...f, ...patch }));
  const onSort = (key: ParticipationSortKey): void =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "events" ? "desc" : "asc" },
    );
  const filtersOn =
    JSON.stringify(filters) !== JSON.stringify(EMPTY_PARTICIPATION_FILTERS);
  // The Filter button counts what the drawer owns; the search box shows itself.
  const drawerCount = (
    ["events", "kind", "sport", "competition", "school"] as const
  ).filter((k) => filters[k] !== "").length;

  const onExport = (): void => {
    const csv = participationCsv(rows, facets.competitions, detail);
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "participation.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  /** ONE toolbar line (owner 2026-08-19): the filters used to wrap onto three
   * rows on a narrow desk, which pushed the sheet below the fold and made the
   * page look like a form. They now sit on a single line that scrolls
   * sideways if the desk is narrow, with the count and the view controls
   * pinned where they never move. */
  /** ONE toolbar line (owner 2026-08-19): a search box and a single Filter
   * button, exactly as the preview sheet does it. Six dropdowns competed with
   * the table for the room the table needs. */
  const filterBar = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div className="relative min-w-40 max-w-xs flex-1">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={filters.q}
          onChange={(e) => set({ q: e.target.value })}
          placeholder={searchLabel}
          aria-label={t("Search participants")}
          data-testid="participation-search"
          className="h-8 pl-7 text-xs"
        />
      </div>
      <Button
        type="button"
        size="sm"
        variant={drawerCount ? "secondary" : "outline"}
        data-testid="participation-open-filters"
        onClick={() => setDrawer(true)}
        className="shrink-0 px-2.5 text-xs"
      >
        <SlidersHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
        {t("Filter")}
        {drawerCount ? (
          <span className="rounded bg-primary px-1.5 font-tabular text-[0.6875rem] text-primary-foreground">
            {drawerCount}
          </span>
        ) : null}
      </Button>
      {filtersOn ? (
        <button
          type="button"
          data-testid="participation-clear"
          onClick={() => setFilters(EMPTY_PARTICIPATION_FILTERS)}
          className="shrink-0 whitespace-nowrap px-1 text-xs font-medium text-primary hover:underline"
        >
          {t("Clear filters")}
        </button>
      ) : null}
    </div>
  );

  return (
    <div
      className={cn(
        "flex w-full flex-col gap-6",
        embedded ? "" : "px-4 py-6 sm:px-6 lg:px-8",
      )}
    >
      <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        {/* Heading, back link, readings and controls all inside ONE panel. */}
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
          <div className="min-w-0">
            {embedded ? null : (
              <Link
                to={routes.tournamentParticipants(id)}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft aria-hidden="true" className="h-3 w-3" />
                {t("Back to participants")}
              </Link>
            )}
            {/* The house heading size (18px cap), not a bigger one of its
                own — the numbers beside it are the page's real headline. */}
            <h1 className="page-title pt-1">{t("Who is playing what")}</h1>
            <p className="text-xs text-muted-foreground">
              {t("Anyone in two events is someone the draw must keep apart.")}
            </p>
          </div>
          <ul className="flex flex-wrap gap-2">
            <li>
              <StatChip
                testid="stat-people"
                label={t("declared")}
                value={totals.people}
                active={!filters.events}
                onClick={() => set({ events: "" })}
              />
            </li>
            <li>
              <StatChip
                testid="stat-multi"
                label={t("in two or more")}
                value={totals.multi}
                tone="warning"
                active={filters.events === "multi"}
                onClick={() => set({ events: "multi" })}
              />
            </li>
            <li>
              <StatChip
                testid="stat-cross-sport"
                label={t("across two sports")}
                value={totals.multiAcrossSports}
                tone="warning"
                active={filters.events === "cross_sport"}
                onClick={() => set({ events: "cross_sport" })}
              />
            </li>
            <li>
              <StatChip
                testid="stat-unentered"
                label={t("not entered yet")}
                value={totals.unentered}
                active={filters.events === "none"}
                onClick={() => set({ events: "none" })}
              />
            </li>
            <li>
              <StatChip
                testid="stat-busiest"
                label={t("most events by one person")}
                value={totals.busiest}
              />
            </li>
          </ul>
        </div>

        <div className="flex items-center gap-2 border-b border-border px-4 py-2 sm:px-5">
          {filterBar}
          <div className="flex shrink-0 items-center gap-2 pl-2">
            <span className="whitespace-nowrap font-tabular text-xs text-muted-foreground">
              {rows.length} {rows.length === 1 ? t("person") : t("people")}
            </span>
            <div
              role="radiogroup"
              aria-label={t("Participation view")}
              className="inline-flex rounded-md border border-border bg-background p-0.5"
            >
              {(
                [
                  ["sheet", t("Sheet")],
                  ["matrix", t("Matrix")],
                ] as const
              ).map(([mode, lbl]) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={view === mode}
                  data-testid={`participation-view-${mode}`}
                  onClick={() => setView(mode)}
                  className={cn(
                    "h-7 rounded px-2.5 text-xs font-medium transition-colors",
                    view === mode
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {lbl}
                </button>
              ))}
            </div>
            {resized ? (
              <button
                type="button"
                data-testid="participation-reset-columns"
                onClick={resetWidths}
                className="whitespace-nowrap text-xs font-medium text-primary hover:underline"
              >
                {t("Reset widths")}
              </button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="participation-export"
              onClick={onExport}
            >
              <Download aria-hidden="true" className="h-3.5 w-3.5" />
              {t("Export CSV")}
            </Button>
          </div>
        </div>

        <ParticipationFilterDrawer
          open={drawer}
          onClose={() => setDrawer(false)}
          rows={all}
          filters={filters}
          onFilters={setFilters}
          visible={rows.length}
        />

        {q.isLoading ? (
          <div className="flex flex-col gap-1.5 p-4" aria-busy="true">
            {Array.from({ length: 10 }, (_, i) => (
              <div key={i} className="h-7 animate-pulse rounded bg-muted/40" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-14 text-center">
            <span
              aria-hidden="true"
              className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10"
            >
              <UserSquare2 className="h-7 w-7 text-primary" />
            </span>
            <h2 className="text-base font-semibold">
              {filtersOn ? t("Nobody matches that") : t("Nobody has been entered yet")}
            </h2>
            <p className="max-w-md text-sm text-muted-foreground">
              {filtersOn
                ? t("Clear the filters to see the whole list.")
                : t("Once the schools fill in the participants form, everyone appears here.")}
            </p>
          </div>
        ) : isMobile ? (
          <ul className="divide-y divide-border" data-testid="participation-cards">
            {rows.map((r) => (
              <li
                key={r.id}
                data-testid={`participation-${r.id}`}
                data-multi={r.events > 1 ? "" : undefined}
                className={cn("flex flex-col gap-1.5 px-4 py-3", r.events > 1 && "bg-warning-muted/30")}
              >
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {r.name}
                  </span>
                  <span className="font-tabular text-xs text-muted-foreground">
                    {r.events} {r.events === 1 ? t("event") : t("events")}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {[
                    r.kind === "teacher" ? t("Teacher in charge") : "",
                    ...detail
                      .filter((c) => c.key !== "docs")
                      .map((c) => cardDetail(r, c)),
                    r.group || r.school,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {r.documents.length ? (
                  <FileChips files={r.documents} />
                ) : null}
                <Chips row={r} wrap />
              </li>
            ))}
          </ul>
        ) : view === "sheet" ? (
          /* A spreadsheet, not a report: a row-number gutter to travel down,
             a gridline on every cell, one line per row, and a heading you can
             drag wider when a name does not fit (owner 2026-08-19). */
          <div
            ref={sheetRef}
            data-testid="participation-sheet"
            className="max-h-[70vh] overflow-auto"
          >
            <table
              className="border-separate border-spacing-0 text-sm"
              style={{ tableLayout: "fixed", width: sheetWidth }}
            >
              <caption className="sr-only">
                {t("Every declared person and the competitions they are entered in")}
              </caption>
              <colgroup>
                <col style={{ width: GUTTER }} />
                {sheetColumns.map((c) => (
                  <col key={c.key} style={{ width: widths[c.key] ?? c.width }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  <th
                    scope="col"
                    className="sticky left-0 top-0 z-40 border-b border-r border-border bg-muted px-2 py-2 text-right text-[0.6875rem] font-medium text-muted-foreground"
                  >
                    <span className="sr-only">{t("Row")}</span>
                    <span aria-hidden="true">#</span>
                  </th>
                  {sheetColumns.map((c) => {
                    const state = c.sort && sort.key === c.sort ? sort.dir : null;
                    const w = widths[c.key] ?? c.width;
                    return (
                      <th
                        key={c.key}
                        scope="col"
                        aria-sort={
                          c.sort
                            ? state
                              ? state === "asc"
                                ? "ascending"
                                : "descending"
                              : "none"
                            : undefined
                        }
                        className="sticky top-0 z-30 border-b border-r border-border bg-muted p-0 text-left font-medium"
                      >
                        <div className="relative flex items-stretch">
                          {c.sort ? (
                            <button
                              type="button"
                              data-testid={`participation-sort-${c.sort}`}
                              onClick={() => onSort(c.sort!)}
                              className={cn(
                                "flex h-8 min-w-0 flex-1 items-center gap-1 px-2 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:bg-secondary",
                                c.align === "right" && "justify-end",
                              )}
                            >
                              <span className="truncate">{t(c.label)}</span>
                              <SortIcon state={state} />
                            </button>
                          ) : (
                            <span className="flex h-8 min-w-0 flex-1 items-center px-2 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                              <span className="truncate">{t(c.label)}</span>
                            </span>
                          )}
                          <ColumnResizer
                            width={w}
                            label={t(c.label)}
                            testId={`participation-resize-${c.key}`}
                            onResize={(px) => setWidth(c.key, px)}
                            onAutoFit={() => autoFit(c.key)}
                          />
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const tint =
                    r.events > 1
                      ? "bg-warning-muted/40"
                      : i % 2
                        ? "bg-muted/20"
                        : "bg-card";
                  const cell =
                    "truncate border-b border-r border-border/60 px-2 py-1.5 group-hover:bg-accent/40";
                  return (
                    <tr
                      key={r.id}
                      data-testid={`participation-${r.id}`}
                      data-multi={r.events > 1 ? "" : undefined}
                      className={cn("group", tint)}
                    >
                      <td
                        data-row-number=""
                        className={cn(
                          "sticky left-0 z-20 border-b border-r border-border px-2 py-1.5 text-right font-tabular text-[0.6875rem] text-muted-foreground",
                          tint,
                        )}
                      >
                        {i + 1}
                      </td>
                      <td data-col="name" className={cell} title={r.name}>
                        <span className="flex items-center gap-1.5">
                          <span className="truncate font-medium">{r.name}</span>
                          {r.kind === "teacher" ? (
                            <span className="shrink-0 rounded bg-muted px-1.5 text-[0.625rem] uppercase tracking-wide text-muted-foreground">
                              {t("Teacher")}
                            </span>
                          ) : null}
                        </span>
                      </td>
                      {detail.map((c) => (
                        <DetailCell key={c.key} column={c} row={r} cell={cell} />
                      ))}
                      <td
                        data-col="school"
                        className={cn(cell, "text-muted-foreground")}
                        title={r.group || r.school || undefined}
                      >
                        <span className="block truncate">
                          {r.group || r.school || "·"}
                        </span>
                      </td>
                      <td
                        data-col="events"
                        className={cn(
                          cell,
                          "text-right font-tabular",
                          r.events > 1 && "font-semibold text-warning",
                        )}
                      >
                        <span className="block truncate">{r.events}</span>
                      </td>
                      <td
                        data-col="entries"
                        className={cn(cell, "overflow-hidden")}
                        title={r.entries.map((e) => e.competition).join(" · ")}
                      >
                        <Chips row={r} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          /* The literal grid: a row with two ticks IS a person the draw must
             keep apart, readable across without counting chips. */
          <div className="max-h-[70vh] overflow-auto">
            <table
              data-testid="participation-matrix"
              className="border-separate border-spacing-0 text-sm"
              style={{
                tableLayout: "fixed",
                width:
                  GUTTER + (widths.name ?? DEFAULT_WIDTHS.name) + 64 +
                  columns.length * 36,
              }}
            >
              <caption className="sr-only">
                {t("Participants by competition, ticked where they are entered")}
              </caption>
              <colgroup>
                <col style={{ width: GUTTER }} />
                <col style={{ width: widths.name ?? DEFAULT_WIDTHS.name }} />
                <col style={{ width: 64 }} />
                {columns.map((c) => (
                  <col key={c.value} style={{ width: 36 }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  <th
                    scope="col"
                    className="sticky left-0 top-0 z-40 border-b border-r border-border bg-muted px-2 py-2 text-right text-[0.6875rem] font-medium text-muted-foreground"
                  >
                    <span className="sr-only">{t("Row")}</span>
                    <span aria-hidden="true">#</span>
                  </th>
                  <th
                    scope="col"
                    style={{ left: GUTTER }}
                    className="sticky top-0 z-30 border-b border-r border-border bg-muted p-0 text-left font-medium"
                  >
                    <div className="relative flex items-stretch">
                      <span className="flex h-8 min-w-0 flex-1 items-center px-2 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                        {t("Name")}
                      </span>
                      <ColumnResizer
                        width={widths.name ?? DEFAULT_WIDTHS.name}
                        label={t("Name")}
                        testId="participation-resize-matrix-name"
                        onResize={(px) => setWidth("name", px)}
                        onAutoFit={() => autoFit("name")}
                      />
                    </div>
                  </th>
                  <th
                    scope="col"
                    className="sticky top-0 z-20 border-b border-r border-border bg-muted px-2 py-2 text-right text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground"
                  >
                    {t("Events")}
                  </th>
                  {columns.map((c) => (
                    <th
                      key={c.value}
                      scope="col"
                      title={c.label}
                      className="sticky top-0 z-20 h-28 border-b border-r border-border bg-muted p-0 align-bottom last:border-r-0"
                    >
                      {/* Upright labels: a competition name is far wider than
                          its tick column, and rotating is what keeps the grid
                          readable rather than 30 characters of ellipsis. */}
                      <span className="flex h-28 w-9 items-end justify-center pb-2">
                        <span
                          className="whitespace-nowrap text-[0.6875rem] font-medium text-muted-foreground"
                          style={{ writingMode: "vertical-rl", rotate: "180deg" }}
                        >
                          {c.label}
                        </span>
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const mine = new Set(r.entries.map((e) => e.leafKey));
                  return (
                    <tr
                      key={r.id}
                      data-testid={`participation-matrix-${r.id}`}
                      data-multi={r.events > 1 ? "" : undefined}
                      className={cn(
                        "group",
                        r.events > 1
                          ? "bg-warning-muted/40"
                          : i % 2
                            ? "bg-muted/20"
                            : "bg-card",
                      )}
                    >
                      <td
                        className={cn(
                          "sticky left-0 z-20 border-b border-r border-border px-2 py-1.5 text-right font-tabular text-[0.6875rem] text-muted-foreground",
                          r.events > 1
                            ? "bg-warning-muted"
                            : i % 2
                              ? "bg-muted/20"
                              : "bg-card",
                        )}
                      >
                        {i + 1}
                      </td>
                      <th
                        scope="row"
                        data-col="name"
                        title={r.name}
                        style={{ left: GUTTER }}
                        className={cn(
                          "sticky z-10 border-b border-r border-border px-2 py-1.5 text-left font-medium",
                          r.events > 1
                            ? "bg-warning-muted"
                            : i % 2
                              ? "bg-muted/20"
                              : "bg-card",
                        )}
                      >
                        <span className="block truncate">{r.name}</span>
                      </th>
                      <td
                        className={cn(
                          "border-b border-r border-border/60 px-2 py-1.5 text-right font-tabular",
                          r.events > 1 && "font-semibold text-warning",
                        )}
                      >
                        {r.events}
                      </td>
                      {columns.map((c) => (
                        <td
                          key={c.value}
                          className="border-b border-r border-border/60 px-2 py-1.5 text-center last:border-r-0 group-hover:bg-accent/40"
                        >
                          {mine.has(c.value) ? (
                            <span
                              aria-label={`${r.name}: ${c.label}`}
                              className="inline-block h-2.5 w-2.5 rounded-sm bg-primary"
                            />
                          ) : (
                            <span className="sr-only">{t("No")}</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
