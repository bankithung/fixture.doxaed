import { describe, expect, it } from "vitest";
import {
  computeDashboardCards,
  MODULES,
  type DashboardCardKey,
} from "../dashboardCards";
import type { OrgMembership, User } from "@/types/user";

function makeUser(): User {
  return {
    id: "u1",
    email: "x@example.com",
    name: "Test User",
    is_superuser: false,
    has_2fa_enrolled: false,
    twofa_enrolled_at: null,
    email_verified_at: null,
    last_active_org_id: "o1",
    last_active_org_slug: "acme",
    memberships: [],
    deleted_at: null,
  };
}

function makeMembership(
  roles: string[],
  effective_modules: string[],
): OrgMembership {
  return {
    org_id: "o1",
    org_slug: "acme",
    org_name: "Acme",
    // The Role union is narrower than what real backend roles look like;
    // tests deliberately exercise the wider catalog (admin, co_organizer,
    // game_coordinator, match_scorer, team_manager).
    roles: roles as OrgMembership["roles"],
    is_org_owner: roles.includes("owner"),
    effective_modules,
  };
}

function keys(roles: string[], modules: string[]): DashboardCardKey[] {
  const user = makeUser();
  return computeDashboardCards({
    user,
    membership: makeMembership(roles, modules),
    slug: "acme",
  }).map((c) => c.key);
}

