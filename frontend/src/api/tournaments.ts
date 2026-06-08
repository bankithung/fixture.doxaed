import { api } from "./client";
import type { AuditEvent } from "./audit";

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

/**
 * Tournament roster row from `GET /api/tournaments/{id}/members/`
 * (see `TournamentMembershipSerializer`). `id` is the membership row PK that
 * the PATCH route addresses; `role`/`status` are the 6-role + 3-status enums.
 */
export interface TournamentMember {
  /** Membership row id (UUID) — the PATCH route uses this. */
  id: string;
  user_id: string;
  email: string;
  full_name: string;
  /** One of the 6 tournament roles. */
  role: string;
  /** `active` | `suspended` | `revoked`. */
  status: string;
  assigned_at: string;
}

/** PATCH body for member management — both fields optional. */
export interface TournamentMemberUpdate {
  role?: string;
  status?: string;
}

/** Tournament-scoped audit feed shape: `{ results: AuditEvent[] }`. */
export interface TournamentAuditResponse {
  results: AuditEvent[];
}

export interface TeamRow {
  id: string;
  name: string;
  short_name: string;
  school: string;
  institution_id?: string | null;
  institution_name?: string;
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
   * Resolve a single accessible tournament by id. There's no dedicated
   * retrieve endpoint yet, so we derive it from the (already isolation-scoped)
   * list — TanStack caches it, and the row carries everything the nav header
   * needs (name). Returns `null` if the id isn't accessible.
   */
  get: async (id: string): Promise<Tournament | null> => {
    const all = await api.get<Tournament[]>("/api/tournaments/");
    return all.find((tt) => tt.id === id) ?? null;
  },
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
  /** Tournament roster (manager-gated on the server; 404 on no-access). */
  members: (id: string) =>
    api.get<TournamentMember[]>(`/api/tournaments/${id}/members/`),
  /**
   * Change a member's role and/or status (manager-only). `status:"revoked"`
   * removes them. Backend guards the last admin → 400 `{detail:"last_admin"}`.
   */
  updateMember: (
    id: string,
    membershipId: string,
    body: TournamentMemberUpdate,
  ) =>
    api.patch<TournamentMember>(
      `/api/tournaments/${id}/members/${membershipId}/`,
      body,
    ),
  /** Tournament-scoped audit feed (manager-only; 403 otherwise). Newest first. */
  audit: (id: string) =>
    api.get<TournamentAuditResponse>(`/api/tournaments/${id}/audit/`),
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

  // --- Setup-stage workflow (WS4) ---
  stage: (id: string) => api.get<StagePayload>(`/api/tournaments/${id}/stage/`),
  previewStage: (id: string, toStage: string) =>
    api.post<StageConsequences>(`/api/tournaments/${id}/stage/preview/`, {
      to_stage: toStage,
    }),
  transitionStage: (
    id: string,
    body: { to_stage: string; ack_warnings?: boolean; reason?: string; event_id: string },
  ) => api.post<StagePayload>(`/api/tournaments/${id}/stage/`, body),

  // --- Rules & settings ---
  settings: (id: string) =>
    api.get<TournamentSettings>(`/api/tournaments/${id}/settings/`),
  updateSettings: (
    id: string,
    body: { rules?: Partial<TournamentRules>; amend?: boolean; reason?: string; event_id: string },
  ) => api.patch<TournamentSettings>(`/api/tournaments/${id}/settings/`, body),

  // --- Fixture generation + FET scheduling engine (WS6) ---
  constraintTypes: () =>
    api.get<ConstraintType[]>(`/api/tournaments/constraint-types/`),
  scheduleFixtures: (id: string, config: ScheduleRequest) =>
    api.post<ScheduleResultDTO>(`/api/tournaments/${id}/schedule/`, config),
};

export interface TournamentRules {
  format: string;
  group_size: number;
  advance_per_group: number;
  points: { win: number; draw: number; loss: number };
  tiebreakers: string[];
  match: { halves: number; half_minutes: number; extra_time: boolean; penalties: boolean };
  squad: { min_players: number; max_players: number; max_subs: number };
  discipline: { yellow_suspension_threshold: number; red_matches_banned: number };
}

export interface TournamentSettings {
  rules: TournamentRules;
  constraints: unknown[];
  rules_frozen_at: string | null;
  can_edit: boolean;
}

export interface ConstraintType {
  type: string;
  label: string;
  hard: boolean;
  params_schema: Record<string, string>;
}

export interface ScheduleRequest {
  date_start: string;
  date_end: string;
  daily_start?: string;
  daily_end?: string;
  slot_minutes?: number;
  venues?: string[];
  rest_minutes?: number;
  max_per_team_per_day?: number;
  excluded_dates?: string[];
}

export interface ScheduleResultDTO {
  scheduled: number;
  unscheduled: string[];
  soft_score: number;
  explanation: string[];
}

/** One step in the setup stepper (server-computed; FE renders, never hardcodes). */
export interface StageInfo {
  key: string;
  label: string;
  state: "complete" | "current" | "upcoming";
  entered_at: string | null;
  reopened_count: number;
  form: { id: string; status: string; title: string } | null;
  counts: Record<string, number>;
}

export interface StagePayload {
  stage: string;
  status: string;
  order: string[];
  allowed_to: string[];
  can_manage: boolean;
  rules_frozen_at: string | null;
  stages: StageInfo[];
}

export interface StageWarning {
  code: string;
  [k: string]: unknown;
}

export interface StageConsequences {
  from_stage: string;
  to_stage: string;
  allowed: boolean;
  blockers: string[];
  warnings: StageWarning[];
  lifecycle_effect?: { status_from: string; status_to: string } | null;
  summary_counts?: Record<string, number>;
  irreversible?: boolean;
}
