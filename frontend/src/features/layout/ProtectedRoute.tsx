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
  // whole tournaments area (hub, self-serve create, AND every tournament
  // workspace — an invite-accepted user holds a TournamentMembership but, by
  // design, no org membership), their invites inbox, and their profile.
  // Prefix-matched: exact paths only would bounce /tournaments/:id back to
  // /orgs, making invited tournaments unopenable. Org-scoped pages (/o/:slug)
  // stay membership-gated. Server-side isolation (accessible_tournaments)
  // remains the real access check — this gate is purely navigational.
  const ORG_OPTIONAL_PREFIXES = [
    routes.orgChooser(),
    routes.tournaments(),
    routes.invites(),
    "/me",
  ];
  const orgOptional = ORG_OPTIONAL_PREFIXES.some(
    (prefix) =>
      location.pathname === prefix ||
      location.pathname.startsWith(`${prefix}/`),
  );
  const memberships = user.memberships ?? [];
  if (memberships.length === 0 && !user.is_superuser && !orgOptional) {
    return <Navigate to={routes.orgChooser()} replace />;
  }

  return <>{children}</>;
}
