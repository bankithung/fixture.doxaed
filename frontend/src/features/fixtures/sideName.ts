import type { PreviewSide } from "@/api/tournaments";
import { t } from "@/lib/t";

/** Resolve a previewed side to a display name: real team, typed source
 * pointer ("Winner of p3") or TBD. Shared by the MatchesByDayGrid chips and
 * the preview page's unscheduled list. */
export function sideName(
  side: PreviewSide,
  teamNames: ReadonlyMap<string, string>,
): string {
  if (side.team_id) return teamNames.get(side.team_id) ?? t("TBD");
  const src = side.source;
  if (src?.type === "winner_of" && src.ref) return `${t("Winner of")} ${src.ref}`;
  if (src?.type === "loser_of" && src.ref) return `${t("Loser of")} ${src.ref}`;
  return t("TBD");
}
