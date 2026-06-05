import { useEffect, useRef, useState } from "react";
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { Bell, ChevronDown, Menu, UserRound, X } from "lucide-react";
import { useAuthStore } from "@/features/auth/authStore";
import { useOrgSwitcher } from "@/features/orgs/OrgSwitcherStore";
import { OrgSwitcher } from "@/features/orgs/OrgSwitcher";
import { ThemeToggle } from "@/features/theme/ThemeToggle";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/button";
import { computeNavItems, type NavItem } from "./computeNavItems";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * Authenticated app shell. Renders a top header with role-aware nav,
 * org switcher, and a user-menu dropdown. The mobile drawer is a simple
 * `<dialog>`-equivalent absolutely-positioned panel — Tailwind handles
 * the visual transitions; we keep behaviour minimal (open/close/Escape).
 *
 * Mounted under <ProtectedRoute>, so by the time we render, `user` is
 * non-null. The Outlet receives `:orgSlug` from route params.
 */
export function AppShell(): React.ReactElement {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const setSlugFromUrl = useOrgSwitcher((s) => s.setSlugFromUrl);
  const location = useLocation();
  const navigate = useNavigate();

  const [menuOpen, setMenuOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Mirror URL slug into the switcher store (B.20: URL is source of truth).
  useEffect(() => {
    setSlugFromUrl(orgSlug ?? null);
  }, [orgSlug, setSlugFromUrl]);

  // Close the user menu / mobile drawer on route change.
  useEffect(() => {
    setMenuOpen(false);
    setDrawerOpen(false);
  }, [location.pathname]);

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

  // On personal routes (/me, /orgs, etc.) there's no :orgSlug in the URL.
  // Fall back to the user's last-active or first membership so the primary
  // nav stays populated and users can navigate back to org surfaces (DEFECT-F).
  const navSlug =
    orgSlug ??
    user?.last_active_org_slug ??
    user?.memberships?.[0]?.org_slug ??
    null;
  const navItems: NavItem[] = computeNavItems(user, navSlug);

  const handleSignOut = async (): Promise<void> => {
    setMenuOpen(false);
    await logout();
    navigate(routes.login());
  };

  const renderNavLink = (item: NavItem): React.ReactElement => {
    const Icon = item.icon;
    return (
      <NavLink
        key={item.key}
        to={item.href}
        end
        className={({ isActive }) =>
          cn(
            "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            isActive
              ? "bg-secondary text-secondary-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )
        }
      >
        <Icon aria-hidden="true" className="h-4 w-4" />
        <span>{item.label}</span>
        {item.badge ? (
          <span className="ml-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800">
            {item.badge}
          </span>
        ) : null}
      </NavLink>
    );
  };

  return (
    <div className="flex min-h-screen flex-col">
      <header
        role="banner"
        className="flex h-14 items-center gap-3 border-b bg-card px-3 sm:px-4"
      >
        {/* Mobile hamburger. Hidden on md+ where the inline nav fits. */}
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

        <Link
          to={routes.landing()}
          className="font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        >
          {t("Fixture")}
        </Link>

        <nav
          aria-label={t("Primary")}
          className="hidden flex-1 items-center gap-1 md:flex"
        >
          {navItems.map(renderNavLink)}
        </nav>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <ThemeToggle />
          <OrgSwitcher />

          {/* User menu trigger. */}
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
                className="absolute right-0 z-30 mt-2 w-56 rounded-md border bg-popover text-popover-foreground shadow-md"
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

      {/* Mobile nav drawer (only mounted when open). */}
      {drawerOpen ? (
        <div
          id="mobile-nav-drawer"
          role="dialog"
          aria-modal="true"
          aria-label={t("Navigation menu")}
          className="fixed inset-0 z-40 md:hidden"
        >
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-foreground/40"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[80vw] flex-col gap-2 border-r bg-card p-4 shadow-xl">
            <div className="flex items-center justify-between">
              <span className="font-semibold">{t("Fixture")}</span>
              <button
                type="button"
                aria-label={t("Close navigation menu")}
                onClick={() => setDrawerOpen(false)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X aria-hidden="true" className="h-5 w-5" />
              </button>
            </div>
            <nav
              aria-label={t("Primary")}
              className="flex flex-col gap-1"
              onClick={() => setDrawerOpen(false)}
            >
              {navItems.length === 0 ? (
                <p className="px-2 py-2 text-xs text-muted-foreground">
                  {t("Pick an organization to see navigation.")}
                </p>
              ) : (
                navItems.map(renderNavLink)
              )}
            </nav>
            <div className="mt-auto flex flex-col gap-1 border-t pt-3">
              <Link
                to={routes.myProfile()}
                className="rounded-md px-3 py-1.5 text-sm hover:bg-accent"
              >
                {t("My profile")}
              </Link>
              <Link
                to={routes.myNotifications()}
                className="rounded-md px-3 py-1.5 text-sm hover:bg-accent"
              >
                {t("Notifications")}
              </Link>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleSignOut()}
              >
                {t("Sign out")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
