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
    expect(computeWorkspaceNav(null)).toEqual([]);
  });

  it("shows the Workspace group for an org-less user", () => {
    // A brand-new user with no org yet must keep a usable sidebar.
    const groups = computeWorkspaceNav(makeUser(["admin"], []));
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
    const groups = computeWorkspaceNav(u);
    expect(groupKeys(groups)).toEqual(["workspace"]);
    expect(flatKeys(groups)).toEqual(["dashboard", "tournaments", "invites"]);
  });

  it("never surfaces an Admin group or its items", () => {
    const u = makeUser(["admin"], ["org.member_directory", "org.audit_log"]);
    const groups = computeWorkspaceNav(u);
    expect(groupKeys(groups)).not.toContain("admin");
    const keys = flatKeys(groups);
    expect(keys).not.toContain("members");
    expect(keys).not.toContain("permissions");
    expect(keys).not.toContain("audit");
    expect(keys).not.toContain("settings");
  });

  it("viewer with no modules sees only the Workspace group", () => {
    const groups = computeWorkspaceNav(makeUser(["viewer"], []));
    expect(groupKeys(groups)).toEqual(["workspace"]);
    expect(flatKeys(groups)).toEqual(["dashboard", "tournaments", "invites"]);
  });

  it("dashboard ALWAYS links to the personal dashboard, even for org admins", () => {
    // Root pages are individual-level (owner decision 2026-06-11): the
    // Dashboard never forks to the org-stats page based on memberships.
    const groups = computeWorkspaceNav(makeUser(["admin"], []));
    const items = groups.flatMap((g) => g.items);
    expect(items.find((i) => i.key === "dashboard")?.href).toBe(
      routes.orgChooser(),
    );
    expect(items.find((i) => i.key === "tournaments")?.href).toBe(
      routes.tournaments(),
    );
  });

  it("includes an Invites item (after Tournaments) linking to the invites inbox", () => {
    const groups = computeWorkspaceNav(makeUser(["admin"], []));
    const keys = flatKeys(groups);
    // Invites comes immediately after Tournaments.
    expect(keys.indexOf("invites")).toBe(keys.indexOf("tournaments") + 1);
    const items = groups.flatMap((g) => g.items);
    expect(items.find((i) => i.key === "invites")?.href).toBe(routes.invites());
  });
});

