import type { PreviewMatch } from "@/api/tournaments";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import {
  categoryFacets,
  sportFacets,
  sportKey,
  type FacetEntry,
} from "./previewFilters";

/** The sport is already picked, so a category chip only needs what VARIES —
 * drop the leading sport segment and show the rest middot-joined (no em-dashes):
 * "Table Tennis — open catagory — girls — 1v1" -> "open catagory · girls · 1v1". */
function shortCatLabel(label: string): string {
  const segs = label.split(/\s+[\u00b7\u2014]\s+/).map((s) => s.trim()).filter(Boolean);
  return (segs.length > 1 ? segs.slice(1) : segs).join(" · ");
}

function Pill({
  active,
  onClick,
  label,
  count,
  testid,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  testid: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      data-testid={testid}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-card text-foreground hover:bg-muted",
      )}
    >
      {label}
      <span
        className={cn(
          "font-tabular",
          active ? "text-primary-foreground/80" : "text-muted-foreground",
        )}
      >
        {count}
      </span>
    </button>
  );
}

/**
 * Filter the dry-run schedule down to one sport, then one category (owner ask
 * 2026-06-27 — "i need a filter to see a specific sport/category"). Two chip
 * rows: sports always; categories appear once a sport is picked. Selection is
 * lifted so the page can apply it to MatchesByDayGrid.
 */
export function PreviewFilterBar({
  matches,
  sport,
  category,
  onSport,
  onCategory,
}: {
  matches: PreviewMatch[];
  sport: string | null;
  category: string | null;
  onSport: (s: string | null) => void;
  onCategory: (c: string | null) => void;
}): React.ReactElement | null {
  const sports = sportFacets(matches);
  // A single sport with a single category isn't worth a filter.
  if (sports.length < 2 && categoryFacets(matches, null).length < 2) return null;
  const cats: FacetEntry[] = sport ? categoryFacets(matches, sport) : [];

  return (
    <div className="flex flex-col gap-2" data-testid="preview-filter-bar">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs font-medium text-muted-foreground">
          {t("Sport")}
        </span>
        <Pill
          testid="filter-sport-all"
          active={sport === null}
          onClick={() => {
            onSport(null);
            onCategory(null);
          }}
          label={t("All")}
          count={matches.length}
        />
        {sports.map((s) => (
          <Pill
            key={s.key}
            testid={`filter-sport-${s.key}`}
            active={sport === s.key}
            onClick={() => {
              onSport(s.key);
              onCategory(null);
            }}
            label={s.label}
            count={s.count}
          />
        ))}
      </div>
      {sport && cats.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2">
          <span className="mr-1 text-xs font-medium text-muted-foreground">
            {t("Category")}
          </span>
          <Pill
            testid="filter-cat-all"
            active={category === null}
            onClick={() => onCategory(null)}
            label={t("All")}
            count={matches.filter((m) => sportKey(m) === sport).length}
          />
          {cats.map((c) => (
            <Pill
              key={c.key}
              testid={`filter-cat-${c.key}`}
              active={category === c.key}
              onClick={() => onCategory(c.key)}
              label={shortCatLabel(c.label)}
              count={c.count}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
