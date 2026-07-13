import { Link, useParams } from "react-router-dom";
import { type StandingRow } from "@/api/tournaments";
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
            "rounded-md px-1.5 py-0.5 text-[0.6875rem] font-medium leading-tight",
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
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/40 text-left text-[0.625rem] uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-2 font-semibold">{t("Team")}</th>
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
                <span className="mr-1.5 font-tabular text-xs text-muted-foreground">
                  {idx + 1}
                </span>
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
