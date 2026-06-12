import {
  Building2,
  CalendarClock,
  FileText,
  LayoutDashboard,
  Mail,
  Radio,
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
  /** Caller's manage flag + effective module codes (permission gating). */
  can_manage?: boolean;
  modules?: string[];
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
 * Pure function — given a hydrated `User`, returns the grouped WORKSPACE
 * navigation the AppShell renders when the route is NOT inside a specific
 * tournament. As of the tournament-scoped Members/Audit rework this is
 * intentionally just the "Workspace" group: Dashboard + Tournaments. The former
 * org-level Admin group (Members / Permissions / Audit / Settings) has been
 * removed from the primary nav — those org-scoped surfaces remain reachable by
 * URL, while member/role management + audit now live INSIDE a tournament. No
 * Zustand or router reads: easy to unit-test. Empty groups are omitted.
 */
export function computeWorkspaceNav(user: User | null): NavGroup[] {
  if (!user) return [];

  // Workspace group — the same for every account. Root pages are
  // individual-level (owner decision 2026-06-11): accounts are personal, so
  // Dashboard is ALWAYS the personal dashboard regardless of org memberships;
  // roles only shape the experience inside a tournament. The org-stats view
  // stays reachable via the dashboard's workspace cards / org switcher.
  const workspace: NavItem[] = [
    {
      key: "dashboard",
      label: t("Dashboard"),
      href: routes.orgChooser(),
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
 * Pure function — the CONTEXTUAL tournament rail shown inside `/tournaments/:id/*`.
 * Sections mirror the staged flow (Overview · Sports · Forms · Institutions ·
 * Teams · Members · Fixtures · Settings) and are gated on TWO axes from the
 * stage payload (the single source of truth, shared with the in-page locks):
 *
 *  - **Stage**: a section is locked (visible, disabled, "Unlocks at …") until
 *    the tournament reaches its stage.
 *  - **Permission**: a section the caller's role/module set gives no access to
 *    is HIDDEN — members only see what they can act on (spec 2026-06-10 P5).
 *    Read surfaces (Overview, Fixtures, Teams, Institutions) stay visible to
 *    every member; admin surfaces (Members, Settings) and editor surfaces
 *    (Sports, Forms) require manage rights or the matching module.
 *
 * No router/Zustand reads — easy to unit-test.
 */
export function computeTournamentNav(
  tournamentId: string,
  opts: { user: User | null; slug: string | null; stage?: NavStage | null },
): NavGroup[] {
  if (!tournamentId) return [];

  const stage = opts.stage ?? null;
  const order = stage?.order ?? [];
  const curIdx = stage ? order.indexOf(stage.stage) : -1;
  // Until the payload resolves we show everything (no flash of missing nav);
  // once it's here, gate by manage flag + effective modules.
  const canManage = stage ? Boolean(stage.can_manage) : true;
  const modules = stage ? new Set(stage.modules ?? []) : null;
  const allowed = (moduleCode: string): boolean =>
    canManage || modules === null || modules.has(moduleCode);

  // A section keyed to `stageKey` is locked until the tournament reaches it.
  const gate = (stageKey: string | null): Pick<NavItem, "locked" | "lockLabel"> => {
    if (!stage || stageKey === null) return {};
    const rank = order.indexOf(stageKey);
    if (rank > curIdx) {
      return { locked: true, lockLabel: stage.stages[rank]?.label ?? "" };
    }
    return {};
  };

  const manage: (NavItem | null)[] = [
    {
      key: "overview",
      label: t("Overview"),
      href: routes.tournamentOverview(tournamentId),
      icon: LayoutDashboard,
    },
    // The sports this tournament runs — first setup step; editor surface.
    allowed("tournament.editor")
      ? {
          key: "sports",
          label: t("Sports"),
          href: routes.tournamentSports(tournamentId),
          icon: Trophy,
        }
      : null,
    // Registration-form builder — unlocks with the first registration stage.
    allowed("forms")
      ? {
          key: "forms",
          label: t("Forms"),
          href: routes.tournamentForms(tournamentId),
          icon: FileText,
          ...gate("org_registration"),
        }
      : null,
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
    // Member/role administration — managers only.
    canManage
      ? {
          key: "members",
          label: t("Members"),
          href: routes.tournamentMembers(tournamentId),
          icon: UserCog,
        }
      : null,
    {
      key: "fixtures",
      label: t("Fixtures"),
      href: routes.tournamentFixtures(tournamentId),
      icon: CalendarClock,
      ...gate("fixtures"),
    },
    // Live-ops cockpit — unlocks once the schedule is published (stage
    // `ready`). Every role's catalog default includes `match.center_admin_view`
    // so all members see it; a per-member module revocation hides it.
    allowed("match.center_admin_view")
      ? {
          key: "control",
          label: t("Control room"),
          href: routes.tournamentControl(tournamentId),
          icon: Radio,
          ...gate("ready"),
        }
      : null,
    allowed("tournament.editor")
      ? {
          key: "settings",
          label: t("Settings"),
          href: routes.tournamentSettings(tournamentId),
          icon: Settings,
        }
      : null,
  ];

  return [
    {
      key: "manage",
      label: t("Manage"),
      items: manage.filter((i): i is NavItem => i !== null),
    },
  ];
}
