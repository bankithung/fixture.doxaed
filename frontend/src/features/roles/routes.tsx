import type { RouteObject } from "react-router-dom";
import { ScorerLandingPage } from "./ScorerLandingPage";
import { RefereeLandingPage } from "./RefereeLandingPage";
import { TeamManagerLandingPage } from "./TeamManagerLandingPage";
import { MyProfilePage } from "./MyProfilePage";
import { NotificationPrefsPage } from "./NotificationPrefsPage";

/**
 * Route configuration for the role-landing + profile surfaces.
 *
 * Spread into the protected `<AppShell>` route block in App.tsx by the
 * AppShell agent (B6). Owning the array here keeps the role pages and
 * their paths colocated, so future role-specific routes get added
 * alongside the page they belong to.
 *
 * NOTE: B6 owns App.tsx, so this module is plain data — it does not
 * call into React Router itself.
 */
export const roleRoutes: RouteObject[] = [
  { path: "/o/:orgSlug/scoring", element: <ScorerLandingPage /> },
  { path: "/o/:orgSlug/referee", element: <RefereeLandingPage /> },
  { path: "/o/:orgSlug/team", element: <TeamManagerLandingPage /> },
  { path: "/me", element: <MyProfilePage /> },
  { path: "/me/notifications", element: <NotificationPrefsPage /> },
];
