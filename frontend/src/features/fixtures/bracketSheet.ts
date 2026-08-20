/**
 * The pure model behind an AUTHORED knockout bracket (owner 2026-08-20).
 *
 * A groups→knockout draw normally seeds itself: top N of each group,
 * cross-seeded. An organiser who wants something else ("Group A's winner plays
 * the best loser, and the winners of match 1 and match 3 meet in the semi")
 * has to be able to WRITE it, so the sheet is data: `from.pairings` is the
 * round-1 card in slot notation, `from.meets` says which of those matches
 * converge next. Everything here is arithmetic over those two lists, shared by
 * the editor and its tests, and it knows nothing about any particular sport.
 */
import { t } from "@/lib/t";

/** The letter that introduces a best-loser slot ("L1"), matching the server. */
export const BEST_LOSER = "L";

/** Group letters, in the order the generator names groups. */
export function groupLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

/**
 * How many groups a bracket of this size implies.
 *
 * The organiser never types this: every qualifying slot has to appear exactly
 * once, so `2 x matches = advancePerGroup x groups + bestLosers` pins it. A
 * size that leaves a remainder is a sheet that cannot be filled, and returns
 * null so the editor can say so instead of listing impossible slots.
 */
export function groupCountFor(
  matches: number,
  advancePerGroup: number,
  bestLosers: number,
): number | null {
  if (matches < 1 || advancePerGroup < 1 || bestLosers < 0) return null;
  const qualifiers = matches * 2 - bestLosers;
  if (qualifiers < advancePerGroup || qualifiers % advancePerGroup !== 0) return null;
  return qualifiers / advancePerGroup;
}

/** Every slot that qualifies, in reading order: A1, A2, B1, B2, …, L1, L2. */
export function slotOptions(
  groups: number,
  advancePerGroup: number,
  bestLosers: number,
): string[] {
  const out: string[] = [];
  for (let g = 0; g < groups; g += 1) {
    for (let p = 1; p <= advancePerGroup; p += 1) out.push(`${groupLetter(g)}${p}`);
  }
  for (let k = 1; k <= bestLosers; k += 1) out.push(`${BEST_LOSER}${k}`);
  return out;
}

/** "A1" reads as "Group A winner"; "L1" as "Best loser 1". */
export function slotLabel(slot: string): string {
  const m = /^([A-Za-z]+)(\d+)$/.exec(slot.trim());
  if (!m) return slot;
  const [, name, num] = m;
  const place = Number(num);
  if (name!.toUpperCase() === BEST_LOSER) return `${t("Best loser")} ${place}`;
  const ordinal =
    place === 1 ? t("winner") : place === 2 ? t("runner-up") : `${t("place")} ${place}`;
  return `${t("Group")} ${name!.toUpperCase()} ${ordinal}`;
}

/**
 * A starting sheet for `matches` round-1 games: group winners are seated first
 * and drawn against the best losers, then the remaining places pair off. It is
 * only a starting point (every slot appears once, so it is always legal) that
 * the organiser then rearranges.
 */
export function defaultSheet(
  matches: number,
  advancePerGroup: number,
  bestLosers: number,
): string[][] {
  const groups = groupCountFor(matches, advancePerGroup, bestLosers);
  if (groups === null) return [];
  const all = slotOptions(groups, advancePerGroup, bestLosers);
  const winners = all.filter((s) => s.endsWith("1") && !s.startsWith(BEST_LOSER));
  const rest = all.filter((s) => !winners.includes(s)).reverse();
  const pairs: string[][] = [];
  for (let i = 0; i < matches; i += 1) {
    const home = winners[i] ?? rest.pop() ?? "";
    const away = rest.pop() ?? winners[i + matches] ?? "";
    pairs.push([home, away]);
  }
  return pairs;
}

/** The plain tree: M1 v M2, M3 v M4. */
export function defaultMeets(matches: number): number[][] {
  const out: number[][] = [];
  for (let i = 1; i <= matches; i += 2) out.push([i, i + 1]);
  return out;
}

/** Round-1 sizes a bracket can have (a knockout halves, so powers of two). */
export function bracketSizes(max = 16): number[] {
  const out: number[] = [];
  for (let n = 1; n <= max; n *= 2) out.push(n);
  return out;
}

/**
 * What is wrong with the sheet, in the organiser's words. Mirrors the server's
 * coverage rule: a qualifier with no match is invisible on a bracket diagram
 * and shows up as a team standing on the court with nothing to play.
 */
export function sheetProblems(pairings: string[][], expected: string[]): string[] {
  const written = pairings.flat().map((s) => s.trim().toUpperCase()).filter(Boolean);
  const problems: string[] = [];
  const blanks = pairings.flat().filter((s) => !s.trim()).length;
  if (blanks) problems.push(t("Every match needs two teams."));
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const s of written) {
    if (seen.has(s)) twice.add(s);
    seen.add(s);
  }
  if (twice.size) {
    problems.push(`${t("Seated twice")}: ${[...twice].sort().join(", ")}`);
  }
  const missing = expected.filter((s) => !seen.has(s));
  if (missing.length) {
    problems.push(`${t("Never plays")}: ${missing.join(", ")}`);
  }
  const unknown = [...seen].filter((s) => !expected.includes(s));
  if (unknown.length) {
    problems.push(`${t("Does not qualify")}: ${unknown.sort().join(", ")}`);
  }
  return problems;
}

/** `meets` must pair up every round-1 match exactly once. */
export function meetsProblem(meets: number[][], matches: number): string | null {
  const flat = meets.flat();
  if (flat.length !== matches) return t("Every match has to meet exactly one other.");
  if (new Set(flat).size !== matches) {
    return t("Every match has to meet exactly one other.");
  }
  return null;
}
