import { Fragment, useMemo } from "react";
import type { PreviewMatch } from "@/api/tournaments";
import { TeamCrest } from "@/components/ui/TeamCrest";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { shortGroupName } from "./groupSlotLabel";
import { competitionLabel } from "./previewFilters";

interface DrawLine {
  group: string;
  /** Position within the group (1-based) — the slot number on a wall chart. */
  slot: number;
  school: string;
  /** The team's badge URL, "" when it has none (then initials stand in). */
  crest: string;
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
  teamCrests,
}: {
  matches: PreviewMatch[];
  teamNames: ReadonlyMap<string, string>;
  /** `{team_id: crest URL}`; absent or empty just means no badges. */
  teamCrests?: ReadonlyMap<string, string>;
}): React.ReactElement {
  const leaves = useMemo<LeafDraw[]>(() => {
    // leaf -> group name -> that group's teams, keyed by team id. Collecting
    // by ID rather than by name is what lets a crest ride along: the badge
    // cannot be recovered from the name once the id is thrown away.
    type Entrant = { name: string; crest: string };
    const byLeaf = new Map<
      string,
      {
        label: string;
        groups: Map<string, Map<string, Entrant>>;
        entrants: Map<string, Entrant>;
      }
    >();
    for (const m of matches) {
      let entry = byLeaf.get(m.leaf_key);
      if (!entry) {
        entry = { label: "", groups: new Map(), entrants: new Map() };
        byLeaf.set(m.leaf_key, entry);
      }
      if (!entry.label && m.group_label) entry.label = competitionLabel(m);
      const sides = [m.home, m.away].flatMap((s) => {
        const name = s.team_id ? teamNames.get(s.team_id) : undefined;
        if (!s.team_id || !name) return [];
        return [
          [s.team_id, { name, crest: teamCrests?.get(s.team_id) ?? "" }] as const,
        ];
      });
      if (m.stage === "group" && m.group_label) {
        const g = `${t("Group")} ${shortGroupName(m.group_label)}`;
        let bucket = entry.groups.get(g);
        if (!bucket) {
          bucket = new Map();
          entry.groups.set(g, bucket);
        }
        for (const [id, e] of sides) bucket.set(id, e);
      } else {
        // Knockout-only competition: its entrants are real teams.
        for (const [id, e] of sides) entry.entrants.set(id, e);
      }
    }
    const out: LeafDraw[] = [];
    // Line numbers are assigned here, in render order, so the table body never
    // mutates a counter while rendering.
    let lineNo = 0;
    for (const [leafKey, e] of byLeaf) {
      const sorted = (m: Map<string, Entrant>): Entrant[] =>
        [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
      const groups =
        e.groups.size > 0
          ? [...e.groups.entries()]
              .sort((a, b) => (a[0] < b[0] ? -1 : 1))
              .map(([name, bucket]) => ({ name, schools: sorted(bucket) }))
          : e.entrants.size > 0
            ? [{ name: t("Entry list"), schools: sorted(e.entrants) }]
            : [];
      if (!groups.length) continue;
      const lines: DrawLine[] = [];
      for (const g of groups) {
        g.schools.forEach((ent, i) => {
          lineNo += 1;
          lines.push({
            group: g.name,
            slot: i + 1,
            school: ent.name,
            crest: ent.crest,
            lineNo,
          });
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
  }, [matches, teamNames, teamCrests]);

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
