import {
  Building2,
  CalendarClock,
  LayoutDashboard,
  Mail,
  Settings,
  Trophy,
  UserCog,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { User } from "@/types/user";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/** One sidebar item. Pure data — the Sidebar renders it (incl. locked state). */
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
  /** Stage-gated rail item: locked until the tournament reaches its stage. */
  locked?: boolean;
  /** Label of the stage that unlocks a locked item (for the "Unlocks at" copy). */
  lockLabel?: string;
}

/** Minimal stage payload the tournament rail needs to compute gating. */
export interface NavStage {
  stage: string;
  order: string[];
  stages: { key: string; label: string }[];
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
  if (!user) return [];

  // Workspace group — always shown so a brand-new (org-less) user still has a
  // usable sidebar. Tournaments + Invites are global; Dashboard needs an org
  // slug, so it falls back to the workspace chooser until one is in scope.
  const workspace: NavItem[] = [
    {
      key: "dashboard",
      label: t("Dashboard"),
      href: slug ? routes.orgDashboard(slug) : routes.orgChooser(),
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
/**
 * Pure function — the CONTEXTUAL tournament rail shown inside `/tournaments/:id/*`.
 * Sections mirror the staged flow (Overview · Institutions · Teams · Members ·
 * Fixtures · Settings) and are **stage-gated**: a section is locked until the
 * tournament reaches its stage, computed from the passed `stage` payload (the
 * single source of truth, shared with the in-page lock states). No router/Zustand
 * reads — easy to unit-test.
 */
export function computeTournamentNav(
  tournamentId: string,
  opts: { user: User | null; slug: string | null; stage?: NavStage | null },
): NavGroup[] {
  if (!tournamentId) return [];

  const stage = opts.stage ?? null;
  const order = stage?.order ?? [];
  const curIdx = stage ? order.indexOf(stage.stage) : -1;

  // A section keyed to `stageKey` is locked until the tournament reaches it.
  const gate = (stageKey: string | null): Pick<NavItem, "locked" | "lockLabel"> => {
    if (!stage || stageKey === null) return {};
    const rank = order.indexOf(stageKey);
    if (rank > curIdx) {
      return { locked: true, lockLabel: stage.stages[rank]?.label ?? "" };
    }
    return {};
  };

  const manage: NavItem[] = [
    {
      key: "overview",
      label: t("Overview"),
      href: routes.tournamentDetail(tournamentId),
      icon: LayoutDashboard,
    },
    {
      key: "institutions",
      label: t("Institutions"),
      href: routes.tournamentInstitutions(tournamentId),
      icon: Building2,
      ...gate("org_registration"),
    },
    {
      key: "teams",
      label: t("Teams"),
      href: routes.tournamentTeams(tournamentId),
      icon: Users,
      ...gate("team_registration"),
    },
    {
      key: "members",
      label: t("Members"),
      href: routes.tournamentMembers(tournamentId),
      icon: UserCog,
    },
    {
      key: "fixtures",
      label: t("Fixtures"),
      href: routes.tournamentFixtures(tournamentId),
      icon: CalendarClock,
      ...gate("fixtures"),
    },
    {
      key: "settings",
      label: t("Settings"),
      href: routes.tournamentSettings(tournamentId),
      icon: Settings,
    },
  ];

  return [{ key: "manage", label: t("Manage"), items: manage }];
}
