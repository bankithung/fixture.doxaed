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

export type SportNodeKind =
  "age_group" | "gender" | "format" | "level" | "custom";

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
  /** Service mechanics (P2): sepak 3-serve blocks vs single service, ends
   * changes; TT 2-per-turn with the deuce switch. */
  serve?: {
    serves_per_turn?: number;
    alternate_every_point?: boolean;
    change_ends_at?: { regular?: number; deciding?: number };
  };
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

/** Who competes in a tournament (spec 2026-08-16). */
export type TournamentScope = "inter_school" | "intra_school";
/** The intra-institution grouping a within-school event competes by. */
export type GroupKind = "house" | "class" | "form" | "department";
/** How players come into existence (spec 2026-08-17): typed on the team form,
 * or declared once up front and then PICKED. */
export type RosterMode = "inline" | "roster_first";

/** What switching `roster_mode` carried across (owner 2026-08-18). Switching a
 * tournament that already has teams MIGRATES rather than being refused. */
export interface RosterSwitch {
  mode: RosterMode;
  changed: boolean;
  /** The mode was already right but the team form was not, and was rebuilt —
   * re-selecting the mode you already have repairs it (owner 2026-08-18). */
  repaired?: boolean;
  /** Players already registered that became declared participants. */
  seeded: number;
  /** The generated team form rebuilt to match the new mode, if any. */
  team_form_id: string | null;
  /** True when a HAND-BUILT team form was left alone — it needs your edit. */
  team_form_kept: boolean;
}

/** One competing house/class in a within-school event. */
export interface TournamentHouse {
  id: string;
  name: string;
  kind: GroupKind;
  colour: string;
  teams: number;
  members: {
    id: string;
    user_id: string;
    name: string;
    email: string;
    role: string;
  }[];
}

export interface TournamentHouses {
  scope: TournamentScope;
  group_kind: GroupKind | "";
  can_manage: boolean;
  /** null = unrestricted (an organizer); a list = the houses this user acts for. */
  my_houses: string[] | null;
  houses: TournamentHouse[];
}

/** One competition a declared participant ended up in. */
export interface RosterEntry {
  team_id: string;
  team: string;
  leaf_key: string;
  /** "player", or the staff row's own role ("in_charge", "coach", …). */
  role: string;
}

/** One person a school declared, before any team existed (spec 2026-08-17). */
export interface RosterMember {
  id: string;
  full_name: string;
  kind: "student" | "teacher";
  class_section: string;
  roll_no: string;
  gender: string;
  date_of_birth: string | null;
  contact_email: string;
  contact_phone: string;
  attributes: Record<string, unknown>;
  /** Papers the school uploaded for this person (age proof, ID, consent),
   * read back out of the submission that declared them. */
  documents: UploadRef[];
  institution: { id: string; name: string } | null;
  group: { id: string; name: string } | null;
  entries: RosterEntry[];
}

export interface TournamentRoster {
  can_manage: boolean;
  roster_mode: string;
  scope: TournamentScope;
  group_kind: GroupKind | "";
  counts: { students: number; teachers: number; multi_entry: number };
  members: RosterMember[];
}

/** Fields a participant row accepts on create/edit. */
export interface RosterMemberInput {
  full_name?: string;
  kind?: "student" | "teacher";
  class_section?: string;
  roll_no?: string;
  gender?: string;
  date_of_birth?: string;
  contact_email?: string;
  contact_phone?: string;
  institution_id?: string;
  group_id?: string;
}

export interface Tournament {
  id: string;
  scope?: TournamentScope;
  group_kind?: GroupKind | "";
  /** How players are entered (spec 2026-08-17). */
  roster_mode?: RosterMode;
  slug: string;
  name: string;
  status: string;
  organization_slug: string;
  sport_code: string | null;
  sports: TournamentSport[];
  time_zone: string;
  starts_at?: string | null;
  ends_at?: string | null;
  season?: string;
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
  /** Multi-stage index (0 = single / first stage). */
  stage_no?: number;
  /** Typed dependency pointer for an unresolved bracket slot (invariant 9):
   * group_position → "Group A #1", winner_of/loser_of → another match. */
  home_source?: MatchSource | null;
  away_source?: MatchSource | null;
}

