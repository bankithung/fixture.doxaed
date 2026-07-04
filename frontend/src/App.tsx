import { Suspense, lazy, useEffect } from "react";
import {
  BrowserRouter,
  Route,
  Routes,
  useNavigate,
} from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient, onAuthEvent } from "@/api/queryClient";
import { useAuthStore } from "@/features/auth/authStore";
import { ToastProvider } from "@/components/ui/toast";
import { ThemeProvider } from "@/features/theme/ThemeProvider";
import { ProtectedRoute } from "@/features/layout/ProtectedRoute";
import { AppShell } from "@/features/layout/AppShell";
import { OrgChooserPage } from "@/features/layout/OrgChooserPage";
import { TournamentsListPage } from "@/features/tournaments/TournamentsListPage";
import { InvitesPage } from "@/features/invitations/InvitesPage";
import { PublicLiveRedirect } from "@/features/live/PublicLiveRedirect";
import { OrgDashboardPage } from "@/features/layout/OrgDashboardPage";
// Auth pages (B1).
import { LoginPage } from "@/features/auth/LoginPage";
import { SignupPage } from "@/features/auth/SignupPage";
import { VerifyEmailPage } from "@/features/auth/VerifyEmailPage";
import { PasswordResetRequestPage } from "@/features/auth/PasswordResetRequestPage";
import { PasswordResetCompletePage } from "@/features/auth/PasswordResetCompletePage";
import { TwoFactorEnrollPage } from "@/features/auth/TwoFactorEnrollPage";
import { TwoFactorChallengePage } from "@/features/auth/TwoFactorChallengePage";
import { PasswordReauthModal } from "@/features/auth/PasswordReauthModal";
// Landing + errors (B6 owns ErrorBoundary + ComingSoonPage; pages live alongside).
import { LandingPage } from "@/features/landing/LandingPage";
import { AboutPage } from "@/features/landing/AboutPage";
import { NotFoundPage } from "@/features/errors/NotFoundPage";
import { ErrorBoundary } from "@/features/errors/ErrorBoundary";
import { ComingSoonPage } from "@/features/errors/ComingSoonPage";
// Orgs (B2/B3).
import { InviteAcceptPage } from "@/features/orgs/InviteAcceptPage";
// Permissions (B4).
// Roles (B5).
import { ScorerLandingPage } from "@/features/roles/ScorerLandingPage";
import { RefereeLandingPage } from "@/features/roles/RefereeLandingPage";
import { TeamManagerLandingPage } from "@/features/roles/TeamManagerLandingPage";
import { MyProfilePage } from "@/features/roles/MyProfilePage";
import { NotificationPrefsPage } from "@/features/roles/NotificationPrefsPage";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

