import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { gsap } from "gsap";
import { ArrowLeft, Lock, Plus, Trophy, X } from "lucide-react";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { Button } from "@/components/ui/button";
import type { NavGroup, NavItem } from "./computeNavItems";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import "./staggered-nav.css";

/** StaggeredMenu (React Bits), re-cut as the left nav overlay below md:
 * brand prelayers sweep in ahead of the card panel, then the nav items
 * stagger up with the source's clip + rotate reveal. Token colors, the same
 * contextual NavGroups as the desktop rail, and the drawer's a11y contract
 * (dialog role, Escape, scrim click, focus to close). Animations need
 * matchMedia + no reduced-motion; otherwise it renders instantly. */

function canAnimate(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function StaggeredNavMenu({
  open,
  onClose,
  groups,
  tournamentName,
  inTournamentContext,
  onSignOut,
}: {
  open: boolean;
  onClose: () => void;
  groups: NavGroup[];
  tournamentName: string | null;
  inTournamentContext: boolean;
  onSignOut: () => void;
}): React.ReactElement | null {
  // Stay mounted through the close animation.
  const [rendered, setRendered] = useState(open);
  const rootRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const closingRef = useRef(false);

  useEffect(() => {
    if (open) setRendered(true);
  }, [open]);

  // Escape closes (mirrors the old drawer).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Focus lands on the close button once the panel exists.
  useEffect(() => {
    if (open && rendered) closeBtnRef.current?.focus();
  }, [open, rendered]);

  // The staggered choreography, scoped so unmount reverts every tween.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !rendered) return;

    if (!canAnimate()) {
      if (!open) setRendered(false);
      return;
    }

    const ctx = gsap.context(() => {
      const layers = root.querySelectorAll<HTMLElement>(".snav-layer");
      const panel = root.querySelector<HTMLElement>(".snav-panel");
      const scrim = root.querySelector<HTMLElement>(".snav-scrim");
      const items = root.querySelectorAll<HTMLElement>(".snav-item-inner");
      const footer = root.querySelector<HTMLElement>(".snav-footer");
      if (!panel || !scrim) return;

      if (open) {
        closingRef.current = false;
        gsap.set([panel, ...layers], { xPercent: -100 });
        gsap.set(scrim, { opacity: 0 });
        gsap.set(items, { yPercent: 130, rotate: 6 });
        if (footer) gsap.set(footer, { y: 16, opacity: 0 });

        const tl = gsap.timeline();
        tl.to(scrim, { opacity: 1, duration: 0.3, ease: "power2.out" }, 0);
        layers.forEach((layer, i) => {
          tl.to(
            layer,
            { xPercent: 0, duration: 0.45, ease: "power4.out" },
            i * 0.07,
          );
        });
        const panelAt = layers.length * 0.07 + 0.08;
        tl.to(
          panel,
          { xPercent: 0, duration: 0.55, ease: "power4.out" },
          panelAt,
        );
        tl.to(
          items,
          {
            yPercent: 0,
            rotate: 0,
            duration: 0.7,
            ease: "power4.out",
            stagger: { each: 0.045, from: "start" },
          },
          panelAt + 0.1,
        );
        if (footer) {
          tl.to(
            footer,
            { y: 0, opacity: 1, duration: 0.4, ease: "power3.out" },
            panelAt + 0.25,
          );
        }
      } else if (!closingRef.current) {
        closingRef.current = true;
        const tl = gsap.timeline({
          onComplete: () => setRendered(false),
        });
        tl.to([...layers, panel], {
          xPercent: -100,
          duration: 0.3,
          ease: "power3.in",
        });
        tl.to(scrim, { opacity: 0, duration: 0.25, ease: "power2.in" }, 0.05);
      }
    }, root);
    return () => ctx.revert();
  }, [open, rendered]);

  if (!rendered) return null;

  const navLink = (item: NavItem): React.ReactElement => {
    const Icon = item.icon;
    if (item.locked) {
      return (
        <div key={item.key} className="snav-itemwrap">
          <div
            aria-disabled="true"
            className="snav-item-inner flex cursor-not-allowed items-start gap-3 rounded-lg px-3 py-2 text-muted-foreground/40"
          >
            <Lock aria-hidden="true" className="mt-1 h-[18px] w-[18px] shrink-0" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-base font-semibold tracking-tight">
                {item.label}
              </span>
              {item.lockLabel ? (
                <span className="truncate text-[0.6875rem]">
                  {t("Unlocks at")} {item.lockLabel}
                </span>
              ) : null}
            </span>
          </div>
        </div>
      );
    }
    return (
      <div key={item.key} className="snav-itemwrap">
        <NavLink
          to={item.href}
          end
          className={({ isActive }) =>
            cn(
              "snav-item-inner flex items-center gap-3 rounded-lg px-3 py-2 text-base font-semibold tracking-tight transition-colors",
              isActive
                ? "bg-accent text-accent-foreground"
                : "text-foreground/80 hover:bg-accent/50 hover:text-primary",
            )
          }
        >
          <Icon aria-hidden="true" className="h-[18px] w-[18px] shrink-0" />
          <span className="flex-1 truncate">{item.label}</span>
          {item.badge ? (
            <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
              {item.badge}
            </span>
          ) : null}
        </NavLink>
      </div>
    );
  };

  return (
    <div
      ref={rootRef}
      id="mobile-nav-drawer"
      role="dialog"
      aria-modal="true"
      aria-label={t("Navigation menu")}
      className="snav-root md:hidden"
    >
      <div aria-hidden="true" className="snav-scrim" onClick={onClose} />
      <div aria-hidden="true" className="snav-layers">
        <div className="snav-layer snav-layer--1" />
        <div className="snav-layer snav-layer--2" />
      </div>
      <div className="snav-panel gap-2 p-4">
        <div className="flex items-center justify-between">
          <Link
            to={routes.landing()}
            onClick={onClose}
            className="flex items-center gap-2 rounded-md font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <BrandLogo className="h-7 w-7 rounded-lg" />
            {t("Fixture")}
          </Link>
          <button
            ref={closeBtnRef}
            type="button"
            aria-label={t("Close navigation menu")}
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>

        {inTournamentContext ? (
          <div className="flex flex-col gap-2 border-b pb-3">
            <Link
              to={routes.tournaments()}
              onClick={onClose}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              {t("All tournaments")}
            </Link>
            <div className="flex items-center gap-2 px-2">
              <Trophy
                aria-hidden="true"
                className="h-[18px] w-[18px] shrink-0 text-primary"
              />
              <span className="truncate text-sm font-semibold tracking-tight">
                {tournamentName ?? t("Tournament")}
              </span>
            </div>
          </div>
        ) : null}

        <nav
          aria-label={t("Primary")}
          className="flex flex-col gap-1 overflow-y-auto"
          onClick={onClose}
        >
          {groups.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              {t("Pick an organization to see navigation.")}
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.key} className="flex flex-col gap-1 pb-2">
                <p className="px-2 pb-0.5 pt-1 text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  {group.label}
                </p>
                {group.items.map(navLink)}
              </div>
            ))
          )}
        </nav>

        <div className="snav-footer mt-auto flex flex-col gap-1 border-t pt-3">
          <Link
            to={routes.tournamentNew()}
            onClick={onClose}
            className="mb-1 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            {t("New tournament")}
          </Link>
          <Link
            to={routes.myProfile()}
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm hover:bg-accent"
          >
            {t("My profile")}
          </Link>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onSignOut}
          >
            {t("Sign out")}
          </Button>
        </div>
      </div>
    </div>
  );
}
