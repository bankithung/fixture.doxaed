import { useMemo } from "react";
import { Users } from "lucide-react";
import type { PreviewMatch } from "@/api/tournaments";
import { t } from "@/lib/t";
import { shortGroupName } from "./groupSlotLabel";
import { LeafLabel } from "./LeafLabel";
import { competitionLabel } from "./previewFilters";

interface GroupCard {
  name: string;
  schools: string[];
}
interface LeafDraw {
  leafKey: string;
  label: string;
  groups: GroupCard[];
}

/**
 * The "Draw" view of the preview: every competition's groups with the schools
 * in each, numbered. The actual draw on a wall chart, so the organiser can see
 * who is in which group before anything is played. Pairs with the knockout
 * bracket shown beneath it. School names come from the group-stage matches'
 * real teams (the knockout sides are still placeholders).
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
    for (const [leafKey, e] of byLeaf) {
      const groups: GroupCard[] =
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
                  name: t("Teams"),
                  schools: [...e.entrants].sort((a, b) => a.localeCompare(b)),
                },
              ]
            : [];
      if (groups.length) {
        out.push({ leafKey, label: e.label || leafKey, groups });
      }
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
    <div className="flex flex-col gap-5" data-testid="draw-groups">
      {leaves.map((leaf) => {
        const total = leaf.groups.reduce((n, g) => n + g.schools.length, 0);
        return (
          <section key={leaf.leafKey} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <LeafLabel label={leaf.label} />
              <span className="font-tabular text-xs text-muted-foreground">
                {total} {t("schools")} · {leaf.groups.length}{" "}
                {leaf.groups.length === 1 ? t("group") : t("groups")}
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {leaf.groups.map((g) => (
                <div
                  key={g.name}
                  data-testid={`draw-${leaf.leafKey}-${g.name}`}
                  className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
                >
                  <h4 className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-sm font-semibold">
                    <Users aria-hidden="true" className="h-4 w-4 text-primary" />
                    {g.name}
                    <span className="font-tabular text-xs font-normal text-muted-foreground">
                      {g.schools.length}
                    </span>
                  </h4>
                  <ol className="flex flex-col">
                    {g.schools.map((s, i) => (
                      <li
                        key={s}
                        className="flex items-center gap-2.5 border-b border-border px-3 py-1.5 text-sm last:border-b-0"
                      >
                        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-secondary font-tabular text-[0.6875rem] font-medium text-secondary-foreground">
                          {i + 1}
                        </span>
                        <span className="truncate">{s}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
