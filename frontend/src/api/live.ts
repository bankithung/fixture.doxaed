import { api } from "./client";

export interface MiniPlayer {
  id: string;
  name: string;
  jersey_no: number | null;
  position: string;
}

export interface LiveTeam {
  id: string;
  name: string;
  short_name: string;
  players: MiniPlayer[];
}

export interface LiveEvent {
  sequence_no: number;
  type: string;
  team_id: string | null;
  player: string | null;
  minute: number | null;
  period: string;
}

export interface LiveSnapshot {
  match: {
    id: string;
    status: string;
    current_period: string;
    home_team: LiveTeam | null;
    away_team: LiveTeam | null;
    home_score: number | null;
    away_score: number | null;
  };
  events: LiveEvent[];
}

export const liveApi = {
  /** Public pollable snapshot of a match (score, rosters, recent events). */
  snapshot: (matchId: string) =>
    api.get<LiveSnapshot>(`/api/live/match/${matchId}/`),
  /** Scorer/manager: append a live event, optionally attributed to a player. */
  recordEvent: (
    matchId: string,
    payload: {
      event_type: string;
      side?: string;
      player_id?: string;
      minute?: number;
      event_id: string;
    },
  ) => api.post(`/api/matches/${matchId}/events/`, payload),
  /** Scorer/manager: move the match through its state machine. */
  transition: (matchId: string, to_status: string) =>
    api.post(`/api/matches/${matchId}/transition/`, { to_status }),
};
