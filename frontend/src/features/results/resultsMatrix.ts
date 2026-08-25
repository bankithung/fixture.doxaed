import type {
  PublicResultCompetition,
  PublicResultSchool,
  PublicResultStudent,
} from "@/api/tournaments";
import {
  buildBands,
  buildColumns,
  type Band,
  type WithCode,
} from "@/features/fixtures/entriesMatrix";

/**
 * The pure model behind the medal tally.
 *
 * The Results grid IS the entries grid with a different thing in the cell —
 * schools down, competitions across, and the reference ANPSA sheet holds the
 * PLACING where ours holds the entry count. So the column model is imported
 * rather than re-cut: one competition wears the same short code on both public
 * tabs, and a code that meant two things across two tabs would be worse than
 * no code at all.
 *
 * Everything here is display. What a placing is worth, and who won it, is
 * decided on the server (apps.matches.services.placings) and arrives already
 * scored.
 */

export type ResultColumn = WithCode<PublicResultCompetition>;
export type ResultBand = Band<PublicResultCompetition>;

export type TallySort = "points" | "golds" | "name";

export function resultColumns(comps: PublicResultCompetition[]): ResultColumn[] {
  return buildColumns(comps);
}

export function resultBands(columns: ResultColumn[]): ResultBand[] {
  return buildBands(columns);
}

/** The placings one school holds in one competition (empty = no medal). */
export function cellPlacings(
  row: PublicResultSchool,
  leafKey: string,
): { place: number; points: number; label: string; team_name: string }[] {
  return row.results[leafKey] ?? [];
}

/** A row's medals and points WITHIN the columns currently on screen.
 *
 * Scoped, always — a sport filter that narrowed the grid to two columns while
 * the row total still reported the whole meet would make the sheet contradict
 * itself, which is exactly the bug the entries matrix shipped with. */
export function scopedTotals(
  row: PublicResultSchool,
  columns: ResultColumn[],
): { points: number; medals: Record<string, number>; count: number } {
  const medals: Record<string, number> = {};
  let points = 0;
  let count = 0;
  for (const c of columns) {
    for (const p of cellPlacings(row, c.leaf_key)) {
      medals[String(p.place)] = (medals[String(p.place)] ?? 0) + 1;
      points += p.points;
      count += 1;
    }
  }
  return { points, medals, count };
}

/** How many schools took a medal in one competition — counted from the ROWS on
 * screen, never from a server-wide number, so the footer can never disagree
 * with the rows above it. */
export function columnMedals(
  rows: PublicResultSchool[],
  leafKey: string,
): number {
  return rows.reduce((n, r) => n + cellPlacings(r, leafKey).length, 0);
}

/** The tally's rows: searched, scoped to the visible columns, ranked. */
export function visibleSchools(
  rows: PublicResultSchool[],
  columns: ResultColumn[],
  opts: {
    search?: string;
    sort?: TallySort;
    medalistsOnly?: boolean;
    places?: number[];
  } = {},
): PublicResultSchool[] {
  const q = (opts.search ?? "").trim().toLowerCase();
  const places = opts.places?.length ? opts.places : [1, 2, 3];
  let out = rows;
  if (q) {
    out = out.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.short_name.toLowerCase().includes(q),
    );
  }
  if (opts.medalistsOnly) {
    out = out.filter((r) => scopedTotals(r, columns).count > 0);
  }
  const sort = opts.sort ?? "points";
  return [...out].sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    const ta = scopedTotals(a, columns);
    const tb = scopedTotals(b, columns);
    if (sort === "golds") {
      for (const p of places) {
        const d = (tb.medals[String(p)] ?? 0) - (ta.medals[String(p)] ?? 0);
        if (d) return d;
      }
      if (tb.points !== ta.points) return tb.points - ta.points;
      return a.name.localeCompare(b.name);
    }
    if (tb.points !== ta.points) return tb.points - ta.points;
    for (const p of places) {
      const d = (tb.medals[String(p)] ?? 0) - (ta.medals[String(p)] ?? 0);
      if (d) return d;
    }
    return a.name.localeCompare(b.name);
  });
}

/** Ranks for an ordered tally: a tie shares a rank, and the next rank skips
 * (1, 1, 3) — two schools level on everything are level, and pretending
 * otherwise is how a paper tally starts an argument. */
export function rankOf(
  ordered: PublicResultSchool[],
  columns: ResultColumn[],
  places: number[],
): Map<string, number> {
  const out = new Map<string, number>();
  let rank = 0;
  let prev = "";
  ordered.forEach((row, i) => {
    const t = scopedTotals(row, columns);
    const key = [t.points, ...places.map((p) => t.medals[String(p)] ?? 0)].join(":");
    if (i === 0 || key !== prev) {
      rank = i + 1;
      prev = key;
    }
    out.set(row.id, rank);
  });
  return out;
}

