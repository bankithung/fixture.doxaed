import type {
  PublicEntryCompetition,
  PublicEntryInstitution,
} from "@/api/tournaments";

/**
 * The pure model behind the public ENTRIES matrix (schools × competitions).
 *
 * The page is a grid, and a grid needs three things the payload deliberately
 * does not decide: a SHORT code per column (ten full category names will not
 * fit across a sheet), the SPORT bands those columns sit under, and the order
 * rows are read in. All three are display, so all three live here — one pure
 * module the page renders and the tests drive directly.
 */

/** The least a competition must be to become a column: a key, its sport and
 * the category path the header code is built from. The entries grid and the
 * medal tally both key on exactly this, so the column model is shared rather
 * than forked — a code that means one thing on one public tab and another on
 * the next would be worse than no code at all. */
export interface CompetitionLike {
  leaf_key: string;
  sport_key: string;
  sport_name: string;
  /** Segment names BELOW the sport ("U-14", "Boys", "Singles"). */
  path: string[];
  label: string;
}

/** A competition plus the display fields a grid header needs. */
export type WithCode<T extends CompetitionLike> = T & {
  /** The header code ("UBS"), unique across the whole matrix. */
  code: string;
  /** The category without the sport ("U-14 · Boys · Singles"). */
  title: string;
};

/** A column of the entries matrix. */
export type MatrixColumn = WithCode<PublicEntryCompetition>;

/** One sport's run of columns — the grid's top band, `span` cells wide. */
export interface Band<T extends CompetitionLike> {
  sportKey: string;
  sportName: string;
  columns: WithCode<T>[];
}

export type MatrixBand = Band<PublicEntryCompetition>;

/** Initials of a category path: ["U-14","Boys","Singles"] -> "UBS".
 *
 * Leading letters only, and never a digit: "U-14" is one segment whose letter
 * is U, and a code of digits is unreadable as a code. A segment with no letter
 * at all contributes nothing rather than a blank, so "2026 · Boys" is "B".
 * A sport-level leaf (no path) falls back to the SPORT's own initials, since
 * a category-less sport is itself the one competition. */
export function pathCode(path: string[], sportName: string): string {
  const letters = path
    .map((seg) => (seg.match(/\p{L}/u)?.[0] ?? "").toUpperCase())
    .filter(Boolean)
    .join("");
  if (letters) return letters;
  return sportName
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.match(/\p{L}/u)?.[0] ?? "").toUpperCase())
    .filter(Boolean)
    .slice(0, 2)
    .join("");
}

/**
 * Column codes for a whole matrix, made UNIQUE.
 *
 * Two categories can easily share initials ("Boys Singles" under U-14 and
 * under Open both start B·S once the age segment differs only in digits), and
 * two identical codes in one header row is worse than a long one: the legend
 * would map one code to two competitions and the grid would lie. A clash is
 * broken by suffixing an index, so every code names exactly one column.
 */
export function columnCodes(comps: CompetitionLike[]): string[] {
  const used = new Set<string>();
  return comps.map((c) => {
    const base = pathCode(c.path, c.sport_name) || "?";
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    let n = 2;
    while (used.has(`${base}${n}`)) n += 1;
    used.add(`${base}${n}`);
    return `${base}${n}`;
  });
}

/** The category label without the sport ("U-14 · Boys · Singles"), falling
 * back to the sport name for a category-less sport. */
export function columnTitle(comp: CompetitionLike): string {
  return comp.path.length ? comp.path.join(" · ") : comp.sport_name;
}

/** Columns in payload order (the organiser's own category order), each with
 * its unique code. */
export function buildColumns<T extends CompetitionLike>(
  comps: T[],
): WithCode<T>[] {
  const codes = columnCodes(comps);
  return comps.map((c, i) => ({
    ...c,
    code: codes[i]!,
    title: columnTitle(c),
  }));
}

/** Columns grouped into their sport bands, sports in first-appearance order —
 * the band header spans its own run, so the runs must stay contiguous. */
