import { api } from "./client";

export interface TeamMatchRow {
  match_id: string;
  opponent: string;
  home: boolean;
  score: string | null;
  set_scores: number[][];
  result: "W" | "D" | "L";
  status: string;
  stage: string;
  group_label: string;
  scheduled_at: string | null;
  venue: string;
}

export interface PublicBadge {
  id: string;
  badge_key: string;
  name: string;
  evidence: Record<string, unknown>;
}

export interface PublicTeamRecord {
  team_id: string;
  team_name: string;
  leaf_key: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  scored: number;
  conceded: number;
  difference: number;
  form: ("W" | "D" | "L")[];
  matches: TeamMatchRow[];
  institution: { id: string; name: string } | null;
  roster: { player_id: string; name: string; jersey_no: number | null }[];
  badges: PublicBadge[];
}

export const publicRecordsApi = {
  team: (slug: string, tournamentId: string, teamId: string) =>
    api.get<PublicTeamRecord>(
      `/api/public/tournaments/${slug}/${tournamentId}/teams/${teamId}/`,
    ),
};
