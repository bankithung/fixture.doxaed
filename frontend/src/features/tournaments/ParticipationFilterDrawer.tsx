import { useMemo, useState } from "react";
import { Check, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import {
  applyParticipationFilters,
  EMPTY_PARTICIPATION_FILTERS,
  EVENT_FILTER_VALUES,
  KIND_FILTER_VALUES,
  participationFacets,
  type ParticipationFilters,
  type ParticipationRow,
} from "./participation";

/**
 * The participation filters, in the drawer the preview sheet already uses
 * (owner 2026-08-19: "make it like this page filter, the sidebar").
 *
 * Six dropdowns on the toolbar competed with the table for the room the table
 * needs; ONE Filter button and a right-hand sheet gives the filter names down
 * the left and the chosen filter's values on the right. Every value carries
 * the count it would leave, computed against the OTHER filters, so the drawer
 * never offers a pick that empties the list without saying so.
 */

/** Lists longer than this get their own search box. */
const SEARCH_THRESHOLD = 8;


type Pane = "events" | "kind" | "sport" | "competition" | "school";

const PANES: { key: Pane; label: string }[] = [
  { key: "events", label: "How many events" },
  { key: "kind", label: "Students or teachers" },
  { key: "sport", label: "Sport" },
  { key: "competition", label: "Competition" },
  { key: "school", label: "School" },
];

export function ParticipationFilterDrawer({
  open,
  onClose,
  rows,
  filters,
  onFilters,
  visible,
}: {
  open: boolean;
  onClose: () => void;
  /** ALL people (unfiltered) — the facets count against them. */
  rows: readonly ParticipationRow[];
  filters: ParticipationFilters;
  onFilters: (f: ParticipationFilters) => void;
  /** How many people the current filters leave. */
  visible: number;
}): React.ReactElement | null {
  const [pane, setPane] = useState<Pane>("events");
  const [query, setQuery] = useState("");

  const facets = useMemo(() => participationFacets(rows), [rows]);

  /** What each value of one facet would leave, with every OTHER filter still
   * applied — the faceting rule the preview drawer set. */
  const optionsFor = useMemo(() => {
    const count = (patch: Partial<ParticipationFilters>): number =>
      applyParticipationFilters(rows, { ...filters, ...patch }).length;
    const build = (
      key: Pane,
      values: { value: string; label: string }[],
    ): { value: string; label: string; count: number }[] =>
      values.map((v) => ({
        ...v,
        label: t(v.label),
        count: count(
          key === "sport"
            ? { sport: v.value, competition: "" }
            : ({ [key]: v.value } as Partial<ParticipationFilters>),
        ),
      }));
    return {
      events: build("events", EVENT_FILTER_VALUES),
      kind: build("kind", KIND_FILTER_VALUES),
      sport: build("sport", facets.sports),
      competition: build(
        "competition",
        facets.competitions.filter(
          (c) => !filters.sport || c.value.startsWith(`${filters.sport}.`),
        ),
      ),
      school: build("school", facets.schools),
    } as Record<Pane, { value: string; label: string; count: number }[]>;
  }, [rows, filters, facets]);

  if (!open) return null;

  const valueOf = (key: Pane): string => String(filters[key] ?? "");
  const valueLabel = (key: Pane): string => {
    const v = valueOf(key);
    if (!v) return t("All");
    return optionsFor[key].find((o) => o.value === v)?.label ?? v;
  };

  const options = optionsFor[pane];
  const searchable = options.length > SEARCH_THRESHOLD;
  const shown =
    searchable && query.trim()
      ? options.filter((o) =>
          o.label.toLowerCase().includes(query.trim().toLowerCase()),
        )
      : options;

  const pick = (value: string): void => {
    setQuery("");
    onFilters(
      pane === "sport"
        ? // A sport change drops a competition belonging to another sport.
          { ...filters, sport: value, competition: "" }
        : ({ ...filters, [pane]: value } as ParticipationFilters),
    );
  };

  const activeCount = PANES.filter((p) => valueOf(p.key) !== "").length;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      variant="side"
      ariaLabel={t("Filter people")}
    >
      <div
        data-testid="participation-filter-drawer"
        className="flex h-full flex-col gap-3"
      >
        <header className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">{t("Filter people")}</h2>
          <span
            data-testid="participation-drawer-count"
            className="font-tabular text-xs text-muted-foreground"
          >
            {visible} {t("of")} {rows.length}
          </span>
          <button
            type="button"
            aria-label={t("Close")}
            data-testid="participation-drawer-close"
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
            {PANES.map((p) => {
              const on = valueOf(p.key) !== "";
              return (
                <button
                  key={p.key}
                  type="button"
                  data-testid={`participation-pane-${p.key}`}
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
                    {t(p.label)}
                    {on ? (
                      <span
                        aria-hidden="true"
                        className="ml-auto h-1.5 w-1.5 rounded-full bg-primary"
                      />
                    ) : null}
                  </span>
                  <span
                    className={cn(
                      "max-w-full truncate text-[0.6875rem]",
                      on ? "text-primary" : "text-muted-foreground",
                    )}
                  >
                    {valueLabel(p.key)}
                  </span>
                </button>
              );
            })}
          </nav>

          {/* Right: that filter's values, with the count each would leave. */}
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
                  data-testid="participation-value-search"
                  placeholder={t("Search")}
                  onChange={(e) => setQuery(e.target.value)}
                  className="h-9 pl-7 text-xs"
                />
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <button
                type="button"
                data-testid="participation-value-all"
                onClick={() => pick("")}
                className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-xs hover:bg-muted/60"
              >
                <Check
                  aria-hidden="true"
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    valueOf(pane) === "" ? "text-primary" : "text-transparent",
                  )}
                />
                <span className="font-medium">{t("All")}</span>
                <span className="ml-auto font-tabular text-[0.6875rem] text-muted-foreground">
                  {rows.length}
                </span>
              </button>
              {shown.map((o) => {
                const active = valueOf(pane) === o.value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    data-testid={`participation-value-${o.value}`}
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
                        o.count
                          ? "text-muted-foreground"
                          : "text-muted-foreground/50",
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
            data-testid="participation-drawer-clear"
            disabled={!activeCount && !filters.q}
            onClick={() => onFilters(EMPTY_PARTICIPATION_FILTERS)}
          >
            {t("Clear all")}
          </Button>
          <Button
            className="ml-auto"
            data-testid="participation-drawer-done"
            onClick={onClose}
          >
            {visible === 1 ? t("Show 1 person") : `${t("Show")} ${visible} ${t("people")}`}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
