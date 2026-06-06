import { Link, NavLink } from "react-router-dom";
import { Plus } from "lucide-react";
import type { NavItem } from "./computeNavItems";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * Desktop navigation rail. Fixed full-height left column so the app fills the
 * viewport (no centered-column dead margins). Hidden below md; the mobile
 * drawer in AppShell renders the same nav list.
 */
export function Sidebar({
  navItems,
}: {
  navItems: NavItem[];
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
        className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-3"
      >
        <p className="px-3 pb-1 pt-1 text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {t("Workspace")}
        </p>
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.key}
              to={item.href}
              end
              className={({ isActive }) =>
                cn(
                  "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isActive
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )
              }
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
        })}
      </nav>

      <div className="border-t border-border p-3">
        <Link
          to="/tournaments/new"
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
          {t("New tournament")}
        </Link>
      </div>
    </aside>
  );
}
