import {
  ClipboardList,
  FileText,
  GitBranch,
  LayoutDashboard,
  Mail,
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
 *
 * Registration-forms module (apps/permissions/fixtures/modules.json → "forms").
 */
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
 * Resolve the user's per-org module set for the given slug. Centralised so the
 * tournament builder's `forms` gate matches the rest of the app.
 */
function resolveContext(user: User | null, slug: string | null): {
  hasModule: (key: string) => boolean;
} {
  const membership: OrgMembership | undefined =
    user && slug
      ? user.memberships.find((m) => m.org_slug === slug)
      : undefined;
  const modules: string[] = membership?.effective_modules ?? [];
  const hasModule = (key: string): boolean => modules.includes(key);
  return { hasModule };
}

/**
 * Pure function — given a hydrated `User` and the URL slug, returns the grouped
 * WORKSPACE navigation the AppShell renders when the route is NOT inside a
 * specific tournament. As of the tournament-scoped Members/Audit rework this is
 * intentionally just the "Workspace" group: Dashboard + Tournaments. The former
 * org-level Admin group (Members / Permissions / Audit / Settings) has been
 * removed from the primary nav — those org-scoped surfaces remain reachable by
 * URL, while member/role management + audit now live INSIDE a tournament. No
 * Zustand or router reads: easy to unit-test. Empty groups are omitted.
 */
export function computeWorkspaceNav(
  user: User | null,
  slug: string | null,
): NavGroup[] {
  if (!user || !slug) return [];

  // Workspace group — Dashboard + the global Tournaments hub. Nothing else.
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
    {
      // Pending-invites inbox. The AppShell attaches a count `badge` here.
      key: "invites",
      label: t("Invites"),
      href: routes.invites(),
      icon: Mail,
    },
  ];

  return [{ key: "workspace", label: t("Workspace"), items: workspace }];
}

/**
 * Pure function — the grouped TOURNAMENT navigation (the "Manage" group) the
 * AppShell renders when the route is under `/tournaments/:id`: Overview,
 * Registration forms (module-gated on `forms`), Fixtures & bracket, Members,
 * and Audit.
 *
 * Members + Audit are shown to anyone in tournament context — the pages
 * themselves enforce manager-only access (the Audit page renders a friendly
 * "managers only" state on a 403). `opts.user` + `opts.slug` resolve the
 * `forms` module the same way the workspace nav does; if membership can't be
 * resolved the forms item simply hides.
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
  manage.push({
    key: "members",
    label: t("Members"),
    href: routes.tournamentMembers(tournamentId),
    icon: Users,
  });
  manage.push({
    key: "audit",
    label: t("Audit"),
    href: routes.tournamentAudit(tournamentId),
    icon: FileText,
  });

  return [{ key: "manage", label: t("Manage"), items: manage }];
}
