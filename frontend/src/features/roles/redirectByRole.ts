import type { User } from "@/types/user";
import { routes } from "@/lib/routes";

/**
 * Given an authenticated user, decide where they should land after login
 * (or after the implicit `/` redirect from `RootRedirect`).
 *
 * Decision order (first-match-wins, by primary membership):
 *   1. No membership → `/orgs` (chooser).
 *   2. Admin-like (`admin` / `co_organizer` / `game_coordinator`) →
 *      `/o/<slug>/dashboard` (B2 owns the dashboard; cards are gated by
 *      `effective_modules` so a co_organizer sees the right subset).
 *   3. `match_scorer` → `/o/<slug>/scoring` (Phase 1A placeholder).
 *   4. `referee` → `/o/<slug>/referee` (Phase 1A placeholder).
 *   5. `team_manager` → `/o/<slug>/team` (Phase 1A placeholder).
 *   6. Any other role → org dashboard fallback.
 *
 * NOTE: Super-admin (platform staff) is *not* handled here — they go to
 * `sadmin.fixture.doxaed.com/`, which is a separate Django+HTMX surface.
 *
 * "Primary" membership = `last_active_org_slug` if set, else the first
 * membership in the array. We compare role strings via `string` rather
 * than the narrow `Role` union because the v1Users.md role catalog
 * (match_scorer, co_organizer, game_coordinator, team_manager) is wider
 * than the legacy `Role` union and the server can hand back any of them.
 */
export function pickLandingPathForUser(user: User): string {
  const memberships = user.memberships ?? [];
  if (memberships.length === 0) return routes.orgChooser();

  // Prefer the membership flagged as "last active"; fall back to first.
  const preferredSlug = user.last_active_org_slug;
  const m =
    (preferredSlug
      ? memberships.find((mm) => mm.org_slug === preferredSlug)
      : null) ?? memberships[0];

  const roles: string[] = (m.roles as string[] | undefined) ?? [];
  const isOwner = m.is_org_owner === true || roles.includes("owner");

  if (
    isOwner ||
    roles.includes("admin") ||
    roles.includes("co_organizer") ||
    roles.includes("game_coordinator")
  ) {
    return routes.orgDashboard(m.org_slug);
  }

  if (roles.includes("match_scorer")) return routes.orgScoring(m.org_slug);
  if (roles.includes("referee")) return routes.orgReferee(m.org_slug);
  if (roles.includes("team_manager")) return routes.orgTeam(m.org_slug);

  // Unknown / viewer / guest → dashboard (it gracefully renders modules).
  return routes.orgDashboard(m.org_slug);
}
