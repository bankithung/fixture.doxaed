import {
  ExternalLink,
  BarChart3,
  ClipboardCheck,
  Building2,
  CalendarClock,
  Camera,
  FileText,
  LayoutDashboard,
  ListChecks,
  Mail,
  Radio,
  Settings,
  Trophy,
  Tv,
  UserCog,
  Users,
  UserSquare2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { User } from "@/types/user";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/**
 * The work page each setup stage opens to. Shared by the vertical stepper
 * sidebar and the mobile stage strip so they navigate identically. "ready"
 * lands on Overview — its own page once the tournament is live.
 */
export const STAGE_WORK_ROUTE: Record<string, (id: string) => string> = {
  setup: routes.tournamentSports,
  org_registration: routes.tournamentInstitutions,
  house_setup: routes.tournamentHouses,
  roster: routes.tournamentParticipants,
  team_registration: routes.tournamentTeams,
  fixtures: routes.tournamentFixtures,
  ready: routes.tournamentOverview,
};

/**
 * Reverse-map the current pathname to the setup stage whose page you're on, so
 * the stepper highlights the PAGE you're viewing — not the tournament's
 * server-side stage (owner: on the Sports page, Setup must be highlighted, not
 * Fixtures). Stage-agnostic pages (Overview / Settings / Members & roles)
 * return null; callers fall back to the tournament's current stage there.
 */
export function pathStageKey(pathname: string): string | null {
  if (/\/sports(\/|$)/.test(pathname)) return "setup";
  if (/\/houses(\/|$)/.test(pathname)) return "house_setup";
  if (/\/participants(\/|$)/.test(pathname)) return "roster";
  if (/\/(forms|institutions)(\/|$)/.test(pathname)) return "org_registration";
  if (/\/teams(\/|$)/.test(pathname)) return "team_registration";
  if (/\/fixtures(\/|$)/.test(pathname)) return "fixtures";
  // `/members` is deliberately absent: roles are handed out at any point in
  // setup and on match day, so the page belongs beside Settings, not in the
  // numbered flow (owner 2026-08-14).
  return null;
}

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
  /**
   * Opens in a new tab instead of navigating the shell (owner 2026-08-19).
   * Only the fan-facing site sets it: an organizer opens it to check what a
   * visitor sees while they are mid-job in the console, and following it in
   * place threw that job away and left them outside the nav they came from.
   */
  external?: boolean;
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
  const stageTwo = order[1] ?? "org_registration";
  const intraSchool = stageTwo === "house_setup";
  const gate = (stageKey: string | null): Pick<NavItem, "locked" | "lockLabel"> => {
    if (!stage || stageKey === null) return {};
    const rank = order.indexOf(stageKey);
    if (rank > curIdx) {
      return { locked: true, lockLabel: stage.stages[rank]?.label ?? "" };
    }
    return {};
  };

  // Once the fixtures are generated (stage `ready`+), the whole workspace
  // pivots from a setup wizard into live-operations software (ops 2026-06-26):
  // an OPERATIONS group leads (Today / Matches / Standings / Officials /
  // Schools & teams — everything revolving around the generated fixture) and
  // the former setup tabs demote into a muted, still-reachable "Setup & config"
  // group. The gate is one index check against the same stage order the rail
  // already has; below `ready` we return the unchanged single setup nav.
  const readyIdx = order.indexOf("ready");
  const opsMode = readyIdx >= 0 && curIdx >= readyIdx;
  if (opsMode) {
    const operations: (NavItem | null)[] = [
      // Every invited member's own work list. Deliberately UNGATED: it shows
      // only the viewer's own assignments, so there is nothing to authorize.
      {
        key: "my-tasks",
        label: t("My tasks"),
        href: routes.tournamentMyTasks(tournamentId),
        icon: ClipboardCheck,
      },
      // Today = the live control room; the post-generation default landing.
      allowed("match.center_admin_view")
        ? {
            key: "control",
            label: t("Today"),
            href: routes.tournamentControl(tournamentId),
            icon: Radio,
          }
        : null,
      // The flat, filterable tournament-wide matches board (bulk find-and-act).
      allowed("match.center_admin_view")
        ? {
            key: "matches",
            label: t("Matches"),
            href: routes.tournamentMatches(tournamentId),
            icon: ListChecks,
          }
        : null,
      // Live outcomes — visible to every member (read).
      {
        key: "standings",
        label: t("Standings & bracket"),
        href: routes.tournamentStandings(tournamentId),
        icon: BarChart3,
      },
      // Full leader board: every scorer, team stats, badges (read).
      {
        key: "leaders",
        label: t("Leaders"),
        href: routes.tournamentLeaders(tournamentId),
        icon: Trophy,
      },
      // Assignment cockpit — schedule editors (admin/co-org/coordinator).
      allowed("tournament.schedule_editor")
        ? {
            key: "crew",
            label: t("Officials & assignments"),
            href: routes.tournamentCrew(tournamentId),
            icon: UserCog,
          }
        : null,
      // The day's "Watch live" links — one per court, plus the per-category
      // and per-match overrides. Sits next to the other prepare-the-day
      // cockpit (Officials & assignments) because it is the same job: a
      // manager arriving in the morning setting the day up. Manager-gated to
      // match the server — pasting a link publishes it on the public page.
      canManage
        ? {
            key: "streams",
            label: t("Live streams"),
            href: routes.tournamentStreams(tournamentId),
            icon: Tv,
          }
        : null,
      // Participant directory, fixture-centric — every member (read).
      {
        key: "directory",
        label: t("Schools & teams"),
        href: routes.tournamentTeams(tournamentId),
        icon: Building2,
      },
      // Guest Lens: the shared event album captured by visiting schools
      // (QR pass cards, moderation, awards) — managers only.
      canManage
        ? {
            key: "lens",
            label: t("Guest Lens"),
            href: routes.tournamentLens(tournamentId),
            icon: Camera,
          }
        : null,
      // The fan-facing site, one hop away (replaces the workspace ribbon).
      opts.slug
        ? {
            key: "public",
            label: t("Public page"),
            href: routes.publicSchedule(opts.slug, tournamentId),
            icon: ExternalLink,
            external: true,
          }
        : null,
    ];

    // People + config — the only setup-era surfaces that stay relevant once the
    // event is running, and ONLY as their own operations-grade pages (ops
    // 2026-06-26: the setup-flow pages — Overview/Sports/Forms/Institutions/the
    // Fixtures wizard — belong to setup, not operations, so they leave the nav;
    // they stay reachable by URL + a "Setup tools" hatch in ops Settings).
    const manage: (NavItem | null)[] = [
      canManage
        ? {
            key: "members",
            label: t("Members"),
            href: routes.tournamentMembers(tournamentId),
            icon: UserCog,
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
        key: "operations",
        label: t("Operations"),
        items: operations.filter((i): i is NavItem => i !== null),
      },
      {
        key: "manage",
        label: t("Manage"),
        items: manage.filter((i): i is NavItem => i !== null),
      },
    ].filter((g) => g.items.length > 0);
  }

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
          ...gate(stageTwo),
        }
      : null,
    // Stage two has two identities: schools register in a between-schools
    // event, houses are set up in a within-school one. The server's `order` is
    // the one list, so the rail follows it rather than knowing the scope.
    intraSchool
      ? {
          key: "houses",
          label: t("Houses"),
          href: routes.tournamentHouses(tournamentId),
          icon: Building2,
          ...gate("house_setup"),
        }
      : {
          key: "institutions",
          label: t("Institutions"),
          href: routes.tournamentInstitutions(tournamentId),
          icon: Building2,
          ...gate("org_registration"),
        },
    // Participants (spec 2026-08-17) — present only for a tournament that
    // declares its people before building teams. Derived from the server's
    // `order`, like every other stage item, so the rail never has to know what
    // turned the layer on.
    order.includes("roster")
      ? {
          key: "participants",
          label: t("Participants"),
          href: routes.tournamentParticipants(tournamentId),
          icon: UserSquare2,
          ...gate("roster"),
        }
      : null,
    {
      key: "teams",
      label: t("Teams"),
      href: routes.tournamentTeams(tournamentId),
      icon: Users,
      ...gate("team_registration"),
    },
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
    // Guest Lens — meaningless before the schedule exists, so it stays locked
    // until the fixtures are generated (stage `ready`), like the control room.
    canManage
      ? {
          key: "lens",
          label: t("Guest Lens"),
          href: routes.tournamentLens(tournamentId),
          icon: Camera,
          ...gate("ready"),
        }
      : null,
    // Member/role administration — managers only. Pinned at the end beside
    // Settings because it sits OUTSIDE the staged flow (owner 2026-08-14):
    // roles are handed out at any point, so it is never a step to complete.
    canManage
      ? {
          key: "members",
          label: t("Members & roles"),
          href: routes.tournamentMembers(tournamentId),
          icon: UserCog,
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
