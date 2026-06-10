import { api } from "./client";
import type { AuditEvent } from "./audit";

/** Tournament row as returned by `GET /api/tournaments/` and create (201). */
/** Legacy 2-level projection of a sport's category tree (server-derived). */
export interface SportCategory {
  name: string;
  subcategories: string[];
}

/**
 * A node in a sport's category tree (arbitrary depth: U15 → Girls → 5v5).
 * `key` is the server-minted stable identity — ALWAYS round-trip it so
 * renames don't orphan registered teams; omit it only for new nodes.
 */
/** Team-size rules a "format" node carries (1v1 → 1 per side; W2-B). The
 * generated team form turns these into roster row bounds. */
export interface SportNodeFormat {
  players_per_side?: number;
  squad_min?: number;
  squad_max?: number;
}

export type SportNodeKind = "age_group" | "gender" | "format" | "level" | "custom";

/** Structured age rule an "age_group" node carries — operator + numbers,
 * never free text, so rules stay comparable (W2). */
export interface SportNodeAge {
  op: "under" | "over" | "between";
  age?: number;
  min?: number;
  max?: number;
}

export interface SportNode {
  key?: string;
  name: string;
  /** What this category IS (drives team-size logic for "format" nodes). */
  kind?: SportNodeKind;
  format?: SportNodeFormat;
  age?: SportNodeAge;
  children?: SportNode[];
}

/** Per-sport set-scoring override (server profile defaults apply when unset). */
export interface SportScoringConfig {
  type: "sets" | "goals";
  best_of?: number;
  points?: number;
  win_by?: number;
  cap?: number | null;
  deciding?: { points?: number; win_by?: number; cap?: number | null };
}

/** Per-sport scheduling hints the fixture engine reads. */
export interface SportSchedulingConfig {
  duration_minutes?: number;
  venue_type?: string;
}

/** A sport the tournament runs (catalog code or a custom one). */
export interface TournamentSport {
  key: string;
  name: string;
  custom?: boolean;
  /**
   * The category tree (recursive; each LEAF = one competition with its own
   * draw). Canonical — the generated forms, team registration and per-leaf
   * fixtures all key off it.
   */
  nodes?: SportNode[];
  /** Legacy read-only 2-level projection (derived from `nodes` server-side). */
  categories?: SportCategory[];
  scoring?: SportScoringConfig;
  scheduling?: SportSchedulingConfig;
}

/** A sport from the global catalog (GET /api/sports/). */
export interface SportCatalogItem {
  code: string;
  name: string;
  category: string;
  icon: string;
  is_team_sport: boolean;
  status: string;
}