// Route-level code splitting (P6): each surface loads on demand —
// public viewers on school phones no longer download the ops cockpit.
const CreateTournamentPage = lazy(() => import("@/features/tournaments/CreateTournamentPage").then((m) => ({ default: m.CreateTournamentPage })));
const TournamentWorkspace = lazy(() => import("@/features/tournaments/TournamentWorkspace").then((m) => ({ default: m.TournamentWorkspace })));
const OverviewTab = lazy(() => import("@/features/tournaments/tabs/OverviewTab").then((m) => ({ default: m.OverviewTab })));
const FlowLanding = lazy(() => import("@/features/tournaments/FlowLanding").then((m) => ({ default: m.FlowLanding })));
const SportsTab = lazy(() => import("@/features/tournaments/tabs/SportsTab").then((m) => ({ default: m.SportsTab })));
const InstitutionsTab = lazy(() => import("@/features/tournaments/tabs/InstitutionsTab").then((m) => ({ default: m.InstitutionsTab })));
const TeamsTab = lazy(() => import("@/features/tournaments/tabs/TeamsTab").then((m) => ({ default: m.TeamsTab })));
const FixturesTab = lazy(() => import("@/features/tournaments/tabs/FixturesTab").then((m) => ({ default: m.FixturesTab })));
const SettingsRoute = lazy(() => import("@/features/tournaments/ops/SettingsRoute").then((m) => ({ default: m.SettingsRoute })));
const TournamentMembersPage = lazy(() => import("@/features/tournaments/TournamentMembersPage").then((m) => ({ default: m.TournamentMembersPage })));
const TournamentAuditPage = lazy(() => import("@/features/tournaments/TournamentAuditPage").then((m) => ({ default: m.TournamentAuditPage })));
const MatchConsolePage = lazy(() => import("@/features/matches/MatchConsolePage").then((m) => ({ default: m.MatchConsolePage })));
const ControlRoomPage = lazy(() => import("@/features/controlroom/ControlRoomPage").then((m) => ({ default: m.ControlRoomPage })));
const MatchesBoardPage = lazy(() => import("@/features/tournaments/ops/MatchBoardPage").then((m) => ({ default: m.MatchesBoardPage })));
const OpsStandingsPage = lazy(() => import("@/features/tournaments/ops/OpsStandingsPage").then((m) => ({ default: m.OpsStandingsPage })));
const LeadersPage = lazy(() => import("@/features/tournaments/ops/LeadersPage").then((m) => ({ default: m.LeadersPage })));
const ChangeHistoryPage = lazy(() => import("@/features/tournaments/ops/ChangeHistoryPage").then((m) => ({ default: m.ChangeHistoryPage })));
const CrewPage = lazy(() => import("@/features/tournaments/ops/CrewPage").then((m) => ({ default: m.CrewPage })));
const BracketPage = lazy(() => import("@/features/tournaments/BracketPage").then((m) => ({ default: m.BracketPage })));
const DryRunPreviewPage = lazy(() => import("@/features/fixtures/DryRunPreviewPage").then((m) => ({ default: m.DryRunPreviewPage })));
const PublicSchedulePage = lazy(() => import("@/features/fixtures/PublicSchedulePage").then((m) => ({ default: m.PublicSchedulePage })));
const RegistrationFormPage = lazy(() => import("@/features/registration/RegistrationFormPage").then((m) => ({ default: m.RegistrationFormPage })));
const FormsListPage = lazy(() => import("@/features/forms/FormsListPage").then((m) => ({ default: m.FormsListPage })));
const FormBuilderPage = lazy(() => import("@/features/forms/FormBuilderPage").then((m) => ({ default: m.FormBuilderPage })));
const ResponsesPage = lazy(() => import("@/features/forms/ResponsesPage").then((m) => ({ default: m.ResponsesPage })));
const PublicFormPage = lazy(() => import("@/features/forms/PublicFormPage").then((m) => ({ default: m.PublicFormPage })));
const PublicDirectoryPage = lazy(() => import("@/features/forms/PublicDirectoryPage").then((m) => ({ default: m.PublicDirectoryPage })));
const LiveViewerPage = lazy(() => import("@/features/live/LiveViewerPage").then((m) => ({ default: m.LiveViewerPage })));
const PublicStandingsPage = lazy(() => import("@/features/live/PublicStandingsPage").then((m) => ({ default: m.PublicStandingsPage })));
const PublicBracketPage = lazy(() => import("@/features/live/PublicBracketPage").then((m) => ({ default: m.PublicBracketPage })));
const PublicTeamPage = lazy(() => import("@/features/live/PublicTeamPage").then((m) => ({ default: m.PublicTeamPage })));
const ExplorePage = lazy(() => import("@/features/live/ExplorePage").then((m) => ({ default: m.ExplorePage })));
const CertificatePage = lazy(() => import("@/features/live/CertificatePage").then((m) => ({ default: m.CertificatePage })));
const VenueDisplayPage = lazy(() => import("@/features/live/VenueDisplayPage").then((m) => ({ default: m.VenueDisplayPage })));
const MemberDirectoryPage = lazy(() => import("@/features/orgs/MemberDirectoryPage").then((m) => ({ default: m.MemberDirectoryPage })));
const OrgSettingsPage = lazy(() => import("@/features/orgs/OrgSettingsPage").then((m) => ({ default: m.OrgSettingsPage })));
const HousePointsPage = lazy(() => import("@/features/orgs/HousePointsPage").then((m) => ({ default: m.HousePointsPage })));
const OrgBrandingPage = lazy(() => import("@/features/orgs/OrgBrandingPage").then((m) => ({ default: m.OrgBrandingPage })));
const OrgAuditLogPage = lazy(() => import("@/features/orgs/OrgAuditLogPage").then((m) => ({ default: m.OrgAuditLogPage })));
const ModuleMatrixPage = lazy(() => import("@/features/permissions/ModuleMatrixPage").then((m) => ({ default: m.ModuleMatrixPage })));

