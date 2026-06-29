import type { PreviewSide } from "@/api/tournaments";
import { t } from "@/lib/t";
import { groupPositionLabel } from "./groupSlotLabel";

/** Resolve a previewed side to a display name: real team, typed source
 * pointer ("Winner of p3", "Group A #1", "Best 3rd #1") or TBD. Shared by the
 * MatchesByDayGrid chips and the preview page's unscheduled list. */
export function sideName(
  side: PreviewSide,
  teamNames: ReadonlyMap<string, string>,
): string {
  if (side.team_id) return teamNames.get(side.team_id) ?? t("TBD");
  const src = side.source;
  if (src?.type === "winner_of" && src.ref) return `${t("Winner of")} ${src.ref}`;
  if (src?.type === "loser_of" && src.ref) return `${t("Loser of")} ${src.ref}`;
  // Group placeholders render as a CLEAN short chip ("Group A #1"), never the
  // raw em-dash legacy label — same helper the FIFA bracket uses so they agree.
  if (src?.type === "group_position") {
    const label = groupPositionLabel(src);
    if (label) return label;
  }
  return t("TBD");
}