describe("computeDashboardCards", () => {
  it("admin sees Members + Settings + Permissions + Audit + Branding + Profile", () => {
    const adminModules = [
      MODULES.ORG_MEMBER_DIRECTORY,
      MODULES.ORG_SETTINGS,
      MODULES.ORG_AUDIT_LOG,
      MODULES.ORG_TOURNAMENT_LIST,
      MODULES.ORG_BRANDING,
      MODULES.PERSONAL_NOTIFICATION_PREFS,
      MODULES.PERSONAL_FEEDBACK_WIDGET,
    ];
    const result = keys(["admin"], adminModules);
    for (const expected of [
      "members",
      "settings",
      "permissions",
      "audit",
      "branding",
      "profile",
    ] as const) {
      expect(result).toContain(expected);
    }
  });

  it("co-organizer sees Members + Settings + Audit + Branding + Profile (no Permissions)", () => {
    const modules = [
      MODULES.ORG_MEMBER_DIRECTORY,
      MODULES.ORG_SETTINGS,
      MODULES.ORG_AUDIT_LOG,
      MODULES.ORG_TOURNAMENT_LIST,
      MODULES.ORG_BRANDING,
      MODULES.PERSONAL_NOTIFICATION_PREFS,
      MODULES.PERSONAL_FEEDBACK_WIDGET,
    ];
    const result = keys(["co_organizer"], modules);
    for (const expected of [
      "members",
      "settings",
      "audit",
      "branding",
      "profile",
    ] as const) {
      expect(result).toContain(expected);
    }
    // v1Users.md §2 line 736: override-grant verb reserved to Admin in v1.0.
    expect(result).not.toContain("permissions");
  });

  it("game-coordinator sees Members + Audit + Tournaments + Profile (no Permissions/Settings/Branding)", () => {
    const modules = [
      MODULES.ORG_MEMBER_DIRECTORY,
      MODULES.ORG_AUDIT_LOG,
      MODULES.ORG_TOURNAMENT_LIST,
      MODULES.PERSONAL_NOTIFICATION_PREFS,
      MODULES.PERSONAL_FEEDBACK_WIDGET,
    ];
    const result = keys(["game_coordinator"], modules);
    for (const expected of [
      "members",
      "audit",
      "tournaments",
      "profile",
    ] as const) {
      expect(result).toContain(expected);
    }
    expect(result).not.toContain("permissions");
    expect(result).not.toContain("settings");
    expect(result).not.toContain("branding");
  });

  it("scorer sees Profile + Notifications (no admin/audit/settings)", () => {
    const modules = [
      MODULES.ORG_TOURNAMENT_LIST,
      MODULES.PERSONAL_NOTIFICATION_PREFS,
      MODULES.PERSONAL_FEEDBACK_WIDGET,
    ];
    const result = keys(["match_scorer"], modules);
    expect(result).toContain("profile");
    expect(result).toContain("notifications");
    expect(result).not.toContain("members");
    expect(result).not.toContain("settings");
    expect(result).not.toContain("permissions");
    expect(result).not.toContain("audit");
    expect(result).not.toContain("branding");
  });

  it("referee sees Profile + Notifications", () => {
    const modules = [
      MODULES.ORG_AUDIT_LOG,
      MODULES.ORG_TOURNAMENT_LIST,
      MODULES.PERSONAL_NOTIFICATION_PREFS,
      MODULES.PERSONAL_FEEDBACK_WIDGET,
    ];
    const result = keys(["referee"], modules);
    expect(result).toContain("profile");
    expect(result).toContain("notifications");
    // Referee in fixture has org.audit_log default — assert it's there too;
    // but no admin-only cards.
    expect(result).not.toContain("permissions");
    expect(result).not.toContain("settings");
    expect(result).not.toContain("branding");
    expect(result).not.toContain("members");
  });

  it("team-manager sees Profile + Notifications", () => {
    const modules = [
      MODULES.ORG_TOURNAMENT_LIST,
      MODULES.PERSONAL_NOTIFICATION_PREFS,
      MODULES.PERSONAL_FEEDBACK_WIDGET,
    ];
    const result = keys(["team_manager"], modules);
    expect(result).toContain("profile");
    expect(result).toContain("notifications");
    expect(result).not.toContain("permissions");
    expect(result).not.toContain("settings");
    expect(result).not.toContain("members");
    expect(result).not.toContain("audit");
    expect(result).not.toContain("branding");
  });

  it("always emits a Profile card even with empty modules + no roles", () => {
    const result = keys([], []);
    expect(result).toContain("profile");
  });

  it("backward-compat: empty effective_modules + admin role still shows admin cards", () => {
    const result = keys(["admin"], []);
    expect(result).toContain("members");
    expect(result).toContain("settings");
    expect(result).toContain("permissions");
    expect(result).toContain("audit");
    expect(result).toContain("branding");
    expect(result).toContain("profile");
    expect(result).toContain("notifications");
  });

  it("backward-compat: empty modules + scorer role still shows profile + notifications", () => {
    const result = keys(["match_scorer"], []);
    expect(result).toContain("profile");
    expect(result).toContain("notifications");
    expect(result).not.toContain("permissions");
    expect(result).not.toContain("settings");
  });

  it("owner role (org creator) gets Permissions card", () => {
    const modules = [MODULES.PERSONAL_NOTIFICATION_PREFS];
    const result = keys(["owner"], modules);
    expect(result).toContain("permissions");
  });

  it("Tournaments card carries the Phase 1B badge", () => {
    const user = makeUser();
    const cards = computeDashboardCards({
      user,
      membership: makeMembership(["game_coordinator"], [
        MODULES.ORG_TOURNAMENT_LIST,
      ]),
      slug: "acme",
    });
    const tournaments = cards.find((c) => c.key === "tournaments");
    expect(tournaments?.badge).toBeDefined();
  });

  it("Feedback card uses the modal action (no href)", () => {
    const user = makeUser();
    const cards = computeDashboardCards({
      user,
      membership: makeMembership(["admin"], [MODULES.PERSONAL_FEEDBACK_WIDGET]),
      slug: "acme",
    });
    const feedback = cards.find((c) => c.key === "feedback");
    expect(feedback?.action).toBe("feedback");
    expect(feedback?.href).toBeUndefined();
  });

  it("null membership emits only the always-show Profile card", () => {
    const user = makeUser();
    const cards = computeDashboardCards({
      user,
      membership: null,
      slug: "acme",
    });
    expect(cards.map((c) => c.key)).toEqual(["profile", "notifications", "feedback"]);
  });
});
