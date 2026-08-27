import type { RosterMember, UploadRef } from "@/api/tournaments";
import { humanizeLeaf } from "@/features/controlroom/format";
import { t } from "@/lib/t";
import { ageFrom } from "./personFormat";

/**
 * The model behind the participation workbench (owner 2026-08-17: "a list of
 * all students and where they are participating, in which sports and
 * categories … and an option to see if one student is participating in
 * multiple games, so that we can set the rules of the games").
 *
 * That second half is the point: the answer feeds a scheduling decision. A
 * person in two competitions is a person the draw must keep apart, so this
 * counts events per person, names which ones, and — because two entries only
 * collide if they can be scheduled at the same time — separates "in two
 * sports" from "in two categories of one sport". The engine's own rules key on
 * exactly that distinction (`no_person_overlap`, and `no_institution_overlap`'s
 * `within`), so the page reports it rather than making the host infer it.
 *
 * Everything is derived from the roster payload already on the client, so
 * filtering is instant and can never disagree with the list it filters.
 */

export interface ParticipationEntry {
  teamId: string;
  team: string;
  leafKey: string;
  /** "table_tennis" — the leaf's first segment. */
  sportKey: string;
  sportLabel: string;
  /** The competition without its sport segment ("U-14 · Boys · Singles"). */
  categoryLabel: string;
  competition: string;
  /** "player", or the staff row's role. */
  role: string;
}

export interface ParticipationRow {
  id: string;
  name: string;
  kind: "student" | "teacher";
  classSection: string;
  rollNo: string;
  /** ISO date, or "" when the sheet did not ask (or the school left it out). */
  dob: string;
  gender: string;
  phone: string;
  email: string;
  /** Papers the school uploaded for this person. */
  documents: UploadRef[];
  school: string;
  /** The house/class in a within-school event, else "". */
  group: string;
  entries: ParticipationEntry[];
  /** How many competitions this person is entered in. */
  events: number;
  /** Distinct sports — two of these is a cross-sport clash risk. */
  sports: string[];
  /** True when they play more than one competition WITHIN a single sport. */
  multiInOneSport: boolean;
  /** True when they play in more than one sport. */
  multiAcrossSports: boolean;
}

export interface ParticipationFacets {
  schools: { value: string; label: string }[];
  sports: { value: string; label: string }[];
  competitions: { value: string; label: string }[];
}

export interface ParticipationTotals {
  people: number;
  /** People entered in nothing yet — a real state, not an error. */
  unentered: number;
  multi: number;
  multiAcrossSports: number;
  /** The busiest single person, which is what caps a day. */
  busiest: number;
}

export type EventsFilter = "" | "none" | "one" | "multi" | "cross_sport";

export interface ParticipationFilters {
  q: string;
  kind: string;
  school: string;
  sport: string;
  competition: string;
  events: EventsFilter;
}

/** The "how many events" choices, and the kinds — ONE list, so the filter
 * drawer, the active-filter summary and the printed document's "Filters
 * applied" line can never word the same filter three ways. */
export const EVENT_FILTER_VALUES: { value: EventsFilter; label: string }[] = [
  { value: "multi", label: "In two or more" },
  { value: "cross_sport", label: "In two or more sports" },
  { value: "one", label: "In exactly one" },
  { value: "none", label: "Not entered yet" },
];

export const KIND_FILTER_VALUES: { value: string; label: string }[] = [
  { value: "student", label: "Students" },
  { value: "teacher", label: "Teachers" },
];

export const EMPTY_PARTICIPATION_FILTERS: ParticipationFilters = {
  q: "",
  kind: "",
  school: "",
  sport: "",
  competition: "",
  events: "",
};

/** The sport segment of a leaf key ("table_tennis.u_14.boys" -> "table_tennis"). */
export function sportOf(leafKey: string): string {
  return leafKey ? leafKey.split(".")[0]! : "";
}

/** The competition label minus its sport segment, so a table can carry the
 * sport in its own column instead of repeating it in every cell. */
function categoryOf(leafKey: string, fallback: string): string {
  if (!leafKey) return fallback;
  const segs = humanizeLeaf(leafKey).split(" · ");
  return (segs.length > 1 ? segs.slice(1) : segs).join(" · ");
}

