import { api } from "./client";

/** `GET /api/me/overview/` — the cross-tournament analytics rollup behind
 * the root dashboard. Mirrors apps/matches/public_views.py::MyOverviewView. */

export interface OverviewTotals {
  tournaments: number;
  tournaments_live: number;
  matches: number;
  matches_completed: number;
  matches_live: number;
  matches_today: number;
  matches_next7: number;
  teams: number;
  players: number;
  institutions: number;
  goals: number;
}

export interface OverviewStatusRow {
  status: string;
  count: number;
}

export interface OverviewSportRow {
  key: string;
  name: string;
  tournaments: number;
  matches: number;
}

export interface OverviewDay {
  date: string; // YYYY-MM-DD in the tournament's own timezone
  completed: number;
  live: number;
  scheduled: number;
}

export interface OverviewProgressRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  total: number;
  completed: number;
  live: number;
  teams: number;
}

export interface OverviewResult {
  match_id: string;
  tournament_id: string;
  tournament_name: string;
  home: string;
  away: string;
  home_score: number | null;
  away_score: number | null;
  sport: string;
  ended_at: string | null;
}

export interface Overview {
  totals: OverviewTotals;
  tournament_status: OverviewStatusRow[];
  sports: OverviewSportRow[];
  matches_per_day: OverviewDay[];
  progress: OverviewProgressRow[];
  recent_results: OverviewResult[];
}

export const overviewApi = {
  get: (): Promise<Overview> => api.get<Overview>("/api/me/overview/"),
};
