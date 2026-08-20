import { Fragment, useMemo } from "react";
import type { PreviewMatch } from "@/api/tournaments";
import { TeamCrest } from "@/components/ui/TeamCrest";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { buildDrawSheet } from "./drawModel";

/**
 * The "Draw" view's who-is-in-what: every competition's groups as a
 * SPREADSHEET, the same instrument as the schedule sheet (owner 2026-08-15 —
 * "same as the sheet like UI/UX with proper tables"). One band per
 * competition, one line per team, group and slot as columns. The knockout
 * bracket keeps its own flow-chart look and is rendered beside this, not by
 * it.
 *
 * The model itself lives in `drawModel.ts`, because the printed draw and the
 * draw CSV read the very same lines.
 */
export function GroupCompositionView({
  matches,
  teamNames,
  teamCrests,
}: {
  matches: PreviewMatch[];
  teamNames: ReadonlyMap<string, string>;
  /** `{team_id: crest URL}`; absent or empty just means no badges. */
  teamCrests?: ReadonlyMap<string, string>;
}): React.ReactElement {
  const leaves = useMemo(
    () => buildDrawSheet(matches, teamNames, teamCrests),
    [matches, teamNames, teamCrests],
  );

  if (leaves.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("No groups in this preview.")}
      </p>
    );
  }

  return (
    <div
      data-testid="draw-groups"
      className="w-full overflow-x-auto rounded-lg border border-border"
    >
      <table className="w-full border-separate border-spacing-0 text-xs">
        <caption className="sr-only">
          {t("The draw, one row per team")}
        </caption>
        <thead>
          <tr>
            {[
              ["#", "w-10 text-right"],
              [t("Group"), "w-32"],
              [t("Slot"), "w-12 text-right"],
              [t("Team"), ""],
            ].map(([label, cls]) => (
              <th
                key={label}
                scope="col"
                className={cn(
                  "sticky top-0 z-20 border-b border-r border-border bg-muted px-2 py-1.5 text-left text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground last:border-r-0",
                  cls,
                )}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {leaves.map((leaf) => (
            <Fragment key={leaf.leafKey}>
              <tr data-testid={`draw-band-${leaf.leafKey}`}>
                <td colSpan={4} className="border-b border-border bg-secondary/60 px-2 py-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-[0.6875rem] font-semibold uppercase tracking-wide">
                      {leaf.label}
                    </span>
                    <span className="ml-auto font-tabular text-[0.6875rem] text-muted-foreground">
                      {leaf.lines.length} {t("teams")} · {leaf.groupCount}{" "}
                      {leaf.groupCount === 1 ? t("group") : t("groups")}
                    </span>
                  </span>
                </td>
              </tr>
              {leaf.lines.map((line) => {
                const zebra = line.lineNo % 2 === 0 ? "bg-muted/20" : "bg-card";
                return (
                  <tr
                    key={`${leaf.leafKey}|${line.group}|${line.school}`}
                    data-testid={`draw-row-${leaf.leafKey}-${line.group}-${line.slot}`}
                    className={cn("group", zebra)}
                  >
                    <td
                      className={cn(
                        "border-b border-r border-border px-2 py-1 text-right font-tabular text-[0.6875rem] text-muted-foreground",
                        zebra,
                      )}
                    >
                      {line.lineNo}
                    </td>
                    {/* Every row names its own group: a filtered or sorted
                        sheet must never leave a cell to be inferred from the
                        row above it (owner 2026-08-15). */}
                    <td className="border-b border-r border-border/60 px-2 py-1 group-hover:bg-accent/40">
                      {line.group}
                    </td>
                    <td className="border-b border-r border-border/60 px-2 py-1 text-right font-tabular text-muted-foreground group-hover:bg-accent/40">
                      {line.slot}
                    </td>
                    <td className="max-w-0 border-b border-border/60 px-2 py-1 font-medium group-hover:bg-accent/40">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <TeamCrest src={line.crest} name={line.school} size="xs" />
                        <span className="truncate">{line.school}</span>
                      </span>
                    </td>
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