/** Bars for the points chart: the tally's own order, capped.
 *
 * A ranked bar chart answers the one thing a table of numbers cannot — how far
 * ahead the leader is. The medal counts stay in the table beside it rather than
 * becoming a second encoding here. */
export function chartBars(
  ordered: PublicResultSchool[],
  columns: ResultColumn[],
  limit = 12,
): {
  id: string;
  name: string;
  crest: string;
  points: number;
  medals: Record<string, number>;
  share: number;
}[] {
  const rows = ordered
    .map((r) => ({ row: r, totals: scopedTotals(r, columns) }))
    .filter((r) => r.totals.points > 0)
    .slice(0, limit);
  const max = Math.max(1, ...rows.map((r) => r.totals.points));
  return rows.map(({ row, totals }) => ({
    id: row.id,
    name: row.name,
    crest: row.crest,
    points: totals.points,
    medals: totals.medals,
    share: totals.points / max,
  }));
}

/** The tally as CSV — full category names, one row per school, the placings in
 * each cell, then the medal counts and the points.
 *
 * Every number is computed from the columns PASSED IN, so a filtered export
 * and the filtered screen agree. */
export function tallyCsv(
  columns: ResultColumn[],
  rows: PublicResultSchool[],
  places: number[],
  ladder: { place: number; label: string }[],
): string {
  const esc = (v: string | number): string => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const labelOf = (place: number): string =>
    ladder.find((l) => l.place === place)?.label || `Place ${place}`;
  const head = [
    "School",
    ...columns.map((c) => `${c.sport_name} ${c.title}`),
    ...places.map(labelOf),
    "Points",
  ];
  const body = rows.map((r) => {
    const t = scopedTotals(r, columns);
    return [
      esc(r.name),
      ...columns.map((c) =>
        cellPlacings(r, c.leaf_key)
          .map((p) => p.place)
          .sort((a, b) => a - b)
          .join(" ") || "",
      ),
      ...places.map((p) => t.medals[String(p)] ?? 0),
      t.points,
    ];
  });
  return [head.map(esc).join(","), ...body.map((l) => l.join(","))].join("\n");
}

export type StudentSort = "points" | "events" | "name";

/** The student list: searched, optionally cut to medalists, ranked. */
export function visibleStudents(
  rows: PublicResultStudent[],
  opts: {
    search?: string;
    sport?: string;
    medalistsOnly?: boolean;
    sort?: StudentSort;
  } = {},
): PublicResultStudent[] {
  const q = (opts.search ?? "").trim().toLowerCase();
  let out = rows;
  if (q) {
    out = out.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.institution_name.toLowerCase().includes(q) ||
        r.roll_no.toLowerCase().includes(q) ||
        r.class_section.toLowerCase().includes(q),
    );
  }
  if (opts.sport) {
    out = out.filter((r) =>
      r.events.some((e) => e.leaf_key.split(".")[0] === opts.sport),
    );
  }
  if (opts.medalistsOnly) out = out.filter((r) => r.medal_count > 0);
  const sort = opts.sort ?? "points";
  return [...out].sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "events" && b.event_count !== a.event_count) {
      return b.event_count - a.event_count;
    }
    if (b.points !== a.points) return b.points - a.points;
    if (b.medal_count !== a.medal_count) return b.medal_count - a.medal_count;
    return a.name.localeCompare(b.name);
  });
}

/** Students who played more than one event — the question the participation
 * workbench asks of entries, answered here of results. */
export function multiEventCount(rows: PublicResultStudent[]): number {
  return rows.filter((r) => r.event_count > 1).length;
}

/** Does a leaf key fall under a competition prefix? Segment-aligned, the same
 * contract the server's `sports.leaf_matches_prefix` keeps — "table_tennis.u1"
 * matches nothing. Mirrored here so the group picker can show what an authored
 * prefix currently covers without a round trip. */
export function leafMatchesPrefix(prefix: string, leafKey: string): boolean {
  if (!prefix || !leafKey) return false;
  return leafKey === prefix || leafKey.startsWith(`${prefix}.`);
}

/** The competitions an authored group covers. An empty list is EVERY
 * competition — that is what "Overall" means. */
export function resolveInclude(
  include: string[],
  leafKeys: string[],
): string[] {
  if (!include.length) return [...leafKeys];
  return leafKeys.filter((k) => include.some((p) => leafMatchesPrefix(p, k)));
}