/** A typed match-dependency pointer (home_source/away_source, invariant 9). */
export interface MatchSource {
  type: "team" | "winner_of" | "loser_of" | "group_position" | "tbd" | string;
  match_id?: string;
  team_id?: string;
  group_label?: string;
  position?: number;
  [k: string]: unknown;
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
  /** P3 advancement health: bracket slots whose feeder finished but whose
   * team never arrived. Non-empty = the bracket is silently stalled. */
  advancement_stalled?: {
    match_id: string;
    side: "home" | "away";
    source_type: string;
    feeder_match_id: string;
    feeder_status: string;
  }[];
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
  /** Multi-stage index (0 = single / first stage). */
  stage_no?: number;
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
  /** Typed dependency pointers — an unresolved bracket slot shows
   * "Group A #1" / "Winner of …" and fills in live (invariant 9). */
  home_source?: MatchSource | null;
  away_source?: MatchSource | null;
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
  /** The court FK behind the `venue` display string (null = no court). */
  court_id?: string | null;
  /** Server-resolved "Watch live" target for THIS match — the court's live
   * stream while it is on, the day's archive at `&t=<offset>` once it has
   * finished. Null when nothing resolves at any level, in which case no Watch
   * live control is shown (streaming spec 2026-08-04). */
  watch_url?: string | null;
}

/** One court of the public payload with the link currently applying to it. */
export interface PublicCourtLink {
  id: string;
  /** Exactly the `venue` display string carried by the match rows. */
  name: string;
  watch_url: string | null;
  /** Narrower than "has a URL": the court is on air right now. */
  is_streaming: boolean;
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
  /** The courts this tournament plays on, each with its resolved link. */
  courts?: PublicCourtLink[];
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
  /** Raw within-set points (set sports; 0 for football). */
  PF_pts?: number;
  PA_pts?: number;
  PD_pts?: number;
}

/** One sport's SportDefinition descriptor (P1.c, /sports-meta/). */
export interface SportDescriptor {
  key: string;
  name: string;
  family: "timed" | "target";
  has_draw: boolean;
  terms: Record<string, string>;
  boards: { key: string; label: string; subject: string; fmt: string }[];
  /** Named, sourced scoring presets — pick one, then edit freely. */
  presets?: {
    key: string;
    label: string;
    note: string;
    scoring: SportScoringConfig;
  }[];
  officials_roles?: string[];
}

export interface SportsMeta {
  sports: { key: string; name: string; leaf_count: number }[];
  descriptors: Record<string, SportDescriptor>;
  /** Named, sourced tiebreaker orders (FIFA, league, ITTF ratio, sets). */
  tiebreaker_presets?: {
    key: string;
    label: string;
    note: string;
    tiebreakers: string[];
  }[];
}

export interface StandingsGroup {
  group_label: string;
  rows: StandingRow[];
}

/** One ranked board of the leaders payload (per sport, or per category). */
export interface LeadersBoard {
  key: string;
  label: string;
  subject: "player" | "team" | "regu" | "pair";
  fmt: string;
  rows: {
    player_id?: string;
    team_id?: string;
    name?: string;
    team_name?: string;
    played?: number;
    value: number | string;
    detail?: string;
  }[];
}

export interface LeadersPayload {
  played: number;
  sports: {
    sport: string;
    name: string;
    played: number;
    /** The sport-wide roll-up. */
    boards: LeadersBoard[];
    /** Per competition leaf — the level that actually has a winner. */
    categories?: {
      leaf_key: string;
      label: string;
      played: number;
      boards: LeadersBoard[];
    }[];
  }[];
  latest_badges: {
    id: string;
    name: string;
    subject: string;
    evidence: Record<string, unknown>;
  }[];
}

