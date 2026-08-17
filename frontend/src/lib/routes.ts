/**
 * Typed route helpers. Centralising URL construction keeps the org-slug
 * source-of-truth invariant (Appendix B.20) honest.
 */

export const routes = {
  root: () => "/",
  landing: () => "/",
  about: () => "/about",
  notFound: () => "/404",
  login: () => "/login",
  signup: () => "/signup",
  verifyEmail: (token?: string) =>
    token ? `/verify-email?token=${encodeURIComponent(token)}` : "/verify-email",
  passwordResetRequest: () => "/password-reset",
  passwordResetComplete: (token?: string) =>
    token
      ? `/password-reset/complete?token=${encodeURIComponent(token)}`
      : "/password-reset/complete",
  twoFactorEnroll: () => "/2fa/enroll",
  twoFactorChallenge: () => "/2fa/challenge",
  inviteAccept: (token?: string) =>
    token ? `/accept?token=${encodeURIComponent(token)}` : "/accept",
  orgChooser: () => "/orgs",
  orgDashboard: (slug: string) => `/o/${encodeURIComponent(slug)}/dashboard`,
  orgMembers: (slug: string) => `/o/${encodeURIComponent(slug)}/members`,
  orgPermissions: (slug: string) =>
    `/o/${encodeURIComponent(slug)}/permissions`,
  orgSettings: (slug: string) => `/o/${encodeURIComponent(slug)}/settings`,
  /** Institution operator surface: seasons, houses, the live house table. */
  orgHouses: (slug: string) => `/o/${encodeURIComponent(slug)}/houses`,
  orgAudit: (slug: string) => `/o/${encodeURIComponent(slug)}/audit`,
  orgBranding: (slug: string) => `/o/${encodeURIComponent(slug)}/branding`,
  /** Phase 1B teaser landing page for Tournament list. */
  orgTournamentsComingSoon: (slug: string) =>
    `/o/${encodeURIComponent(slug)}/tournaments-coming-soon`,
  /** Phase 1A placeholder for the Phase 1B scorer console. */
  orgScoring: (slug: string) => `/o/${encodeURIComponent(slug)}/scoring`,
  /** Phase 1A placeholder for the Phase 1B referee console. */
  orgReferee: (slug: string) => `/o/${encodeURIComponent(slug)}/referee`,
  /** Phase 1A placeholder for the Phase 1B team-manager console. */
  orgTeam: (slug: string) => `/o/${encodeURIComponent(slug)}/team`,
  /** Your tournaments hub (the primary post-login surface). */
  tournaments: () => "/tournaments",
  /** Self-serve "create your first tournament" page. */
  tournamentNew: () => "/tournaments/new",
  /** Your pending invitations inbox (workspace-level). */
  invites: () => "/invites",
  /** Tournament dashboard (thin in 1A; Phase 1B fills it). */
  tournament: (slug: string, id: string) =>
    `/o/${encodeURIComponent(slug)}/tournaments/${encodeURIComponent(id)}`,
  /** Public school self-registration via a shared link. */
  register: (token: string) => `/register/${encodeURIComponent(token)}`,
  /** The standalone public form renderer (org/team registration). */
  publicForm: (formId: string) => `/f/${encodeURIComponent(formId)}`,
  /** Tournament workspace — Overview tab (index of the tabbed workspace). */
  tournamentDetail: (id: string) => `/tournaments/${encodeURIComponent(id)}`,
  /** Workspace tabs (dedicated pages). */
  tournamentOverview: (id: string) =>
    `/tournaments/${encodeURIComponent(id)}/overview`,
  tournamentSports: (id: string) =>
    `/tournaments/${encodeURIComponent(id)}/sports`,
  tournamentInstitutions: (id: string) =>
    `/tournaments/${encodeURIComponent(id)}/institutions`,
  /** Stage two of a WITHIN-SCHOOL event, where institution registration sits
   * in a between-schools one (spec 2026-08-16). */
  tournamentHouses: (id: string) =>
    `/tournaments/${encodeURIComponent(id)}/houses`,
  /** Participants-first (spec 2026-08-17): everyone a school declared, before
   * any team exists — and which competitions each of them ended up in. */
  tournamentParticipants: (id: string) =>
    `/tournaments/${encodeURIComponent(id)}/participants`,
  /** Who is playing what (owner 2026-08-17): the read-only workbench that
   * answers "is this student in more than one event?" before the draw. */
  tournamentParticipation: (id: string) =>
    `/tournaments/${encodeURIComponent(id)}/participation`,
  tournamentTeams: (id: string) => `/tournaments/${encodeURIComponent(id)}/teams`,
  tournamentFixtures: (id: string) =>
    `/tournaments/${encodeURIComponent(id)}/fixtures`,
  /** Full-page dry-run preview (fixture-engine redesign §6 screen 5).
   * `leafKey` scopes the simulate to one competition. */
  tournamentFixturesPreview: (id: string, leafKey?: string) =>
    `/tournaments/${encodeURIComponent(id)}/fixtures/preview${
      leafKey ? `?leaf=${encodeURIComponent(leafKey)}` : ""
    }`,
  /** Combined dry-run across EVERY competition (all sports), with publish-all. */
  tournamentFixturesPreviewAll: (id: string) =>
    `/tournaments/${encodeURIComponent(id)}/fixtures/preview?all=1`,
  tournamentSettings: (id: string) =>
    `/tournaments/${encodeURIComponent(id)}/settings`,
  /** Live-ops cockpit: day lanes, call-ups, repair verbs (control room spec).
   * Also the post-generation HOME — the workspace lands here once fixtures are
   * generated (stage `ready`). */
  tournamentControl: (id: string) =>
    `/tournaments/${encodeURIComponent(id)}/control`,
  /** Operations: flat, filterable tournament-wide matches board. */
  tournamentMatches: (id: string) =>
    `/tournaments/${encodeURIComponent(id)}/matches`,
  /** Operations: an invited member's own assigned matches (scoring seat or any
   * officiating slot). Visible to every member — it only ever shows theirs. */
  tournamentMyTasks: (id: string) =>
    `/tournaments/${encodeURIComponent(id)}/my-tasks`,
  /** Operations: admin-context live standings & bracket per competition. */
  tournamentStandings: (id: string) =>
    `/tournaments/${encodeURIComponent(id)}/standings`,
  /** Operations: officials, scorer & task assignment cockpit. */
  tournamentCrew: (id: string) => `/tournaments/${encodeURIComponent(id)}/crew`,
  /** Operations: the day's "Watch live" links — one per court, plus the
   * per-category and per-match overrides (manager-only). */
  tournamentStreams: (id: string) =>
    `/tournaments/${encodeURIComponent(id)}/streams`,
  /** Operations: how to film one court — the QR code that carries the phone
   * broadcast URL to a handset, the OBS overlay URL, and the steps. */
  tournamentStreamSetup: (id: string) =>
    `/tournaments/${encodeURIComponent(id)}/streams/setup`,
  /** Operations: full leader board (all scorers, team stats, badges). */
  tournamentLeaders: (id: string) =>
    `/tournaments/${encodeURIComponent(id)}/leaders`,
  /** Operations: full schedule change history (audit feed). */
  tournamentChanges: (id: string) =>
    `/tournaments/${encodeURIComponent(id)}/changes`,
  /** Public, read-only live match viewer (no login). */
  liveViewer: (matchId: string) => `/m/${encodeURIComponent(matchId)}`,
  /** Public, read-only tournament schedule (no login; slug+UUID pair). */
  publicSchedule: (slug: string, id: string) =>
    `/t/${encodeURIComponent(slug)}/${encodeURIComponent(id)}/schedule`,
  /** Public team profile: record, form, results, roster, badges. */
  publicSchool: (slug: string, id: string, instId: string) =>
    `/t/${slug}/${id}/school/${instId}`,
  publicTeam: (slug: string, id: string, teamId: string) =>
    `/t/${encodeURIComponent(slug)}/${encodeURIComponent(id)}/team/${encodeURIComponent(teamId)}`,
  /** Public group standings, every competition's tables (no login). */
  publicStandings: (slug: string, id: string) =>
    `/t/${encodeURIComponent(slug)}/${encodeURIComponent(id)}/standings`,
  /** Guest Lens campaign list (manager landing: all photo campaigns). */
  tournamentLens: (id: string) =>
    `/tournaments/${encodeURIComponent(id)}/lens`,
  /** One Guest Lens campaign's console (cards, moderation, awards). */
  tournamentLensCampaign: (id: string, campaignId: string) =>
    `/tournaments/${encodeURIComponent(id)}/lens/${encodeURIComponent(campaignId)}`,
  /** Public no-login photo upload page a Guest Lens QR card opens. */
  lensUpload: (token: string) => `/lens/${encodeURIComponent(token)}`,
  /** Public shared event album (approved Guest Lens photos, no login). One
   * album per campaign; omit campaignId for the tournament's first. */
  publicAlbum: (slug: string, id: string, campaignId?: string) =>
    `/t/${encodeURIComponent(slug)}/${encodeURIComponent(id)}/album${campaignId ? `/${encodeURIComponent(campaignId)}` : ""}`,
  /** Legacy live-scores URL; redirects to the Matches tab (live band). */
  publicLive: (slug: string, id: string) =>
    `/t/${encodeURIComponent(slug)}/${encodeURIComponent(id)}/live`,
  /** Public, read-only knockout bracket per competition (no login). */
  publicBracket: (slug: string, id: string) =>
    `/t/${encodeURIComponent(slug)}/${encodeURIComponent(id)}/bracket`,
  /**
   * OBS broadcast scoreboard overlay for ONE court — the URL an operator
   * pastes into a Browser Source once for the whole tournament. `court` is the
   * fixture's venue string; `opts.scale` matches the canvas (1280x720 is
   * 0.667), `opts.side` picks the anchor corner and `opts.server` says which
   * side opened the match for the serve indicator. See docs/obs-overlay.md.
   */
  overlayCourt: (
    slug: string,
    id: string,
    court: string,
    opts: { scale?: number; side?: "left" | "right"; server?: "home" | "away" } = {},
  ) => {
    const q = new URLSearchParams();
    if (opts.scale && opts.scale !== 1) q.set("scale", String(opts.scale));
    if (opts.side) q.set("side", opts.side);
    if (opts.server === "away") q.set("server", "away");
    const qs = q.toString();
    return `/overlay/t/${encodeURIComponent(slug)}/${encodeURIComponent(id)}/court/${encodeURIComponent(court)}${qs ? `?${qs}` : ""}`;
  },
  /**
   * Phone camera + live scoreboard for ONE court — the URL an operator opens
   * on the phone that will film the match, then broadcasts with the YouTube
   * app's "Go live → Screen". Same `court` addressing (the fixture's venue
   * string) and the same `scale`/`side`/`server` options as the OBS overlay,
   * so the two routes stay interchangeable.
   */
  broadcastCourt: (
    slug: string,
    id: string,
    court: string,
    opts: { scale?: number; side?: "left" | "right"; server?: "home" | "away" } = {},
  ) => {
    const q = new URLSearchParams();
    if (opts.scale && opts.scale !== 1) q.set("scale", String(opts.scale));
    if (opts.side) q.set("side", opts.side);
    if (opts.server === "away") q.set("server", "away");
    const qs = q.toString();
    return `/broadcast/t/${encodeURIComponent(slug)}/${encodeURIComponent(id)}/court/${encodeURIComponent(court)}${qs ? `?${qs}` : ""}`;
  },
  /** Live scorer console for a match. */
  matchConsole: (tournamentId: string, matchId: string) =>
    `/tournaments/${encodeURIComponent(tournamentId)}/matches/${encodeURIComponent(matchId)}`,
  /** Visual bracket / flow view of a tournament's fixtures. */
  tournamentBracket: (id: string) =>
    `/tournaments/${encodeURIComponent(id)}/bracket`,
  /** Tournament-scoped members & roles management. */
  tournamentMembers: (id: string) =>
    `/tournaments/${encodeURIComponent(id)}/members`,
  /** Tournament-scoped audit log (manager-only page). */
  tournamentAudit: (id: string) =>
    `/tournaments/${encodeURIComponent(id)}/audit`,
  /** Registration-forms list for a tournament (builder entry point). */
  tournamentForms: (id: string) =>
    `/tournaments/${encodeURIComponent(id)}/forms`,
  /** Drag-and-drop builder for a single registration form. */
  tournamentFormBuilder: (id: string, formId: string) =>
    `/tournaments/${encodeURIComponent(id)}/forms/${encodeURIComponent(formId)}/edit`,
  /** Responses dashboard for a registration form (Increment 8). */
  tournamentFormResponses: (id: string, formId: string) =>
    `/tournaments/${encodeURIComponent(id)}/forms/${encodeURIComponent(formId)}/responses`,
  profile: () => "/me",
  profileNotifications: () => "/me/notifications",
  /** Aliases — match the role-landing spec naming (`myProfile`, `myNotifications`). */
  myProfile: () => "/me",
  myNotifications: () => "/me/notifications",
} as const;