/** Flatten the roster payload into one row per person. */
export function buildParticipation(
  members: readonly RosterMember[],
): ParticipationRow[] {
  return members.map((m) => {
    const entries: ParticipationEntry[] = m.entries.map((e) => {
      const sportKey = sportOf(e.leaf_key);
      return {
        teamId: e.team_id,
        team: e.team,
        leafKey: e.leaf_key,
        sportKey,
        sportLabel: sportKey ? humanizeLeaf(sportKey) : t("Tournament"),
        categoryLabel: categoryOf(e.leaf_key, e.team),
        competition: e.leaf_key ? humanizeLeaf(e.leaf_key) : e.team,
        role: e.role,
      };
    });
    // One competition can hold the same person twice only through separate
    // rows (player and staff); count COMPETITIONS, not rows, or a teacher who
    // also plays would read as a clash with themselves.
    const leaves = new Set(entries.map((e) => e.leafKey || e.teamId));
    const sports = [...new Set(entries.map((e) => e.sportKey).filter(Boolean))];
    return {
      id: m.id,
      name: m.full_name,
      kind: m.kind,
      classSection: m.class_section,
      rollNo: m.roll_no,
      dob: m.date_of_birth ?? "",
      gender: m.gender,
      phone: m.contact_phone,
      email: m.contact_email,
      documents: m.documents ?? [],
      school: m.institution?.name ?? "",
      group: m.group?.name ?? "",
      entries,
      events: leaves.size,
      sports,
      multiInOneSport: leaves.size > 1 && sports.length <= 1,
      multiAcrossSports: sports.length > 1,
    };
  });
}

export function participationFacets(
  rows: readonly ParticipationRow[],
): ParticipationFacets {
  const schools = new Set<string>();
  const sports = new Map<string, string>();
  const competitions = new Map<string, string>();
  for (const r of rows) {
    if (r.school) schools.add(r.school);
    for (const e of r.entries) {
      if (e.sportKey) sports.set(e.sportKey, e.sportLabel);
      if (e.leafKey) competitions.set(e.leafKey, e.competition);
    }
  }
  const byLabel = (a: { label: string }, b: { label: string }): number =>
    a.label.localeCompare(b.label);
  return {
    schools: [...schools].sort().map((s) => ({ value: s, label: s })),
    sports: [...sports]
      .map(([value, label]) => ({ value, label }))
      .sort(byLabel),
    competitions: [...competitions]
      .map(([value, label]) => ({ value, label }))
      .sort(byLabel),
  };
}

export function applyParticipationFilters(
  rows: readonly ParticipationRow[],
  f: ParticipationFilters,
): ParticipationRow[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.kind && r.kind !== f.kind) return false;
    if (f.school && r.school !== f.school) return false;
    if (f.sport && !r.entries.some((e) => e.sportKey === f.sport)) return false;
    if (f.competition && !r.entries.some((e) => e.leafKey === f.competition)) {
      return false;
    }
    if (f.events === "none" && r.events !== 0) return false;
    if (f.events === "one" && r.events !== 1) return false;
    if (f.events === "multi" && r.events < 2) return false;
    if (f.events === "cross_sport" && !r.multiAcrossSports) return false;
    if (q) {
      const hay = [r.name, r.classSection, r.rollNo, r.school, r.group, r.phone]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function participationTotals(
  rows: readonly ParticipationRow[],
): ParticipationTotals {
  return {
    people: rows.length,
    unentered: rows.filter((r) => r.events === 0).length,
    multi: rows.filter((r) => r.events > 1).length,
    multiAcrossSports: rows.filter((r) => r.multiAcrossSports).length,
    busiest: rows.reduce((mx, r) => Math.max(mx, r.events), 0),
  };
}

export type ParticipationSortKey =
  | "name"
  | "class"
  | "roll"
  | "dob"
  | "gender"
  | "school"
  | "events";

export function sortParticipation(
  rows: readonly ParticipationRow[],
  key: ParticipationSortKey,
  dir: "asc" | "desc",
): ParticipationRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const pick = (r: ParticipationRow): string | number =>
    key === "events"
      ? r.events
      : key === "class"
        ? r.classSection
        : key === "roll"
          ? r.rollNo
          : key === "dob"
            ? r.dob
            : key === "gender"
              ? r.gender
              : key === "school"
                ? r.school
                : r.name;
  return [...rows].sort((a, b) => {
    const x = pick(a);
    const y = pick(b);
    if (typeof x === "number" && typeof y === "number") {
      return (x - y) * sign || a.name.localeCompare(b.name);
    }
    return String(x).localeCompare(String(y)) * sign || a.name.localeCompare(b.name);
  });
}

