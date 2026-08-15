import { useMemo, useState } from "react";
import { Check, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import {
  EMPTY_FILTERS,
  FILTER_FIELDS,
  applyFilters,
  facetsFor,
  type FacetField,
  type GridFilters,
  type PreviewRow,
} from "./previewGrid";

/** Status is not a facet of the data — it is the scheduler's verdict. */
const STATUS_OPTIONS: { value: GridFilters["status"]; label: string }[] = [
  { value: "placed", label: "Scheduled" },
  { value: "unplaced", label: "No time yet" },
];

type Pane = FacetField | "status";

/** Lists longer than this get their own search box. */
const SEARCH_THRESHOLD = 8;

/**
 * The filter drawer (owner ask 2026-08-15): one "Filter" button opens a
 * right-hand sheet with the filter NAMES down the left and the chosen
 * filter's values on the right — instead of a row of seven dropdowns
 * competing with the sheet for the toolbar.
 *
 * Values carry the count they would give you, computed against every OTHER
 * filter (the ERP faceting rule), so the drawer never offers a pick that
 * empties the grid without saying so.
 */
export function PreviewFilterDrawer({
  open,
  onClose,
  rows,
  filters,
  onFilters,
  visible,
}: {
  open: boolean;
  onClose: () => void;
  /** ALL rows (unfiltered) — the facets count against them. */
  rows: PreviewRow[];
  filters: GridFilters;
  onFilters: (f: GridFilters) => void;
  /** How many rows the current filters leave. */
  visible: number;
}): React.ReactElement | null {
  const [pane, setPane] = useState<Pane>("sport");
  const [query, setQuery] = useState("");

  const facets = useMemo(() => {
    const out = {} as Record<FacetField, ReturnType<typeof facetsFor>>;
    for (const f of FILTER_FIELDS) out[f.key] = facetsFor(rows, filters, f.key);
    return out;
  }, [rows, filters]);

  // Names for every value the data ever had, so the left rail can show what is
  // picked even when another filter empties that facet.
  const names = useMemo(() => {
    const out = new Map<string, string>();
    for (const f of FILTER_FIELDS) {
      for (const o of facetsFor(rows, EMPTY_FILTERS, f.key)) {
        out.set(`${f.key}|${o.value}`, o.label);
      }
    }
    return out;
  }, [rows]);

  const statusCounts = useMemo(() => {
    const base = applyFilters(rows, { ...filters, status: "" });
    return {
      placed: base.filter((r) => r.placed).length,
      unplaced: base.filter((r) => !r.placed).length,
    };
  }, [rows, filters]);

  if (!open) return null;

  const valueLabel = (key: Pane): string => {
    if (key === "status") {
      return (
        STATUS_OPTIONS.find((o) => o.value === filters.status)?.label ??
        t("Any")
      );
    }
    const v = filters[key];
    return v ? (names.get(`${key}|${v}`) ?? v) : t("All");
  };

  const options =
    pane === "status"
      ? STATUS_OPTIONS.map((o) => ({
          value: o.value,
          label: t(o.label),
          count: statusCounts[o.value as "placed" | "unplaced"],
        }))
      : facets[pane];
  const searchable = options.length > SEARCH_THRESHOLD;
  const shown = searchable && query.trim()
    ? options.filter((o) =>
        o.label.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : options;

  const pick = (value: string): void => {
    setQuery("");
    onFilters(
      pane === "sport"
        ? // A sport change drops a category belonging to another sport.
          { ...filters, sport: value, category: "" }
        : ({ ...filters, [pane]: value } as GridFilters),
    );
  };

  const panes: { key: Pane; label: string }[] = [
    ...FILTER_FIELDS.map((f) => ({ key: f.key as Pane, label: t(f.label) })),
    { key: "status", label: t("Status") },
  ];
  const activeCount = (Object.keys(EMPTY_FILTERS) as (keyof GridFilters)[]).filter(
    (k) => k !== "q" && filters[k] !== "",
  ).length;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      variant="side"
      ariaLabel={t("Filter matches")}
    >
      <div data-testid="filter-drawer" className="flex h-full flex-col gap-3">
        <header className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">{t("Filter matches")}</h2>
          <span
            data-testid="drawer-count"
            className="font-tabular text-xs text-muted-foreground"
          >
            {visible} {t("of")} {rows.length} {t("rows")}
          </span>
          <button
            type="button"
            aria-label={t("Close")}
            data-testid="drawer-close"
            onClick={onClose}
            className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
          {/* Left: the filter names, each showing what it is set to. */}
          <nav
            aria-label={t("Filters")}
            className="flex w-40 shrink-0 flex-col overflow-y-auto border-r border-border bg-muted/30"
          >
            {panes.map((p) => {
              const set =
                p.key === "status" ? filters.status !== "" : filters[p.key] !== "";
              return (
                <button
                  key={p.key}
                  type="button"
                  data-testid={`filter-pane-${p.key}`}
                  aria-current={pane === p.key}
                  onClick={() => {
                    setPane(p.key);
                    setQuery("");
                  }}
                  className={cn(
                    "flex flex-col items-start gap-0.5 border-b border-border px-3 py-2 text-left transition-colors",
                    pane === p.key ? "bg-card" : "hover:bg-muted/60",
                  )}
                >
                  <span className="flex w-full items-center gap-1.5 text-xs font-medium">
                    {p.label}
                    {set ? (
                      <span
                        aria-hidden="true"
                        className="ml-auto h-1.5 w-1.5 rounded-full bg-primary"
                      />
                    ) : null}
                  </span>
                  <span
                    className={cn(
                      "max-w-full truncate text-[0.6875rem]",
                      set ? "text-primary" : "text-muted-foreground",
                    )}
                  >
                    {valueLabel(p.key)}
                  </span>
                </button>
              );
            })}
          </nav>

          {/* Right: that filter's values, with the count each would give. */}
          <div className="flex min-w-0 flex-1 flex-col">
            {searchable ? (
              <div className="relative border-b border-border p-2">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  value={query}
                  aria-label={t("Search values")}
                  data-testid="filter-value-search"
                  placeholder={t("Search")}
                  onChange={(e) => setQuery(e.target.value)}
                  className="h-9 pl-7 text-xs"
                />
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <button
                type="button"
                data-testid="filter-value-all"
                onClick={() => pick("")}
                className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-xs hover:bg-muted/60"
              >
                <Check
                  aria-hidden="true"
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    (pane === "status" ? filters.status : filters[pane]) === ""
                      ? "text-primary"
                      : "text-transparent",
                  )}
                />
                <span className="font-medium">{t("All")}</span>
                <span className="ml-auto font-tabular text-[0.6875rem] text-muted-foreground">
                  {rows.length}
                </span>
              </button>
              {shown.map((o) => {
                const active =
                  (pane === "status" ? filters.status : filters[pane]) === o.value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    data-testid={`filter-value-${o.value}`}
                    onClick={() => pick(o.value)}
                    className={cn(
                      "flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-xs hover:bg-muted/60",
                      active && "bg-primary/5",
                    )}
                  >
                    <Check
                      aria-hidden="true"
                      className={cn(
                        "h-3.5 w-3.5 shrink-0",
                        active ? "text-primary" : "text-transparent",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    <span
                      className={cn(
                        "font-tabular text-[0.6875rem]",
                        o.count ? "text-muted-foreground" : "text-muted-foreground/50",
                      )}
                    >
                      {o.count}
                    </span>
                  </button>
                );
              })}
              {shown.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  {t("Nothing to filter by here.")}
                </p>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            data-testid="drawer-clear"
            disabled={!activeCount && !filters.q}
            onClick={() => onFilters(EMPTY_FILTERS)}
          >
            {t("Clear all")}
          </Button>
          <Button className="ml-auto" data-testid="drawer-done" onClick={onClose}>
            {t(`Show ${visible} matches`)}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
