import type { LiveLineupSide, LiveTeam } from "@/api/live";
import type { LineupSideView } from "./types";

/** The team-sheet slice a lineup module renders: the confirmed lineup when
 * the snapshot has one, else the visible roster as an unroled list. Shared
 * by the public hub (LiveViewerPage) and the admin console (LineupPanel). */
export function sideView(
  team: LiveTeam | null,
  lineup: LiveLineupSide | undefined,
): LineupSideView | null {
  if (!team) return null;
  if (lineup && lineup.entries.length > 0) {
    return {
      teamName: team.name,
      confirmed: lineup.confirmed,
      entries: lineup.entries,
    };
  }
  if (team.players.length > 0) {
    return {
      teamName: team.name,
      confirmed: false,
      entries: team.players.map((p) => ({
        player_id: p.id,
        name: p.name,
        role: "",
        shirt_no: p.jersey_no,
        positional_role: "",
      })),
    };
  }
  return { teamName: team.name, confirmed: false, entries: [] };
}
