import { useState } from "react";
import { ChevronDown, Scale } from "lucide-react";
import type { FairnessFlag, FairnessTeamRow } from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import "@/components/ui/star-border.css";

/** Plain fairness-flag explanations per stable code (§7.7). */
const FLAG_LABELS: Record<string, string> = {
  early_outlier: "starts the day far more often than most teams",
  rest_below_min: "gets less rest than your minimum",
};

/** Rows shown before the table collapses behind "Show all". */
const COLLAPSE_AT = 8;

function fmtMinutes(v: number | null | undefined): string {
  if (v == null) return "·";
  const h = Math.floor(v / 60);
  const m = Math.round(v % 60);
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

const COLS = ["Min rest", "Median rest", "Early", "Late", "Venues", "Max/day"];

/**
 * Per-team fairness analytics of the dry-run preview (increment R): minimum/
 * median rest, early/late starts, venue spread and the per-day maximum, with
 * the server's outlier flags (stable codes) called out above the table.
 * Renders nothing while the preview carries no per-team data.
 */
export function FairnessPanel({
  teams,
  flags,
}: {
  teams: FairnessTeamRow[];
  flags: FairnessFlag[];
}): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false);
  if (teams.length === 0) return null;

  const names = new Map(teams.map((tm) => [tm.team_id, tm.name]));
  const flagged = new Map<string, Set<string>>();
  for (const fl of flags) {
    const codes = flagged.get(fl.team_id) ?? new Set<string>();
    codes.add(fl.code);
    flagged.set(fl.team_id, codes);
  }
  const rows = expanded ? teams : teams.slice(0, COLLAPSE_AT);

  return (
    <section
      data-testid="fairness-panel"
      aria-label={t("Fairness check")}
      className="overflow-hidden bento-card star-rim rounded-xl border border-border bg-card shadow-sm"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Scale aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{t("Fairness check")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("How evenly teams get rest, early starts and venues.")}
          </p>
        </div>
      </div>

      {flags.length ? (
        <ul className="flex flex-col gap-0.5 border-b border-border bg-warning-muted px-4 py-2">
          {flags.map((fl, i) => (
            <li
              key={`${fl.code}-${fl.team_id}-${i}`}
              data-testid={`fairness-flag-${fl.code}`}
              className="text-xs text-warning"
            >
              <span className="font-medium">
                {names.get(fl.team_id) || fl.team_id}
              </span>{" "}
              {t(FLAG_LABELS[fl.code] ?? fl.code)}{" "}
              <span className="font-tabular">
                ({fl.value}
                {fl.median != null ? ` ${t("vs median")} ${fl.median}` : ""})
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2 font-medium">{t("Team")}</th>
              {COLS.map((h) => (
                <th key={h} className="px-2 py-2 text-right font-medium">
                  {t(h)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((tm) => {
              const codes = flagged.get(tm.team_id);
              return (
                <tr
                  key={tm.team_id}
                  data-testid={`fairness-row-${tm.team_id}`}
                  className="border-t border-border transition-colors hover:bg-accent/40"
                >
                  <td className="px-4 py-2 font-medium">{tm.name}</td>
                  <td
                    className={cn(
                      "px-2 py-2 text-right font-tabular",
                      codes?.has("rest_below_min")
                        ? "font-semibold text-destructive"
                        : "text-muted-foreground",
                    )}
                  >
                    {fmtMinutes(tm.rest_min)}
                  </td>
                  <td className="px-2 py-2 text-right font-tabular text-muted-foreground">
                    {fmtMinutes(tm.rest_median)}
                  </td>
                  <td
                    className={cn(
                      "px-2 py-2 text-right font-tabular",
                      codes?.has("early_outlier")
                        ? "font-semibold text-warning"
                        : "text-muted-foreground",
                    )}
                  >
                    {tm.early}
                  </td>
                  <td className="px-2 py-2 text-right font-tabular text-muted-foreground">
                    {tm.late}
                  </td>
                  <td className="px-2 py-2 text-right font-tabular text-muted-foreground">
                    {tm.venues}
                  </td>
                  <td className="px-2 py-2 text-right font-tabular text-muted-foreground">
                    {tm.max_per_day}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {teams.length > COLLAPSE_AT ? (
        <div className="border-t border-border px-4 py-2">
          <Button
            variant="ghost"
            size="sm"
            data-testid="fairness-toggle"
            onClick={() => setExpanded((v) => !v)}
          >
            <ChevronDown
              aria-hidden="true"
              className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")}
            />
            {expanded
              ? t("Show fewer")
              : t(`Show all ${teams.length} teams`)}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