/**
 * Bulk crew assignment writes one match row + one audit row per match, serially
 * and without batching, so a big scope legitimately runs far past the 20 s
 * default `apiFetch` timeout (a 14-match scope timed out in production while the
 * server went on to commit every row — nginx logged the 499, the organiser saw
 * "could not assign"). Give the call a budget that fits the work instead of
 * raising the global default, which every fast call relies on.
 */
export const BULK_ASSIGN_TIMEOUT_MS = 120_000;

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
  create: (payload: {
    name: string;
    sport_code?: string;
    event_id: string;
    /** Who competes (spec 2026-08-16). Omitted = between schools, unchanged. */
    scope?: TournamentScope;
    /** Only with scope "intra_school": the grouping the host competes by. */
    group_kind?: GroupKind;
    /** How players are entered (spec 2026-08-17). Omitted = typed inline. */
    roster_mode?: RosterMode;
  }) => api.post<Tournament>("/api/tournaments/", payload),
  /** Houses & members — the within-school competitor list (spec 2026-08-16). */
  houses: (tournamentId: string) =>
    api.get<TournamentHouses>(`/api/tournaments/${tournamentId}/houses/`),
  createHouse: (
    tournamentId: string,
    payload: { name: string; colour?: string; kind?: GroupKind },
  ) => api.post<TournamentHouse>(`/api/tournaments/${tournamentId}/houses/`, payload),
  updateHouse: (
    tournamentId: string,
    houseId: string,
    payload: { name?: string; colour?: string },
  ) =>
    api.patch<TournamentHouse>(
      `/api/tournaments/${tournamentId}/houses/${houseId}/`,
      payload,
    ),
  removeHouse: (tournamentId: string, houseId: string) =>
    api.delete<void>(`/api/tournaments/${tournamentId}/houses/${houseId}/`),
  addHouseMember: (tournamentId: string, houseId: string, email: string) =>
    api.post<TournamentHouse>(
      `/api/tournaments/${tournamentId}/houses/${houseId}/members/`,
      { email },
    ),
  removeHouseMember: (tournamentId: string, houseId: string, userId: string) =>
    api.delete<void>(
      `/api/tournaments/${tournamentId}/houses/${houseId}/members/?user=${encodeURIComponent(userId)}`,
    ),
  /** Participants — the people declared before any team exists, and every
   * competition each of them is now in (spec 2026-08-17). */
  roster: (
    tournamentId: string,
    params?: { institution?: string; kind?: string; group?: string; q?: string },
  ) => {
    const qs = new URLSearchParams(
      Object.entries(params ?? {}).filter(([, v]) => Boolean(v)) as [
        string,
        string,
      ][],
    ).toString();
    return api.get<TournamentRoster>(
      `/api/tournaments/${tournamentId}/roster/${qs ? `?${qs}` : ""}`,
    );
  },
  declareParticipant: (tournamentId: string, payload: RosterMemberInput) =>
    api.post<RosterMember>(`/api/tournaments/${tournamentId}/roster/`, payload),
  updateParticipant: (
    tournamentId: string,
    memberId: string,
    payload: RosterMemberInput,
  ) =>
    api.patch<RosterMember>(
      `/api/tournaments/${tournamentId}/roster/${memberId}/`,
      payload,
    ),
  withdrawParticipant: (tournamentId: string, memberId: string) =>
    api.delete<void>(`/api/tournaments/${tournamentId}/roster/${memberId}/`),
  /** Reserve a court for one or more competitions (leaf-key prefixes), and
   * say whether that reservation LOCKS the court or merely gives its own
   * competitions first claim of it (owner 2026-08-17). */
  setCourtCompetitions: (
    tournamentId: string,
    courtId: string,
    competitions: string[],
    exclusive?: boolean,
  ) =>
    api.patch<{ id: string; competitions: string[]; exclusive: boolean }>(
      `/api/tournaments/${tournamentId}/courts/${courtId}/`,
      { competitions, ...(exclusive === undefined ? {} : { exclusive }) },
    ),
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
   *  `institution_ids` to send/resend to specific schools only, or
   *  `reveal` to mint readable codes WITHOUT emailing anyone. */
  issueTeamCodes: (
    id: string,
    opts: {
      force?: boolean;
      reveal?: boolean;
      institution_ids?: string[];
    } = {},
  ) =>
    api.post<{
      sent: number;
      failed: number;
      no_email: number;
      skipped: number;
      minted: number;
      no_email_institutions: { id: string; name: string }[];
      failed_institutions: { id: string; name: string }[];
    }>(`/api/tournaments/${id}/team-codes/`, opts),
  /** Every school's access code, to read out or copy (manager-only).
   *  A code minted before codes were readable comes back `readable: false`
   *  with an empty `code` — it is an Argon2 hash and genuinely gone. */
  teamCodes: (id: string) =>
    api.get<{
      codes: {
        institution_id: string;
        name: string;
        contact_email: string;
        code: string;
        has_code: boolean;
        readable: boolean;
        sent_at: string | null;
        grace_until: string | null;
      }[];
      form_url: string;
    }>(`/api/tournaments/${id}/team-codes/`),
  /** All matches (the generated fixture). The server enriches each row with the
   * competition leaf label + assigned scorer/officials (the operations Matches
   * board reads those via `matchesEnriched`); plain consumers (bracket,
   * standings) keep the lean `MatchRow` view. */
  matches: (id: string) =>
    api.get<MatchRow[]>(`/api/tournaments/${id}/matches/`),
  /** Same endpoint as `matches`, typed as the enriched control-room row
   * (leaf_label + scorer + officials are always present in the response). */
  matchesEnriched: (id: string) =>
    api.get<ControlRoomMatch[]>(`/api/tournaments/${id}/matches/`),
  /** P3: re-run advancement for every stalled bracket slot (manager-only,
   * idempotent — always safe). */
  refireAdvancement: (id: string) =>
    api.post<{ filled: number; stalled_before: number; stalled_after: number }>(
      `/api/tournaments/${id}/advancement:refire/`,
    ),
  /** The tournament's sports + their SportDefinition descriptors (P1.c). */
  sportsMeta: (id: string) =>
    api.get<SportsMeta>(`/api/tournaments/${id}/sports-meta/`),
  /** Standings grouped by pool. */
  /** Live leaderboards, PER SPORT (P1.b): each sport ships its own boards
   * from the SportDefinition catalog; sports never pool into one table. */
  leaders: (id: string, opts?: { full?: boolean }) =>
    api.get<LeadersPayload>(
      `/api/tournaments/${id}/leaders/${opts?.full ? "?full=1" : ""}`,
    ),
  /** Card-derived suspensions (PRD 5.8) — who is banned, why, remaining. */
  suspensions: (id: string) =>
    api.get<{
      suspensions: {
        player_id: string;
        player_name: string;
        team_id: string;
        team_name: string;
        reason: string;
        triggered_match_id: string;
        banned_matches: number;
        served: number;
        active: boolean;
      }[];
    }>(`/api/tournaments/${id}/suspensions/`),
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
      /** Replay the previewed draw exactly (§5.2 — Accept carries the seed).
       * A random re-draw needs BOTH: the seed is only honoured when the
       * seeding method is "random". */
      seed?: number;
      seeding?: "registration" | "random" | "seeded" | "snake";
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
    if (opts?.seeding !== undefined) body.seeding = opts.seeding;
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
  /** Take another tournament's fixture setup. `dry_run` reports what would
   * happen and writes nothing, which is how a host checks before taking it. */
  copySetup: (id: string, body: CopySetupRequest) =>
    api.post<CopySetupReport>(`/api/tournaments/${id}/copy-setup/`, body),
  createVenue: (id: string, body: Omit<VenueRecord, "id">) =>
    api.post<VenueRecord>(`/api/tournaments/${id}/venues/`, body),
  updateVenue: (
    id: string,
    venueId: string,
    body: Partial<Omit<VenueRecord, "id">>,
  ) =>
    api.patch<VenueRecord>(`/api/tournaments/${id}/venues/${venueId}/`, body),
  deleteVenue: (id: string, venueId: string) =>
    api.delete(`/api/tournaments/${id}/venues/${venueId}/`),
  /** Member x module permission matrix (manager-only). */
  permissionMatrix: (id: string) =>
    api.get<PermissionMatrix>(`/api/tournaments/${id}/permissions/`),
  /** Set one member's per-module override (manager-only; reason >= 20 chars). */
  setPermission: (
    id: string,
    body: {
      user_id: string;
      module_code: string;
      state: "grant" | "deny" | "default";
      reason: string;
    },
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
  /** Who is running a match: every assigned official plus the scorer seat.
   * Readable by anyone who can reach the match — the pre-match check shows a
   * scorer who is on court, and a scorer may not assign (owner 2026-08-17). */
  matchOfficials: (matchId: string) =>
    api.get<{
      officials: MatchOfficialRow[];
      scorer: { id: string; name: string } | null;
    }>(`/api/matches/${matchId}/officials/`),
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
  /** Assign (or change) the scorer seat on a match (manager only).
   * `eventId` is the invariant-3 idempotency key: the caller generates it ONCE
   * per intent so a retry of the same seat change replays instead of re-running.
   * (Server-side replay support for this endpoint is landing separately; until
   * it does the field is simply ignored, which is harmless.) */
  assignScorer: (matchId: string, userId: string | null, eventId?: string) =>
    api.post<MatchRow>(`/api/matches/${matchId}/scorer/`, {
      user_id: userId,
      ...(eventId ? { event_id: eventId } : {}),
    }),
  /** Bulk-assign one scorer/official to every match in a scope (a court, a
   * competition category/leaf, or a sport). Reuses the per-match services, so
   * every guard fires; returns how many landed / were skipped + soft clashes. */
  bulkAssignCrew: (
    id: string,
    payload: {
      scope: "court" | "category" | "sport";
      key: string;
      day: string | null;
      role: string;
      user_id: string;
      only_unassigned: boolean;
      event_id: string;
    },
  ) =>
    api.post<{
      assigned: number;
      skipped: number;
      total: number;
      warnings: { match_id: string; code: string; count: number }[];
      scope: string;
      key: string;
    }>(`/api/tournaments/${id}/crew/bulk-assign/`, payload, {
      timeoutMs: BULK_ASSIGN_TIMEOUT_MS,
    }),

  // --- Setup-stage workflow (WS4) ---
  stage: (id: string) => api.get<StagePayload>(`/api/tournaments/${id}/stage/`),
  previewStage: (id: string, toStage: string) =>
    api.post<StageConsequences>(`/api/tournaments/${id}/stage/preview/`, {
      to_stage: toStage,
    }),
  transitionStage: (
    id: string,
    body: {
      to_stage: string;
      ack_warnings?: boolean;
      reason?: string;
      event_id: string;
    },
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
  /** Replace this tournament's selected sports (manager-only; idempotent
   * replay when event_id is passed). */
  setSports: (id: string, sports: TournamentSport[], eventId?: string) =>
    api.put<{ sports: TournamentSport[] }>(`/api/tournaments/${id}/sports/`, {
      sports,
      ...(eventId ? { event_id: eventId } : {}),
    }),
  /** Soft-delete a tournament (manager-only; blocked while live). */
  remove: (id: string) => api.delete<void>(`/api/tournaments/${id}/`),
  /** Deactivate (archive) or reactivate a tournament. */
  setActive: (id: string, active: boolean) =>
    api.patch<Tournament>(`/api/tournaments/${id}/`, { active }),
  /** Event basics: dates, season, timezone (tz locks at stage=ready). */
  patch: (
    id: string,
    body: {
      starts_at?: string | null;
      ends_at?: string | null;
      season?: string;
      time_zone?: string;
      name?: string;
    },
  ) => api.patch<Tournament>(`/api/tournaments/${id}/`, body),
  /** Rename a tournament (display name only — the slug/public URL stays
   * stable). Manager-allowed; the server enforces the permission. */
  rename: (id: string, name: string) =>
    api.patch<Tournament>(`/api/tournaments/${id}/`, { name }),
  /** Switch how players are entered (spec 2026-08-17). 409 `roster_mode_locked`
   * once teams exist — by then the team form's pickers are already bound to
   * the list, and the people declared would be stranded. */
  setRosterMode: (id: string, roster_mode: RosterMode) =>
    api.patch<Tournament & { roster_switch?: RosterSwitch }>(
      `/api/tournaments/${id}/`,
      { roster_mode },
    ),

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
    opts: {
      since?: string;
      leafKey?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) => {
    const q = new URLSearchParams();
    if (opts.since) q.set("since", opts.since);
    if (opts.leafKey) q.set("leaf_key", opts.leafKey);
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    if (opts.offset) q.set("offset", String(opts.offset));
    const qs = q.toString();
    return api.get<{ results: ScheduleChangeEntry[]; total?: number }>(
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
    body: {
      schedule?: Partial<ScheduleRequest>;
      /** DrawConfig overrides applied to EVERY competition, this run only
       * (e.g. `{seeding: "random"}` for a fresh draw). */
      draw?: DrawConfigLayer;
      include_schedule?: boolean;
    },
  ) =>
    api.post<
      FixturePreview & {
        competitions: number;
        /** Per-leaf seeds Accept MUST replay so publish-all ≡ preview (C11). */
        per_leaf_seed?: Record<string, number | null>;
        /** Per-leaf drift-guard hashes for publish-all's 409. */
        per_leaf_inputs_hash?: Record<string, string>;
      }
    >(`/api/tournaments/${id}/fixtures/preview-all/`, body),

  /** Generate every competition's draw (existing draws kept) + schedule them
   * all together, atomically — the "publish the whole tournament" action. */
  publishAllFixtures: (
    id: string,
    body: {
      schedule?: Partial<ScheduleRequest>;
      /** The same per-leaf overrides the preview ran with, so publish commits
       * exactly what was previewed (a random re-draw included). */
      draw?: DrawConfigLayer;
      per_leaf_seed?: Record<string, number | null>;
      per_leaf_inputs_hash?: Record<string, string>;
    },
  ) =>
    api.post<{
      competitions: number;
      scheduled: number;
      unscheduled: string[];
      warnings: unknown[];
    }>(`/api/tournaments/${id}/fixtures/publish-all/`, body),
};

/** Per-game (category leaf) overrides — the owner's "everything is per game"
 * rule. Scoring + ranking are participant-facing, so they live under the
 * invariant-7 freeze (in `rules`), not draw_config. */
export interface LeafRules {
  scoring?: SportScoringConfig | null;
  tiebreakers?: string[] | null;
}

export interface TournamentRules {
  format: string;
  group_size: number;
  advance_per_group: number;
  points: { win: number; draw: number; loss: number };
  tiebreakers: string[];
  match: {
    halves: number;
    half_minutes: number;
    extra_time: boolean;
    penalties: boolean;
  };
  squad: { min_players: number; max_players: number; max_subs: number };
  discipline: {
    yellow_suspension_threshold: number;
    red_matches_banned: number;
  };
  /** Per-game scoring/tiebreaker overrides, keyed by competition leaf key. */
  by_leaf?: Record<string, LeafRules>;
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
  /** Per-sport scoring baseline (override → profile) each game inherits until a
   * per-game override is set. Keyed by sport key; null = goal-based/unknown. */
  scoring_defaults?: Record<string, SportScoringConfig | null>;
}

export interface ConstraintType {
  type: string;
  label: string;
  /** Default enforcement (records may toggle hard/soft individually). */
  hard: boolean;
  /** Param key → kind ("int" | "time" | "date" | "date_or_last_day" | "list" |
   * "bool" | "order" | "str") — drives the ConstraintRow field renderer
   * (redesign §3). */
  params_schema: Record<string, string>;
  /** Param key → the fixed set of values it accepts. Present only for
   * enumerated params; the row renders a picker instead of a text box. */
  param_options?: Record<string, string[]>;
  /** Scope kinds this type meaningfully accepts ("all"|"sport"|"leaf"|"team"|"tag"). */
  scopes: string[];
  /** "S" = slot-time (scheduler), "P" = pairing-time (generator). */
  layer: string;
}

/** A stored venue: physical facility with a type + availability windows. */
export interface CopySetupRequest {
  source_tournament_id: string;
  /** Omitted = the fixture generator's own inputs. */
  parts?: string[];
  dry_run?: boolean;
  event_id?: string;
}

/** What a copy did, or would do. */
export interface CopySetupReport {
  source_id: string;
  source_name: string;
  parts: string[];
  counts: Record<string, number>;
  /** Competitions the copied settings name that this tournament does not
   * have — a rule that would read as set and do nothing. */
  unknown_competitions: string[];
  target_had: { constraints: number; draw_config: number };
  copied: boolean;
  dry_run?: boolean;
  replayed?: boolean;
}

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
  /** Daily breaks for THIS venue (lunch/prayer); no match is scheduled here
   * during them (owner ask 2026-06-27). */
  breaks?: { from: string; to: string }[];
  /** One row per playing surface, with the competitions reserved to it
   * (leaf-key prefixes; empty = takes anything). Spec 2026-08-16. */
  courts?: {
    id: string;
    index: number;
    name: string;
    competitions: string[];
    /** False = a preference, not a lock: the court takes a waiting match
     * rather than standing idle (owner 2026-08-17). */
    exclusive?: boolean;
  }[];
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
  /** Per-competition match length in minutes (owner ask 2026-06-27). Layered:
   * "*" = tournament default, "<leaf>" = override. null = inherit. Scheduling-
   * only (excluded from inputs_hash). */
  match_duration_minutes?: number | null;
  /** Rest a TEAM gets before its next match (minutes), layered like the
   * duration. null = inherit the tournament value (owner 2026-08-17). */
  rest_minutes?: number | null;
  /** Composable multi-stage plan (owner ask 2026-06-27). null/[] = single-stage
   * (the flat `format` governs); a non-empty ordered list supersedes it. */
  stages?: DrawStage[] | null;
}

export type StageType = "round_robin" | "knockout" | "swiss" | "double_elim";

/** Qualification INTO a stage (lives on the downstream stage). */
export interface StageIntake {
  /** id of an earlier stage (defaults to the immediately preceding one). */
  stage?: string;
  method?: "top_n_per_group" | string;
  advance_per_group: number;
  advance_best_thirds: number;
  seeding: "cross" | "overall";
}

/** One stage in a competition's multi-stage plan (draw_config[leaf].stages). */
export interface DrawStage {
  /** uuid7 handle (server auto-fills if omitted); stable across reorder. */
  id?: string;
  name?: string;
  type: StageType;
  group_size?: number;
  balance_groups?: boolean;
  /** Partial round-robin target: each team plays >= N. null = full RR. */
  min_matches_per_team?: number | null;
  legs?: number;
  third_place?: boolean;
  plate?: boolean;
  swiss_rounds?: number | null;
  from?: StageIntake;
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
  venues?: (
    | string
    | {
        name: string;
        venue_type?: string;
        windows?: { from: string; to: string }[];
      }
  )[];
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
  /** This match's own length in minutes (per-competition duration). */
  duration_minutes?: number | null;
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
