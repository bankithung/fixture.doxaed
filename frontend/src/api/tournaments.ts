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
  /** How the current user relates to this tournament. Only the list endpoint
   * fills these in; other endpoints return null/[]. */
  origin?: "owner" | "invited" | null;
  my_roles?: string[];
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
  /** Current seed (nullable) — the SeedListEditor prefills from this. */
  seed?: number | null;
  player_count: number;
  /** Inline roster (Teams tab expands a team to show it). */
  players?: TeamPlayerRow[];
}

/** A stored upload's display metadata (filename, signed view URL, MIME). */
export interface UploadRef {
  name: string;
  /** The respondent's document name ("Aadhaar card"); "" when unnamed. */
  label?: string;
  url: string;
  content_type: string;
}

/** Rich roster detail read back from a team's originating submission: logo,
 * coaches (+ docs), and each player's full DOB + uploaded documents merged with
 * the domain roster (jersey/captain). Served by the registration-detail endpoint. */
export interface TeamRegistrationDetail {
  team_id: string;
  logo: UploadRef | null;
  coaches: { name: string; documents: UploadRef[] }[];
  players: {
    id: string;
    name: string;
    jersey_no: number | null;
    position: string;
    captain: boolean;
    dob: string | null;
    documents: UploadRef[];
  }[];
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
  /** Slot pinned by a schedule editor — repair verbs and scheduler re-runs
   * never move a locked match. */
  locked_at?: string | null;
  /** Penalty-shootout result (null = no shootout). */
  home_pens?: number | null;
  away_pens?: number | null;
  /** In-play period ("first_half", …); "" outside play. */
  current_period?: string;
  /** "Called to the venue" annotation of `scheduled` (control room §2.b) —
   * presentation-only, NOT a lifecycle state. */
  called_at?: string | null;
}

// --- Control room day-view aggregate (control room spec §2.a) ---

/** One day chip of the control room (tournament-TZ date + progress counts). */
export interface ControlRoomDay {
  date: string;
  counts: { total: number; completed: number; live: number };
}

/** An official assigned to a match (referee/assistant/fourth/umpire). */
export interface MatchOfficialRow {
  id: string;
  user_id: string;
  name: string;
  /** referee | assistant | fourth | umpire | commissioner */
  role: string;
  /** assigned | accepted | declined */
  status: string;
}

/** A MatchSerializer row enriched for the cockpit. */
export interface ControlRoomMatch extends MatchRow {
  /** Human label of the competition leaf ("" = whole-tournament draw). */
  leaf_label: string;
  /** Assigned scorer, if any. */
  scorer: { id: string; name: string } | null;
  /** Assigned officials (referees/assistants/etc.). */
  officials: MatchOfficialRow[];
}

export interface ControlRoomVenue {
  /** Raw venue string ("" = unassigned). */
  venue: string;
  /** The venue's matches for the day, kick-off order. */
  matches: ControlRoomMatch[];
}

export interface ControlRoomPayload {
  tournament: {
    id: string;
    name: string;
    slug: string;
    status: string;
    time_zone: string;
  };
  days: ControlRoomDay[];
  /** The selected (or server-defaulted) day; null = nothing scheduled. */
  day: string | null;
  venues: ControlRoomVenue[];
  /** Cross-venue "up next": unfinished matches of the day, time order. */
  queue: ControlRoomMatch[];
}

/** One raw scheduler violation from the repair endpoints (`validate_schedule`
 * shape — stable codes the FE localizes, §9 A5; distinct from the preview's
 * `PreviewViolation`). */
export interface RepairViolation {
  code: string;
  hard: boolean;
  match_id?: string;
  other_match_id?: string | null;
  team_id?: string;
  linked_team_id?: string;
  venue?: string;
  at?: string;
  date?: string;
  [k: string]: unknown;
}

/** One slot move in a delay-cascade / shift-day result (`moved` list). */
export interface MovedSlot {
  match_id: string;
  /** Old/new scheduled_at ISO strings (venue unchanged by both verbs). */
  old: string;
  new: string;
  venue: string;
}

