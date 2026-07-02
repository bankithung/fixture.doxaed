import {
  Bell,
  ClipboardList,
  FileText,
  MessageSquare,
  Palette,
  Settings,
  Shield,
  Trophy,
  UserRound,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { OrgMembership, User } from "@/types/user";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/**
 * Card identifier — stable string keys used for tests and tracking.
 * NOT user-visible.
 */
export type DashboardCardKey =
  | "members"
  | "settings"
  | "permissions"
  | "audit"
  | "tournaments"
  | "branding"
  | "profile"
  | "notifications"
  | "feedback";

export interface DashboardCardConfig {
  key: DashboardCardKey;
  icon: LucideIcon;
  title: string;
  description: string;
  href?: string;
  /** Sentinel handled by the page (e.g., "feedback" opens a modal). */
  action?: "feedback";
  badge?: string;
}

/**
 * Module CODES — must match `apps/permissions/fixtures/modules.json`.
 * Centralised here so we never hard-code strings inline.
 */
export const MODULES = {
  ORG_MEMBER_DIRECTORY: "org.member_directory",
  ORG_SETTINGS: "org.settings",
  ORG_AUDIT_LOG: "org.audit_log",
  ORG_TOURNAMENT_LIST: "org.tournament_list",
  ORG_BRANDING: "org.branding",
  PERSONAL_NOTIFICATION_PREFS: "personal.notification_prefs",
  PERSONAL_FEEDBACK_WIDGET: "personal.feedback_widget",
} as const;

/**
 * Roles that imply "admin-level" surface for the role-only Permissions
 * (Module Overrides) card. Per v1Users.md §2.2 + Appendix A, the trio
 * admin / co_organizer / game_coordinator are the "admin-tier" roles.
 *
 * Owner-ness is now sourced from `OrgMembership.is_org_owner`, NOT from a
 * synthetic `roles: ["owner"]` entry, so it's checked separately. Older
 * payloads may still emit `roles: ["owner"]` — those are accepted via the
 * fallback comparison below for backward-compat.
 */
const ADMIN_ROLES = new Set<string>([
  "admin",
  "co_organizer",
  "game_coordinator",
]);

function hasModule(modules: string[], key: string): boolean {
  return modules.includes(key);
}

function hasAdminRole(roles: string[]): boolean {
  // Accept the legacy "owner" role string as admin-like for backward-compat.
  return roles.some((r) => ADMIN_ROLES.has(r) || r === "owner");
}

function isOrgOwner(membership: OrgMembership | null): boolean {
  if (!membership) return false;
  if (membership.is_org_owner) return true;
  // Backward-compat: older payloads may emit a synthetic "owner" role string.
  const roleStrings = (membership.roles ?? []) as readonly string[];
  return roleStrings.includes("owner");
}

/**
 * Compute the ordered list of cards visible to the current user for the
 * active org membership. Pure function — depends only on its inputs, no
 * Zustand or router reads. Easy to unit-test.
 *
 * Ordering rationale:
 *   1. Org-scoped admin tasks (Members, Settings, Permissions, Audit) first
 *   2. Operational surfaces (Tournaments, Branding) next
 *   3. Personal surfaces (Profile, Notifications, Feedback) last
 *
 * Backward-compat: when `effective_modules` is missing or empty (auth state
 * mid-load), we fall back to role-only signals so the user still sees their
 * profile + notifications and admins still see member directory + settings.
 */
export function computeDashboardCards(opts: {
  user: User;
  membership: OrgMembership | null;
  slug: string;
}): DashboardCardConfig[] {
  const { membership, slug } = opts;
  const modules: string[] = membership?.effective_modules ?? [];
  const roles: string[] = membership?.roles ?? [];
  const fallbackToRoles = modules.length === 0;
  const adminLike = hasAdminRole(roles);
  const orgOwner = isOrgOwner(membership);

  const showByModule = (key: string, roleFallback: boolean): boolean =>
    fallbackToRoles ? roleFallback : hasModule(modules, key);

  const cards: DashboardCardConfig[] = [];

  // 1. Members (Member Directory)
  if (showByModule(MODULES.ORG_MEMBER_DIRECTORY, adminLike)) {
    cards.push({
      key: "members",
      icon: Users,
      title: t("Member directory"),
      description: t(
        "Browse, invite, and manage people in this organization.",
      ),
      href: routes.orgMembers(slug),
    });
  }

  // 2. Settings (Org Settings)
  if (showByModule(MODULES.ORG_SETTINGS, adminLike)) {
    cards.push({
      key: "settings",
      icon: Settings,
      title: t("Org settings"),
      description: t("Name, slug, timezone, and public-page settings."),
      href: routes.orgSettings(slug),
    });
  }

  // 3. Permissions (Module Overrides) — admin role + org owner ONLY.
  //    Backend gate is `IsOrgAdminOrOwner` (admin role OR is_org_owner=True);
  //    co-organizer and game-coordinator are intentionally excluded per
  //    v1Users.md §2 line 736 (override-grant verb reserved to Admin v1.0).
  const canManagePermissions =
    membership?.roles?.includes("admin") || orgOwner;
  if (canManagePermissions) {
    cards.push({
      key: "permissions",
      icon: Shield,
      title: t("Module overrides"),
      description: t("Per-user grants and denials on top of role defaults."),
      href: routes.orgPermissions(slug),
    });
  }

  // 4. Audit log
  if (showByModule(MODULES.ORG_AUDIT_LOG, adminLike)) {
    cards.push({
      key: "audit",
      icon: FileText,
      title: t("Audit log"),
      description: t("Searchable, append-only record of org-scoped events."),
      href: routes.orgAudit(slug),
    });
  }

  // 5. Tournaments — the live working surface (fixtures, scoring, standings).
  if (showByModule(MODULES.ORG_TOURNAMENT_LIST, false)) {
    cards.push({
      key: "tournaments",
      icon: Trophy,
      title: t("Tournaments"),
      description: t(
        "Create, run, and score tournaments · fixtures, live scoring, standings.",
      ),
      href: routes.tournaments(),
    });
  }

  // 6. Branding
  if (showByModule(MODULES.ORG_BRANDING, adminLike)) {
    cards.push({
      key: "branding",
      icon: Palette,
      title: t("Branding"),
      description: t("Logo, primary brand color, and public description."),
      href: routes.orgBranding(slug),
    });
  }

  // 7. Profile (always)
  cards.push({
    key: "profile",
    icon: UserRound,
    title: t("My profile"),
    description: t("Edit your name, photo, password, and 2FA."),
    href: routes.profile(),
  });

  // 8. Notifications
  if (showByModule(MODULES.PERSONAL_NOTIFICATION_PREFS, true)) {
    cards.push({
      key: "notifications",
      icon: Bell,
      title: t("Notifications"),
      description: t("Choose which events alert you and on which channel."),
      href: routes.profileNotifications(),
    });
  }

  // 9. Feedback widget — opens a modal, no href.
  if (showByModule(MODULES.PERSONAL_FEEDBACK_WIDGET, true)) {
    cards.push({
      key: "feedback",
      icon: MessageSquare,
      title: t("Send feedback"),
      description: t("Report a bug, request a feature, or share praise."),
      action: "feedback",
    });
  }

  return cards;
}

/** Exported for tests / labels — list of card keys in canonical order. */
export const ALL_CARD_KEYS: DashboardCardKey[] = [
  "members",
  "settings",
  "permissions",
  "audit",
  "tournaments",
  "branding",
  "profile",
  "notifications",
  "feedback",
];

/** Teaser strip content. Empty now that tournaments/scoring/disputes have shipped. */
export const PHASE_1B_TEASERS: readonly string[] = [] as const;

/** Re-export icon identity for tests that want to assert specific icons. */
export const CARD_ICONS = {
  Users,
  Settings,
  Shield,
  FileText,
  Trophy,
  Palette,
  UserRound,
  Bell,
  MessageSquare,
  ClipboardList,
} as const;
