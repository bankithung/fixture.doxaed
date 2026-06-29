import { useMemo } from "react";
import type { PreviewMatch } from "@/api/tournaments";
import { t } from "@/lib/t";
import { shortGroupName } from "./groupSlotLabel";
import { LEAF_ACCENTS, MatchChip } from "./MatchesByDayGrid";

/** A bucket of matches that share a group (or the knockout). */
interface Bucket {
  key: string;
  /** "Group A" / "Knockout" — the clean ASCII heading. */
  heading: string;
  leafKey: string;
  matches: PreviewMatch[];
}

/**
 * The dry-run preview, grouped by group instead of by day (owner ask): one card
 * per group (Group A, Group B, ...) with every match of that group together, in
 * play order, then the knockout. Lets the organiser read a competition group by
 * group rather than chronologically. The knockout bucket carries its placeholder
 * "Group A top 1" rows so the Stage 2 flow is visible here too.
 */
export function MatchesByGroupGrid({
  matches,
  teamNames,
}: {
  matches: PreviewMatch[];
  teamNames: ReadonlyMap<string, string>;
}): React.ReactElement {
  const { buckets, accentOf } = useMemo(() => {
    const accents = new Map<string, string>();
    const map = new Map<string, Bucket>();
    for (const m of matches) {
      if (!accents.has(m.leaf_key)) {
        accents.set(m.leaf_key, LEAF_ACCENTS[accents.size % LEAF_ACCENTS.length]);
      }
      const isKo = m.stage === "knockout";
      const groupName = isKo
        ? t("Knockout")
        : m.group_label
          ? `${t("Group")} ${shortGroupName(m.group_label)}`
          : t("Matches");
      // Key by leaf so two competitions that both have a "Group A" stay apart.
      const key = `${m.leaf_key}::${isKo ? "__ko__" : groupName}`;
      if (!map.has(key)) {
        map.set(key, { key, heading: groupName, leafKey: m.leaf_key, matches: [] });
      }
      map.get(key)!.matches.push(m);
    }
    // Sort matches in each bucket by time, then round, then ref.
    for (const b of map.values()) {
      b.matches.sort((a, c) => {
        const ta = a.scheduled_at ?? "";
        const tc = c.scheduled_at ?? "";
        if (ta !== tc) return ta < tc ? -1 : 1;
        if (a.round_no !== c.round_no) return (a.round_no ?? 0) - (c.round_no ?? 0);
        return a.ref < c.ref ? -1 : 1;
      });
    }
    // Knockout buckets sort last within a competition; groups alphabetically.
    const order = (b: Bucket): string =>
      `${b.leafKey}::${b.heading === t("Knockout") ? "~" : b.heading}`;
    const buckets = [...map.values()].sort((a, b) =>
      order(a) < order(b) ? -1 : 1,
    );
    return {
      buckets,
      accentOf: (leaf: string) => accents.get(leaf) ?? LEAF_ACCENTS[0],
    };
  }, [matches]);

  // Show the competition name on each card only when more than one is present.
  const multiLeaf = useMemo(
    () => new Set(matches.map((m) => m.leaf_key)).size > 1,
    [matches],
  );

  if (buckets.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("No matches in this preview.")}
      </p>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {buckets.map((b) => (
        <section
          key={b.key}
          data-testid={`group-${b.key}`}
          className="flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm"
        >
          <h3 className="flex items-baseline gap-2 border-b border-border bg-muted/40 px-4 py-2 text-sm font-semibold">
            {b.heading}
            <span className="font-tabular text-xs font-normal text-muted-foreground">
              {b.matches.length}
            </span>
            {multiLeaf ? (
              <span className="ml-auto truncate text-[0.6875rem] font-normal text-muted-foreground">
                {shortGroupName(b.matches[0]?.group_label) || b.leafKey}
              </span>
            ) : null}
          </h3>
          <div className="flex flex-col gap-1.5 p-3">
            {b.matches.map((m) => (
              <MatchChip
                key={m.ref}
                match={m}
                accent={accentOf(m.leaf_key)}
                teamNames={teamNames}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
