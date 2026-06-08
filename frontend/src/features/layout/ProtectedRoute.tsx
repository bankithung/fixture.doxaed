import { Navigate, useLocation } from "react-router-dom";
import { useAuthStore } from "@/features/auth/authStore";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/**
 * Gate that ensures `user` is hydrated before rendering protected content.
 * Bootstrap is kicked off in main.tsx; this component just blocks until
 * `bootstrapped === true`, then either renders children or redirects.
 *
 * Redirect rules (B6 spec):
 *   1. Not bootstrapped → render a `role="status"` placeholder.
 *   2. `requires2FA` flag set without user → `/2fa/challenge`.
 *   3. No user → `/login?next=<original>`.
 *   4. Authenticated user with zero memberships AND not platform super-admin →
 *      `/orgs` (the chooser will surface the "no orgs yet" empty state).
 *      We skip this when already on `/orgs` to avoid a redirect loop.
 */
export function ProtectedRoute({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const user = useAuthStore((s) => s.user);
  const bootstrapped = useAuthStore((s) => s.bootstrapped);
  const requires2FA = useAuthStore((s) => s.requires2FA);
  const location = useLocation();

  if (!bootstrapped) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex min-h-screen items-center justify-center text-sm text-muted-foreground"
      >
        {t("Loading...")}
      </div>
    );
  }

  if (requires2FA && !user) {
    return <Navigate to={routes.twoFactorChallenge()} replace />;
  }

  if (!user) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`${routes.login()}?next=${next}`} replace />;
  }

  // Surfaces a brand-new (org-less) user must still reach: the chooser, the
  // tournaments hub, the self-serve "start a tournament" page (which
  // auto-provisions their workspace), their invites inbox, and their profile.
  // Without this allowlist the zero-membership redirect traps new users in a
  // loop — /orgs → "Start a tournament" → /tournaments/new → back to /orgs.
  const ORG_OPTIONAL_PATHS = new Set<string>([
    routes.orgChooser(),
    routes.tournaments(),
    routes.tournamentNew(),
    routes.invites(),
    "/me",
  ]);
  const memberships = user.memberships ?? [];
  if (
    memberships.length === 0 &&
    !user.is_superuser &&
    !ORG_OPTIONAL_PATHS.has(location.pathname)
  ) {
    return <Navigate to={routes.orgChooser()} replace />;
  }

  return <>{children}</>;
}
