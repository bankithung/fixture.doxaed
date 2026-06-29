import { t } from "@/lib/t";
import type { Scoring } from "./scoring";

/** Human labels for the standings tiebreaker criteria the backend understands. */
const LABELS: Record<string, string> = {
  points: t("Match points"),
  head_to_head: t("Head-to-head"),
  goal_difference: t("Goal difference"),
  goals_for: t("Goals scored"),
  goals_against: t("Goals conceded"),
  set_difference: t("Set difference"),
  point_difference: t("Point difference"),
  points_for: t("Total points scored"),
  points_against: t("Points conceded"),
  wins: t("Most wins"),
  coin_toss: t("Coin toss (referee draw)"),
  name: t("Alphabetical"),
};

export function tbLabel(key: string): string {
  return LABELS[key] ?? key;
}

/** A timed/goal game ranks by goals; everything else (sets) ranks by sets +
 * raw points. Unknown/blank scoring defaults to the set criteria. */
export function isSetSport(s: Scoring | null | undefined): boolean {
  return !s || s.type !== "goals";
}

const SET_CRITERIA = [
  "head_to_head", "set_difference", "point_difference", "points_for",
  "points_against", "wins", "coin_toss", "name",
];
const GOAL_CRITERIA = [
  "head_to_head", "goal_difference", "goals_for", "goals_against", "wins",
  "coin_toss", "name",
];

/** Criteria offered for a game (besides the pinned primary, match points). */
export function availableCriteria(scoring: Scoring | null | undefined): string[] {
  return isSetSport(scoring) ? SET_CRITERIA : GOAL_CRITERIA;
}

/** The recommended order shown before a game gets its own override. Match
 * points is always the implicit primary; the rest break level-on-points ties. */
export function defaultTiebreakers(scoring: Scoring | null | undefined): string[] {
  return isSetSport(scoring)
    ? ["points", "head_to_head", "set_difference", "point_difference", "points_for", "coin_toss"]
    : ["points", "goal_difference", "goals_for", "head_to_head", "name"];
}

/** Keep `coin_toss` last: a coin toss settles everything, so it always goes at
 * the end. A no-op when coin_toss is absent or already last (so a reorder that
 * does not touch it returns an equivalent list). */
export function snapCoinTossLast(rest: string[]): string[] {
  if (!rest.includes("coin_toss")) return rest;
  if (rest[rest.length - 1] === "coin_toss") return rest;
  return [...rest.filter((c) => c !== "coin_toss"), "coin_toss"];
}

/** Move item at `i` up (-1) or down (+1), returning a new array. */
export function moveItem<T>(arr: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (j < 0 || j >= arr.length) return arr;
  const next = arr.slice();
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/** Equality so the board can tell a real reorder from a no-op. */
export function tiebreakersEqual(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
