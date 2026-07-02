import { api } from "./client";
import type { MatchRow } from "./tournaments";

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
    /** Kickoff stamp — drives the console's running clock. */
    started_at?: string | null;
    home_pens?: number | null;
    away_pens?: number | null;
    /** Set sports: raw sport key, per-set points, resolved scoring rules
     * (home/away_score mirror sets won). */
    sport?: string | null;
    set_scores?: number[][];
    scoring?: {
      type: string;
      best_of?: number;
      points?: number;
      win_by?: number;
      cap?: number | null;
      deciding?: Record<string, unknown> | null;
    } | null;
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
      related_player_id?: string;
      minute?: number;
      event_id: string;
      /** Undo: sequence_no of the event a "void" reverses. */
      voids_seq?: number;
    },
  ) => api.post(`/api/matches/${matchId}/events/`, payload),
  /** Record the penalty-shootout result for a level knockout match, then
   * complete it normally (surfaced when completion 400s with
   * knockout_draw_needs_shootout). */
  scoreShootout: (
    matchId: string,
    payload: { home_pens: number; away_pens: number; event_id: string },
  ) => api.post(`/api/matches/${matchId}/shootout/`, payload),
  /** Record a set-sport final result as ordered per-set scores. */
  recordSetScores: (
    matchId: string,
    payload: { set_scores: number[][]; event_id: string },
  ) => api.post(`/api/matches/${matchId}/score/`, payload),
  /** Full event timeline as a downloadable CSV (same-origin; sends the cookie). */
  exportUrl: (matchId: string) => `/api/matches/${matchId}/events/export/`,
  /** Scorer/manager: move the match through its state machine. `extra` carries
   * the walkover winner (manager-only) or the replay/abandon reason. */
  transition: (
    matchId: string,
    to_status: string,
    extra?: { winner_team_id?: string; reason?: string },
  ) => api.post(`/api/matches/${matchId}/transition/`, { to_status, ...extra }),
  /** Referee/scorer/manager: file an append-only incident report. */
  fileIncident: (
    matchId: string,
    payload: {
      kind: string;
      description: string;
      minute?: number | null;
      player_id?: string | null;
      event_id: string;
    },
  ) => api.post(`/api/matches/${matchId}/incidents/`, payload),
  /** Incident reports for a match (any match viewer). */
  listIncidents: (matchId: string) =>
    api.get<
      {
        id: string;
        kind: string;
        description: string;
        minute: number | null;
        player_id: string | null;
        created_at: string;
        reported_by: string | null;
      }[]
    >(`/api/matches/${matchId}/incidents/`),
  /** Schedule editor: mark a `scheduled` match as called to its venue
   * (control room §2.b — an annotation, not a state; idempotent). */
  callMatch: (matchId: string) =>
    api.post<{ match: MatchRow }>(`/api/matches/${matchId}/call/`),
  /** Schedule editor: clear the call (idempotent). */
  uncallMatch: (matchId: string) =>
    api.delete<{ match: MatchRow }>(`/api/matches/${matchId}/call/`),
  /** Public one-way SSE tick stream for a tournament (invariant 11; AllowAny —
   * frames carry only UUIDs + a tick kind, clients refetch on tick). */
  streamUrl: (slug: string, tournamentId: string) =>
    `/api/public/tournaments/${encodeURIComponent(slug)}/${tournamentId}/stream/`,
};
