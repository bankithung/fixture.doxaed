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
  /** Tournament dashboard (thin in 1A; Phase 1B fills it). */
  tournament: (slug: string, id: string) =>
    `/o/${encodeURIComponent(slug)}/tournaments/${encodeURIComponent(id)}`,
  /** Public school self-registration via a shared link. */
  register: (token: string) => `/register/${encodeURIComponent(token)}`,
  /** Tournament management page (teams, fixtures, scores, standings). */
  tournamentDetail: (id: string) => `/tournaments/${encodeURIComponent(id)}`,
  profile: () => "/me",
  profileNotifications: () => "/me/notifications",
  /** Aliases — match the role-landing spec naming (`myProfile`, `myNotifications`). */
  myProfile: () => "/me",
  myNotifications: () => "/me/notifications",
} as const;
