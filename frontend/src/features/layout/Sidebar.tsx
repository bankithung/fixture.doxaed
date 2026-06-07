import { Link, NavLink } from "react-router-dom";
import { ArrowLeft, Plus, Trophy } from "lucide-react";
import type { NavGroup, NavItem } from "./computeNavItems";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * Tournament-context header shown above the groups in tournament mode: a
 * "back to all tournaments" link, then the tournament's name beside a Trophy.
 * While the name resolves we fall back to a neutral "Tournament" label.
 */
export interface TournamentContext {
  name: string | null;
}

const NAV_LINK = (isActive: boolean): string =>
  cn(
    "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    isActive
      ? "bg-accent font-medium text-accent-foreground"
      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
  );

function railNavLink(item: NavItem): React.ReactElement {
  const Icon = item.icon;
  return (
    <NavLink
      key={item.key}
      to={item.href}
      end
      className={({ isActive }) => NAV_LINK(isActive)}
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
          <span className="flex-1 truncate">{item.label}</span>
          {item.badge ? (
            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800">
              {item.badge}
            </span>
          ) : null}
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
 * Two modes, both driven by `groups`:
 *  - Workspace mode (`tournament` omitted): Workspace + Admin groups.
 *  - Tournament mode (`tournament` provided): a context header ("← All
 *    tournaments" + Trophy + name) above the Manage group.
 */
export function Sidebar({
  groups,
  tournament,
}: {
  groups: NavGroup[];
  tournament?: TournamentContext;
}): React.ReactElement {
  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-card md:flex lg:w-64">
      <div className="flex h-14 items-center border-b border-border px-4">
        <Link
          to={routes.landing()}
          className="flex items-center gap-2 rounded-md font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground shadow-sm">
            F
          </span>
          {t("Fixture")}
        </Link>
      </div>

      <nav
        aria-label={t("Primary")}
        className="flex flex-1 flex-col gap-1 overflow-y-auto p-3"
      >
        {tournament ? (
          <div className="mb-2 flex flex-col gap-2 border-b border-border pb-3">
            <Link
              to={routes.tournaments()}
              className="flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              {t("All tournaments")}
            </Link>
            <div className="flex items-center gap-2 px-3">
              <Trophy
                aria-hidden="true"
                className="h-[18px] w-[18px] shrink-0 text-primary"
              />
              <span className="truncate text-sm font-semibold tracking-tight">
                {tournament.name ?? t("Tournament")}
              </span>
            </div>
          </div>
        ) : null}

        {groups.map((group) => (
          <div key={group.key} className="flex flex-col gap-0.5 pb-2">
            <p className="px-3 pb-1 pt-1 text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              {group.label}
            </p>
            {group.items.map(railNavLink)}
          </div>
        ))}
      </nav>

      <div className="border-t border-border p-3">
        <Link
          to={routes.tournamentNew()}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
          {t("New tournament")}
        </Link>
      </div>
    </aside>
  );
}