/** One side of a public-schedule match (no PII beyond team/school names). */
export interface PublicScheduleSide {
  id: string;
  name: string;
  short_name: string;
  school: string;
}

/** One match of the public read-only schedule (trust layer, increment H). */
export interface PublicScheduleMatch {
  id: string;
  leaf_key: string;
  leaf_label: string;
  stage: string;
  group_label: string;
  round_no: number;
  match_no: number;
  status: string;
  /** Tournament-local date the match falls on; null = unscheduled. */
  day: string | null;
  scheduled_at: string | null;
  venue: string;
  home: PublicScheduleSide | null;
  away: PublicScheduleSide | null;
  home_score: number | null;
  away_score: number | null;
  /** Live match points (control room spec §2.d): shootout result, sport +
   * per-set scores (home/away_score = sets won for set sports) and the
   * running period for the live pill. */
  home_pens: number | null;
  away_pens: number | null;
  /** Sport key (e.g. "table_tennis"); "" = goal-based (football). */
  sport: string;
  set_scores: number[][];
  current_period: string;
}

export interface PublicSchedulePayload {
  tournament: {
    id: string;
    slug: string;
    name: string;
    status: string;
    time_zone: string;
  };
  matches: PublicScheduleMatch[];
}

/** A slot in the schedule-change feed (null on lock/unlock entries). */
export interface ScheduleChangeSlot {
  scheduled_at: string | null;
  venue: string | null;
}

/** One entry of the unified slot-change feed (trust layer, increment F) —
 * flattened from the repair/scheduler audit rows, reverse-chrono. */
