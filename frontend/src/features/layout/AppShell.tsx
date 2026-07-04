import { useEffect, useRef, useState } from "react";
import {
  Link,
  Outlet,
  useLocation,
  useMatch,
  useNavigate,
} from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Bell,
  ChevronDown,
  ChevronRight,
  Menu,
  PanelLeft,
  UserRound,
} from "lucide-react";
import { useAuthStore } from "@/features/auth/authStore";
import { useOrgSwitcher } from "@/features/orgs/OrgSwitcherStore";
import { OrgSwitcher } from "@/features/orgs/OrgSwitcher";
import { ThemeToggle } from "@/features/theme/ThemeToggle";
import { NotificationBell } from "@/features/notifications/NotificationBell";
import { Avatar } from "@/components/ui/Avatar";
import { Sidebar } from "./Sidebar";
import { SetupStepperSidebar } from "./SetupStepperSidebar";
import { SportsStepBar } from "./SportsStepBar";
import { FixtureStepBar } from "./FixtureStepBar";
import { StaggeredNavMenu } from "./StaggeredNavMenu";
import { AppBackdrop } from "@/components/backdrop/AppBackdrop";
import { ClickSpark } from "@/components/backdrop/ClickSpark";
import {
  computeTournamentNav,
  computeWorkspaceNav,
  pathStageKey,
  type NavGroup,
} from "./computeNavItems";
import { tournamentsApi } from "@/api/tournaments";
import { invitationsApi } from "@/api/invitations";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/**
 * Attach the pending-invite count as a `badge` on the Workspace "invites" nav
 * item. Returns the groups unchanged when the count is 0 (no badge) so the
 * Sidebar/drawer render a plain item. Non-mutating: only the matched item is
 * cloned.
 */
function decorateInvitesBadge(groups: NavGroup[], count: number): NavGroup[] {
  if (count <= 0) return groups;
  return groups.map((group) => ({
    ...group,
    items: group.items.map((item) =>
      item.key === "invites" ? { ...item, badge: String(count) } : item,
    ),
  }));
}

/**
 * Authenticated app shell: a fixed left Sidebar (desktop) + a slim sticky
 * Topbar, filling the viewport. Below md the sidebar collapses into a
 * hamburger-triggered slide-in drawer. The global useBreakpoint() detector
 * auto-closes the drawer when the viewport grows back to desktop.
 *
 * Mounted under <ProtectedRoute>, so `user` is non-null when we render.
 */