export interface Tournament {
  id: string;
  slug: string;
  name: string;
  status: string;
  organization_slug: string;
  sport_code: string | null;
  sports: TournamentSport[];
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

export interface TeamPlayerRow {
  id: string;
  full_name: string;
  jersey_no: number | null;
  position: string;
  captain: boolean;
}

export interface TeamRow {
  id: string;
  name: string;
  short_name: string;
  school: string;
  institution_id?: string | null;
  institution_name?: string;
  pool: string;
  /** Sport key + category-leaf this team registered into ("" = uncategorized). */
  sport: string;
  leaf_key: string;
  status: string;
  player_count: number;
  /** Inline roster (Teams tab expands a team to show it). */
  players?: TeamPlayerRow[];
}

export interface MiniTeam {
  id: string;
  name: string;
  short_name: string;
}

/** Resolved set-scoring rules served by the backend (sport profile merged
 * with any per-tournament override). null on a match = goal-based. */
export interface SetScoringRules {
  type: "sets";
  best_of: number;
  points: number;
  win_by: number;
  cap: number | null;
  /** Deciding-set overrides (e.g. volleyball 5th set to 15). */
  deciding?: { points?: number; win_by?: number; cap?: number | null };
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
  /** Sport key (e.g. "table_tennis"); "" = goal-based (football). */
  sport: string;
  /** Per-set [home, away] scores for set-based sports (home/away_score = sets won). */
  set_scores: number[][];
  /** Category-leaf this match belongs to ("" = whole-tournament draw). */
  leaf_key: string;
  venue: string;
  /** Server-resolved set rules; null = goal-based. Render entry UIs from this. */
  scoring: SetScoringRules | null;
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
  /** (Re)email team-registration access codes (manager-only). Pass
   *  `institution_ids` to send/resend to specific schools only. */
  issueTeamCodes: (
    id: string,
    opts: { force?: boolean; institution_ids?: string[] } = {},
  ) =>
    api.post<{
      sent: number;
      no_email: number;
      skipped: number;
      no_email_institutions: { id: string; name: string }[];
    }>(`/api/tournaments/${id}/team-codes/`, opts),
  /** All matches (the generated fixture). */
  matches: (id: string) => api.get<MatchRow[]>(`/api/tournaments/${id}/matches/`),
  /** Standings grouped by pool. */
  standings: (id: string) =>
    api.get<{ groups: StandingsGroup[] }>(`/api/tournaments/${id}/standings/`),
  /** Generate a draw (bracket-editor module or manager). `leafKey` scopes the
   * run to ONE competition (category leaf); omit for the whole tournament. */
  generateFixtures: (
    id: string,
    opts?: {
      groupSize?: number;
      format?:
        | "round_robin"
        | "by_category"
        | "knockout"
        | "knockout_from_groups";
      leafKey?: string;
    },
  ) =>
    api.post<{ generated: number; format?: string; leaf_key?: string }>(
      `/api/tournaments/${id}/generate-fixtures/`,
      {
        group_size: opts?.groupSize ?? 5,
        format: opts?.format ?? "round_robin",
        leaf_key: opts?.leafKey ?? "",
      },
    ),
  /** The workspace's venue pool (types + availability windows). */
  venues: (id: string) =>
    api.get<{ venues: VenueRecord[] }>(`/api/tournaments/${id}/venues/`),
  createVenue: (id: string, body: Omit<VenueRecord, "id">) =>
    api.post<VenueRecord>(`/api/tournaments/${id}/venues/`, body),
  updateVenue: (id: string, venueId: string, body: Partial<Omit<VenueRecord, "id">>) =>
    api.patch<VenueRecord>(`/api/tournaments/${id}/venues/${venueId}/`, body),
  deleteVenue: (id: string, venueId: string) =>
    api.delete(`/api/tournaments/${id}/venues/${venueId}/`),
  /** Member x module permission matrix (manager-only). */
  permissionMatrix: (id: string) =>
    api.get<PermissionMatrix>(`/api/tournaments/${id}/permissions/`),
  /** Set one member's per-module override (manager-only; reason >= 20 chars). */
  setPermission: (
    id: string,
    body: { user_id: string; module_code: string; state: "grant" | "deny" | "default"; reason: string },
  ) =>
    api.put<{ user_id: string; effective: string[] }>(
      `/api/tournaments/${id}/permissions/grants/`,
      body,
    ),
  /** Mint a shareable school-registration link (manager only). */
  createRegistrationLink: (id: string) =>
    api.post<{ token: string; path: string; tournament_id: string }>(
      `/api/tournaments/${id}/registration-link/`,
      { label: "" },
    ),
  /** Record a goal-based match result (assigned scorer or manager). */
  score: (
    matchId: string,
    payload: { home_score: number; away_score: number; event_id: string },
  ) => api.post<MatchRow>(`/api/matches/${matchId}/score/`, payload),
  /** Record a set/game-based result (Table Tennis, Sepak Takraw). */
  scoreSets: (
    matchId: string,
    payload: { set_scores: number[][]; event_id: string },
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
  /** The global sports catalog (for the picker). */
  sportsCatalog: () => api.get<SportCatalogItem[]>("/api/sports/"),
  /** This tournament's selected sports. */
  sports: (id: string) =>
    api.get<{ sports: TournamentSport[] }>(`/api/tournaments/${id}/sports/`),
  /** Replace this tournament's selected sports (manager-only). */
  setSports: (id: string, sports: TournamentSport[]) =>
    api.put<{ sports: TournamentSport[] }>(`/api/tournaments/${id}/sports/`, {
      sports,
    }),
  /** Soft-delete a tournament (manager-only; blocked while live). */
  remove: (id: string) => api.delete<void>(`/api/tournaments/${id}/`),
  /** Deactivate (archive) or reactivate a tournament. */
  setActive: (id: string, active: boolean) =>
    api.patch<Tournament>(`/api/tournaments/${id}/`, { active }),

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
  /** Manager rights independent of the freeze gate (drives archive/delete). */
  can_manage: boolean;
}

export interface ConstraintType {
  type: string;
  label: string;
  hard: boolean;
  params_schema: Record<string, string>;
}

/** A stored venue: physical facility with a type + availability windows. */
export interface VenueRecord {
  id: string;
  name: string;
  venue_type: string;
  windows: { from: string; to: string }[];
}

/** Member x module matrix from GET /api/tournaments/{id}/permissions/. */
export interface PermissionMatrix {
  modules: { code: string; name: string; category: string }[];
  members: {
    user_id: string;
    email: string;
    roles: string[];
    effective: string[];
    overrides: Record<string, string>;
  }[];
}

export interface ScheduleRequest {
  date_start: string;
  date_end: string;
  daily_start?: string;
  daily_end?: string;
  slot_minutes?: number;
  /** Plain names or rich records; omit entirely to use the stored venue pool. */
  venues?: (string | { name: string; venue_type?: string; windows?: { from: string; to: string }[] })[];
  rest_minutes?: number;
  max_per_team_per_day?: number;
  excluded_dates?: string[];
  /** Schedule ONE competition around everything else's bookings. */
  leaf_key?: string;
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
  /** The caller's effective module codes — nav/surfaces gate on this. */
  modules: string[];
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
