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

  it("still shows the Workspace group when there is no slug (org-less user)", () => {
    // A brand-new user with no org yet must keep a usable sidebar. Dashboard
    // falls back to the workspace chooser; Tournaments + Invites are global.
    const groups = computeWorkspaceNav(makeUser(["admin"], []), null);
    expect(groupKeys(groups)).toEqual(["workspace"]);
    expect(flatKeys(groups)).toEqual(["dashboard", "tournaments", "invites"]);
    const dashboard = groups[0].items.find((i) => i.key === "dashboard");
    expect(dashboard?.href).toBe("/orgs");
  });

  it("is ONLY the Workspace group: Dashboard + Tournaments + Invites", () => {
    // The org-level Admin group (Members/Permissions/Audit/Settings) has been
    // removed from the primary nav — member/role management + audit now live
    // inside a tournament. Even an admin with every module sees just Workspace.
    const u = makeUser(["admin"], ["org.member_directory", "org.audit_log"]);
    const groups = computeWorkspaceNav(u, "acme");
    expect(groupKeys(groups)).toEqual(["workspace"]);
    expect(flatKeys(groups)).toEqual(["dashboard", "tournaments", "invites"]);
  });

  it("never surfaces an Admin group or its items", () => {
    const u = makeUser(["admin"], ["org.member_directory", "org.audit_log"]);
    const groups = computeWorkspaceNav(u, "acme");
    expect(groupKeys(groups)).not.toContain("admin");
    const keys = flatKeys(groups);
    expect(keys).not.toContain("members");
    expect(keys).not.toContain("permissions");
    expect(keys).not.toContain("audit");
    expect(keys).not.toContain("settings");
  });

  it("viewer with no modules sees only the Workspace group", () => {
    const groups = computeWorkspaceNav(makeUser(["viewer"], []), "acme");
    expect(groupKeys(groups)).toEqual(["workspace"]);
    expect(flatKeys(groups)).toEqual(["dashboard", "tournaments", "invites"]);
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

  it("includes an Invites item (after Tournaments) linking to the invites inbox", () => {
    const groups = computeWorkspaceNav(makeUser(["admin"], []), "acme");
    const keys = flatKeys(groups);
    // Invites comes immediately after Tournaments.
    expect(keys.indexOf("invites")).toBe(keys.indexOf("tournaments") + 1);
    const items = groups.flatMap((g) => g.items);
    expect(items.find((i) => i.key === "invites")?.href).toBe(routes.invites());
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

  it("emits a single Manage group with Overview + Bracket + Members + Audit (no forms module)", () => {
    const groups = computeTournamentNav(TID, {
      user: makeUser(["admin"], []),
      slug: "acme",
    });
    expect(groupKeys(groups)).toEqual(["manage"]);
    expect(flatKeys(groups)).toEqual([
      "overview",
      "bracket",
      "members",
      "audit",
    ]);
  });

  it("includes Registration forms when the forms module is granted", () => {
    const groups = computeTournamentNav(TID, {
      user: makeUser(["admin"], ["forms"]),
      slug: "acme",
    });
    expect(flatKeys(groups)).toEqual([
      "overview",
      "forms",
      "bracket",
      "members",
      "audit",
    ]);
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

  it("shows Members + Audit to anyone in tournament context (pages enforce manager-only)", () => {
    // Even a viewer with no modules sees Members + Audit — the Audit PAGE
    // enforces the manager gate (403 → friendly empty state).
    const groups = computeTournamentNav(TID, {
      user: makeUser(["viewer"], []),
      slug: "acme",
    });
    const keys = flatKeys(groups);
    expect(keys).toContain("members");
    expect(keys).toContain("audit");
  });

  it("links Overview / Forms / Bracket / Members / Audit to the right routes", () => {
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
    expect(items.find((i) => i.key === "members")?.href).toBe(
      routes.tournamentMembers(TID),
    );
    expect(items.find((i) => i.key === "audit")?.href).toBe(
      routes.tournamentAudit(TID),
    );
  });
});
