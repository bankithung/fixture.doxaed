import { Fragment, useMemo } from "react";
import type { PreviewMatch } from "@/api/tournaments";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { shortGroupName } from "./groupSlotLabel";
import { competitionLabel } from "./previewFilters";

interface DrawLine {
  group: string;
  /** Position within the group (1-based) — the slot number on a wall chart. */
  slot: number;
  school: string;
  /** Continuous line number down the whole sheet. */
  lineNo: number;
}
interface LeafDraw {
  leafKey: string;
  label: string;
  lines: DrawLine[];
  groupCount: number;
}

/**
 * The "Draw" view's who-is-in-what: every competition's groups as a
 * SPREADSHEET, the same instrument as the schedule sheet (owner 2026-08-15 —
 * "same as the sheet like UI/UX with proper tables"). One band per
 * competition, one line per team, group and slot as columns. The knockout
 * bracket keeps its own flow-chart look and is rendered beside this, not by
 * it. School names come from the group-stage matches' real teams (knockout
 * sides are still placeholders).
 */
export function GroupCompositionView({
  matches,
  teamNames,
}: {
  matches: PreviewMatch[];
  teamNames: ReadonlyMap<string, string>;
}): React.ReactElement {
  const leaves = useMemo<LeafDraw[]>(() => {
    // leaf -> group name -> ordered unique school names.
    const byLeaf = new Map<
      string,
      { label: string; groups: Map<string, Set<string>>; entrants: Set<string> }
    >();
    for (const m of matches) {
      let entry = byLeaf.get(m.leaf_key);
      if (!entry) {
        entry = { label: "", groups: new Map(), entrants: new Set() };
        byLeaf.set(m.leaf_key, entry);
      }
      if (!entry.label && m.group_label) entry.label = competitionLabel(m);
      const names = [m.home, m.away]
        .map((s) => (s.team_id ? teamNames.get(s.team_id) : undefined))
        .filter((n): n is string => !!n);
      if (m.stage === "group" && m.group_label) {
        const g = `${t("Group")} ${shortGroupName(m.group_label)}`;
        if (!entry.groups.has(g)) entry.groups.set(g, new Set());
        names.forEach((n) => entry.groups.get(g)!.add(n));
      } else {
        // Knockout-only competition: its entrants are real teams.
        names.forEach((n) => entry.entrants.add(n));
      }
    }
    const out: LeafDraw[] = [];
    // Line numbers are assigned here, in render order, so the table body never
    // mutates a counter while rendering.
    let lineNo = 0;
    for (const [leafKey, e] of byLeaf) {
      const groups =
        e.groups.size > 0
          ? [...e.groups.entries()]
              .sort((a, b) => (a[0] < b[0] ? -1 : 1))
              .map(([name, set]) => ({
                name,
                schools: [...set].sort((a, b) => a.localeCompare(b)),
              }))
          : e.entrants.size > 0
            ? [
                {
                  name: t("Entry list"),
                  schools: [...e.entrants].sort((a, b) => a.localeCompare(b)),
                },
              ]
            : [];
      if (!groups.length) continue;
      const lines: DrawLine[] = [];
      for (const g of groups) {
        g.schools.forEach((school, i) => {
          lineNo += 1;
          lines.push({ group: g.name, slot: i + 1, school, lineNo });
        });
      }
      out.push({
        leafKey,
        label: e.label || leafKey,
        lines,
        groupCount: groups.length,
      });
    }
    return out;
  }, [matches, teamNames]);

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
                    <td
                      className={cn(
                        "border-b border-r border-border/60 px-2 py-1 group-hover:bg-accent/40",
                        line.slot > 1 && "text-muted-foreground/40",
                      )}
                    >
                      {line.slot === 1 ? line.group : "\u00b7"}
                    </td>
                    <td className="border-b border-r border-border/60 px-2 py-1 text-right font-tabular text-muted-foreground group-hover:bg-accent/40">
                      {line.slot}
                    </td>
                    <td className="max-w-0 truncate border-b border-border/60 px-2 py-1 font-medium group-hover:bg-accent/40">
                      {line.school}
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
