import type { Section } from "./types";

/**
 * Which people a competition step should offer (owner 2026-08-17).
 *
 * The school says, person by person, which SPORT each is here for. Each
 * competition then shortlists its dropdown to the people who play that sport,
 * so the category choice happens in the category's own step — with a list of
 * three names instead of the school's whole roll.
 *
 * A sport is deliberately as far as the declaration goes: "plays table tennis"
 * must not silently enter a child in all eight of its competitions.
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
