import { useMemo } from "react";
import { Download, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, type SelectOption } from "@/components/ui/Select";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import {
  EMPTY_FILTERS,
  facetsFor,
  type GridFilters,
  type GroupBy,
  type PreviewRow,
} from "./previewGrid";

/** The filter fields that are driven by facets of the data itself. */
const FACET_FIELDS = [
  ["sport", "Sport"],
  ["category", "Category"],
  ["day", "Day"],
  ["venue", "Venue"],
  ["stage", "Stage"],
  ["round", "Round"],
] as const;

type FacetField = (typeof FACET_FIELDS)[number][0];

const GROUP_OPTIONS: SelectOption[] = [
  { value: "day_venue", label: t("Day and court") },
  { value: "day", label: t("Day") },
  { value: "venue", label: t("Court") },
  { value: "competition", label: t("Competition") },
  { value: "group", label: t("Group") },
  { value: "none", label: t("No grouping") },
];

const STATUS_OPTIONS: SelectOption[] = [
  { value: "", label: t("Any status") },
  { value: "placed", label: t("Scheduled") },
  { value: "unplaced", label: t("No time yet") },
];

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
 * The spreadsheet's filter bar, ERP-style (owner ask 2026-08-15): a search box
 * plus one dropdown per column facet, each counting rows against the OTHER
 * filters, the applied filters restated as removable chips, a group-by
 * control, the visible/total tally and a CSV export of exactly what is on
 * screen. Selection is lifted so the page can drive the sheet and the
 * competition views from the same state.
 */
export function PreviewToolbar({
  rows,
  filters,
  onFilters,
  groupBy,
  onGroupBy,
  visible,
  onExport,
}: {
  /** ALL rows (unfiltered) — facets count against them. */
  rows: PreviewRow[];
  filters: GridFilters;
  onFilters: (f: GridFilters) => void;
  groupBy: GroupBy;
  onGroupBy: (g: GroupBy) => void;
  /** How many rows survive the current filters. */
  visible: number;
  onExport: () => void;
}): React.ReactElement {
  const facets = useMemo(() => {
    const out = {} as Record<FacetField, ReturnType<typeof facetsFor>>;
    for (const [field] of FACET_FIELDS) out[field] = facetsFor(rows, filters, field);
    return out;
  }, [rows, filters]);
  // Names for every value the data has ever had. The contextual facets above
  // can legitimately go empty (another filter excludes everything), and a chip
  // must still read "Table Tennis", never the raw key.
  const names = useMemo(() => {
    const out = new Map<string, string>();
    for (const [field] of FACET_FIELDS) {
      for (const o of facetsFor(rows, EMPTY_FILTERS, field)) {
        out.set(`${field}|${o.value}`, o.label);
      }
    }
    return out;
  }, [rows]);

  const set = (patch: Partial<GridFilters>): void =>
    onFilters({ ...filters, ...patch });

  const active = (Object.keys(EMPTY_FILTERS) as (keyof GridFilters)[]).filter(
    (k) => filters[k] !== "",
  );

  const labelFor = (field: FacetField, value: string): string =>
    names.get(`${field}|${value}`) ?? value;

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

        {FACET_FIELDS.map(([field, label]) => {
          const options = facets[field];
          // A facet with nothing to choose between is noise, not a filter.
          if (options.length < 2 && !filters[field]) return null;
          return (
            <div key={field} className="w-36" data-testid={`filter-${field}`}>
              <Select
                size="sm"
                value={filters[field]}
                aria-label={t(label)}
                placeholder={t(`All ${label.toLowerCase()}`)}
                onChange={(v) =>
                  set(
                    // Picking a sport drops a category from another sport.
                    field === "sport" ? { sport: v, category: "" } : { [field]: v },
                  )
                }
                options={[
                  { value: "", label: t(`All ${label.toLowerCase()}`) },
                  // The picked value always stays in its own list, even when
                  // another filter leaves it with nothing.
                  ...(filters[field] && !options.some((o) => o.value === filters[field])
                    ? [
                        {
                          value: filters[field],
                          label: `${labelFor(field, filters[field])} (0)`,
                        },
                      ]
                    : []),
                  ...options.map((o) => ({
                    value: o.value,
                    label: `${o.label} (${o.count})`,
                  })),
                ]}
                className="text-xs"
              />
            </div>
          );
        })}

        <div className="w-32" data-testid="filter-status">
          <Select
            size="sm"
            value={filters.status}
            aria-label={t("Status")}
            onChange={(v) => set({ status: v as GridFilters["status"] })}
            options={STATUS_OPTIONS}
            className="text-xs"
          />
        </div>

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
            onClick={onExport}
            className="px-2.5 text-xs"
            title={t("Download the rows you can see")}
          >
            <Download aria-hidden="true" className="h-3.5 w-3.5" />
            {t("CSV")}
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
            value={
              k === "q"
                ? filters.q
                : k === "status"
                  ? (STATUS_OPTIONS.find((o) => o.value === filters.status)?.label ??
                    filters.status)
                  : labelFor(k as FacetField, filters[k])
            }
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
    </div>
  );
}
