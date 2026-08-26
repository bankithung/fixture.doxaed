import { Link, useParams } from "react-router-dom";
import { type StandingRow } from "@/api/tournaments";
import { TeamCrest } from "@/components/ui/TeamCrest";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { splitLabel } from "./publicTournament";

/** Presentational pieces shared by the public tournament tabs (Matches /
 * Standings). Data + label logic lives in publicTournament.ts. */

/** Competition label as clean chips: sport (accent) then age/gender/discipline
 * (muted), no separator glyphs. `omitSport` drops the leading sport chip when
 * the surrounding header already names it. */
export function LabelChips({
  label,
  omitSport = false,
  className,
}: {
  label: string;
  omitSport?: boolean;
  className?: string;
}): React.ReactElement | null {
  let parts = splitLabel(label);
  if (omitSport) parts = parts.slice(1);
  if (parts.length === 0) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      {parts.map((p, i) => (
        <span
          key={`${p}-${i}`}
          className={cn(
            "shrink-0 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[0.6875rem] font-medium leading-tight",
            !omitSport && i === 0
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          {/* "U-14" → "U14": the internal hyphen is the last dash on the page. */}
          {/^U-\d/.test(p) ? p.replace("-", "") : p}
        </span>
      ))}
    </span>
  );
}

/** A bookmark tab: the sheet below is one continuous panel and the active tab
 * merges into it (same pattern as the setup wizard's sport bookmarks). Shared
 * by the public Standings and Knockout tabs. */
export function Bookmark({
  active,
  onClick,
  label,
  count,
  testid,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  testid: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={testid}
      onClick={onClick}
      className={cn(
        "relative flex max-w-full shrink-0 items-center gap-2 rounded-t-lg border px-3.5 py-2 text-[0.8125rem] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "z-10 -mb-px border-border border-b-transparent bg-card text-foreground"
          : "border-transparent bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <span className="truncate">{label}</span>
      {count != null ? (
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 font-tabular text-[0.625rem] font-semibold",
            active
              ? "bg-primary/15 text-primary"
              : "bg-muted-foreground/10 text-muted-foreground",
          )}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

/** Compact FIFA-style group table — qualifying rows get a 2px accent left
 * rule (not a fill, not a dot). Columns are SPORT-NATIVE: timed sports read
 * P W D L +/- Pts (goal difference); target (set) sports read P W L Sets +/-
 * Pts (sets for-against + within-set point diff) — a sepak table never shows
 * a draw column. */
export function GroupTable({
  rows,
  family = "timed",
}: {
  rows: StandingRow[];
  family?: "timed" | "target";
}): React.ReactElement {
  // Rendered under /t/:slug/:id — each team links to its public profile
  // (record, form, every played and upcoming match).
  const { slug = "", id = "" } = useParams();
  const target = family === "target";
  const heads = target
    ? ["P", "W", "L", t("Sets"), "+/-", "Pts"]
    : ["P", "W", "D", "L", "+/-", "Pts"];
  const cells = (r: StandingRow): (number | string)[] =>
    target
      ? [r.P, r.W, r.L, `${r.GF}-${r.GA}`, r.PD_pts ?? 0, r.Pts]
      : [r.P, r.W, r.D, r.L, r.GD, r.Pts];
  return (
    <div className="overflow-x-auto">
      {/* Fluid type: a phone gets a table it can read in one line per team, a
          desk gets a bigger one, from the same rule (owner 2026-08-26). */}
      <table className="w-full text-[clamp(0.72rem,0.64rem+0.26vw,0.9rem)]">
        <thead>
          <tr className="border-b border-border bg-muted/40 text-left text-[0.625rem] uppercase tracking-wide text-muted-foreground">
            <th className="px-2 py-1.5 sm:px-4 sm:py-2 font-semibold">{t("Team")}</th>
            {heads.map((h) => (
              <th key={h} className="px-2 py-2 text-right font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr
              key={r.team_id}
              data-testid={`group-standing-${r.team_id}`}
              className={cn(
                "border-t border-border",
                idx < 2 && "border-l-2 border-primary",
              )}
            >
              <td className="px-4 py-1.5 font-medium">
                {/* Badge, then name: it sits at the row's own line height, so
                    the stat columns keep their alignment. */}
                <span className="flex items-center gap-1.5">
                  <span className="font-tabular text-xs text-muted-foreground">
                    {idx + 1}
                  </span>
                  <TeamCrest src={r.crest} name={r.name} size="sm" />
                  {slug && id ? (
                    <Link
                      to={routes.publicTeam(slug, id, r.team_id)}
                      data-testid={`standing-team-link-${r.team_id}`}
                      className="rounded-sm underline-offset-2 transition-colors hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {r.name}
                    </Link>
                  ) : (
                    r.name
                  )}
                </span>
              </td>
              {cells(r).map((v, i) => (
                <td
                  key={i}
                  className={cn(
                    "px-2 py-1.5 text-right font-tabular",
                    i === 5
                      ? "font-semibold text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {i === 4 && typeof v === "number" && v > 0 ? `+${v}` : v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The view switcher, inside the board rather than a tab attached above it —
 * one section means one box (owner 2026-08-25). */
export function Segment({
  active,
  onClick,
  label,
  count,
  testid,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  testid: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={testid}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[0.8125rem] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-card text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      {count != null ? (
        <span className="font-tabular text-[0.625rem] text-muted-foreground">
          {count}
        </span>
      ) : null}
    </button>
  );
}

/** The sport filter: a chip row, not a second set of tabs. */
export function Chip({
  active,
  onClick,
  label,
  count,
  testid,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  testid: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={testid}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      {count != null ? (
        <span className="font-tabular text-[0.625rem] opacity-70">{count}</span>
      ) : null}
    </button>
  );
}

/**
 * The phone's floating FILTER button.
 *
 * The match centre's pill is the one every other public board should wear
 * (owner 2026-08-26): it floats clear of the content instead of walling off
 * the bottom edge, it carries what you are looking at as its own label, and it
 * is thumb-reachable from anywhere on the page. A full-width bar did none of
 * that and covered the last row of every table.
 */
export function FilterFab({
  label,
  onClick,
  testid,
  count,
  icon: Icon,
}: {
  /** What is on screen right now — the button answers "what am I looking at"
   * as much as it opens the picker. */
  label: string;
  onClick: () => void;
  testid: string;
  /** Active filters, shown as a badge when there are any. */
  count?: number;
  icon?: React.ComponentType<{ className?: string }>;
}): React.ReactElement {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center px-4 print:hidden">
      <button
        type="button"
        data-testid={testid}
        onClick={onClick}
        className="pointer-events-auto inline-flex h-11 max-w-full items-center gap-2 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground shadow-lg hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
        <span className="min-w-0 truncate">{label}</span>
        <span className="shrink-0 rounded-full bg-primary-foreground/20 px-2 py-0.5 font-tabular text-[0.6875rem]">
          {count ? `${t("Filter")} ${count}` : t("Filter")}
        </span>
      </button>
    </div>
  );
}
