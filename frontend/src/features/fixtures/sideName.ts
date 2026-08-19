import type { PreviewSide } from "@/api/tournaments";
import { t } from "@/lib/t";
import { groupPositionLabel } from "./groupSlotLabel";

/** Resolve a previewed side to a display name: real team, typed source
 * pointer ("Winner of p3", "Group A #1", "Best 3rd #1") or TBD. Shared by the
 * MatchesByDayGrid chips and the preview page's unscheduled list. */
export function sideName(
  side: PreviewSide,
  teamNames: ReadonlyMap<string, string>,
  /** Plan ref -> what that match is called on the page ("Semi-final 2").
   * Without it a pointer falls back to the raw ref, which is an internal
   * code the reader cannot look up anywhere (owner 2026-08-19: "Winner of
   * p109 — the name is confusing"). */
  refLabels?: ReadonlyMap<string, string>,
): string {
  if (side.team_id) return teamNames.get(side.team_id) ?? t("TBD");
  const src = side.source;
  const named = (ref: string): string => refLabels?.get(ref) ?? ref;
  if (src?.type === "winner_of" && src.ref) {
    return `${t("Winner of")} ${named(src.ref)}`;
  }
  if (src?.type === "loser_of" && src.ref) {
    return `${t("Loser of")} ${named(src.ref)}`;
  }
  // Group placeholders render as a CLEAN short chip ("Group A #1"), never the
  // raw em-dash legacy label — same helper the FIFA bracket uses so they agree.
  if (src?.type === "group_position") {
    const label = groupPositionLabel(src);
    if (label) return label;
  }
  return t("TBD");
}

/**
 * The badge that belongs beside `sideName`'s text, or "" when there is none.
 *
 * A crest cannot ride on a string, and `sideName` returns one — so the badge
 * is threaded alongside it rather than folded into it. Everything downstream
 * (sorting, CSV columns, the search filter) reads the NAME, and a crest must
 * not disturb any of that.
 *
 * An unresolved side has no team yet, so it has no badge either: "Winner of
 * Match 3" and "Group A #1" both answer "". Callers render nothing for "" on
 * paper, and the team's initials on screen.
 */
export function sideCrest(
  side: PreviewSide,
  crests: ReadonlyMap<string, string>,
): string {
  if (!side.team_id) return "";
  return crests.get(side.team_id) ?? "";
}
