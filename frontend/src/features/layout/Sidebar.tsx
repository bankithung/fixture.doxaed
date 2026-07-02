import { Link, NavLink } from "react-router-dom";
import { ArrowLeft, Lock, Plus, Trophy } from "lucide-react";
import type { NavGroup, NavItem } from "./computeNavItems";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { BrandLogo } from "@/components/ui/BrandLogo";

/**
 * Tournament-context header shown above the groups in tournament mode: a
 * "back to all tournaments" link, then the tournament's name beside a Trophy.
 * While the name resolves we fall back to a neutral "Tournament" label.
 */
export interface TournamentContext {
  name: string | null;
}

const NAV_LINK = (isActive: boolean, collapsed: boolean): string =>
  cn(
    "group relative flex items-center gap-3 rounded-lg py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    collapsed ? "justify-center px-0" : "px-3",
    isActive
      ? "bg-accent font-medium text-accent-foreground"
      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
  );

function railNavLink(item: NavItem, collapsed: boolean): React.ReactElement {
  const Icon = item.icon;

  // Stage-gated section not yet reached — disabled, with an "Unlocks at X" hint.
  if (item.locked) {
    return (
      <div
        key={item.key}
        aria-disabled="true"
        title={
          collapsed
            ? `${item.label} · ${t("Unlocks at")} ${item.lockLabel ?? ""}`
            : undefined
        }
        className={cn(
          "group relative flex cursor-not-allowed items-start gap-3 rounded-lg py-2 text-sm text-muted-foreground/40",
          collapsed ? "justify-center px-0" : "px-3",
        )}
      >
        <Lock aria-hidden="true" className="h-[18px] w-[18px] shrink-0" />
        {collapsed ? (
          <span className="sr-only">{item.label}</span>
        ) : (
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{item.label}</span>
            {item.lockLabel ? (
              <span className="truncate text-[0.6875rem]">
                {t("Unlocks at")} {item.lockLabel}
              </span>
            ) : null}
          </span>
        )}
      </div>
    );
  }

  return (
    <NavLink
      key={item.key}
      to={item.href}
      end
      title={collapsed ? item.label : undefined}
      className={({ isActive }) => NAV_LINK(isActive, collapsed)}
    >
      {({ isActive }) => (
        <>
          {isActive ? (
            <span
              aria-hidden="true"
              className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-primary"
            />
          ) : null}
          <Icon aria-hidden="true" className="h-[18px] w-[18px] shrink-0" />
          {collapsed ? (
            <>
              <span className="sr-only">{item.label}</span>
              {item.badge ? (
                <span
                  aria-hidden="true"
                  className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-primary"
                />
              ) : null}
            </>
          ) : (
            <>
              <span className="flex-1 truncate">{item.label}</span>
              {item.badge ? (
                <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                  {item.badge}
                </span>
              ) : null}
            </>
          )}
        </>
      )}
    </NavLink>
  );
}

/**
 * Desktop navigation rail. Fixed full-height left column so the app fills the
 * viewport (no centered-column dead margins). Hidden below md; the mobile
 * drawer in AppShell renders the same grouped nav.
 *
 * `collapsed` shrinks the rail to an icons-only strip (labels move to native
 * tooltips); the choice is persisted by AppShell.
 *
 * Two modes, both driven by `groups`:
 *  - Workspace mode (`tournament` omitted): Workspace + Admin groups.
 *  - Tournament mode (`tournament` provided): a context header ("← All
 *    tournaments" + Trophy + name) above the Manage group.
 */
export function Sidebar({
  groups,
  tournament,
  collapsed = false,
}: {
  groups: NavGroup[];
  tournament?: TournamentContext;
  collapsed?: boolean;
}): React.ReactElement {
  return (
    <aside
      className={cn(
        "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-border bg-card transition-[width] duration-200 md:flex print:!hidden",
        collapsed ? "w-16" : "w-60 lg:w-64",
      )}
    >
      <div
        className={cn(
          "flex h-14 items-center border-b border-border",
          collapsed ? "justify-center px-2" : "px-4",
        )}
      >
        <Link
          to={routes.landing()}
          title={collapsed ? t("Fixture") : undefined}
          className="flex items-center gap-2 rounded-md font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <BrandLogo className="h-7 w-7 rounded-lg shadow-sm" alt={t("Fixture")} />
          {collapsed ? null : t("Fixture")}
        </Link>
      </div>

      <nav
        aria-label={t("Primary")}
        className={cn(
          "flex flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden p-3",
          collapsed && "items-stretch",
        )}
      >
        {tournament ? (
          <div className="mb-2 flex flex-col gap-2 border-b border-border pb-3">
            <Link
              to={routes.tournaments()}
              title={collapsed ? t("All tournaments") : undefined}
              className={cn(
                "flex items-center gap-1.5 rounded-md py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                collapsed ? "justify-center px-0" : "px-3",
              )}
            >
              <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              {collapsed ? null : t("All tournaments")}
            </Link>
            <div
              className={cn(
                "flex items-center gap-2",
                collapsed ? "justify-center px-0" : "px-3",
              )}
              title={collapsed ? (tournament.name ?? t("Tournament")) : undefined}
            >
              <Trophy
                aria-hidden="true"
                className="h-[18px] w-[18px] shrink-0 text-primary"
              />
              {collapsed ? null : (
                <span className="truncate text-sm font-semibold tracking-tight">
                  {tournament.name ?? t("Tournament")}
                </span>
              )}
            </div>
          </div>
        ) : null}

        {groups.map((group) => (
          <div key={group.key} className="flex flex-col gap-0.5 pb-2">
            {collapsed ? (
              <div aria-hidden="true" className="mx-2 my-1 border-t border-border/60" />
            ) : (
              <p className="px-3 pb-1 pt-1 text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                {group.label}
              </p>
            )}
            {group.items.map((item) => railNavLink(item, collapsed))}
          </div>
        ))}
      </nav>

      <div className="border-t border-border p-3">
        <Link
          to={routes.tournamentNew()}
          title={collapsed ? t("New tournament") : undefined}
          className={cn(
            "flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            collapsed ? "px-0" : "px-3",
          )}
        >
          <Plus aria-hidden="true" className="h-4 w-4 shrink-0" />
          {collapsed ? null : t("New tournament")}
        </Link>
      </div>
    </aside>
  );
}
