import { useEffect } from "react";
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
import { CreateTournamentPage } from "@/features/tournaments/CreateTournamentPage";
import { TournamentsListPage } from "@/features/tournaments/TournamentsListPage";
import { TournamentWorkspace } from "@/features/tournaments/TournamentWorkspace";
import { OverviewTab } from "@/features/tournaments/tabs/OverviewTab";
import { FlowLanding } from "@/features/tournaments/FlowLanding";
import { SportsTab } from "@/features/tournaments/tabs/SportsTab";
import { InstitutionsTab } from "@/features/tournaments/tabs/InstitutionsTab";
import { TeamsTab } from "@/features/tournaments/tabs/TeamsTab";
import { FixturesTab } from "@/features/tournaments/tabs/FixturesTab";
import { SettingsRoute } from "@/features/tournaments/ops/SettingsRoute";
import { TournamentMembersPage } from "@/features/tournaments/TournamentMembersPage";
import { InvitesPage } from "@/features/invitations/InvitesPage";
import { TournamentAuditPage } from "@/features/tournaments/TournamentAuditPage";
import { MatchConsolePage } from "@/features/matches/MatchConsolePage";
import { ControlRoomPage } from "@/features/controlroom/ControlRoomPage";
import { MatchesBoardPage } from "@/features/tournaments/ops/MatchBoardPage";
import { OpsStandingsPage } from "@/features/tournaments/ops/OpsStandingsPage";
import { CrewPage } from "@/features/tournaments/ops/CrewPage";
import { BracketPage } from "@/features/tournaments/BracketPage";
import { DryRunPreviewPage } from "@/features/fixtures/DryRunPreviewPage";
import { PublicSchedulePage } from "@/features/fixtures/PublicSchedulePage";
import { RegistrationFormPage } from "@/features/registration/RegistrationFormPage";
import { FormsListPage } from "@/features/forms/FormsListPage";
import { FormBuilderPage } from "@/features/forms/FormBuilderPage";
import { ResponsesPage } from "@/features/forms/ResponsesPage";
import { PublicFormPage } from "@/features/forms/PublicFormPage";
import { PublicDirectoryPage } from "@/features/forms/PublicDirectoryPage";
import { LiveViewerPage } from "@/features/live/LiveViewerPage";
import { PublicLiveScoreboardPage } from "@/features/live/PublicLiveScoreboardPage";
import { PublicBracketPage } from "@/features/live/PublicBracketPage";
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
import { MemberDirectoryPage } from "@/features/orgs/MemberDirectoryPage";
import { OrgSettingsPage } from "@/features/orgs/OrgSettingsPage";
import { OrgBrandingPage } from "@/features/orgs/OrgBrandingPage";
import { OrgAuditLogPage } from "@/features/orgs/OrgAuditLogPage";
// Permissions (B4).
import { ModuleMatrixPage } from "@/features/permissions/ModuleMatrixPage";
// Roles (B5).
import { ScorerLandingPage } from "@/features/roles/ScorerLandingPage";
import { RefereeLandingPage } from "@/features/roles/RefereeLandingPage";
import { TeamManagerLandingPage } from "@/features/roles/TeamManagerLandingPage";
import { MyProfilePage } from "@/features/roles/MyProfilePage";
import { NotificationPrefsPage } from "@/features/roles/NotificationPrefsPage";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

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
              {/* Public read-only tournament views (trust layer): schedule,
                  live scoreboard, knockout bracket — all SSE-live, no login. */}
              <Route path="/t/:slug/:id/schedule" element={<PublicSchedulePage />} />
              <Route
                path="/t/:slug/:id/live"
                element={<PublicLiveScoreboardPage />}
              />
              <Route path="/t/:slug/:id/bracket" element={<PublicBracketPage />} />

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
          </BrowserRouter>
        </ErrorBoundary>
      </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
