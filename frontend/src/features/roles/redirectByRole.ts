import type { User } from "@/types/user";
import { routes } from "@/lib/routes";

/**
 * Given an authenticated user, decide where they should land after login
 * (or after the implicit `/` redirect from `RootRedirect`).
 *
 * Everyone lands on the personal Dashboard (`/orgs`). Accounts are
 * individual (owner decision 2026-06-11): the root pages — Dashboard,
 * Tournaments, Invites — are the same for every user, and ROLES ONLY MATTER
 * INSIDE A TOURNAMENT, where the rail/tabs are gated by the
 * tournament-scoped roles the organiser assigned. The dashboard lists the
 * user's tournaments (owned or invited), pending invites, and their
 * workspace cards — the org-stats view stays one click away for organisers.
 *
 * This replaced the Phase-1A role-aware fork (admin → org dashboard,
 * match_scorer → /scoring, referee → /referee, team_manager → /team): an
 * account's landing surface kept changing shape the moment they created or
 * joined a workspace, which read as a bug ("why is the dashboard different
 * for different users?"). Those org-scoped pages remain reachable by URL.
 *
 * NOTE: Super-admin (platform staff) is *not* handled here — they go to
 * `sadmin.fixture.doxaed.com/`, which is a separate Django+HTMX surface.
 */
export function pickLandingPathForUser(_user: User): string {
  return routes.orgChooser();
}