/** Listen for global auth events fired by the query client. */
function AuthBusBridge(): null {
  const navigate = useNavigate();
  const clear = useAuthStore((s) => s.clear);
  useEffect(
    () =>
      onAuthEvent((e) => {
        if (e.type === "unauthenticated") {
          clear();
          navigate(routes.login());
        }
      }),
    [navigate, clear],
  );
  return null;
}

/**
 * Top-level app composition. Provider order is meaningful:
 *
 *   QueryClientProvider          (server state cache)
 *     ToastProvider              (UI toasts; no router needed)
 *       ErrorBoundary            (catches render-phase throws below)
 *         BrowserRouter          (history + routing)
 *           AuthBusBridge        (route on global 401)
 *           PasswordReauthModal  (re-auth challenges anywhere)
 *           Routes               (the route table)
 *
 * The ErrorBoundary sits inside the toast provider but outside the
 * router so a thrown render error in any route renders the friendly
 * <ErrorPage>. Router-level errors that have their own handling
 * (e.g. an explicit useRouteError) bypass this boundary by design.
 */
export default function App(): React.ReactElement {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ErrorBoundary>
          <BrowserRouter>
            <AuthBusBridge />
            <PasswordReauthModal />
            <Suspense
              fallback={
                <div className="grid min-h-[40vh] w-full place-items-center">
                  <div
                    aria-label="Loading"
                    className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-primary"
                  />
                </div>
              }
            >
            <Routes>
              {/* Public surfaces. */}
              <Route path="/" element={<LandingPage />} />
              <Route path="/about" element={<AboutPage />} />

              {/* Public auth surfaces (B1). */}
              <Route path="/login" element={<LoginPage />} />
              <Route path="/signup" element={<SignupPage />} />
              <Route path="/verify-email" element={<VerifyEmailPage />} />
              <Route
                path="/password-reset"
                element={<PasswordResetRequestPage />}
              />
              <Route
                path="/password-reset/complete"
                element={<PasswordResetCompletePage />}
              />
              <Route path="/2fa/enroll" element={<TwoFactorEnrollPage />} />
              <Route
                path="/2fa/challenge"
                element={<TwoFactorChallengePage />}
              />
              <Route path="/accept" element={<InviteAcceptPage />} />
              <Route
                path="/register/:token"
                element={<RegistrationFormPage />}
              />
              {/* Data-driven public form renderer (Increment 7). */}
              <Route path="/f/:formId/directory" element={<PublicDirectoryPage />} />
              <Route path="/f/:formId" element={<PublicFormPage />} />
              <Route path="/r/:token" element={<PublicFormPage />} />
              <Route path="/m/:matchId" element={<LiveViewerPage />} />
              {/* Public read-only tournament panel (trust layer): Matches,
                  Standings, Knockout as instant tabs over one shared fetch ·
                  all SSE-live, no login. The legacy /live scoreboard redirects
                  to Matches (live matches pin into its Now-playing band). */}
              <Route path="/t/:slug/:id/schedule" element={<PublicSchedulePage />} />
              <Route
                path="/t/:slug/:id/standings"
                element={<PublicStandingsPage />}
              />
              <Route path="/t/:slug/:id/live" element={<PublicLiveRedirect />} />
              <Route path="/t/:slug/:id/bracket" element={<PublicBracketPage />} />
              <Route path="/t/:slug/:id/team/:teamId" element={<PublicTeamPage />} />
              <Route path="/explore" element={<ExplorePage />} />
              <Route path="/cert/:awardId" element={<CertificatePage />} />
              <Route path="/t/:slug/:id/display" element={<VenueDisplayPage />} />

              {/* Protected surfaces — share the AppShell chrome. */}
              <Route
                element={
                  <ProtectedRoute>
                    <AppShell />
                  </ProtectedRoute>
                }
              >
                <Route path="/orgs" element={<OrgChooserPage />} />
                <Route path="/invites" element={<InvitesPage />} />
                <Route path="/tournaments" element={<TournamentsListPage />} />
                <Route
                  path="/tournaments/new"
                  element={<CreateTournamentPage />}
                />
                <Route path="/tournaments/:id" element={<TournamentWorkspace />}>
                  <Route index element={<FlowLanding />} />
                  <Route path="overview" element={<OverviewTab />} />
                  <Route path="sports" element={<SportsTab />} />
                  <Route path="forms" element={<FormsListPage />} />
                  <Route path="institutions" element={<InstitutionsTab />} />
                  <Route path="teams" element={<TeamsTab />} />
                  <Route path="members" element={<TournamentMembersPage />} />
                  <Route path="fixtures" element={<FixturesTab />} />
                  {/* Live-ops cockpit (control room spec 2026-06-12) — the
                      post-generation home + the rest of the Operations group. */}
                  <Route path="control" element={<ControlRoomPage />} />
                  <Route path="matches" element={<MatchesBoardPage />} />
                  <Route path="standings" element={<OpsStandingsPage />} />
                  <Route path="crew" element={<CrewPage />} />
                  <Route path="leaders" element={<LeadersPage />} />
                  <Route path="changes" element={<ChangeHistoryPage />} />
                  <Route path="settings" element={<SettingsRoute />} />
                </Route>
                <Route
                  path="/tournaments/:id/bracket"
                  element={<BracketPage />}
                />
                {/* Full-page dry-run preview (fixture-engine redesign §6.5). */}
                <Route
                  path="/tournaments/:id/fixtures/preview"
                  element={<DryRunPreviewPage />}
                />
                <Route
                  path="/tournaments/:id/audit"
                  element={<TournamentAuditPage />}
                />
                <Route
                  path="/tournaments/:id/matches/:matchId"
                  element={<MatchConsolePage />}
                />
                <Route
                  path="/tournaments/:id/forms/:formId/edit"
                  element={<FormBuilderPage />}
                />
                <Route
                  path="/tournaments/:id/forms/:formId/responses"
                  element={<ResponsesPage />}
                />

                {/* Personal / role-agnostic. */}
                <Route path="/me" element={<MyProfilePage />} />
                <Route
                  path="/me/notifications"
                  element={<NotificationPrefsPage />}
                />

                {/* Org-scoped. */}
                <Route
                  path="/o/:orgSlug/dashboard"
                  element={<OrgDashboardPage />}
                />
                <Route
                  path="/o/:orgSlug/members"
                  element={<MemberDirectoryPage />}
                />
                <Route
                  path="/o/:orgSlug/permissions"
                  element={<ModuleMatrixPage />}
                />

                {/* Role-specific landings (B5 / Phase 1B placeholders). */}
                <Route
                  path="/o/:orgSlug/scoring"
                  element={<ScorerLandingPage />}
                />
                <Route
                  path="/o/:orgSlug/referee"
                  element={<RefereeLandingPage />}
                />
                <Route
                  path="/o/:orgSlug/team"
                  element={<TeamManagerLandingPage />}
                />

                {/* Phase 1A placeholders for surfaces that ship in Phase 1B. */}
                <Route
                  path="/o/:orgSlug/audit"
                  element={<OrgAuditLogPage />}
                />
                <Route
                  path="/o/:orgSlug/settings"
                  element={<OrgSettingsPage />}
                />
                {/* Institution operator surface (P4): seasons + house points. */}
                <Route
                  path="/o/:orgSlug/houses"
                  element={<HousePointsPage />}
                />
                <Route
                  path="/o/:orgSlug/branding"
                  element={<OrgBrandingPage />}
                />
                <Route
                  path="/o/:orgSlug/tournaments-coming-soon"
                  element={<ComingSoonPage feature={t("Tournaments")} />}
                />
              </Route>

              {/* Friendly catch-all. */}
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
            </Suspense>
          </BrowserRouter>
        </ErrorBoundary>
      </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
