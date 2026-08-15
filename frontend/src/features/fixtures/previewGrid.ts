import type { PreviewMatch } from "@/api/tournaments";
import { t } from "@/lib/t";
import { shortGroupName } from "./groupSlotLabel";
import { competitionLabel, sportKey, sportLabel } from "./previewFilters";
import { sideName } from "./sideName";

/**
 * The spreadsheet layer of the dry-run preview (owner ask 2026-08-15: "a
 * proper ERP spreadsheet view with proper ERP filters"). One flat row per
 * previewed match, faceted filters computed the way an ERP grid does them
 * (each facet counts against the OTHER filters), column sorting, group bands
 * and CSV export — all pure functions so the grid component stays dumb.
 */

/** One spreadsheet line: every column pre-resolved to display text. */
export interface PreviewRow {
  ref: string;
  /** "2026-08-16" ("" when the match has no time yet). */
  day: string;
  dayLabel: string;
  /** Wall clock "13:59" (invariant 14: never viewer-TZ shifted). */
  start: string;
  end: string;
  minutes: number | null;
  venue: string;
  sportKey: string;
  sportLabel: string;
  leafKey: string;
  /** Competition without the leading sport segment ("U-14 · Boys · Singles"). */
  categoryLabel: string;
  competition: string;
  stage: string;
  stageLabel: string;
  /** "Group A" for a real group-stage match, else "". */
  group: string;
  round: number;
  home: string;
  away: string;
  placed: boolean;
  match: PreviewMatch;
}

export type ColumnKey =
  | "day"
  | "start"
  | "end"
  | "minutes"
  | "venue"
  | "sport"
  | "category"
  | "group"
  | "round"
  | "home"
  | "away"
  | "status";

export type SortDir = "asc" | "desc";
export interface GridSort {
  key: ColumnKey;
  dir: SortDir;
}

export type GroupBy =
  | "none"
  | "day"
  | "venue"
  | "day_venue"
  | "competition"
  | "group";

/** How each banding reads in the toolbar and on an export's cover line. */
export const GROUP_LABELS: Record<GroupBy, string> = {
  day_venue: "Day and court",
  day: "Day",
  venue: "Court",
  competition: "Competition",
  group: "Group",
  none: "No grouping",
};

/** The facet-driven filter fields, in the order they are offered. Shared by
 * the toolbar chips and the filter drawer so the two never drift. */
export const FILTER_FIELDS = [
  { key: "sport", label: "Sport" },
  { key: "category", label: "Category" },
  { key: "day", label: "Day" },
  { key: "venue", label: "Venue" },
  { key: "stage", label: "Stage" },
  { key: "round", label: "Round" },
] as const;

export type FacetField = (typeof FILTER_FIELDS)[number]["key"];

/** Every filter the toolbar owns. "" always means "all". */
export interface GridFilters {
  q: string;
  sport: string;
  category: string;
  day: string;
  venue: string;
  stage: string;
  round: string;
  status: "" | "placed" | "unplaced";
}

export const EMPTY_FILTERS: GridFilters = {
  q: "",
  sport: "",
  category: "",
  day: "",
  venue: "",
  stage: "",
  round: "",
  status: "",
};

export const UNASSIGNED_VENUE = "Unassigned venue";

export function fmtDayLabel(day: string): string {
  if (!day) return t("No date yet");
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? day
    : d.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
}

/** "…T13:59:00" -> "13:59" (string slice, never Date math — no TZ drift). */
export function clockOf(iso: string | null | undefined): string {
  return iso ? iso.slice(11, 16) : "";
}

/** Wall-clock "13:59" + 20 -> "14:19". */
export function addMinutes(hhmm: string, mins: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const total = (h ?? 0) * 60 + (m ?? 0) + mins;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(
    total % 60,
  ).padStart(2, "0")}`;
}

/** Wall clock in the house 12-hour reading: "13:59" -> "1:59 PM" (owner
 * 2026-08-15 — organisers read schedules in am/pm, never 24-hour). Sorting and
 * filtering still use the raw 24-hour value, so the sheet stays in play order. */
export function fmtClock(hhmm: string): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const hour24 = h ?? 0;
  const hour = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour}:${String(m ?? 0).padStart(2, "0")} ${hour24 < 12 ? "AM" : "PM"}`;
}

