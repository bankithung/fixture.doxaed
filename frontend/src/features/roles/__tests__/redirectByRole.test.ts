import { describe, expect, it } from "vitest";
import { pickLandingPathForUser } from "../redirectByRole";
import type { OrgMembership, User } from "@/types/user";

/**
 * Build a `User` with a single membership carrying `roles`. We cast
 * through `unknown` for roles because the v1Users.md catalog
 * (match_scorer, co_organizer, etc.) is wider than the legacy `Role`
 * union in `types/user.ts`. The redirect helper itself widens to
 * `string[]`, so this is the contract under test.
 */
function userWithRoles(
  roles: string[],
  opts: {
    slug?: string;
    extraMemberships?: OrgMembership[];
    lastActiveSlug?: string | null;
  } = {},
): User {
  const slug = opts.slug ?? "acme";
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
    last_active_org_slug:
      opts.lastActiveSlug === undefined ? slug : opts.lastActiveSlug,
    memberships: [m, ...(opts.extraMemberships ?? [])],
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

describe("pickLandingPathForUser", () => {
  it("routes user with no memberships to /orgs", () => {
    expect(pickLandingPathForUser(emptyUser())).toBe("/orgs");
  });

  it("routes admin to org dashboard", () => {
    expect(pickLandingPathForUser(userWithRoles(["admin"]))).toBe(
      "/o/acme/dashboard",
    );
  });

  it("routes owner to org dashboard", () => {
    expect(pickLandingPathForUser(userWithRoles(["owner"]))).toBe(
      "/o/acme/dashboard",
    );
  });

  it("routes co_organizer to org dashboard (B2 dashboard handles module gating)", () => {
    expect(pickLandingPathForUser(userWithRoles(["co_organizer"]))).toBe(
      "/o/acme/dashboard",
    );
  });

  it("routes game_coordinator to org dashboard", () => {
    expect(pickLandingPathForUser(userWithRoles(["game_coordinator"]))).toBe(
      "/o/acme/dashboard",
    );
  });

  it("routes match_scorer to /scoring", () => {
    expect(pickLandingPathForUser(userWithRoles(["match_scorer"]))).toBe(
      "/o/acme/scoring",
    );
  });

  it("routes referee to /referee", () => {
    expect(pickLandingPathForUser(userWithRoles(["referee"]))).toBe(
      "/o/acme/referee",
    );
  });

  it("routes team_manager to /team", () => {
    expect(pickLandingPathForUser(userWithRoles(["team_manager"]))).toBe(
      "/o/acme/team",
    );
  });

  it("multi-role: admin + match_scorer prefers admin (dashboard)", () => {
    expect(
      pickLandingPathForUser(userWithRoles(["admin", "match_scorer"])),
    ).toBe("/o/acme/dashboard");
  });

  it("multi-role: match_scorer + referee prefers scorer landing", () => {
    expect(
      pickLandingPathForUser(userWithRoles(["match_scorer", "referee"])),
    ).toBe("/o/acme/scoring");
  });

  it("multi-role: referee + team_manager prefers referee landing", () => {
    expect(
      pickLandingPathForUser(userWithRoles(["referee", "team_manager"])),
    ).toBe("/o/acme/referee");
  });

  it("unknown / viewer / guest role falls through to dashboard", () => {
    expect(pickLandingPathForUser(userWithRoles(["viewer"]))).toBe(
      "/o/acme/dashboard",
    );
    expect(pickLandingPathForUser(userWithRoles([]))).toBe(
      "/o/acme/dashboard",
    );
  });

  it("honours last_active_org_slug when present and matching", () => {
    const second: OrgMembership = {
      org_id: "o2",
      org_slug: "globex",
      org_name: "Globex",
      roles: ["match_scorer"] as unknown as OrgMembership["roles"],
      is_org_owner: false,
      effective_modules: [],
    };
    const u = userWithRoles(["admin"], {
      slug: "acme",
      extraMemberships: [second],
      lastActiveSlug: "globex",
    });
    // last-active is globex (where they're a scorer), so we land on scoring.
    expect(pickLandingPathForUser(u)).toBe("/o/globex/scoring");
  });

  it("falls back to first membership when last_active_org_slug is null", () => {
    const second: OrgMembership = {
      org_id: "o2",
      org_slug: "globex",
      org_name: "Globex",
      roles: ["referee"] as unknown as OrgMembership["roles"],
      is_org_owner: false,
      effective_modules: [],
    };
    const u = userWithRoles(["admin"], {
      slug: "acme",
      extraMemberships: [second],
      lastActiveSlug: null,
    });
    expect(pickLandingPathForUser(u)).toBe("/o/acme/dashboard");
  });

  it("encodes org slug in produced paths", () => {
    expect(
      pickLandingPathForUser(
        userWithRoles(["match_scorer"], { slug: "acme & sons" }),
      ),
    ).toBe(`/o/${encodeURIComponent("acme & sons")}/scoring`);
  });
});
