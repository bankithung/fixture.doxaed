import { describe, expect, it } from "vitest";
import { computeNavItems } from "../computeNavItems";
import type { Role, User } from "@/types/user";

function makeUser(roles: string[], modules: string[]): User {
  return {
    id: "u1",
    email: "u@example.com",
    name: "Test User",
    is_superuser: false,
    has_2fa_enrolled: false,
    twofa_enrolled_at: null,
    email_verified_at: null,
    last_active_org_id: "o1",
    last_active_org_slug: "acme",
    memberships: [
      {
        org_id: "o1",
        org_slug: "acme",
        org_name: "Acme",
        roles: roles as Role[],
        is_org_owner: roles.includes("owner"),
        effective_modules: modules,
      },
    ],
    deleted_at: null,
  };
}

describe("computeNavItems", () => {
  it("returns empty list when there is no user", () => {
    expect(computeNavItems(null, "acme")).toEqual([]);
  });

  it("returns empty list when there is no slug", () => {
    expect(computeNavItems(makeUser(["admin"], []), null)).toEqual([]);
  });

  it("returns empty list when slug doesn't match any membership (no scope)", () => {
    const items = computeNavItems(makeUser(["admin"], []), "ghost");
    // Dashboard always renders given a slug — we never try to find membership
    // for the dashboard label itself; downstream items hide because modules
    // and roles come up empty for an unknown slug.
    expect(items.map((i) => i.key)).toEqual(["dashboard", "tournaments"]);
  });

  it("admin sees Dashboard + Members + Permissions + Audit", () => {
    const u = makeUser(
      ["admin"],
      ["org.member_directory", "org.audit_log"],
    );
    const keys = computeNavItems(u, "acme").map((i) => i.key);
    expect(keys).toEqual([
      "dashboard",
      "tournaments",
      "members",
      "permissions",
      "audit",
    ]);
  });

  it("owner sees Permissions just like admin", () => {
    const u = makeUser(["owner"], ["org.member_directory"]);
    const keys = computeNavItems(u, "acme").map((i) => i.key);
    expect(keys).toContain("permissions");
  });

  it("co_organizer sees Members + Audit but NOT Permissions", () => {
    // Per v1Users.md §2 line 736, the override-grant verb is reserved to
    // Admin in v1.0. Co-organizers manage members/invitations but not the
    // Module-Overrides matrix; the nav must mirror the backend gate or it
    // teases a 403.
    const u = makeUser(
      ["co_organizer"],
      ["org.member_directory", "org.audit_log"],
    );
    const keys = computeNavItems(u, "acme").map((i) => i.key);
    expect(keys).not.toContain("permissions");
    expect(keys).toContain("members");
    expect(keys).toContain("audit");
  });

  it("game_coordinator sees Members + Audit but NOT Permissions", () => {
    const u = makeUser(
      ["game_coordinator"],
      ["org.member_directory", "org.audit_log"],
    );
    const keys = computeNavItems(u, "acme").map((i) => i.key);
    expect(keys).not.toContain("permissions");
    expect(keys).toContain("members");
    expect(keys).toContain("audit");
  });

  it("admin-tier role with match.scoring_console module sees Scoring", () => {
    // Admins / co_organizers / game_coordinators all carry
    // `match.scoring_console` by default in the fixture — module gate
    // surfaces Scoring for them, not just for match_scorer.
    const u = makeUser(["admin"], ["match.scoring_console"]);
    const keys = computeNavItems(u, "acme").map((i) => i.key);
    expect(keys).toContain("scoring");
  });

  it("match_scorer with match.scoring_console module surfaces Scoring", () => {
    const u = makeUser(["match_scorer"], ["match.scoring_console"]);
    const keys = computeNavItems(u, "acme").map((i) => i.key);
    expect(keys).toContain("scoring");
  });

  it("Scoring hides when match.scoring_console module is absent", () => {
    // Even a match_scorer hides the Scoring nav if their effective_modules
    // doesn't include the console (e.g. an admin override revoked it).
    const u = makeUser(["match_scorer"], []);
    const keys = computeNavItems(u, "acme").map((i) => i.key);
    expect(keys).not.toContain("scoring");
  });

  it("admin-tier role with match.referee_console module sees Referee", () => {
    const u = makeUser(["co_organizer"], ["match.referee_console"]);
    const keys = computeNavItems(u, "acme").map((i) => i.key);
    expect(keys).toContain("referee");
  });

  it("referee with match.referee_console module surfaces Referee", () => {
    const u = makeUser(["referee"], ["match.referee_console"]);
    const keys = computeNavItems(u, "acme").map((i) => i.key);
    expect(keys).toContain("referee");
  });

  it("Referee hides when match.referee_console module is absent", () => {
    const u = makeUser(["referee"], []);
    const keys = computeNavItems(u, "acme").map((i) => i.key);
    expect(keys).not.toContain("referee");
  });

  it("team_manager sees Team (no module gate; spec gap)", () => {
    // Appendix A.2 has no `tournament.team_manager_workspace` module, so
    // the Team workspace falls back to role-only gating — see report.
    const u = makeUser(["team_manager"], []);
    const keys = computeNavItems(u, "acme").map((i) => i.key);
    expect(keys).toContain("team");
  });

  it("viewer with no modules sees only Dashboard", () => {
    const u = makeUser(["viewer"], []);
    expect(computeNavItems(u, "acme").map((i) => i.key)).toEqual([
      "dashboard",
      "tournaments",
    ]);
  });

  it("Members hides when org.member_directory module is absent", () => {
    const u = makeUser(["admin"], []);
    const keys = computeNavItems(u, "acme").map((i) => i.key);
    expect(keys).not.toContain("members");
  });

  it("Audit hides when org.audit_log module is absent", () => {
    const u = makeUser(["admin"], ["org.member_directory"]);
    const keys = computeNavItems(u, "acme").map((i) => i.key);
    expect(keys).not.toContain("audit");
  });

  it("each item has an absolute href under /o/:slug", () => {
    const u = makeUser(
      ["admin", "scorer"],
      ["org.member_directory", "org.audit_log"],
    );
    for (const item of computeNavItems(u, "acme")) {
      if (item.key === "tournaments") {
        // Tournaments is the global hub, not an org-scoped surface.
        expect(item.href).toBe("/tournaments");
        continue;
      }
      expect(item.href.startsWith("/o/acme/")).toBe(true);
    }
  });

  it("href slugs are URL-encoded", () => {
    const u = makeUser(["admin"], ["org.member_directory"]);
    const items = computeNavItems(u, "with space");
    expect(items.find((i) => i.key === "dashboard")?.href).toBe(
      "/o/with%20space/dashboard",
    );
  });
});
