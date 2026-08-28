import { api } from "./client";

export interface TeamMatchRow {
  match_id: string;
  opponent: string;
  /** Signed crest URL of the opponent, "" when they have none. */
  opponent_crest?: string;
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
  /** Signed crest URL, "" when the team has no badge. */
  crest?: string;
  leaf_key: string;
  /** The competition as people say it ("Table Tennis · U-14 · Boys ·
   * Singles"); the raw `leaf_key` when the leaf is no longer configured. */
  leaf_label?: string;
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

export interface SchoolTotals {
  played: number;
  wins: number;
  draws: number;
  losses: number;
  scored: number;
  conceded: number;
  difference: number;
}

export interface SchoolHistorySeason {
  season: string;
  tournaments: {
    tournament_id: string;
    tournament_name: string;
    tournament_slug: string;
    season: string;
    starts_at: string | null;
    status: string;
    totals: SchoolTotals;
    teams: SchoolTeamRow[];
  }[];
}

/** One team of a school in ONE tournament — the row the school page lists,
 * for the current tournament and for any past one alike. */
export interface SchoolTeamRow {
  team_id: string;
  team_name: string;
  /** Signed crest URL, "" when the team has no badge. */
  crest?: string;
  leaf_key: string;
  leaf_label?: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  scored?: number;
  conceded?: number;
  difference?: number;
  form?: ("W" | "D" | "L")[];
}

export interface PublicSchoolRecord {
  institution_id: string;
  institution_name: string;
  /** The school's own badge (signed URL), "" when it has none. */
  crest?: string;
  tournament_id: string;
  tournament_name?: string;
  tournament_slug?: string;
  season?: string;
  totals: SchoolTotals;
  teams: PublicTeamRecord[];
  badges: PublicBadge[];
  history: SchoolHistorySeason[];
}

export const publicRecordsApi = {
  team: (slug: string, tournamentId: string, teamId: string) =>
    api.get<PublicTeamRecord>(
      `/api/public/tournaments/${slug}/${tournamentId}/teams/${teamId}/`,
    ),
  /** A school's rollup for one tournament + its cross-year history. */
  school: (slug: string, tournamentId: string, instId: string) =>
    api.get<PublicSchoolRecord>(
      `/api/public/tournaments/${slug}/${tournamentId}/institutions/${instId}/record/`,
    ),
};