export function buildBands<T extends CompetitionLike>(
  columns: WithCode<T>[],
): Band<T>[] {
  const bands: Band<T>[] = [];
  for (const col of columns) {
    const last = bands[bands.length - 1];
    if (last && last.sportKey === col.sport_key) {
      last.columns.push(col);
      continue;
    }
    bands.push({
      sportKey: col.sport_key,
      sportName: col.sport_name,
      columns: [col],
    });
  }
  return bands;
}

export type SortKey = "name" | "entries" | "competitions";

/** How many entries a school has in one competition (0 = not entered). */
export function cellCount(
  row: PublicEntryInstitution,
  leafKey: string,
): number {
  return row.entries[leafKey]?.teams ?? 0;
}

/** The rows a school-matrix shows: filtered by a free-text school search and
 * by sport, then sorted.
 *
 * Filtering by SPORT drops the schools that entered nothing in it — a row of
 * empty cells under "Sepak Takraw only" is not a participant, and leaving it in
 * would make the filter look broken. */
export function visibleRows(
  rows: PublicEntryInstitution[],
  columns: CompetitionLike[],
  opts: { search?: string; sport?: string; sort?: SortKey } = {},
): PublicEntryInstitution[] {
  const q = (opts.search ?? "").trim().toLowerCase();
  const sport = opts.sport ?? "";
  const inSport = columns
    .filter((c) => !sport || c.sport_key === sport)
    .map((c) => c.leaf_key);

  let out = rows;
  if (q) {
    out = out.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.short_name.toLowerCase().includes(q) ||
        r.region.toLowerCase().includes(q),
    );
  }
  if (sport) {
    out = out.filter((r) => inSport.some((k) => cellCount(r, k) > 0));
  }

  const sort = opts.sort ?? "name";
  const scoped = (r: PublicEntryInstitution): { teams: number; comps: number } => {
    let teams = 0;
    let comps = 0;
    for (const key of inSport) {
      const n = cellCount(r, key);
      if (n > 0) {
        teams += n;
        comps += 1;
      }
    }
    return { teams, comps };
  };

  return [...out].sort((a, b) => {
    if (sort === "entries" || sort === "competitions") {
      const sa = scoped(a);
      const sb = scoped(b);
      const va = sort === "entries" ? sa.teams : sa.comps;
      const vb = sort === "entries" ? sb.teams : sb.comps;
      if (va !== vb) return vb - va;
    }
    return a.name.localeCompare(b.name);
  });
}

/** Per-sport totals for the summary chips: how many schools entered anything
 * in that sport, and how many entries that is. Counted from the ROWS, never
 * from the column totals, so a filtered view and the chips can never disagree
 * about who is participating. */
export function sportTotals(
  rows: PublicEntryInstitution[],
  bands: MatrixBand[],
): { sportKey: string; sportName: string; schools: number; teams: number }[] {
  return bands.map((band) => {
    let schools = 0;
    let teams = 0;
    for (const r of rows) {
      let n = 0;
      for (const col of band.columns) n += cellCount(r, col.leaf_key);
      if (n > 0) schools += 1;
      teams += n;
    }
    return {
      sportKey: band.sportKey,
      sportName: band.sportName,
      schools,
      teams,
    };
  });
}

/** The matrix as CSV — the sheet a host pastes into a circular. One header
 * row of full category names (not codes: a spreadsheet has no legend), one row
 * per school, the entry count in each cell. */
export function entriesCsv(
  columns: MatrixColumn[],
  rows: PublicEntryInstitution[],
): string {
  const esc = (v: string | number): string => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = [
    "School",
    ...columns.map((c) => `${c.sport_name} ${c.title}`),
    "Competitions",
    "Entries",
  ];
  const body = rows.map((r) => [
    esc(r.name),
    ...columns.map((c) => cellCount(r, c.leaf_key)),
    r.competition_count,
    r.team_count,
  ]);
  return [head.map(esc).join(","), ...body.map((line) => line.join(","))].join(
    "\n",
  );
}
