import { useMemo, useState } from "react";
import { Download, FileText, Search, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, type SelectOption } from "@/components/ui/Select";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { PreviewFilterDrawer } from "./PreviewFilterDrawer";
import {
  EMPTY_FILTERS,
  FILTER_FIELDS,
  facetsFor,
  GROUP_LABELS,
  type GridFilters,
  type GroupBy,
  type PreviewRow,
} from "./previewGrid";

const GROUP_OPTIONS: SelectOption[] = (
  Object.keys(GROUP_LABELS) as GroupBy[]
).map((value) => ({ value, label: t(GROUP_LABELS[value]) }));

const STATUS_LABELS: Record<string, string> = {
  placed: "Scheduled",
  unplaced: "No time yet",
};

function Chip({
  label,
  value,
  onClear,
  testid,
}: {
  label: string;
  value: string;
  onClear: () => void;
  testid: string;
}): React.ReactElement {
  return (
    <span
      data-testid={testid}
      className="inline-flex shrink-0 items-center gap-1 rounded border border-primary/30 bg-primary/10 py-0.5 pl-1.5 pr-1 text-[0.6875rem] font-medium text-primary"
    >
      <span className="text-primary/70">{label}</span>
      <span className="max-w-40 truncate">{value}</span>
      <button
        type="button"
        aria-label={t(`Clear ${label} filter`)}
        onClick={onClear}
        className="rounded-sm p-0.5 hover:bg-primary/20"
      >
        <X aria-hidden="true" className="h-3 w-3" />
      </button>
    </span>
  );
}

/**
 * The sheet's toolbar: a search box, ONE Filter button (the filters live in a
 * right-hand drawer — owner 2026-08-15, seven dropdowns were crowding the
 * sheet), the applied filters restated as removable chips, the group-by
 * control, the visible/total tally and two exports — CSV for a spreadsheet,
 * PDF for the landscape run sheet — both carrying exactly what is on screen.
 * Selection is lifted so the page can drive the sheet and the competition
 * views from the same state.
 */
export function PreviewToolbar({
  rows,
  filters,
  onFilters,
  groupBy,
  onGroupBy,
  visible,
  onExportCsv,
  onExportPdf,
}: {
  /** ALL rows (unfiltered) — facets count against them. */
  rows: PreviewRow[];
  filters: GridFilters;
  onFilters: (f: GridFilters) => void;
  groupBy: GroupBy;
  onGroupBy: (g: GroupBy) => void;
  /** How many rows survive the current filters. */
  visible: number;
  /** Both exports carry exactly what the filters are showing. */
  onExportCsv: () => void;
  onExportPdf: () => void;
}): React.ReactElement {
  const [drawer, setDrawer] = useState(false);

  // Names for every value the data has ever had, so a chip reads "Table
  // Tennis" even when another filter leaves that facet empty.
  const names = useMemo(() => {
    const out = new Map<string, string>();
    for (const f of FILTER_FIELDS) {
      for (const o of facetsFor(rows, EMPTY_FILTERS, f.key)) {
        out.set(`${f.key}|${o.value}`, o.label);
      }
    }
    return out;
  }, [rows]);

  const set = (patch: Partial<GridFilters>): void =>
    onFilters({ ...filters, ...patch });

  const active = (Object.keys(EMPTY_FILTERS) as (keyof GridFilters)[]).filter(
    (k) => filters[k] !== "",
  );
  // The Filter button counts what the drawer owns; the search box shows itself.
  const drawerCount = active.filter((k) => k !== "q").length;

  const chipLabel: Record<keyof GridFilters, string> = {
    q: t("Search"),
    sport: t("Sport"),
    category: t("Category"),
    day: t("Day"),
    venue: t("Venue"),
    stage: t("Stage"),
    round: t("Round"),
    status: t("Status"),
  };

  const chipValue = (k: keyof GridFilters): string => {
    if (k === "q") return filters.q;
    if (k === "status") return t(STATUS_LABELS[filters.status] ?? filters.status);
    return names.get(`${k}|${filters[k]}`) ?? filters[k];
  };

  return (
    <div
      data-testid="preview-toolbar"
      className="flex flex-col gap-2 border-b border-border bg-muted/30 px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="relative min-w-48 flex-1 sm:max-w-72">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={filters.q}
            data-testid="filter-search"
            aria-label={t("Search matches")}
            placeholder={t("Search team, court, competition")}
            onChange={(e) => set({ q: e.target.value })}
            className="h-9 pl-7 text-xs"
          />
        </div>

        <Button
          variant={drawerCount ? "secondary" : "outline"}
          data-testid="open-filters"
          onClick={() => setDrawer(true)}
          className="px-2.5 text-xs"
        >
          <SlidersHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
          {t("Filter")}
          {drawerCount ? (
            <span className="rounded bg-primary px-1.5 font-tabular text-[0.6875rem] text-primary-foreground">
              {drawerCount}
            </span>
          ) : null}
        </Button>

        <div className="ml-auto flex items-center gap-1.5">
          <span className="hidden text-[0.6875rem] text-muted-foreground sm:inline">
            {t("Group by")}
          </span>
          <div className="w-36" data-testid="filter-groupby">
            <Select
              size="sm"
              value={groupBy}
              aria-label={t("Group by")}
              onChange={(v) => onGroupBy(v as GroupBy)}
              options={GROUP_OPTIONS}
              className="text-xs"
            />
          </div>
          <Button
            variant="outline"
            data-testid="export-csv"
            onClick={onExportCsv}
            className="px-2.5 text-xs"
            title={t("Download the rows you can see as a spreadsheet")}
          >
            <Download aria-hidden="true" className="h-3.5 w-3.5" />
            {t("CSV")}
          </Button>
          <Button
            variant="outline"
            data-testid="export-pdf"
            onClick={onExportPdf}
            className="px-2.5 text-xs"
            title={t("Print or save the rows you can see, landscape")}
          >
            <FileText aria-hidden="true" className="h-3.5 w-3.5" />
            {t("PDF")}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span
          data-testid="sheet-count"
          className="font-tabular text-[0.6875rem] text-muted-foreground"
        >
          {visible === rows.length
            ? t(`${rows.length} rows`)
            : t(`${visible} of ${rows.length} rows`)}
        </span>
        {active.map((k) => (
          <Chip
            key={k}
            testid={`chip-filter-${k}`}
            label={chipLabel[k]}
            value={chipValue(k)}
            onClear={() => set({ [k]: "" } as Partial<GridFilters>)}
          />
        ))}
        {active.length ? (
          <button
            type="button"
            data-testid="clear-filters"
            onClick={() => onFilters(EMPTY_FILTERS)}
            className={cn(
              "text-[0.6875rem] font-medium text-primary hover:underline",
            )}
          >
            {t("Clear all")}
          </button>
        ) : null}
      </div>

      <PreviewFilterDrawer
        open={drawer}
        onClose={() => setDrawer(false)}
        rows={rows}
        filters={filters}
        onFilters={onFilters}
        visible={visible}
      />
    </div>
  );
}