describe("computeTournamentNav", () => {
  const TID = "tour-1";

  it("returns no groups when there is no tournament id", () => {
    expect(
      computeTournamentNav("", { user: makeUser(["admin"], []), slug: "acme" }),
    ).toEqual([]);
  });

  const STAGE = {
    stage: "org_registration",
    can_manage: true,
    modules: [],
    order: ["setup", "org_registration", "team_registration", "members", "fixtures", "ready"],
    stages: [
      { key: "setup", label: "Setup" },
      { key: "org_registration", label: "Institution registration" },
      { key: "team_registration", label: "Team registration" },
      { key: "members", label: "Members & roles" },
      { key: "fixtures", label: "Fixtures" },
      { key: "ready", label: "Ready" },
    ],
  };

  it("emits a single Manage group with the tournament sections", () => {
    const groups = computeTournamentNav(TID, {
      user: makeUser(["admin"], []),
      slug: "acme",
    });
    expect(groupKeys(groups)).toEqual(["manage"]);
    expect(flatKeys(groups)).toEqual([
      "overview",
      "sports",
      "forms",
      "institutions",
      "teams",
      "members",
      "fixtures",
      "control",
      "lens",
      "settings",
    ]);
  });

  it("locks future-stage sections from the stage payload", () => {
    const items = computeTournamentNav(TID, {
      user: makeUser(["admin"], []),
      slug: "acme",
      stage: STAGE,
    }).flatMap((g) => g.items);
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    // At org_registration: forms + institutions reachable; teams + fixtures locked.
    expect(byKey.forms.locked).toBeFalsy();
    expect(byKey.institutions.locked).toBeFalsy();
    expect(byKey.teams.locked).toBe(true);
    expect(byKey.teams.lockLabel).toBe("Team registration");
    expect(byKey.fixtures.locked).toBe(true);
    // Always-available sections are never locked.
    expect(byKey.overview.locked).toBeFalsy();
    expect(byKey.members.locked).toBeFalsy();
    expect(byKey.settings.locked).toBeFalsy();
  });

  it("hides admin/editor sections from members whose modules don't cover them", () => {
    // A match_scorer: no manage flag, scoring-console module only.
    const items = computeTournamentNav(TID, {
      user: makeUser(["match_scorer"], []),
      slug: "acme",
      stage: { ...STAGE, can_manage: false, modules: ["match.scoring_console"] },
    }).flatMap((g) => g.items);
    const keys = items.map((i) => i.key);
    // read surfaces stay; admin/editor surfaces are hidden
    expect(keys).toContain("overview");
    expect(keys).toContain("fixtures");
    expect(keys).toContain("teams");
    expect(keys).not.toContain("members");
    expect(keys).not.toContain("settings");
    expect(keys).not.toContain("sports");
    expect(keys).not.toContain("forms");
  });

  it("shows editor sections to module-granted members", () => {
    // A game_coordinator: catalog grants editor/bracket/schedule/forms.
    const items = computeTournamentNav(TID, {
      user: makeUser(["game_coordinator"], []),
      slug: "acme",
      stage: {
        ...STAGE,
        can_manage: false,
        modules: ["tournament.editor", "forms", "tournament.bracket_editor"],
      },
    }).flatMap((g) => g.items);
    const keys = items.map((i) => i.key);
    expect(keys).toContain("sports");
    expect(keys).toContain("forms");
    expect(keys).toContain("settings");
    expect(keys).not.toContain("members"); // manager-only stays hidden
  });

  it("locks nothing when no stage payload is provided", () => {
    const items = computeTournamentNav(TID, {
      user: makeUser(["admin"], []),
      slug: "acme",
    }).flatMap((g) => g.items);
    expect(items.every((i) => !i.locked)).toBe(true);
  });

  it("Control room: locked until the stage is ready, then open to module holders", () => {
    // Mid-flow (org_registration): visible but locked, unlock label = Ready.
    const locked = computeTournamentNav(TID, {
      user: makeUser(["admin"], []),
      slug: "acme",
      stage: STAGE,
    }).flatMap((g) => g.items);
    const lockedItem = locked.find((i) => i.key === "control");
    expect(lockedItem?.locked).toBe(true);
    expect(lockedItem?.lockLabel).toBe("Ready");
    expect(lockedItem?.href).toBe(routes.tournamentControl(TID));

    // Stage ready: unlocked for a plain member holding the view module
    // (the catalog default for all six roles).
    const member = computeTournamentNav(TID, {
      user: makeUser(["match_scorer"], []),
      slug: "acme",
      stage: {
        ...STAGE,
        stage: "ready",
        can_manage: false,
        modules: ["match.center_admin_view", "match.scoring_console"],
      },
    }).flatMap((g) => g.items);
    const open = member.find((i) => i.key === "control");
    expect(open?.locked).toBeFalsy();
  });

  it("Control room is HIDDEN from members whose modules revoke the view", () => {
    const items = computeTournamentNav(TID, {
      user: makeUser(["team_manager"], []),
      slug: "acme",
      stage: {
        ...STAGE,
        stage: "ready",
        can_manage: false,
        modules: ["team.manager_portal"],
      },
    }).flatMap((g) => g.items);
    expect(items.map((i) => i.key)).not.toContain("control");
  });

  // --- Post-generation operations mode (stage `ready`) ---

  const readyStage = (
    over: { can_manage?: boolean; modules?: string[] } = {},
  ) => ({
    ...STAGE,
    stage: "ready",
    ...over,
  });

  it("at ready, the nav is Operations + Manage — no setup-flow pages", () => {
    const groups = computeTournamentNav(TID, {
      user: makeUser(["admin"], []),
      slug: "acme",
      stage: readyStage({ can_manage: true }),
    });
    expect(groupKeys(groups)).toEqual(["operations", "manage"]);
    const ops = groups.find((g) => g.key === "operations")!;
    expect(ops.items.map((i) => i.key)).toEqual([
      "control",
      "matches",
      "standings",
      "leaders",
      "crew",
      "directory",
      "lens",
      "public",
    ]);
    // Public page deep-links with the TOURNAMENT slug (slug+UUID pair) —
    // an org slug here 404s the public schedule (owner report 2026-07-02).
    const pub = ops.items.find((i) => i.key === "public")!;
    expect(pub.href).toBe(`/t/acme/${TID}/schedule`);
    // Only people + config remain; the setup-flow pages are gone from the nav.
    const manage = groups.find((g) => g.key === "manage")!;
    expect(manage.items.map((i) => i.key)).toEqual(["members", "settings"]);
    const allKeys = flatKeys(groups);
    for (const gone of ["overview", "sports", "forms", "institutions", "fixtures"]) {
      expect(allKeys).not.toContain(gone);
    }
  });

  it("ops-mode items are never stage-locked (all reachable at ready)", () => {
    const items = computeTournamentNav(TID, {
      user: makeUser(["admin"], []),
      slug: "acme",
      stage: readyStage({ can_manage: true }),
    }).flatMap((g) => g.items);
    expect(items.every((i) => !i.locked)).toBe(true);
  });

  it("a scorer at ready gets a trimmed Operations rail, no Setup admin items", () => {
    const groups = computeTournamentNav(TID, {
      user: makeUser(["match_scorer"], []),
      slug: "acme",
      stage: readyStage({
        can_manage: false,
        modules: ["match.center_admin_view", "match.scoring_console"],
      }),
    });
    const keys = flatKeys(groups);
    expect(keys).toContain("control");
    expect(keys).toContain("matches");
    expect(keys).toContain("standings");
    expect(keys).toContain("leaders");
    expect(keys).toContain("directory");
    // No schedule_editor → no assignment cockpit; no manage → no admin tabs.
    expect(keys).not.toContain("crew");
    expect(keys).not.toContain("members");
    expect(keys).not.toContain("sports");
    expect(keys).not.toContain("settings");
  });

  it("the coordinator (schedule_editor) gets the Officials & assignments item", () => {
    const items = computeTournamentNav(TID, {
      user: makeUser(["game_coordinator"], []),
      slug: "acme",
      stage: readyStage({
        can_manage: false,
        modules: ["match.center_admin_view", "tournament.schedule_editor"],
      }),
    }).flatMap((g) => g.items);
    expect(items.map((i) => i.key)).toContain("crew");
  });

  it("ops items link to their operations routes", () => {
    const items = computeTournamentNav(TID, {
      user: makeUser(["admin"], []),
      slug: "acme",
      stage: readyStage({ can_manage: true }),
    }).flatMap((g) => g.items);
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey.control.href).toBe(routes.tournamentControl(TID));
    expect(byKey.matches.href).toBe(routes.tournamentMatches(TID));
    expect(byKey.standings.href).toBe(routes.tournamentStandings(TID));
    expect(byKey.crew.href).toBe(routes.tournamentCrew(TID));
    expect(byKey.directory.href).toBe(routes.tournamentTeams(TID));
  });

  it("links sections to the right routes", () => {
    const items = computeTournamentNav(TID, {
      user: makeUser(["admin"], []),
      slug: "acme",
    }).flatMap((g) => g.items);
    expect(items.find((i) => i.key === "overview")?.href).toBe(routes.tournamentOverview(TID));
    expect(items.find((i) => i.key === "institutions")?.href).toBe(routes.tournamentInstitutions(TID));
    expect(items.find((i) => i.key === "teams")?.href).toBe(routes.tournamentTeams(TID));
    expect(items.find((i) => i.key === "members")?.href).toBe(routes.tournamentMembers(TID));
    expect(items.find((i) => i.key === "fixtures")?.href).toBe(routes.tournamentFixtures(TID));
    expect(items.find((i) => i.key === "settings")?.href).toBe(routes.tournamentSettings(TID));
  });
});
