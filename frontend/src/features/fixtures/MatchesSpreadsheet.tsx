import { Fragment, useMemo } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown, Coffee } from "lucide-react";
import type { PreviewMatch } from "@/api/tournaments";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { useBreakpoint } from "@/lib/useBreakpoint";
import {
  fmtClock,
  groupRows,
  linesWithBreaks,
  occupancyByCourt,
  sortRows,
  type BlackoutWindow,
  type ColumnKey,
  type GridSort,
  type GroupBy,
  type PreviewRow,
} from "./previewGrid";

interface Column {
  key: ColumnKey;
  label: string;
  /** Header + cell alignment; numbers sit right like a spreadsheet. */
  align?: "right";
  width: string;
  /** Dropped on phones, where the sheet keeps only the working columns. */
  phone?: boolean;
  cell: (r: PreviewRow) => React.ReactNode;
}

const COLUMNS: Column[] = [
  {
    key: "day",
    label: "Day",
    width: "w-28",
    cell: (r) => (
      <span className={cn(!r.day && "text-muted-foreground")}>{r.dayLabel}</span>
    ),
  },
  {
    key: "start",
    label: "Start",
    width: "w-20",
    phone: true,
    cell: (r) => (
      <span className="whitespace-nowrap font-tabular">
        {fmtClock(r.start) || "·"}
      </span>
    ),
  },
  {
    key: "end",
    label: "End",
    width: "w-20",
    cell: (r) => (
      <span className="whitespace-nowrap font-tabular text-muted-foreground">
        {fmtClock(r.end) || "·"}
      </span>
    ),
  },
  {
    key: "minutes",
    label: "Min",
    align: "right",
    width: "w-12",
    cell: (r) => (
      <span className="font-tabular text-muted-foreground">
        {r.minutes ?? "·"}
      </span>
    ),
  },
  {
    key: "venue",
    label: "Venue",
    width: "w-32",
    phone: true,
    cell: (r) => <span className="truncate">{r.day ? r.venue : "·"}</span>,
  },
  {
    key: "sport",
    label: "Sport",
    width: "w-28",
    cell: (r) => <span className="truncate">{r.sportLabel}</span>,
  },
  {
    key: "category",
    label: "Category",
    width: "w-44",
    cell: (r) => (
      <span className="truncate text-muted-foreground">{r.categoryLabel}</span>
    ),
  },
  {
    key: "group",
    label: "Stage",
    width: "w-28",
    cell: (r) => (
      <span className="truncate">{r.group || r.stageLabel}</span>
    ),
  },
  {
    key: "round",
    label: "Rd",
    align: "right",
    width: "w-10",
    cell: (r) => (
      <span className="font-tabular text-muted-foreground">
        {r.round ? `R${r.round}` : "·"}
      </span>
    ),
  },
  {
    key: "home",
    label: "Home",
    width: "w-56",
    phone: true,
    cell: (r) => <span className="truncate font-medium">{r.home}</span>,
  },
  {
    key: "away",
    label: "Away",
    width: "w-56",
    phone: true,
    cell: (r) => <span className="truncate font-medium">{r.away}</span>,
  },
  {
    key: "status",
    label: "Status",
    width: "w-24",
    cell: (r) =>
      r.placed ? (
        <span className="text-muted-foreground">{t("Scheduled")}</span>
      ) : (
        <span className="rounded bg-warning-muted px-1.5 py-0.5 font-medium text-warning">
          {t("No time")}
        </span>
      ),
  },
];

function SortIcon({ state }: { state: "asc" | "desc" | null }): React.ReactElement {
  const Icon = state === "asc" ? ArrowUp : state === "desc" ? ArrowDown : ChevronsUpDown;
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        "h-3 w-3 shrink-0",
        state ? "text-primary" : "text-muted-foreground/50",
      )}
    />
  );
}

/**
 * The dry-run schedule as a spreadsheet (owner ask 2026-08-15): one dense line
 * per match, frozen header + line-number column, grid rules, click-to-sort
 * columns and optional group bands (day, court, competition, group). Court
 * breaks render as their own line so an idle stretch is visible in the sheet
 * rather than inferred from a time jump.
 */
