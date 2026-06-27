import type { PreviewMatch } from "@/api/tournaments";

/** Trailing bits the rich group_label carries on top of the competition name. */
const STAGE_SUFFIX = / — (Group .*|3rd Place|Plate|Swiss|Grand Final)$/;

function prettify(key: string): string {
  return key
    .split(/[._\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/** Sport key — the first segment of a leaf_key ("table_tennis.u14…"). */
export function sportKey(m: PreviewMatch): string {
  return m.leaf_key.split(".")[0] || m.leaf_key;
}

/** Sport display name — the first segment of the rich group_label, e.g.
 * "Table Tennis"; falls back to a prettified key. */
export function sportLabel(m: PreviewMatch): string {
  const first = m.group_label.split(" — ")[0]?.trim();
  return first || prettify(sportKey(m));
}

/** Competition (leaf) label WITHOUT the "— Group A / 3rd Place" suffix, so the
 * filter shows one entry per category, not one per group/round. */
export function competitionLabel(m: PreviewMatch): string {
  const base = m.group_label.replace(STAGE_SUFFIX, "").trim();
  return base || prettify(m.leaf_key);
}

export interface FacetEntry {
  key: string;
  label: string;
  count: number;
}

/** Build the sport facets (key + display label + match count), first-seen order. */
export function sportFacets(matches: PreviewMatch[]): FacetEntry[] {
  const seen = new Map<string, FacetEntry>();
  for (const m of matches) {
    const key = sportKey(m);
    const e = seen.get(key);
    if (e) e.count += 1;
    else seen.set(key, { key, label: sportLabel(m), count: 1 });
  }
  return [...seen.values()];
}

/** Category facets (leaf_key + label + count) within an optional sport. */
export function categoryFacets(
  matches: PreviewMatch[],
  sport: string | null,
): FacetEntry[] {
  const seen = new Map<string, FacetEntry>();
  for (const m of matches) {
    if (sport && sportKey(m) !== sport) continue;
    const e = seen.get(m.leaf_key);
    if (e) e.count += 1;
    else seen.set(m.leaf_key, { key: m.leaf_key, label: competitionLabel(m), count: 1 });
  }
  return [...seen.values()];
}
