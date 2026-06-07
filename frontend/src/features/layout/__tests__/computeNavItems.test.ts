import { describe, expect, it } from "vitest";
import {
  computeTournamentNav,
  computeWorkspaceNav,
  type NavGroup,
} from "../computeNavItems";
import { routes } from "@/lib/routes";
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

/** Flatten groups to a {groupKey, itemKey} order for compact assertions. */
function flatKeys(groups: NavGroup[]): string[] {
  return groups.flatMap((g) => g.items.map((i) => i.key));
}

function groupKeys(groups: NavGroup[]): string[] {
  return groups.map((g) => g.key);
}

describe("computeWorkspaceNav", () => {
  it("returns no groups when there is no user", () => {
    expect(computeWorkspaceNav(null, "acme")).toEqual([]);
  });

  it("returns no groups when there is no slug", () => {
    expect(computeWorkspaceNav(makeUser(["admin"], []), null)).toEqual([]);
  });

  it("unknown slug → only the Workspace group (Dashboard + Tournaments)", () => {
    // Dashboard/Tournaments always render given a slug; the Admin group hides
    // because modules + roles come up empty for an unknown slug.
    const groups = computeWorkspaceNav(makeUser(["admin"], []), "ghost");
    expect(groupKeys(groups)).toEqual(["workspace"]);
    expect(flatKeys(groups)).toEqual(["dashboard", "tournaments"]);
  });

  it("admin sees Workspace (Dashboard+Tournaments) + Admin (Members+Permissions+Audit+Settings)", () => {
    const u = makeUser(["admin"], ["org.member_directory", "org.audit_log"]);
    const groups = computeWorkspaceNav(u, "acme");
    expect(groupKeys(groups)).toEqual(["workspace", "admin"]);
    expect(flatKeys(groups)).toEqual([
      "dashboard",
      "tournaments",
      "members",
      "permissions",
      "audit",
      "settings",
    ]);
  });

  it("owner sees Permissions + Settings just like admin", () => {
    const u = makeUser(["owner"], ["org.member_directory"]);
    const keys = flatKeys(computeWorkspaceNav(u, "acme"));
    expect(keys).toContain("permissions");
    expect(keys).toContain("settings");
  });

  it("co_organizer sees Members + Audit but NOT Permissions/Settings", () => {
    // Per v1Users.md §2 line 736 the override-grant verb is reserved to Admin
    // in v1.0; co-organizers manage members but not the override matrix or
    // org settings — the nav must mirror the backend gate.
    const u = makeUser(
      ["co_organizer"],
      ["org.member_directory", "org.audit_log"],
    );
    const keys = flatKeys(computeWorkspaceNav(u, "acme"));
    expect(keys).toContain("members");
    expect(keys).toContain("audit");
    expect(keys).not.toContain("permissions");
    expect(keys).not.toContain("settings");
  });

  it("game_coordinator sees Members + Audit but NOT Permissions/Settings", () => {
    const u = makeUser(
      ["game_coordinator"],
      ["org.member_directory", "org.audit_log"],
    );
    const keys = flatKeys(computeWorkspaceNav(u, "acme"));
    expect(keys).toContain("members");
    expect(keys).toContain("audit");
    expect(keys).not.toContain("permissions");
  });

  it("viewer with no modules sees only the Workspace group", () => {
    const groups = computeWorkspaceNav(makeUser(["viewer"], []), "acme");
    expect(groupKeys(groups)).toEqual(["workspace"]);
    expect(flatKeys(groups)).toEqual(["dashboard", "tournaments"]);
  });

  it("Members hides when org.member_directory module is absent", () => {
    const keys = flatKeys(computeWorkspaceNav(makeUser(["admin"], []), "acme"));
    expect(keys).not.toContain("members");
  });

  it("Audit hides when org.audit_log module is absent", () => {
    const keys = flatKeys(
      computeWorkspaceNav(makeUser(["admin"], ["org.member_directory"]), "acme"),
    );
    expect(keys).not.toContain("audit");
  });

  it("Admin group is omitted entirely when no admin item qualifies", () => {
    // A viewer has no admin modules and isn't owner/admin → no Admin group.
    const groups = computeWorkspaceNav(makeUser(["viewer"], []), "acme");
    expect(groupKeys(groups)).not.toContain("admin");
  });

  it("dashboard links to the org dashboard; tournaments to the global hub", () => {
    const groups = computeWorkspaceNav(makeUser(["admin"], []), "acme");
    const items = groups.flatMap((g) => g.items);
    expect(items.find((i) => i.key === "dashboard")?.href).toBe(
      routes.orgDashboard("acme"),
    );
    expect(items.find((i) => i.key === "tournaments")?.href).toBe(
      routes.tournaments(),
    );
  });

  it("admin items resolve to their org-scoped routes", () => {
    const u = makeUser(["admin"], ["org.member_directory", "org.audit_log"]);
    const items = computeWorkspaceNav(u, "acme").flatMap((g) => g.items);
    expect(items.find((i) => i.key === "members")?.href).toBe(
      routes.orgMembers("acme"),
    );
    expect(items.find((i) => i.key === "permissions")?.href).toBe(
      routes.orgPermissions("acme"),
    );
    expect(items.find((i) => i.key === "audit")?.href).toBe(
      routes.orgAudit("acme"),
    );
    expect(items.find((i) => i.key === "settings")?.href).toBe(
      routes.orgSettings("acme"),
    );
  });

  it("href slugs are URL-encoded", () => {
    const u = makeUser(["admin"], ["org.member_directory"]);
    const items = computeWorkspaceNav(u, "with space").flatMap((g) => g.items);
    expect(items.find((i) => i.key === "dashboard")?.href).toBe(
      "/o/with%20space/dashboard",
    );
  });
});

