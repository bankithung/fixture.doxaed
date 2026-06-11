import { describe, expect, it } from "vitest";
import { pickLandingPathForUser } from "../redirectByRole";
import type { OrgMembership, User } from "@/types/user";

/**
 * Build a `User` with a single membership carrying `roles`. We cast
 * through `unknown` for roles because the v1Users.md catalog
 * (match_scorer, co_organizer, etc.) is wider than the legacy `Role`
 * union in `types/user.ts`.
 */
function userWithRoles(roles: string[], slug = "acme"): User {
  const m: OrgMembership = {
    org_id: "o1",
    org_slug: slug,
    org_name: "Acme",
    roles: roles as unknown as OrgMembership["roles"],
    is_org_owner: roles.includes("owner"),
    effective_modules: [],
  };
  return {
    id: "u1",
    email: "x@example.com",
    name: "X",
    is_superuser: false,
    has_2fa_enrolled: false,
    twofa_enrolled_at: null,
    email_verified_at: null,
    last_active_org_id: "o1",
    last_active_org_slug: slug,
    memberships: [m],
    deleted_at: null,
  };
}

function emptyUser(): User {
  return {
    id: "u1",
    email: "x@example.com",
    name: "X",
    is_superuser: false,
    has_2fa_enrolled: false,
    twofa_enrolled_at: null,
    email_verified_at: null,
    last_active_org_id: null,
    last_active_org_slug: null,
    memberships: [],
    deleted_at: null,
  };
}

/**
 * Root pages are individual-level (owner decision 2026-06-11): every account
 * lands on the personal Dashboard regardless of org memberships or roles.
 * Roles only matter INSIDE a tournament. The org-scoped pages (dashboard,
 * scoring, referee, team) remain reachable by URL — they're just not the
 * login landing anymore.
 */
describe("pickLandingPathForUser", () => {
  it("routes user with no memberships to the personal dashboard", () => {
    expect(pickLandingPathForUser(emptyUser())).toBe("/orgs");
  });

  it.each([
    [["owner"]],
    [["admin"]],
    [["co_organizer"]],
    [["game_coordinator"]],
    [["match_scorer"]],
    [["referee"]],
    [["team_manager"]],
    [["viewer"]],
    [[]],
    [["admin", "match_scorer"]],
  ])("routes %j to the personal dashboard too", (roles) => {
    expect(pickLandingPathForUser(userWithRoles(roles as string[]))).toBe(
      "/orgs",
    );
  });
});
