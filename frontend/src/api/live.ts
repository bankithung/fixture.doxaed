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
  /** Secondary attribution (assist on a goal, player replaced on a sub). */
  related_player?: string | null;
  minute: number | null;
  period: string;
}

/** One team's confirmed team sheet in the public snapshot (P6 hub). */
export interface LiveLineupEntry {
  player_id: string;
  name: string;
  /** "starter" | "substitute". */
  role: string;
  shirt_no: number | null;
  /** Sport slot, e.g. sepak takraw "tekong" | "left_inside" | "right_inside". */
  positional_role: string;
}

export interface LiveLineupSide {
  confirmed: boolean;
  entries: LiveLineupEntry[];
}

/** Per-team event-type counts for the hub's Stats tab. */
export interface LiveStatRow {
  type: string;
  home: number;
  away: number;
}

/** A prior completed meeting of the two teams (same tournament). */
export interface LiveH2HRow {
  id: string;
  status: string;
  scheduled_at: string | null;
  home_team_id: string;
  away_team_id: string;
  home_score: number | null;
  away_score: number | null;
  set_scores: number[][] | null;
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
    /** The SportDefinition slice a console needs to render sport-natively:
     * family picks the console module, terms carry per-sport vocabulary. */
    sport_meta?: {
      key: string;
      name: string;
      family: "timed" | "target";
      terms: Record<string, string>;
      version: number;
    };
    set_scores?: number[][];
    scoring?: {
      type: string;
      best_of?: number;
      points?: number;
      win_by?: number;
      cap?: number | null;
      deciding?: Record<string, unknown> | null;
      /** Serve rotation + change-ends triggers (set sports, P2 consoles). */
      serve?: {
        serves_per_turn?: number;
        alternate_every_point?: boolean;
        change_ends_at?: { regular?: number; deciding?: number } | null;
      } | null;
    } | null;
    /** P6 hub: schedule context + competition labels. */
    scheduled_at?: string | null;
    venue?: string;
    leaf_key?: string;
    group_label?: string;
    /** Confirmed team sheets (only once live/final and a lineup was built). */
    lineups?: { home?: LiveLineupSide; away?: LiveLineupSide } | null;
  };
  /** Back-nav target + wall-clock TZ for kickoff rendering. */
  tournament?: {
    id: string;
    slug: string;
    name: string;
    time_zone: string;
  };
  stats?: LiveStatRow[];
  h2h?: LiveH2HRow[];
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
      /** Annotation context (e.g. rally reason + scoring side). */
      detail?: Record<string, unknown>;
    },
  ) => api.post(`/api/matches/${matchId}/events/`, payload),
  /** Record the penalty-shootout result for a level knockout match, then
   * complete it normally (surfaced when completion 400s with
   * knockout_draw_needs_shootout). */
  scoreShootout: (
    matchId: string,
    payload: { home_pens: number; away_pens: number; event_id: string },
  ) => api.post(`/api/matches/${matchId}/shootout/`, payload),
  /** Manager-only, audited correction of a COMPLETED set-sport result;
   * requires a reason and re-fires bracket advancement (H3). */
  amendSetResult: (
    matchId: string,
    payload: { set_scores: number[][]; reason: string; event_id: string },
  ) => api.post(`/api/matches/${matchId}/amend/`, payload),
  /** Record a set-sport final result as ordered per-set scores. */
  recordSetScores: (
    matchId: string,
    payload: { set_scores: number[][]; event_id: string },
  ) => api.post(`/api/matches/${matchId}/score/`, payload),
  /** Live tap scoring: push the running per-set points of a LIVE set-sport
   * match (ties and in-progress sets legal) without completing it. */
  recordSetProgress: (
    matchId: string,
    payload: { set_scores: number[][]; event_id: string },
  ) => api.post(`/api/matches/${matchId}/score/`, { ...payload, progress: true }),
  /** Full event timeline as a downloadable CSV (same-origin; sends the cookie). */
  exportUrl: (matchId: string) => `/api/matches/${matchId}/events/export/`,
  /** Scorer/manager: move the match through its state machine. `extra` carries
   * the walkover winner (manager-only) or the replay/abandon reason. */
  transition: (
    matchId: string,
    to_status: string,
    extra?: { winner_team_id?: string; reason?: string },
  ) => api.post(`/api/matches/${matchId}/transition/`, { to_status, ...extra }),
  /** Both teams' declared lineups (starters/bench, confirmation state). */
  getLineups: (matchId: string) =>
    api.get<{
      lineups: {
        id: string;
        team: { id: string; name: string } | null;
        entries: {
          player_id: string;
          player_name: string;
          role: string;
          shirt_no: number | null;
        }[];
        confirmed_at: string | null;
        confirmed_by: string | null;
      }[];
    }>(`/api/matches/${matchId}/lineups/`),
  /** Replace one team's lineup (frozen once the match starts). */
  setLineup: (
    matchId: string,
    payload: {
      team_id: string;
      entries: { player_id: string; role: string; shirt_no?: number | null }[];
      event_id: string;
    },
  ) => api.post(`/api/matches/${matchId}/lineups/`, payload),
  /** Confirm a declared lineup (locks it as the official team sheet). */
  confirmLineup: (matchId: string, payload: { team_id: string; event_id: string }) =>
    api.post(`/api/matches/${matchId}/lineups/confirm/`, payload),
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