/**
 * The person-detail columns the sheet CAN carry, in reading order.
 *
 * A registration form is DATA, not a fixed shape: this event asks each school
 * for a date of birth, a gender and an age-proof document, the next asks for a
 * class and a roll number, and a third asks for something nobody has thought of
 * yet. The list showed a hardcoded Class and Roll either way, so an organizer
 * running the first kind read a column of dots beside every child while the
 * details their schools HAD filled in were nowhere on the page (owner
 * 2026-08-19). So the columns follow the answers: one is shown when at least
 * one person carries it, and hidden when nobody does.
 */
export type DetailKey =
  | "class"
  | "roll"
  | "dob"
  | "age"
  | "gender"
  | "phone"
  | "docs";

export interface DetailColumn {
  key: DetailKey;
  label: string;
  width: number;
  sort?: ParticipationSortKey;
  align?: "right";
}

/** Every detail column that can appear, whatever this event asks for. The page
 * seeds its saved column widths from the whole set, so a width survives a
 * column going quiet and coming back. */
export const ALL_DETAIL_COLUMNS: DetailColumn[] = [
  { key: "class", label: "Class", width: 96, sort: "class" },
  { key: "roll", label: "Roll", width: 84, sort: "roll" },
  { key: "dob", label: "Born", width: 118, sort: "dob" },
  { key: "age", label: "Age", width: 60, align: "right" },
  { key: "gender", label: "Gender", width: 90, sort: "gender" },
  { key: "phone", label: "Phone", width: 130 },
  { key: "docs", label: "Documents", width: 210 },
];

/** Whether any visible person carries this detail. Age rides on the date of
 * birth, so the two appear and disappear together. */
function carries(rows: readonly ParticipationRow[], key: DetailKey): boolean {
  switch (key) {
    case "class":
      return rows.some((r) => !!r.classSection);
    case "roll":
      return rows.some((r) => !!r.rollNo);
    case "dob":
    case "age":
      return rows.some((r) => !!r.dob);
    case "gender":
      return rows.some((r) => !!r.gender);
    case "phone":
      return rows.some((r) => !!r.phone);
    case "docs":
      return rows.some((r) => r.documents.length > 0);
  }
}

/** The detail columns worth showing for these people. Computed from the WHOLE
 * roster, not the filtered view, so narrowing to one school never makes a
 * column jump out of the table under the reader. */
export function detailColumns(
  rows: readonly ParticipationRow[],
): DetailColumn[] {
  return ALL_DETAIL_COLUMNS.filter((c) => carries(rows, c.key));
}

/** One detail as text — the single source both the sheet cell and the exported
 * spreadsheet read, so what an organizer sees is what they download. */
export function detailText(r: ParticipationRow, key: DetailKey): string {
  switch (key) {
    case "class":
      return r.classSection;
    case "roll":
      return r.rollNo;
    case "dob":
      return r.dob;
    case "age": {
      const a = r.dob ? ageFrom(r.dob) : null;
      return a === null ? "" : String(a);
    }
    case "gender":
      return r.gender;
    case "phone":
      return r.phone;
    case "docs":
      return r.documents.map((d) => d.label || d.name).join("; ");
  }
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

/**
 * The visible rows as a spreadsheet file. One column per competition, ticked
 * where the person is entered — the shape a host actually works in, and the
 * one that makes a double entry visible by eye across a row.
 */
export function participationCsv(
  rows: readonly ParticipationRow[],
  competitions: readonly { value: string; label: string }[],
  columns: readonly DetailColumn[],
): string {
  const head = [
    t("Name"),
    t("Kind"),
    ...columns.map((c) => t(c.label)),
    t("School"),
    t("Events"),
    ...competitions.map((c) => c.label),
  ];
  const body = rows.map((r) => {
    const mine = new Set(r.entries.map((e) => e.leafKey));
    return [
      r.name,
      r.kind === "teacher" ? t("Teacher") : t("Student"),
      ...columns.map((c) => detailText(r, c.key)),
      r.school,
      String(r.events),
      ...competitions.map((c) => (mine.has(c.value) ? t("Yes") : "")),
    ]
      .map(csvCell)
      .join(",");
  });
  return [head.map(csvCell).join(","), ...body].join("\n");
}
