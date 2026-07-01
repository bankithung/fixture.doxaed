import { Search } from "lucide-react";
import type { ControlRoomDay } from "@/api/tournaments";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import type { BoardFilter, BoardGroup } from "./BoardTable";
import { fmtDayLabel } from "./format";

const FILTERS: { key: BoardFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "attention", label: "Needs you" },
  { key: "live", label: "Live" },
  { key: "scheduled", label: "Scheduled" },
  { key: "done", label: "Done" },
];

const GROUPS: { key: BoardGroup; label: string }[] = [
  { key: "court", label: "By court" },
  { key: "time", label: "By time" },
];

/**
 * The sticky board toolbar: day selector (chips desktop / Select mobile, keeps
 * day-chip-<date>), a Group-by segmented control (Court / Time — the two views
 * that replace the old lane grid and queue rail), quick status filters, and a
 * search. All controls sit on the h-9 rhythm so the bar reads as one line.
 */
export function BoardControls({
  days,
  selectedDay,
  onDay,
  group,
  onGroup,
  filter,
  onFilter,
  query,
  onQuery,
  isMobile,
}: {
  days: ControlRoomDay[];
  selectedDay: string;
  onDay: (d: string) => void;
  group: BoardGroup;
  onGroup: (g: BoardGroup) => void;
  filter: BoardFilter;
  onFilter: (f: BoardFilter) => void;
  query: string;
  onQuery: (q: string) => void;
  isMobile: boolean;
}): React.ReactElement {
  return (
    <div className="sticky top-0 z-20 flex flex-col gap-2 border-y border-border bg-card px-1 py-2">
      <div className="flex flex-wrap items-center gap-2">
        {isMobile ? (
          <Select
            aria-label={t("Match day")}
            className="w-full"
            value={selectedDay}
            onChange={onDay}
            options={days.map((d) => ({
              value: d.date,
              label: `${fmtDayLabel(d.date)} · ${d.counts.completed}/${d.counts.total}`,
            }))}
          />
        ) : (
          <div role="group" aria-label={t("Match day")} className="flex flex-wrap items-center gap-1.5">
            {days.map((d) => {
              const active = d.date === selectedDay;
              return (
                <button
                  key={d.date}
                  type="button"
                  data-testid={`day-chip-${d.date}`}
                  aria-pressed={active}
                  onClick={() => onDay(d.date)}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card text-foreground hover:bg-accent",
                  )}
                >
                  {fmtDayLabel(d.date)}
                  <span
                    className={cn(
                      "font-tabular",
                      active ? "text-primary-foreground/80" : "text-muted-foreground",
                    )}
                  >
                    {d.counts.completed}/{d.counts.total}
                  </span>
                  {d.counts.live > 0 ? (
                    <span
                      aria-label={t("Live now")}
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        active ? "bg-primary-foreground" : "bg-primary",
                      )}
                    />
                  ) : null}
                </button>
              );
            })}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {/* Group-by segmented control */}
          <div
            role="group"
            aria-label={t("Group matches")}
            className="inline-flex overflow-hidden rounded-md border border-border"
          >
            {GROUPS.map((g) => (
              <button
                key={g.key}
                type="button"
                data-testid={`group-${g.key}`}
                aria-pressed={group === g.key}
                onClick={() => onGroup(g.key)}
                className={cn(
                  "h-8 px-2.5 text-xs font-medium transition-colors",
                  group === g.key
                    ? "bg-secondary text-secondary-foreground"
                    : "bg-card text-muted-foreground hover:bg-accent",
                )}
              >
                {t(g.label)}
              </button>
            ))}
          </div>

          {/* Search */}
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="search"
              aria-label={t("Search matches")}
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder={t("Search teams, courts")}
              className="h-8 w-44 rounded-md border border-border bg-background pl-7 pr-2 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        </div>
      </div>

      {/* Quick status filters */}
      <div role="group" aria-label={t("Filter by status")} className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            data-testid={`filter-${f.key}`}
            aria-pressed={filter === f.key}
            onClick={() => onFilter(f.key)}
            className={cn(
              "h-7 rounded-full border px-2.5 text-xs font-medium transition-colors",
              filter === f.key
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-card text-muted-foreground hover:bg-accent",
            )}
          >
            {t(f.label)}
          </button>
        ))}
      </div>
    </div>
  );
}
