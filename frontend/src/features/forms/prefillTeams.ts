import type { Field, Section } from "./types";

/**
 * Pre-fill a competition's team from the participants sheet (owner 2026-08-17:
 * "based on that, automatically in the next stage the real team registration
 * the names should automatically show in the list — if they want to change,
 * they can change").
 *
 * The school already said, person by person, what each is here for. Making it
 * then re-pick the same people competition by competition is asking the same
 * question twice, so each competition step opens with its people already in
 * it. Every seeded row is an ordinary answer: editable, removable, and only
 * ever written into an EMPTY group, so nothing a school typed is overwritten.
 */

/** Segment-aligned prefix match, mirroring `sports.leaf_matches_prefix`:
 * "table_tennis" covers "table_tennis.u14.boys", "table_tennis.u1" covers
 * nothing. */
export function eventCovers(declared: string, leafKey: string): boolean {
  if (!declared || !leafKey) return false;
  return declared === leafKey || leafKey.startsWith(`${declared}.`);
}

/** The competition a generated `cat_*` section is for — carried by its own
 * visibility rule, which gates the section on that leaf being chosen. */
export function leafOfSection(section: Section): string {
  const v = section.visibility?.value;
  return typeof v === "string" ? v : "";
}

interface TeamShape {
  /** The repeatable team group. */
  groupKey: string;
  playersKey: string;
  playerPickKey: string;
  staffKey?: string;
  staffPickKey?: string;
}

/** Find the team group and the two person pickers inside a competition
 * section, by their binding rather than by name — the keys are slugged per
 * competition, but the `form_group` data source is not. */
export function teamShapeOf(section: Section): TeamShape | null {
  const group = (section.fields ?? []).find((f) => f.type === "group" && f.repeatable);
  if (!group) return null;
  let players: Field | undefined;
  let staff: Field | undefined;
  for (const child of group.fields ?? []) {
    if (child.type !== "group") continue;
    const pick = (child.fields ?? []).find(
      (g) => g.data_source?.type === "form_group",
    );
    if (!pick) continue;
    if (pick.data_source?.group === "participant_students") players = child;
    if (pick.data_source?.group === "participant_staff") staff = child;
  }
  if (!players) return null;
  const playerPick = (players.fields ?? []).find(
    (g) => g.data_source?.type === "form_group",
  )!;
  const staffPick = (staff?.fields ?? []).find(
    (g) => g.data_source?.type === "form_group",
  );
  return {
    groupKey: group.key,
    playersKey: players.key,
    playerPickKey: playerPick.key,
    ...(staff && staffPick
      ? { staffKey: staff.key, staffPickKey: staffPick.key }
      : {}),
  };
}

function idsFor(
  rows: unknown,
  idKey: string,
  eventsKey: string,
  leafKey: string,
): string[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => {
      const declared = (row as Record<string, unknown>)?.[eventsKey];
      return (
        Array.isArray(declared) &&
        declared.some((d) => eventCovers(String(d), leafKey))
      );
    })
    .map((row) => String((row as Record<string, unknown>)?.[idKey] ?? ""))
    .filter(Boolean);
}

/**
 * The value to write into a competition's team group, or null when there is
 * nothing to seed (nobody declared it, the section is not a competition, or
 * the group already holds rows the school entered).
 */
export function prefillForSection(
  section: Section,
  answers: Record<string, unknown>,
): { key: string; value: unknown } | null {
  const leafKey = leafOfSection(section);
  if (!leafKey) return null;
  const shape = teamShapeOf(section);
  if (!shape) return null;
  const existing = answers[shape.groupKey];
  if (Array.isArray(existing) && existing.length > 0) return null;

  const players = idsFor(
    answers.participant_students,
    "participant_id",
    "participant_events",
    leafKey,
  );
  const staff = shape.staffPickKey
    ? idsFor(answers.participant_staff, "staff_id", "staff_events", leafKey)
    : [];
  if (!players.length && !staff.length) return null;

  const row: Record<string, unknown> = {
    [shape.playersKey]: players.map((id) => ({ [shape.playerPickKey]: id })),
  };
  if (shape.staffKey && shape.staffPickKey) {
    row[shape.staffKey] = staff.map((id) => ({ [shape.staffPickKey!]: id }));
  }
  return { key: shape.groupKey, value: [row] };
}
