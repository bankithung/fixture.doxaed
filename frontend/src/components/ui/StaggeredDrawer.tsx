import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { gsap } from "gsap";
import { X } from "lucide-react";
import { t } from "@/lib/t";
import "./staggered-drawer.css";

/** StaggeredMenu (React Bits), re-cut as a generic RIGHT-side drawer for
 * settings surfaces at every breakpoint: brand prelayers sweep in ahead of
 * the card panel, then children wrapped in `.sdrawer-itemwrap > .sdrawer-item`
 * rise in with the clip stagger. Dialog a11y contract (Escape, scrim click,
 * focus to close); renders instantly without matchMedia or under reduced
 * motion. */

function canAnimate(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function StaggeredDrawer({
  open,
  onClose,
  title,
  children,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  testId?: string;
}): React.ReactElement | null {
  // Stay mounted through the close animation.
  const [rendered, setRendered] = useState(open);
  const rootRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const closingRef = useRef(false);

  useEffect(() => {
    if (open) setRendered(true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open && rendered) closeBtnRef.current?.focus();
  }, [open, rendered]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !rendered) return;

    if (!canAnimate()) {
      if (!open) setRendered(false);
      return;
    }

    const ctx = gsap.context(() => {
      const layers = root.querySelectorAll<HTMLElement>(".sdrawer-layer");
      const panel = root.querySelector<HTMLElement>(".sdrawer-panel");
      const scrim = root.querySelector<HTMLElement>(".sdrawer-scrim");
      const items = root.querySelectorAll<HTMLElement>(".sdrawer-item");
      if (!panel || !scrim) return;

      if (open) {
        closingRef.current = false;
        gsap.set([panel, ...layers], { xPercent: 100 });
        gsap.set(scrim, { opacity: 0 });
        gsap.set(items, { yPercent: 120, rotate: 4 });

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
            duration: 0.6,
            ease: "power4.out",
            stagger: { each: 0.05, from: "start" },
          },
          panelAt + 0.1,
        );
      } else if (!closingRef.current) {
        closingRef.current = true;
        const tl = gsap.timeline({ onComplete: () => setRendered(false) });
        tl.to([...layers, panel], {
          xPercent: 100,
          duration: 0.3,
          ease: "power3.in",
        });
        tl.to(scrim, { opacity: 0, duration: 0.25, ease: "power2.in" }, 0.05);
      }
    }, root);
    return () => ctx.revert();
  }, [open, rendered]);

  if (!rendered) return null;

  // Portaled to <body>: panels/StarBorder wrappers use overflow-hidden and
  // transforms, which turn position:fixed into position-in-my-corner (owner
  // 2026-07-05: the sports filter drawer slid out of the SECTION).
  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid={testId}
      className="sdrawer-root"
    >
      <div aria-hidden="true" className="sdrawer-scrim" onClick={onClose} />
      <div aria-hidden="true" className="sdrawer-layers">
        <div className="sdrawer-layer sdrawer-layer--1" />
        <div className="sdrawer-layer sdrawer-layer--2" />
      </div>
      <div className="sdrawer-panel">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          <button
            ref={closeBtnRef}
            type="button"
            aria-label={t("Close settings")}
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>
        <div className="flex flex-1 flex-col gap-4 p-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
