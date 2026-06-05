import {
  FileText,
  Flag,
  Goal,
  LayoutDashboard,
  Shield,
  Trophy,
  Users,
  Users2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { OrgMembership, User } from "@/types/user";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/**
 * Module CODES — must match `apps/permissions/fixtures/modules.json`.
 * Duplicated here (rather than imported from features/orgs) to keep this
 * pure helper module-isolated; the source-of-truth list is in
 * features/orgs/dashboardCards.ts and the two should stay in sync.
 */
const MODULE_ORG_MEMBER_DIRECTORY = "org.member_directory";
const MODULE_ORG_AUDIT_LOG = "org.audit_log";
const MODULE_MATCH_SCORING_CONSOLE = "match.scoring_console";
const MODULE_MATCH_REFEREE_CONSOLE = "match.referee_console";

export interface NavItem {
  /** Stable identifier for tests / keys; not user-visible. */
  key: string;
  /** Localised label. */
  label: string;
  /** Absolute URL — built via `routes.*`. */
  href: string;
  icon: LucideIcon;
  /** Optional badge text (e.g. "Phase 1B"). */
  badge?: string;
}

/**
 * Pure function — given a hydrated `User` and the URL slug, returns the
 * ordered list of nav items the AppShell should render in its primary
 * navigation. No Zustand or router reads: easy to unit-test.
 *
 * Slug rule: when there is no `:orgSlug` in the URL (e.g. on `/orgs` or
 * `/me`), only Dashboard is suppressed (no org context). The rest of the
 * org-scoped items hide entirely until a slug is in scope.
 */
export function computeNavItems(
  user: User | null,
  slug: string | null,
): NavItem[] {
  if (!user || !slug) return [];

  const membership: OrgMembership | undefined = user.memberships.find(
    (m) => m.org_slug === slug,
  );
  const roles: readonly string[] = (membership?.roles ?? []) as readonly string[];
  const modules: string[] = membership?.effective_modules ?? [];

  const hasModule = (key: string): boolean => modules.includes(key);
  const isOrgOwner =
    membership?.is_org_owner === true || roles.includes("owner");
  // Module-Overrides surface is admin-only on the BACKEND (v1Users.md §2 line
  // 736 — override-grant verb is reserved to Admin in v1.0). Co-organizer +
  // game-coordinator can manage members but not the override matrix; mirror
  // that here so the nav doesn't tease a 403.
  const canManagePermissions =
    roles.includes("admin") || isOrgOwner;

  const items: NavItem[] = [];

  // 1. Dashboard — always visible when org is in scope.
  items.push({
    key: "dashboard",
    label: t("Dashboard"),
    href: routes.orgDashboard(slug),
    icon: LayoutDashboard,
  });

  // 1b. Tournaments — the primary working surface (create/manage tournaments,
  //     share registration links, fixtures, scores, standings). Global (not
  //     org-scoped) but shown whenever an org is in scope so it's reachable.
  items.push({
    key: "tournaments",
    label: t("Tournaments"),
    href: routes.tournaments(),
    icon: Trophy,
  });

  // 2. Members — module-gated.
  if (hasModule(MODULE_ORG_MEMBER_DIRECTORY)) {
    items.push({
      key: "members",
      label: t("Members"),
      href: routes.orgMembers(slug),
      icon: Users,
    });
  }

  // 3. Permissions — admin role + org owner ONLY (matches backend gate).
  if (canManagePermissions) {
    items.push({
      key: "permissions",
      label: t("Permissions"),
      href: routes.orgPermissions(slug),
      icon: Shield,
    });
  }

  // 4. Audit — module-gated.
  if (hasModule(MODULE_ORG_AUDIT_LOG)) {
    items.push({
      key: "audit",
      label: t("Audit"),
      href: routes.orgAudit(slug),
      icon: FileText,
    });
  }

  // 5. Role-specific landings (Phase 1A placeholders for Phase 1B consoles).
  //    Module-gated per v1Users.md §A.1 two-layer model: any user with the
  //    relevant module sees the nav item, regardless of role string. This
  //    correctly surfaces Scoring/Referee for admin / co_organizer /
  //    game_coordinator (who all hold the module by default) without
  //    needing role-string matching.
  if (hasModule(MODULE_MATCH_SCORING_CONSOLE)) {
    items.push({
      key: "scoring",
      label: t("Scoring"),
      href: routes.orgScoring(slug),
      icon: Goal,
      badge: t("Phase 1B"),
    });
  }
  if (hasModule(MODULE_MATCH_REFEREE_CONSOLE)) {
    items.push({
      key: "referee",
      label: t("Referee"),
      href: routes.orgReferee(slug),
      icon: Flag,
      badge: t("Phase 1B"),
    });
  }
  // Team workspace: no Appendix A.2 module exists (`tournament.team_manager_workspace`
  // is unspecified). Spec gap — see report. Fall back to role-only gating until
  // the module catalog is extended. Use a People icon (Users2) to differentiate
  // from the Tournaments Trophy icon (DEFECT-N).
  if (roles.includes("team_manager")) {
    items.push({
      key: "team",
      label: t("Team"),
      href: routes.orgTeam(slug),
      icon: Users2,
      badge: t("Phase 1B"),
    });
  }

  return items;
}
