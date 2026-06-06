import { api } from "./client";

/** Tournament row as returned by `GET /api/tournaments/` and create (201). */
export interface Tournament {
  id: string;
  slug: string;
  name: string;
  status: string;
  organization_slug: string;
  sport_code: string | null;
  time_zone: string;
  created_at: string;
}

export interface TournamentInvitation {
  id: string;
  email: string;
  role: string;
  tournament_id: string;
  status: string;
}

export interface TeamRow {
  id: string;
  name: string;
  short_name: string;
  school: string;
  pool: string;
  status: string;
  player_count: number;
}

export interface MiniTeam {
  id: string;
  name: string;
  short_name: string;
}

export interface MatchRow {
  id: string;
  stage: string;
  group_label: string;
  round_no: number;
  match_no: number;
  status: string;
  home_team: MiniTeam | null;
  away_team: MiniTeam | null;
  home_score: number | null;
  away_score: number | null;
  scheduled_at: string | null;
}

export interface StandingRow {
  team_id: string;
  name: string;
  school: string;
  P: number;
  W: number;
  D: number;
  L: number;
  GF: number;
  GA: number;
  GD: number;
  Pts: number;
}

export interface StandingsGroup {
  group_label: string;
  rows: StandingRow[];
}

export const tournamentsApi = {
  /** Tournaments the user can access (isolation-scoped on the server). */
  list: () => api.get<Tournament[]>("/api/tournaments/"),
  /**
   * Self-serve create. Auto-provisions a hidden personal workspace if the user
   * has none and makes them the tournament admin. `event_id` is a client UUID
   * for idempotency (invariant 3).
   */
  create: (payload: { name: string; sport_code?: string; event_id: string }) =>
    api.post<Tournament>("/api/tournaments/", payload),
  /** Invite anyone by email to this tournament with a tournament role. */
  invite: (
    tournamentId: string,
    payload: { email: string; role: string; event_id: string },
  ) =>
    api.post<TournamentInvitation>(
      `/api/tournaments/${tournamentId}/invitations/`,
      payload,
    ),
  /** Registered teams for a tournament. */
  teams: (id: string) => api.get<TeamRow[]>(`/api/tournaments/${id}/teams/`),
  /** All matches (the generated fixture). */
  matches: (id: string) => api.get<MatchRow[]>(`/api/tournaments/${id}/matches/`),
  /** Standings grouped by pool. */
  standings: (id: string) =>
    api.get<{ groups: StandingsGroup[] }>(`/api/tournaments/${id}/standings/`),
  /** Generate the fixture (manager only): round-robin groups or a knockout bracket. */
  generateFixtures: (
    id: string,
    opts?: {
      groupSize?: number;
      format?: "round_robin" | "knockout" | "knockout_from_groups";
    },
  ) =>
    api.post<{ generated: number; format?: string }>(
      `/api/tournaments/${id}/generate-fixtures/`,
      { group_size: opts?.groupSize ?? 5, format: opts?.format ?? "round_robin" },
    ),
  /** Mint a shareable school-registration link (manager only). */
  createRegistrationLink: (id: string) =>
    api.post<{ token: string; path: string; tournament_id: string }>(
      `/api/tournaments/${id}/registration-link/`,
      { label: "" },
    ),
  /** Record a match result (assigned scorer or manager). */
  score: (
    matchId: string,
    payload: { home_score: number; away_score: number; event_id: string },
  ) => api.post<MatchRow>(`/api/matches/${matchId}/score/`, payload),
};
