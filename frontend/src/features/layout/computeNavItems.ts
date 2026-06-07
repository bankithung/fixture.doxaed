import {
  ClipboardList,
  FileText,
  GitBranch,
  LayoutDashboard,
  Settings,
  Shield,
  Trophy,
  Users,
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
/** Registration-forms module (apps/permissions/fixtures/modules.json → "forms"). */
const MODULE_FORMS = "forms";

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
 * A labelled cluster of nav items. The Sidebar renders the `label` as an
 * overline above its `items`. Empty groups are never emitted by the builders
 * below, so the UI can render every group it receives unconditionally.
 */
export interface NavGroup {
  /** Stable identifier for tests / keys; not user-visible. */
  key: string;
  /** Localised group heading (overline). */
  label: string;
  items: NavItem[];
}

/**
 * Resolve the user's per-org context for the given slug. Centralised so both
 * the workspace and tournament builders apply the SAME gating rules.
 */
function resolveContext(user: User | null, slug: string | null): {
  hasModule: (key: string) => boolean;
  canManagePermissions: boolean;
} {
  const membership: OrgMembership | undefined =
    user && slug
      ? user.memberships.find((m) => m.org_slug === slug)
      : undefined;
  const roles: readonly string[] = (membership?.roles ?? []) as readonly string[];
  const modules: string[] = membership?.effective_modules ?? [];

  const hasModule = (key: string): boolean => modules.includes(key);
  const isOrgOwner =
    membership?.is_org_owner === true || roles.includes("owner");
  // Module-Overrides surface is admin-only on the BACKEND (v1Users.md §2 line
  // 736 — override-grant verb is reserved to Admin in v1.0). Co-organizer +
  // game-coordinator can manage members but not the override matrix; mirror
  // that here so the nav doesn't tease a 403. Settings is gated the same way.
  const canManagePermissions = roles.includes("admin") || isOrgOwner;

  return { hasModule, canManagePermissions };
}

/**
 * Pure function — given a hydrated `User` and the URL slug, returns the
 * grouped WORKSPACE navigation (Workspace + Admin) the AppShell renders when
 * the route is NOT inside a specific tournament. No Zustand or router reads:
 * easy to unit-test. Empty groups are omitted.
 *
 * Slug rule: when there is no org slug in scope (e.g. on `/orgs` before a
 * fallback resolves), org-scoped Admin items hide entirely, but Dashboard +
 * Tournaments still render so the user can navigate.
 */
export function computeWorkspaceNav(
  user: User | null,
  slug: string | null,
): NavGroup[] {
  if (!user || !slug) return [];

  const { hasModule, canManagePermissions } = resolveContext(user, slug);

  // Workspace group — Dashboard + the global Tournaments hub.
  const workspace: NavItem[] = [
    {
      key: "dashboard",
      label: t("Dashboard"),
      href: routes.orgDashboard(slug),
      icon: LayoutDashboard,
    },
    {
      // Tournaments is the primary working surface. Global (not org-scoped)
      // but shown whenever an org is in scope so it's always reachable.
      key: "tournaments",
      label: t("Tournaments"),
      href: routes.tournaments(),
      icon: Trophy,
    },
  ];

  // Admin group — each item gated as before.
  const admin: NavItem[] = [];
  if (hasModule(MODULE_ORG_MEMBER_DIRECTORY)) {
    admin.push({
      key: "members",
      label: t("Members"),
      href: routes.orgMembers(slug),
      icon: Users,
    });
  }
  if (canManagePermissions) {
    admin.push({
      key: "permissions",
      label: t("Permissions"),
      href: routes.orgPermissions(slug),
      icon: Shield,
    });
  }
  if (hasModule(MODULE_ORG_AUDIT_LOG)) {
    admin.push({
      key: "audit",
      label: t("Audit"),
      href: routes.orgAudit(slug),
      icon: FileText,
    });
  }
  if (canManagePermissions) {
    admin.push({
      key: "settings",
      label: t("Settings"),
      href: routes.orgSettings(slug),
      icon: Settings,
    });
  }

  const groups: NavGroup[] = [
    { key: "workspace", label: t("Workspace"), items: workspace },
  ];
  if (admin.length > 0) {
    groups.push({ key: "admin", label: t("Admin"), items: admin });
  }
  return groups;
}

/**
 * Pure function — the grouped TOURNAMENT navigation (the "Manage" group) the
 * AppShell renders when the route is under `/tournaments/:id`. Only links to
 * routes that already exist: Overview, Registration forms (module-gated on
 * `forms`), and Fixtures & bracket.
 *
 * `opts.user` + `opts.slug` mirror the workspace `hasModule("forms")` check
 * using the user's memberships, so the forms item is gated identically in both
 * modes. If membership can't be resolved the forms item simply hides.
 */
export function computeTournamentNav(
  tournamentId: string,
  opts: { user: User | null; slug: string | null },
): NavGroup[] {
  if (!tournamentId) return [];

  const { hasModule } = resolveContext(opts.user, opts.slug);

  const manage: NavItem[] = [
    {
      key: "overview",
      label: t("Overview"),
      href: routes.tournamentDetail(tournamentId),
      icon: Trophy,
    },
  ];
  if (hasModule(MODULE_FORMS)) {
    manage.push({
      key: "forms",
      label: t("Registration forms"),
      href: routes.tournamentForms(tournamentId),
      icon: ClipboardList,
    });
  }
  manage.push({
    key: "bracket",
    label: t("Fixtures & bracket"),
    href: routes.tournamentBracket(tournamentId),
    icon: GitBranch,
  });

  return [{ key: "manage", label: t("Manage"), items: manage }];
}