export interface ScheduleChangeEntry {
  match_id: string;
  match_label: string;
  leaf_key: string;
  changed_at: string;
  actor: { id: string; email: string } | null;
  kind:
    | "rescheduled"
    | "delayed"
    | "swapped"
    | "day_shifted"
    | "engine_rerun"
    | "locked"
    | "unlocked"
    | string;
  old: ScheduleChangeSlot | null;
  new: ScheduleChangeSlot | null;
  reason: string;
  batch_id: string;
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
  /** All matches (the generated fixture). The server enriches each row with the
   * competition leaf label + assigned scorer/officials (the operations Matches
   * board reads those via `matchesEnriched`); plain consumers (bracket,
   * standings) keep the lean `MatchRow` view. */
  matches: (id: string) => api.get<MatchRow[]>(`/api/tournaments/${id}/matches/`),
  /** Same endpoint as `matches`, typed as the enriched control-room row
   * (leaf_label + scorer + officials are always present in the response). */
  matchesEnriched: (id: string) =>
    api.get<ControlRoomMatch[]>(`/api/tournaments/${id}/matches/`),
  /** Standings grouped by pool. */
  standings: (id: string) =>
    api.get<{ groups: StandingsGroup[] }>(`/api/tournaments/${id}/standings/`),
  /** Generate a draw (bracket-editor module or manager). `leafKey` scopes the
   * run to ONE competition (category leaf); omit for the whole tournament.
   * Omitted keys are NOT sent — the stored draw-config layers govern them
   * (redesign §4.5: a bare `{leaf_key}` body works once the wizard saved the
   * format); explicit params always win on the server. */
  generateFixtures: (
    id: string,
    opts?: {
      groupSize?: number;
      /** Groups→knockout: how many advance from each group. */
      advancePerGroup?: number;
      format?:
        | "round_robin"
        | "by_category"
        | "knockout"
        | "knockout_from_groups"
        | "swiss"
        | "double_elim";
      leafKey?: string;
      /** Replay the previewed draw exactly (§5.2 — Accept carries the seed). */
      seed?: number;
      /** Optimistic-concurrency guard (§9 A1/D10): the preview's
       * `inputs_hash`; the server answers 409 `inputs_changed` on drift. */
      expectedInputsHash?: string;
    },
  ) => {
    const body: Record<string, unknown> = { leaf_key: opts?.leafKey ?? "" };
    if (opts?.format !== undefined) body.format = opts.format;
    if (opts?.groupSize !== undefined) body.group_size = opts.groupSize;
    if (opts?.advancePerGroup !== undefined) {
      body.advance_per_group = opts.advancePerGroup;
    }
    if (opts?.seed !== undefined) body.seed = opts.seed;
    if (opts?.expectedInputsHash !== undefined) {
      body.expected_inputs_hash = opts.expectedInputsHash;
    }
    return api.post<{
      generated: number;
      format?: string;
      leaf_key?: string;
      /** The RNG seed the draw used (replayable — §4.3). */
      seed?: number | null;
      /** Pairing-layer warnings (relaxed keep-apart records, …). */
      warnings?: unknown[];
    }>(`/api/tournaments/${id}/generate-fixtures/`, body);
  },
  /** Bulk seed assignment for one competition (redesign §4.3 — drives the
   * `seeding: "seeded"` method). `seed: null` clears a team's seed. */
  setTeamSeeds: (
    id: string,
    body: {
      leaf_key?: string;
      seeds: { team_id: string; seed: number | null }[];
      event_id: string;
    },
  ) =>
    api.put<{ updated: number; leaf_key: string }>(
      `/api/tournaments/${id}/teams/seeds/`,
      body,
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
  /** Assign an official (referee/assistant/etc.) to a match. Returns the full
   * officials list + a soft double-booking warning when the person clashes. */
  assignOfficial: (
    matchId: string,
    payload: { user_id: string; role: string; event_id: string },
  ) =>
    api.post<{
      officials: MatchOfficialRow[];
      warning: { code: string; count: number } | null;
    }>(`/api/matches/${matchId}/officials/`, payload),
  /** Remove an assigned official from a match. */
  removeOfficial: (matchId: string, officialId: string) =>
    api.delete<{ officials: MatchOfficialRow[] }>(
      `/api/matches/${matchId}/officials/`,
      { body: { official_id: officialId } },
    ),
  /** Assign (or change) the scorer seat on a match (manager only). */
  assignScorer: (matchId: string, userId: string) =>
    api.post<MatchRow>(`/api/matches/${matchId}/scorer/`, { user_id: userId }),

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
    body: {
      rules?: Partial<TournamentRules>;
      constraints?: ConstraintDraft[];
      amend?: boolean;
      reason?: string;
      event_id: string;
    },
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
  /** Rename a tournament (display name only — the slug/public URL stays
   * stable). Manager-allowed; the server enforces the permission. */
  rename: (id: string, name: string) =>
    api.patch<Tournament>(`/api/tournaments/${id}/`, { name }),

  // --- Fixture generation + FET scheduling engine (WS6) ---
  constraintTypes: () =>
    api.get<ConstraintType[]>(`/api/tournaments/constraint-types/`),
  scheduleFixtures: (id: string, config: ScheduleRequest) =>
    api.post<ScheduleResultDTO>(`/api/tournaments/${id}/schedule/`, config),

  // --- Fixture-engine redesign (spec 2026-06-11) ---
  /** Per-competition draw configuration (stored layers + canonical defaults). */
  drawConfig: (id: string) =>
    api.get<DrawConfigResponse>(`/api/tournaments/${id}/draw-config/`),
  /** Whitelist-merge one layer (`leaf_key` or `"*"`); idempotent + audited. */
  updateDrawConfig: (
    id: string,
    body: { leaf_key?: string; config: DrawConfigLayer; event_id: string },
  ) =>
    api.patch<{
      leaf_key: string;
      draw_config: Record<string, DrawConfigLayer>;
      effective: DrawConfig;
      /** A draw already exists in scope — show the invariant-10 banner. */
      has_matches: boolean;
    }>(`/api/tournaments/${id}/draw-config/`, body),
  /** Server-computed readiness checklist (§5.1) — the FE never replicates it. */
  fixtureReadiness: (id: string) =>
    api.get<FixtureReadiness>(`/api/tournaments/${id}/fixture-readiness/`),
  // --- Match-day repair seam (spec §7) ---
  /** Move ONE match (time and/or venue). Naive `scheduled_at` is tournament-
   * local wall clock (invariant 14). Hard conflicts → 409 `schedule_conflicts`
   * with the structured violations unless `force`. Idempotent on `event_id`. */
  rescheduleMatch: (
    matchId: string,
    body: {
      scheduled_at?: string;
      venue?: string;
      force?: boolean;
      event_id: string;
    },
  ) =>
    api.patch<{ match: MatchRow; violations: RepairViolation[] }>(
      `/api/matches/${matchId}/schedule/`,
      body,
    ),
  /** Delay a match by +minutes; `cascade` (default true) pushes later
   * same-venue movable matches just enough. 409 semantics like reschedule. */
  delayMatch: (
    matchId: string,
    body: {
      minutes: number;
      cascade?: boolean;
      force?: boolean;
      event_id: string;
    },
  ) =>
    api.post<{ moved: MovedSlot[]; violations: RepairViolation[] }>(
      `/api/matches/${matchId}/delay/`,
      body,
    ),
  /** Pin a match's slot — scheduler re-runs and cascades route around it. */
  lockMatch: (matchId: string) =>
    api.post<{ match: MatchRow }>(`/api/matches/${matchId}/lock/`),
  /** Release a pinned slot. */
  unlockMatch: (matchId: string) =>
    api.delete<{ match: MatchRow }>(`/api/matches/${matchId}/lock/`),
  /** Rain-day shift: move every movable match on `from_date` to `to_date`
   * keeping time-of-day + venue. `to_date` omitted ⇒ the first stored
   * reserve day (400 `reserve_day_unavailable` when none). 409 semantics
   * like the other repair verbs. */
  shiftDay: (
    id: string,
    body: {
      from_date: string;
      to_date?: string;
      leaf_key?: string;
      force?: boolean;
      event_id: string;
    },
  ) =>
    api.post<{
      moved: MovedSlot[];
      violations: RepairViolation[];
      to_date: string;
    }>(`/api/tournaments/${id}/fixtures/shift-day/`, body),
  /** Public read-only schedule (AllowAny; (slug, UUID) pair — invariant 1). */
  publicSchedule: (slug: string, id: string) =>
    api.get<PublicSchedulePayload>(
      `/api/public/tournaments/${encodeURIComponent(slug)}/${id}/schedule/`,
    ),
  /** Public read-only standings (AllowAny; same slug+UUID gating as the
   * public schedule — control room spec §2.d). */
  publicStandings: (slug: string, id: string) =>
    api.get<{ groups: StandingsGroup[] }>(
      `/api/public/tournaments/${encodeURIComponent(slug)}/${id}/standings/`,
    ),
  /** Control-room day aggregate: lanes by venue + day chips + up-next queue
   * (any tournament member; spec §2.a). Omit `day` for the server default
   * (today when it has matches, else the next day with matches). */
  controlRoom: (id: string, day?: string) =>
    api.get<ControlRoomPayload>(
      `/api/tournaments/${id}/control-room/${
        day ? `?day=${encodeURIComponent(day)}` : ""
      }`,
    ),
  /** Mint a signed per-team iCal URL (manager or the team's institution
   * contact). The returned `url` is the shareable calendar feed. */
  teamCalendarLink: (id: string, teamId: string) =>
    api.post<{ token: string; url: string }>(
      `/api/tournaments/${id}/teams/${teamId}/calendar-link/`,
    ),
  /** Rich roster detail (logo, coaches, per-player DOB + documents) for one
   * team — manager-only; lazily fetched when a team is expanded. */
  teamRegistrationDetail: (id: string, teamId: string) =>
    api.get<TeamRegistrationDetail>(
      `/api/tournaments/${id}/teams/${teamId}/registration/`,
    ),
  /** Unified reverse-chrono slot-change feed (any tournament member). */
  scheduleChanges: (
    id: string,
    opts: { since?: string; leafKey?: string; limit?: number } = {},
  ) => {
    const q = new URLSearchParams();
    if (opts.since) q.set("since", opts.since);
    if (opts.leafKey) q.set("leaf_key", opts.leafKey);
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return api.get<{ results: ScheduleChangeEntry[] }>(
      `/api/tournaments/${id}/schedule-changes/${qs ? `?${qs}` : ""}`,
    );
  },
  /** Exchange scheduled_at+venue between two movable matches. */
  swapSlots: (
    id: string,
    body: {
      match_a: string;
      match_b: string;
      force?: boolean;
      event_id: string;
    },
  ) =>
    api.post<{
      match_a: MatchRow | null;
      match_b: MatchRow | null;
      violations: RepairViolation[];
    }>(`/api/tournaments/${id}/fixtures/swap-slots/`, body),

  /** Materialize the NEXT Swiss round from current standings (increment P).
   * Idempotent per round on `event_id`. 400 stable codes: `round_incomplete`
   * (current round unfinished), `swiss_not_started`, `swiss_complete`. */
  swissNextRound: (id: string, body: { leaf_key?: string; event_id: string }) =>
    api.post<SwissNextRoundResult>(
      `/api/tournaments/${id}/fixtures/next-round/`,
      body,
    ),

  /** Dry-run preview (§5.2, D6): a PURE simulate — persists nothing, takes
   * no event_id. Accept replays the returned `seed` + `inputs_hash`. */
  previewFixtures: (
    id: string,
    body: {
      leaf_key?: string;
      /** DrawConfig overrides for this run only (never persisted). */
      draw?: DrawConfigLayer;
      /** ScheduleConfig overrides; omit to use the stored config. */
      schedule?: Partial<ScheduleRequest>;
      include_schedule?: boolean;
    },
  ) =>
    api.post<FixturePreview>(`/api/tournaments/${id}/fixtures/preview/`, body),

  /** ONE combined dry-run across every competition (all sports + categories),
   * scheduled together — the master "see everything before publishing" view. */
  previewAllFixtures: (
    id: string,
    body: { schedule?: Partial<ScheduleRequest>; include_schedule?: boolean },
  ) =>
    api.post<FixturePreview & { competitions: number }>(
      `/api/tournaments/${id}/fixtures/preview-all/`,
      body,
    ),

  /** Generate every competition's draw (existing draws kept) + schedule them
   * all together, atomically — the "publish the whole tournament" action. */
  publishAllFixtures: (
    id: string,
    body: { schedule?: Partial<ScheduleRequest> },
  ) =>
    api.post<{
      competitions: number;
      scheduled: number;
      unscheduled: string[];
      warnings: unknown[];
    }>(`/api/tournaments/${id}/fixtures/publish-all/`, body),
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

/** A stored scheduling-constraint record (`{type, scope, hard, weight, params}`,
 * redesign §2.2). The server normalizes scope/weight on write. */
export interface ConstraintRecord {
  type: string;
  /** `"all" | "sport:<id>" | "leaf:<key>" | "team:<id>" | "tag:<k>=<v>"`. */
  scope: string;
  hard: boolean;
  /** Soft-constraint multiplier 1–10 (hard records ignore it). */
  weight: number;
  params: Record<string, unknown>;
}

/** Write shape — the server fills scope/hard/weight defaults from the catalog. */
export type ConstraintDraft = Partial<ConstraintRecord> & {
  type: string;
  params: Record<string, unknown>;
};

export interface TournamentSettings {
  rules: TournamentRules;
  constraints: ConstraintRecord[];
  rules_frozen_at: string | null;
  can_edit: boolean;
  /** Manager rights independent of the freeze gate. */
  can_manage: boolean;
  /** Organizer-only (creator / workspace admin): drives the danger zone —
   * invited managers can manage but never delete/deactivate. */
  can_delete: boolean;
  /** Stored scheduling preferences from the last engine run (slot length,
   * rests, auto_reflow, …) — lets the Schedule wizard pre-seed its controls. */
  scheduling_config?: Record<string, unknown> | null;
}

export interface ConstraintType {
  type: string;
  label: string;
  /** Default enforcement (records may toggle hard/soft individually). */
  hard: boolean;
  /** Param key → kind ("int" | "time" | "date" | "list" | "str") — drives
   * the ConstraintRow field renderer (redesign §3). */
  params_schema: Record<string, string>;
  /** Scope kinds this type meaningfully accepts ("all"|"sport"|"leaf"|"team"|"tag"). */
  scopes: string[];
  /** "S" = slot-time (scheduler), "P" = pairing-time (generator). */
  layer: string;
}

/** A stored venue: physical facility with a type + availability windows. */
export interface VenueRecord {
  id: string;
  name: string;
  venue_type: string;
  windows: { from: string; to: string }[];
  /** Parallel courts/tables/pitches at this venue (redesign §2.3). */
  count: number;
  /** Per-venue off-days (ISO dates) the grid and repairs honor (increment S). */
  unavailable_dates?: string[];
  /** Sport keys allowed on this venue (owner ask 2026-06-25); empty = any
   * sport. The scheduler keeps a sport's matches on its own courts. */
  sports?: string[];
}

/** `POST …/fixtures/next-round/` response (Swiss, increment P). */
export interface SwissNextRoundResult {
  generated: number;
  round_no: number | null;
  leaf_key: string;
  /** Created match ids. */
  matches: string[];
  warnings: unknown[];
}

// --- Fixture-engine redesign types (spec 2026-06-11) ---

/** Global-setup wizard calendar, stored on `draw_config["*"].calendar`
 * (slot-time data — excluded from the draw inputs_hash). */
export interface DrawCalendar {
  date_start?: string | null;
  date_end?: string | null;
  daily_start?: string | null;
  daily_end?: string | null;
  slot_minutes?: number | null;
}

/** Effective per-competition draw configuration (generation inputs, §2.1). */
export interface DrawConfig {
  format:
    | "round_robin"
    | "knockout"
    | "groups_knockout"
    | "swiss"
    | "double_elim"
    | string;
  group_size: number;
  /** R3 FIFA-style auto group-sizing: treat group_size as the TARGET and derive
   * ceil(n/target) even-sized groups (no orphan group). */
  balance_groups?: boolean;
  advance_per_group: number;
  /** Best next-placed cross-group qualifiers (groups→knockout, increment N). */
  advance_best_thirds: number;
  /** 1 | 2 (double round-robin). */
  legs: number;
  /** format="swiss": round count; null = auto (ceil(log2 n), capped n-1). */
  swiss_rounds: number | null;
  seeding: "registration" | "random" | "snake" | "seeded" | string;
  /** Groups→knockout bracket pool order: cross-group (A1 vs B2) or overall
   * record (increment O). */
  knockout_seeding: "cross" | "overall" | string;
  /** RNG seed persisted on the first random draw (replayable). */
  seed: number | null;
  third_place: boolean;
  /** Consolation plate over round-1 losers (knockout family, increment M). */
  plate: boolean;
  bye_policy: string;
  min_entries_action: string;
  /** ISO timestamp of "Mark reviewed" (§9 A10). */
  constraints_reviewed_at: string | null;
  calendar?: DrawCalendar | null;
}

/** One stored layer is SPARSE — only the keys the organizer set. */
export type DrawConfigLayer = Partial<DrawConfig>;

export interface DrawConfigResponse {
  /** Keyed by leaf key, with `"*"` = tournament-wide defaults layer. */
  draw_config: Record<string, DrawConfigLayer>;
  defaults: DrawConfig;
}

export type ReadinessStatus = "ok" | "warn" | "fail";

/** One server-computed readiness check (§5.1). `fix` is a deep-link key the
 * hub turns into an action (settings/venues/constraints/teams/format/seeds/diff). */
export interface ReadinessCheck {
  id: string;
  status: ReadinessStatus;
  hint?: string;
  fix?: string;
}

export interface ReadinessCompetition {
  leaf_key: string;
  label: string;
  /** No hard-fail checks — the dry-run/generate CTA may run. */
  ready: boolean;
  /** "3/5" — ok count over the gating checks. */
  summary: string;
  checks: ReadinessCheck[];
}

export interface FixtureReadiness {
  global: { checks: ReadinessCheck[] };
  competitions: ReadinessCompetition[];
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
  /** Auto-adjust later same-court match times when a match runs early/late
   * (R11 elastic re-timing). Stored on scheduling_config. */
  auto_reflow?: boolean;
  /** Run the optimization pass (R12): search for a better-soft-scored
   * arrangement than the greedy seed, adopted only when hard-legal and no
   * worse. Off = the fast greedy schedule. */
  optimize?: boolean;
  /** Optimizer engine: "local" (fast hill-climb) or "cpsat" (OR-Tools, slower
   * but explores more globally). Falls back to local if OR-Tools is absent. */
  optimize_engine?: "local" | "cpsat";
  /** Optional wall-clock budget (seconds) for the optimizer search. */
  optimize_seconds?: number;
  /** Schedule ONE competition around everything else's bookings. */
  leaf_key?: string;
  /** Optimistic-concurrency guard (§9 A1/D10): the preview's `inputs_hash`;
   * the server answers 409 `inputs_changed` when the inputs drifted. */
  expected_inputs_hash?: string;
}

export interface ScheduleResultDTO {
  scheduled: number;
  unscheduled: string[];
  soft_score: number;
  explanation: string[];
  /** Structured hard-constraint failures (§3 infeasibility contract). */
  violations?: PreviewViolation[];
}

// --- Dry-run preview (§5.2) ---

/** One side of a previewed pairing: a real team OR a typed source pointer
 * (`winner_of`/`loser_of` reference other preview refs like "p3"). */
export interface PreviewSide {
  team_id?: string;
  source?: { type: string; ref?: string; [k: string]: unknown };
}

export interface PreviewMatch {
  /** Stable in-preview reference ("p1"…) — violations point at these. */
  ref: string;
  leaf_key: string;
  stage: string;
  group_label: string;
  round_no: number;
  home: PreviewSide;
  away: PreviewSide;
  /** Tournament-local wall clock (invariant 14); null = unscheduled. */
  scheduled_at: string | null;
  venue: string | null;
}

/** A concrete relaxation suggestion (§3) — stable `code` + params; the FE
 * localizes from the code, never string-matches messages (§9 A5). */
export interface PreviewRelaxation {
  action: string;
  code: string;
  params: Record<string, unknown>;
}

export interface PreviewViolation {
  code: string;
  hard: boolean;
  /** The offending stored constraint record (null for capacity failures). */
  constraint: ConstraintRecord | null;
  /** Preview refs (or match ids on the commit path) this violation hits. */
  matches: string[];
  params: Record<string, unknown>;
  /** Server-rendered fallback message (gettext) — FE prefers the code. */
  message: string;
  relaxations: PreviewRelaxation[];
}

/** Per-team fairness analytics row (preview `fairness.teams`, increment R). */
export interface FairnessTeamRow {
  team_id: string;
  name: string;
  /** Minimum / median rest minutes between this team's matches (null while
   * the team has fewer than 2 scheduled matches). */
  rest_min: number | null;
  rest_median: number | null;
  /** Starts within the first / last 2 hours of the day's window. */
  early: number;
  late: number;
  /** Distinct physical venues (sub-venues collapse to their base). */
  venues: number;
  max_per_day: number;
}

/** A fairness outlier — stable i18n code (§9 A5), never a message. */
export interface FairnessFlag {
  code: "early_outlier" | "rest_below_min" | string;
  team_id: string;
  value: number;
  median: number | null;
}

export interface FixturePreview {
  matches: PreviewMatch[];
  unscheduled: string[];
  violations: PreviewViolation[];
  soft_score: number | null;
  fairness: {
    /** Per-team rest / early-slot / venue analytics (increment R). */
    teams?: FairnessTeamRow[];
    flags?: FairnessFlag[];
    rest_min_by_team?: Record<string, number>;
    venue_distribution?: Record<string, number>;
    days_used?: number;
  };
  /** The seed Accept MUST replay so commit ≡ preview (tenet 3). */
  seed: number | null;
  /** Accept's `expected_inputs_hash` guard value (§9 A1). */
  inputs_hash: string;
  warnings: unknown[];
  explanation: string[];
  leaf_key: string;
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
  /** Organizer-only (creator / workspace admin): gates the Delete button. */
  can_delete?: boolean;
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