export function MatchesSpreadsheet({
  rows,
  sort,
  onSort,
  groupBy,
  occupancy,
  blackouts,
  onClearFilters,
  filtered,
}: {
  /** Rows AFTER the toolbar's filters. */
  rows: PreviewRow[];
  sort: GridSort | null;
  onSort: (key: ColumnKey) => void;
  groupBy: GroupBy;
  /** Every previewed match, so a break only shows when the court is truly free. */
  occupancy?: readonly PreviewMatch[];
  /** Configured no-play windows, so a scheduled break says which one it is. */
  blackouts?: readonly BlackoutWindow[];
  onClearFilters?: () => void;
  /** True when filters are hiding rows (drives the empty-state wording). */
  filtered?: boolean;
}): React.ReactElement {
  const { isMobile } = useBreakpoint();
  const columns = useMemo(
    () => (isMobile ? COLUMNS.filter((c) => c.phone) : COLUMNS),
    [isMobile],
  );
  const busyByCourt = useMemo(
    () => occupancyByCourt(occupancy ?? rows.map((r) => r.match)),
    [occupancy, rows],
  );

  const { bands, lineNos } = useMemo(() => {
    const sorted = sortRows(rows, sort);
    const grouped = groupRows(sorted, groupBy).map((band) => ({
      ...band,
      // Breaks are a property of one court on one day; any other grouping
      // mixes courts, where an "idle" gap would be meaningless.
      lines:
        groupBy === "day_venue"
          ? linesWithBreaks(
              band.rows,
              busyByCourt.get(`${band.day}|${band.venue}`) ?? [],
              blackouts ?? [],
            )
          : band.rows.map((row) => ({ kind: "match" as const, row })),
    }));
    // Line numbers run continuously down the whole sheet, in the order the
    // bands actually render.
    const nos = new Map(
      grouped
        .flatMap((b) => b.lines)
        .filter((l) => l.kind === "match")
        .map((l, i) => [l.row.ref, i + 1] as const),
    );
    return { bands: grouped, lineNos: nos };
  }, [rows, sort, groupBy, busyByCourt, blackouts]);

  const span = columns.length + 1;

  return (
    <div
      data-testid="matches-spreadsheet"
      className="relative max-h-[65vh] w-full overflow-auto overscroll-contain"
    >
      <table className="w-full border-separate border-spacing-0 text-xs">
        <caption className="sr-only">
          {t("Previewed matches, one row per match")}
        </caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="sticky left-0 top-0 z-30 w-10 border-b border-r border-border bg-muted px-2 py-1.5 text-right font-tabular text-[0.6875rem] font-medium text-muted-foreground"
            >
              #
            </th>
            {columns.map((c) => {
              const state = sort?.key === c.key ? sort.dir : null;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={
                    state ? (state === "asc" ? "ascending" : "descending") : "none"
                  }
                  className={cn(
                    "sticky top-0 z-20 border-b border-r border-border bg-muted p-0 text-left font-medium last:border-r-0",
                    c.width,
                  )}
                >
                  <button
                    type="button"
                    data-testid={`sheet-sort-${c.key}`}
                    onClick={() => onSort(c.key)}
                    title={t("Sort by this column")}
                    className={cn(
                      "flex h-7 w-full items-center gap-1 px-2 text-[0.6875rem] font-medium uppercase tracking-wide transition-colors hover:bg-secondary",
                      c.align === "right" && "justify-end",
                      state ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {t(c.label)}
                    <SortIcon state={state} />
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={span} className="border-b border-border px-3 py-8 text-center">
                <p className="text-sm text-muted-foreground">
                  {filtered
                    ? t("No matches fit these filters.")
                    : t("No matches were scheduled in this preview.")}
                </p>
                {filtered && onClearFilters ? (
                  <button
                    type="button"
                    data-testid="sheet-empty-clear"
                    onClick={onClearFilters}
                    className="mt-1 text-xs font-medium text-primary hover:underline"
                  >
                    {t("Clear filters")}
                  </button>
                ) : null}
              </td>
            </tr>
          ) : null}

          {bands.map((band) => (
            <Fragment key={band.key || "all"}>
              {band.label ? (
                <tr data-testid={`sheet-band-${band.key}`}>
                  <td
                    colSpan={span}
                    className="border-b border-border bg-secondary/60 px-2 py-1"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-[0.6875rem] font-semibold uppercase tracking-wide">
                        {band.label}
                      </span>
                      {band.sub ? (
                        <span className="text-[0.6875rem] text-muted-foreground">
                          {band.sub}
                        </span>
                      ) : null}
                      <span className="ml-auto font-tabular text-[0.6875rem] text-muted-foreground">
                        {band.rows.length} {t("matches")}
                      </span>
                    </span>
                  </td>
                </tr>
              ) : null}
              {band.lines.map((line) => {
                if (line.kind === "break") {
                  return (
                    <tr key={line.key} data-testid={`sheet-break-${line.key}`}>
                      <td className="sticky left-0 z-10 border-b border-r border-border bg-warning-muted" />
                      <td
                        colSpan={span - 1}
                        className="border-b border-border bg-warning-muted px-2 py-1"
                      >
                        <span className="flex items-center gap-1.5">
                          <Coffee aria-hidden="true" className="h-3 w-3 text-warning" />
                          <span className="text-[0.6875rem] font-medium">
                            {line.label}
                          </span>
                          <span className="font-tabular text-[0.6875rem] text-muted-foreground">
                            {fmtClock(line.from)} {t("to")} {fmtClock(line.to)} ·{" "}
                            {line.minutes} {t("min")}
                          </span>
                        </span>
                      </td>
                    </tr>
                  );
                }
                const r = line.row;
                const lineNo = lineNos.get(r.ref) ?? 0;
                const zebra = lineNo % 2 === 0 ? "bg-muted/20" : "bg-card";
                return (
                  <tr
                    key={r.ref}
                    data-testid={`sheet-row-${r.ref}`}
                    data-unplaced={r.placed ? undefined : "true"}
                    className={cn("group", zebra, !r.placed && "bg-warning-muted/40")}
                  >
                    <td
                      className={cn(
                        "sticky left-0 z-10 border-b border-r border-border px-2 py-1 text-right font-tabular text-[0.6875rem] text-muted-foreground",
                        zebra,
                        !r.placed && "bg-warning-muted",
                      )}
                    >
                      {lineNo}
                    </td>
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        className={cn(
                          "max-w-0 border-b border-r border-border/60 px-2 py-1 last:border-r-0 group-hover:bg-accent/40",
                          c.align === "right" && "text-right",
                        )}
                      >
                        <span className="flex items-center gap-1 truncate">
                          {c.cell(r)}
                        </span>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