/** "13:59" -> minutes since midnight. */
export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** minutes since midnight -> "11:30". */
export function fromMinutes(min: number): string {
  return `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(
    min % 60,
  ).padStart(2, "0")}`;
}

const STAGE_LABELS: Record<string, string> = {
  group: "Group",
  knockout: "Knockout",
  league: "League",
};

/** The competition label minus its sport segment, middot-joined (no dashes). */
export function categoryOf(m: PreviewMatch): string {
  const segs = competitionLabel(m)
    .split(/\s+[·—]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return (segs.length > 1 ? segs.slice(1) : segs).join(" · ");
}

/** Flatten previewed matches into spreadsheet rows. */
export function buildRows(
  matches: readonly PreviewMatch[],
  teamNames: ReadonlyMap<string, string>,
  unscheduled: readonly string[] = [],
): PreviewRow[] {
  const unplaced = new Set(unscheduled);
  return matches.map((m) => {
    const day = m.scheduled_at ? m.scheduled_at.slice(0, 10) : "";
    const start = clockOf(m.scheduled_at);
    const mins = m.duration_minutes ?? null;
    const isGroup =
      m.stage !== "knockout" && /group/i.test(m.group_label ?? "");
    return {
      ref: m.ref,
      day,
      dayLabel: fmtDayLabel(day),
      start,
      end: start && mins ? addMinutes(start, mins) : "",
      minutes: mins,
      venue: m.venue || t(UNASSIGNED_VENUE),
      sportKey: sportKey(m),
      sportLabel: sportLabel(m),
      leafKey: m.leaf_key,
      categoryLabel: categoryOf(m),
      competition: competitionLabel(m),
      stage: m.stage,
      stageLabel: t(STAGE_LABELS[m.stage] ?? m.stage),
      group: isGroup ? `${t("Group")} ${shortGroupName(m.group_label)}` : "",
      round: m.round_no ?? 0,
      home: sideName(m.home, teamNames),
      away: sideName(m.away, teamNames),
      placed: Boolean(m.scheduled_at) && !unplaced.has(m.ref),
      match: m,
    };
  });
}

/** Does one row survive one field of the filter set? */
function matchesField(row: PreviewRow, field: keyof GridFilters, f: GridFilters): boolean {
  const v = f[field];
  if (!v) return true;
  switch (field) {
    case "q": {
      const q = v.toLowerCase();
      return [
        row.home,
        row.away,
        row.venue,
        row.competition,
        row.group,
        row.dayLabel,
        row.start,
        row.ref,
      ].some((s) => s.toLowerCase().includes(q));
    }
    case "sport":
      return row.sportKey === v;
    case "category":
      return row.leafKey === v;
    case "day":
      return row.day === v;
    case "venue":
      return row.venue === v;
    case "stage":
      return row.stage === v;
    case "round":
      return String(row.round) === v;
    case "status":
      return v === "placed" ? row.placed : !row.placed;
    default:
      return true;
  }
}

export function applyFilters(
  rows: readonly PreviewRow[],
  f: GridFilters,
): PreviewRow[] {
  const fields = Object.keys(EMPTY_FILTERS) as (keyof GridFilters)[];
  return rows.filter((r) => fields.every((k) => matchesField(r, k, f)));
}

export interface FacetOption {
  value: string;
  label: string;
  count: number;
}

/** The value + label a row contributes to one facet. */
const FACET_OF: Record<
  string,
  (r: PreviewRow) => { value: string; label: string } | null
> = {
  sport: (r) => ({ value: r.sportKey, label: r.sportLabel }),
  category: (r) => ({ value: r.leafKey, label: r.categoryLabel || r.competition }),
  day: (r) => (r.day ? { value: r.day, label: r.dayLabel } : null),
  venue: (r) => ({ value: r.venue, label: r.venue }),
  stage: (r) => ({ value: r.stage, label: r.stageLabel }),
  round: (r) => (r.round ? { value: String(r.round), label: `R${r.round}` } : null),
};

/**
 * ERP faceting: each facet counts rows that pass every OTHER filter, so the
 * numbers tell you what picking that value would actually give you (and a
 * value that would empty the grid never shows a stale count).
 */
export function facetsFor(
  rows: readonly PreviewRow[],
  f: GridFilters,
  field: keyof typeof FACET_OF,
): FacetOption[] {
  const others = { ...f, [field]: "" } as GridFilters;
  const seen = new Map<string, FacetOption>();
  for (const r of applyFilters(rows, others)) {
    const e = FACET_OF[field]!(r);
    if (!e) continue;
    const hit = seen.get(e.value);
    if (hit) hit.count += 1;
    else seen.set(e.value, { ...e, count: 1 });
  }
  const out = [...seen.values()];
  return field === "round" || field === "day"
    ? out.sort((a, b) => a.value.localeCompare(b.value, undefined, { numeric: true }))
    : out.sort((a, b) => a.label.localeCompare(b.label));
}

const FILTER_TITLES: Record<keyof GridFilters, string> = {
  q: "Search",
  sport: "Sport",
  category: "Category",
  day: "Day",
  venue: "Venue",
  stage: "Stage",
  round: "Round",
  status: "Status",
};

const STATUS_LABELS: Record<string, string> = {
  placed: "Scheduled",
  unplaced: "No time yet",
};

/** The applied filters in one plain line ("Sport: Table Tennis · Status: No
 * time yet") — what an export has to state so a printed sheet is never
 * mistaken for the whole draw. "" when nothing is filtered. */
export function filterSummary(
  rows: readonly PreviewRow[],
  f: GridFilters,
): string {
  const label = (field: keyof typeof FACET_OF, value: string): string =>
    facetsFor(rows, EMPTY_FILTERS, field).find((o) => o.value === value)?.label ??
    value;
  const parts: string[] = [];
  for (const key of Object.keys(FILTER_TITLES) as (keyof GridFilters)[]) {
    const v = f[key];
    if (!v) continue;
    const shown =
      key === "q"
        ? `"${v}"`
        : key === "status"
          ? t(STATUS_LABELS[v] ?? v)
          : label(key, v);
    parts.push(`${t(FILTER_TITLES[key])}: ${shown}`);
  }
  return parts.join(" · ");
}

/** Chronological baseline: day, then kickoff, then venue, then ref. Rows with
 * no time sink to the bottom — they are work still to do, not 00:00 matches. */
function chronoKey(r: PreviewRow): string {
  return `${r.day || "9999-99-99"}|${r.start || "99:99"}|${r.venue}|${r.ref}`;
}

const SORT_VALUE: Record<ColumnKey, (r: PreviewRow) => string | number> = {
  day: (r) => r.day || "9999-99-99",
  start: (r) => r.start || "99:99",
  end: (r) => r.end || "99:99",
  minutes: (r) => r.minutes ?? -1,
  venue: (r) => r.venue,
  sport: (r) => r.sportLabel,
  category: (r) => r.categoryLabel,
  group: (r) => r.group,
  round: (r) => r.round,
  home: (r) => r.home,
  away: (r) => r.away,
  status: (r) => (r.placed ? 0 : 1),
};

export function sortRows(
  rows: readonly PreviewRow[],
  sort: GridSort | null,
): PreviewRow[] {
  const out = [...rows];
  if (!sort) {
    return out.sort((a, b) => chronoKey(a).localeCompare(chronoKey(b)));
  }
  const pick = SORT_VALUE[sort.key];
  const dir = sort.dir === "asc" ? 1 : -1;
  return out.sort((a, b) => {
    const va = pick(a);
    const vb = pick(b);
    const c =
      typeof va === "number" && typeof vb === "number"
        ? va - vb
        : String(va).localeCompare(String(vb), undefined, { numeric: true });
    // Ties always fall back to play order, so a sort never scrambles a court.
    return c !== 0 ? c * dir : chronoKey(a).localeCompare(chronoKey(b));
  });
}

export interface RowGroup {
  key: string;
  label: string;
  /** Second line of the band ("Court 1", "12 matches"). */
  sub: string;
  /** Set when the band is one court on one day, so breaks can be measured. */
  day: string;
  venue: string;
  rows: PreviewRow[];
}

const GROUP_OF: Record<GroupBy, (r: PreviewRow) => { key: string; label: string; sub: string }> = {
  none: () => ({ key: "", label: "", sub: "" }),
  day: (r) => ({ key: r.day || "~", label: r.dayLabel, sub: "" }),
  venue: (r) => ({ key: r.venue, label: r.venue, sub: "" }),
  day_venue: (r) => ({
    key: `${r.day || "~"}|${r.venue}`,
    label: r.dayLabel,
    sub: r.venue,
  }),
  competition: (r) => ({ key: r.leafKey, label: r.competition, sub: "" }),
  group: (r) => ({
    key: `${r.leafKey}|${r.group || r.stageLabel}`,
    label: r.group || r.stageLabel,
    sub: r.competition,
  }),
};

/** Split sorted rows into bands, preserving the incoming row order. */
export function groupRows(
  rows: readonly PreviewRow[],
  by: GroupBy,
): RowGroup[] {
  if (by === "none") {
    return [{ key: "", label: "", sub: "", day: "", venue: "", rows: [...rows] }];
  }
  const map = new Map<string, RowGroup>();
  for (const r of rows) {
    const g = GROUP_OF[by](r);
    let band = map.get(g.key);
    if (!band) {
      band = { ...g, day: r.day, venue: r.venue, rows: [] };
      map.set(g.key, band);
    }
    band.rows.push(r);
  }
  return [...map.values()];
}

/** Busy [startMin, endMin) intervals per `${day}|${venue}` across EVERY
 * previewed match — the truth about when a court is actually in use, so a
 * filtered view never invents a break for time other categories are using. */
export function occupancyByCourt(
  matches: readonly PreviewMatch[],
): Map<string, [number, number][]> {
  const map = new Map<string, [number, number][]>();
  for (const m of matches) {
    if (!m.scheduled_at || m.duration_minutes == null) continue;
    const key = `${m.scheduled_at.slice(0, 10)}|${m.venue || t(UNASSIGNED_VENUE)}`;
    const s = toMinutes(clockOf(m.scheduled_at));
    const arr = map.get(key);
    if (arr) arr.push([s, s + m.duration_minutes]);
    else map.set(key, [[s, s + m.duration_minutes]]);
  }
  return map;
}

/** The genuinely-empty sub-windows of [start, end) once every busy interval
 * is removed. */
export function idleWindows(
  start: number,
  end: number,
  busy: readonly [number, number][],
): [number, number][] {
  const clipped = busy
    .map(([s, e]): [number, number] => [Math.max(s, start), Math.min(e, end)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const idle: [number, number][] = [];
  let cursor = start;
  for (const [s, e] of clipped) {
    if (s > cursor) idle.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < end) idle.push([cursor, end]);
  return idle;
}

/** A configured no-play window from the tournament's rules (the wizard's
 * daily break, a Sunday church window, …). */
export interface BlackoutWindow {
  from: string;
  to: string;
  /** Weekday keys ("sun", "mon"…); empty/absent = every day. */
  days?: string[];
  /** One date only ("2026-08-17") — a ceremony, not a recurring window. */
  date?: string;
  /** Stored label ("daily_break") — humanized for the sheet. */
  label?: string;
}

export type GridLine =
  | { kind: "match"; row: PreviewRow }
  | {
      kind: "break";
      key: string;
      from: string;
      to: string;
      minutes: number;
      /** What this gap IS: a scheduled break, or an idle court. */
      label: string;
    };

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Humanize a stored blackout label ("daily_break" -> "Daily break",
 * "opening" -> "Opening ceremony"). */
export function blackoutLabel(label: string | undefined): string {
  if (label === "opening") return t("Opening ceremony");
  if (label === "closing") return t("Closing ceremony");
  if (!label) return t("Scheduled break");
  const words = label.replace(/[_.]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : t("Scheduled break");
}

/** A gap only counts as "the break you set" once this much of it falls inside
 * the configured window — play rarely ends exactly on the break's edge. */
const BREAK_OVERLAP_MIN = 10;

/** The configured window an idle stretch is standing in, if any. */
function coveringBlackout(
  start: number,
  end: number,
  day: string,
  windows: readonly BlackoutWindow[],
): BlackoutWindow | null {
  const weekday = day ? WEEKDAY_KEYS[new Date(`${day}T00:00:00`).getDay()] : "";
  for (const w of windows) {
    if (w.days?.length && weekday && !w.days.includes(weekday)) continue;
    if (w.date && w.date !== day) continue;
    const overlap =
      Math.min(end, toMinutes(w.to)) - Math.max(start, toMinutes(w.from));
    if (overlap >= BREAK_OVERLAP_MIN) return w;
  }
  return null;
}

/**
 * Interleave the tournament's OWN breaks into one court's day.
 *
 * A break line means "you set a break here" — nothing else (owner 2026-08-15,
 * twice: an idle court reads as an unplanned break and made one configured
 * break look like three). So a line appears only where the court is idle
 * across a configured no-play window — the daily break, a ceremony, a Sunday
 * window — and it shows THAT window's own hours, not the ragged gap around
 * it. Courts standing empty for any other reason (a rule keeping two
 * competitions apart, a round waiting on its feeders) are simply time between
 * matches, and the sheet stays quiet about them.
 */
export function linesWithBreaks(
  rows: readonly PreviewRow[],
  busy: readonly [number, number][],
  /** The tournament's configured no-play windows. */
  blackouts: readonly BlackoutWindow[] = [],
): GridLine[] {
  const out: GridLine[] = [];
  const shown = new Set<string>();
  rows.forEach((row, i) => {
    out.push({ kind: "match", row });
    const next = rows[i + 1];
    if (!next || !row.start || !next.start || row.minutes == null) return;
    const gapStart = toMinutes(row.start) + row.minutes;
    const gapEnd = toMinutes(next.start);
    for (const [s, e] of idleWindows(gapStart, gapEnd, busy)) {
      const w = coveringBlackout(s, e, row.day, blackouts);
      if (!w) continue;
      const key = `${row.day}|${w.from}|${w.to}`;
      if (shown.has(key)) continue;
      shown.add(key);
      out.push({
        kind: "break",
        key: `brk-${row.ref}-${w.from}`,
        from: w.from,
        to: w.to,
        minutes: Math.max(0, toMinutes(w.to) - toMinutes(w.from)),
        label: blackoutLabel(w.label),
      });
    }
  });
  return out;
}

const CSV_COLUMNS: [string, (r: PreviewRow) => string][] = [
  ["Date", (r) => r.day],
  ["Day", (r) => r.dayLabel],
  ["Start", (r) => fmtClock(r.start)],
  ["End", (r) => fmtClock(r.end)],
  ["Minutes", (r) => (r.minutes == null ? "" : String(r.minutes))],
  ["Venue", (r) => (r.placed || r.day ? r.venue : "")],
  ["Sport", (r) => r.sportLabel],
  ["Category", (r) => r.categoryLabel],
  ["Stage", (r) => r.stageLabel],
  ["Group", (r) => r.group],
  ["Round", (r) => (r.round ? String(r.round) : "")],
  ["Home", (r) => r.home],
  ["Away", (r) => r.away],
  ["Status", (r) => (r.placed ? "Scheduled" : "No time")],
  ["Ref", (r) => r.ref],
];

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** The visible rows as a spreadsheet file (what the filters currently show). */
export function toCsv(rows: readonly PreviewRow[]): string {
  const head = CSV_COLUMNS.map(([h]) => h).join(",");
  const body = rows.map((r) =>
    CSV_COLUMNS.map(([, pick]) => csvCell(pick(r))).join(","),
  );
  return [head, ...body].join("\n");
}