describe("computeTournamentNav", () => {
  const TID = "tour-1";

  it("returns no groups when there is no tournament id", () => {
    expect(
      computeTournamentNav("", { user: makeUser(["admin"], []), slug: "acme" }),
    ).toEqual([]);
  });

  it("emits a single Manage group with Overview + Bracket (no forms module)", () => {
    const groups = computeTournamentNav(TID, {
      user: makeUser(["admin"], []),
      slug: "acme",
    });
    expect(groupKeys(groups)).toEqual(["manage"]);
    expect(flatKeys(groups)).toEqual(["overview", "bracket"]);
  });

  it("includes Registration forms when the forms module is granted", () => {
    const groups = computeTournamentNav(TID, {
      user: makeUser(["admin"], ["forms"]),
      slug: "acme",
    });
    expect(flatKeys(groups)).toEqual(["overview", "forms", "bracket"]);
  });

  it("hides Registration forms when the forms module is absent", () => {
    const groups = computeTournamentNav(TID, {
      user: makeUser(["admin"], ["org.member_directory"]),
      slug: "acme",
    });
    expect(flatKeys(groups)).not.toContain("forms");
  });

  it("hides Registration forms when org membership can't be resolved", () => {
    const groups = computeTournamentNav(TID, {
      user: makeUser(["admin"], ["forms"]),
      slug: null,
    });
    expect(flatKeys(groups)).not.toContain("forms");
  });

  it("links Overview / Forms / Bracket to the right routes", () => {
    const items = computeTournamentNav(TID, {
      user: makeUser(["admin"], ["forms"]),
      slug: "acme",
    }).flatMap((g) => g.items);
    expect(items.find((i) => i.key === "overview")?.href).toBe(
      routes.tournamentDetail(TID),
    );
    expect(items.find((i) => i.key === "forms")?.href).toBe(
      routes.tournamentForms(TID),
    );
    expect(items.find((i) => i.key === "bracket")?.href).toBe(
      routes.tournamentBracket(TID),
    );
  });
});
