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
import { TournamentDetailPage } from "@/features/tournaments/TournamentDetailPage";
import { MatchConsolePage } from "@/features/matches/MatchConsolePage";
import { RegistrationFormPage } from "@/features/registration/RegistrationFormPage";
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

              {/* Protected surfaces — share the AppShell chrome. */}
              <Route
                element={
                  <ProtectedRoute>
                    <AppShell />
                  </ProtectedRoute>
                }
              >
                <Route path="/orgs" element={<OrgChooserPage />} />
                <Route path="/tournaments" element={<TournamentsListPage />} />
                <Route
                  path="/tournaments/new"
                  element={<CreateTournamentPage />}
                />
                <Route
                  path="/tournaments/:id"
                  element={<TournamentDetailPage />}
                />
                <Route
                  path="/tournaments/:id/matches/:matchId"
                  element={<MatchConsolePage />}
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