export function AppShell(): React.ReactElement {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  // AppShell is a pathless layout route, so child-route params aren't in its
  // own useParams(). Match the URL directly to recover org + tournament ids.
  const orgMatch = useMatch("/o/:orgSlug/*");
  const orgSlug = orgMatch?.params.orgSlug;
  const tournamentMatch = useMatch("/tournaments/:id/*");
  const rawTournamentId = tournamentMatch?.params.id;
  // "/tournaments/new" is the create page, not a real tournament context.
  const tournamentId =
    rawTournamentId && rawTournamentId !== "new" ? rawTournamentId : null;
  const setSlugFromUrl = useOrgSwitcher((s) => s.setSlugFromUrl);
  const location = useLocation();
  const navigate = useNavigate();
  const { isDesktop } = useBreakpoint();

  const [menuOpen, setMenuOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Desktop sidebar collapse (icons-only), persisted across sessions.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("sidebar:collapsed") === "1";
    } catch {
      return false;
    }
  });
  const toggleCollapsed = (): void =>
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem("sidebar:collapsed", next ? "1" : "0");
      } catch {
        /* storage unavailable — non-fatal */
      }
      return next;
    });

  // Mirror URL slug into the switcher store (B.20: URL is source of truth).
  useEffect(() => {
    setSlugFromUrl(orgSlug ?? null);
  }, [orgSlug, setSlugFromUrl]);

  // Close the user menu / mobile drawer on route change.
  useEffect(() => {
    setMenuOpen(false);
    setDrawerOpen(false);
  }, [location.pathname]);

  // Global screen-size detector: auto-close the drawer once we hit desktop.
  useEffect(() => {
    if (isDesktop) setDrawerOpen(false);
  }, [isDesktop]);

  // Click-outside + Escape to dismiss the user menu.
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent): void => {
      if (
        menuRef.current &&
        e.target instanceof Node &&
        !menuRef.current.contains(e.target)
      ) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // On personal/tournament routes there's no :orgSlug. Fall back to
  // last-active or first membership so the workspace nav + the forms module
  // gate stay populated (DEFECT-F).
  const navSlug =
    orgSlug ??
    user?.last_active_org_slug ??
    user?.memberships?.[0]?.org_slug ??
    null;
  const orgName =
    user?.memberships?.find((m) => m.org_slug === navSlug)?.org_name ?? null;

  // In tournament context, fetch the tournament so the rail header can show
  // its name. Cached by TanStack; while it loads the header degrades to a
  // neutral "Tournament" label (handled in the Sidebar/drawer).
  const tournamentQuery = useQuery({
    queryKey: ["t-nav", tournamentId],
    queryFn: () => tournamentsApi.get(tournamentId as string),
    enabled: tournamentId != null,
    staleTime: 60_000,
  });
  const inTournamentContext = tournamentId != null;
  const tournamentName = tournamentQuery.data?.name ?? null;

  // Stage payload drives the contextual rail's stage-gating (shared source of
  // truth with the in-page lock states). Cheap + cached; only inside a tournament.
  const stageQuery = useQuery({
    queryKey: ["tournament-stage", tournamentId],
    queryFn: () => tournamentsApi.stage(tournamentId as string),
    enabled: tournamentId != null,
    staleTime: 30_000,
  });

  // Pending-invite count for the Workspace > Invites badge. Cheap + cached;
  // a failed/loading query simply yields no badge.
  const invitesQuery = useQuery({
    queryKey: ["my-invitations"],
    queryFn: invitationsApi.myInvitations,
    staleTime: 30_000,
  });
  // The endpoint returns the full history; only actionable ones badge.
  const pendingInviteCount =
    invitesQuery.data?.filter((inv) => inv.status === "pending").length ?? 0;

  // Contextual sidebar: inside a tournament it shows THAT tournament's sections
  // (stage-gated); at the workspace root it shows Dashboard/Tournaments/Invites.
  const navGroups: NavGroup[] = inTournamentContext
    ? computeTournamentNav(tournamentId, {
        user,
        slug: tournamentQuery.data?.slug ?? null,
        stage: stageQuery.data ?? null,
      })
    : decorateInvitesBadge(computeWorkspaceNav(user), pendingInviteCount);

  // Focused setup flow (owner W2-C, 2026-06-10): while a MANAGED tournament
  // is still being set up (any stage before "ready"), the sidebar is hidden —
  // the workspace renders the guided flow (stage chips, Continue, delete at
  // the top) like a job-site onboarding, and the full SaaS shell with the
  // sidebar appears once fixtures are generated and the tournament is ready.
  // Members without manage rights always get the normal shell. While the
  // stage payload is still LOADING inside a tournament, render no sidebar —
  // defaulting to "shown" flashed the rail for managers on every refresh
  // (owner report 2026-06-10); members instead get a quiet pop-in. On query
  // error, fail open to the normal shell.
  const setupMode =
    inTournamentContext &&
    ((stageQuery.data == null && !stageQuery.isError) ||
      (stageQuery.data != null &&
        stageQuery.data.can_manage &&
        stageQuery.data.stage !== "ready"));

  // Once the stage payload has loaded for a manager mid-setup, the left rail
  // becomes the vertical stage stepper (the guided Setup -> Ready flow). While
  // it's still loading we render no rail at all (avoids the flash the old code
  // guarded against); members and `ready` tournaments get the normal Sidebar.
  const setupSidebar =
    inTournamentContext &&
    stageQuery.data != null &&
    stageQuery.data.can_manage &&
    stageQuery.data.stage !== "ready";

  const handleSignOut = async (): Promise<void> => {
    setMenuOpen(false);
    await logout();
    navigate(routes.login());
  };

  return (
    // No bg here: the body carries --background and the fixed -z PixelBlast
    // backdrop paints between the body color and the content's own surfaces.
    <div className="flex min-h-screen">
      <AppBackdrop />
      {setupMode ? (
        setupSidebar ? (
          <SetupStepperSidebar
            tournamentId={tournamentId as string}
            stage={stageQuery.data ?? null}
          />
        ) : null
      ) : (
        <Sidebar
          groups={navGroups}
          collapsed={collapsed}
          tournament={
            inTournamentContext ? { name: tournamentName } : undefined
          }
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          role="banner"
          className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-card/80 px-4 backdrop-blur print:hidden sm:px-6 lg:px-8"
        >
          {!setupMode ? (
            <button
              type="button"
              aria-label={t("Open navigation menu")}
              aria-expanded={drawerOpen}
              aria-controls="mobile-nav-drawer"
              onClick={() => setDrawerOpen(true)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
            >
              <Menu aria-hidden="true" className="h-5 w-5" />
            </button>
          ) : null}

          {!setupMode ? (
            <button
              type="button"
              aria-label={collapsed ? t("Expand sidebar") : t("Collapse sidebar")}
              aria-pressed={collapsed}
              onClick={toggleCollapsed}
              className="hidden h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:inline-flex"
            >
              <PanelLeft aria-hidden="true" className="h-5 w-5" />
            </button>
          ) : null}

          <Link
            to={routes.landing()}
            className="font-semibold tracking-tight md:hidden"
          >
            {t("Fixture")}
          </Link>

          {inTournamentContext ? (
            <nav
              aria-label={t("Breadcrumb")}
              className="hidden min-w-0 items-center gap-1.5 text-sm md:flex"
            >
              <Link
                to={routes.tournaments()}
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                {t("Tournaments")}
              </Link>
              <ChevronRight
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50"
              />
              <span className="truncate font-medium text-foreground">
                {tournamentName ?? t("Tournament")}
              </span>
            </nav>
          ) : orgSlug && orgName ? (
            // Workspace breadcrumb only INSIDE org-scoped pages (/o/:slug/*).
            // Root pages are individual-level (owner decision 2026-06-11) —
            // the org is a hidden workspace, so it never labels the topbar there.
            <nav
              aria-label={t("Breadcrumb")}
              className="hidden items-center gap-1.5 text-sm md:flex"
            >
              <span className="text-muted-foreground">{t("Workspace")}</span>
              <ChevronRight
                aria-hidden="true"
                className="h-3.5 w-3.5 text-muted-foreground/50"
              />
              <span className="font-medium text-foreground">{orgName}</span>
            </nav>
          ) : null}

          <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
            <NotificationBell />
            <ThemeToggle />
            {orgSlug ? <OrgSwitcher /> : null}

            <div ref={menuRef} className="relative">
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label={t("Open user menu")}
                onClick={() => setMenuOpen((o) => !o)}
                className="inline-flex items-center gap-1.5 rounded-md p-1 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {user ? (
                  <Avatar email={user.email} name={user.name} size="sm" />
                ) : (
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-muted">
                    <UserRound aria-hidden="true" className="h-4 w-4" />
                  </span>
                )}
                <ChevronDown aria-hidden="true" className="h-4 w-4 opacity-60" />
              </button>

              {menuOpen ? (
                <div
                  role="menu"
                  aria-label={t("User menu")}
                  className="absolute right-0 z-30 mt-2 w-56 rounded-lg border bg-popover text-popover-foreground shadow-lg"
                >
                  <div className="border-b px-3 py-2">
                    <div className="text-sm font-medium leading-tight">
                      {user?.name ?? user?.email}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {user?.email}
                    </div>
                  </div>
                  <div className="py-1 text-sm">
                    <Link
                      role="menuitem"
                      to={routes.myProfile()}
                      className="flex items-center gap-2 px-3 py-1.5 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                    >
                      <UserRound aria-hidden="true" className="h-4 w-4" />
                      {t("My profile")}
                    </Link>
                    <Link
                      role="menuitem"
                      to={routes.myNotifications()}
                      className="flex items-center gap-2 px-3 py-1.5 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                    >
                      <Bell aria-hidden="true" className="h-4 w-4" />
                      {t("Notifications")}
                    </Link>
                  </div>
                  <div className="border-t p-1">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void handleSignOut()}
                      className="flex w-full items-center gap-2 rounded-sm px-3 py-1.5 text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                    >
                      {t("Sign out")}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        <StaggeredNavMenu
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          groups={navGroups}
          tournamentName={tournamentName}
          inTournamentContext={inTournamentContext}
          onSignOut={() => void handleSignOut()}
        />


        {/* Sticky sub-toolbar — the Sports page's own sub-steps, only there. */}
        {setupMode &&
        setupSidebar &&
        pathStageKey(location.pathname) === "setup" ? (
          <SportsStepBar tournamentId={tournamentId as string} />
        ) : null}

        {/* Sticky sub-toolbar — the Fixtures setup journey, only there. Same
            placement as the Sports step bar; the hub publishes its state and
            FixtureStepBar self-hides until it does. */}
        {pathStageKey(location.pathname) === "fixtures" ? (
          <FixtureStepBar />
        ) : null}

        <main className="flex flex-1 flex-col">
          <ClickSpark>
            <Outlet />
          </ClickSpark>
        </main>
      </div>
    </div>
  );
}
