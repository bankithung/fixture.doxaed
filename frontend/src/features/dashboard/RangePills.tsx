import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { cn } from "@/lib/tailwind";
import { motionDisabled } from "./BentoCard";

/** PillNav (React Bits), re-cut as the chart-window switcher: the hover
 * circle wipes up from the pill's bottom edge and the label swaps color,
 * token colors throughout. Selection = solid primary pill. */
export function RangePills({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  label: string;
}): React.ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const { isMobile } = useBreakpoint();

  useEffect(() => {
    const root = rootRef.current;
    if (!root || motionDisabled(isMobile)) return;

    const cleanups: (() => void)[] = [];
    root.querySelectorAll<HTMLElement>("[data-pill]").forEach((pill) => {
      const circle = pill.querySelector<HTMLElement>(".pill-circle");
      const label = pill.querySelector<HTMLElement>(".pill-label");
      const hoverLabel = pill.querySelector<HTMLElement>(".pill-label-hover");
      if (!circle || !label || !hoverLabel) return;

      const layout = (): gsap.core.Timeline => {
        const { width: w, height: h } = pill.getBoundingClientRect();
        const R = w > 0 && h > 0 ? (w * w) / 4 / h + h : 40;
        const D = Math.ceil(2 * R) + 2;
        gsap.set(circle, {
          width: D,
          height: D,
          bottom: -(D - h) / 2 - h * 0.15,
          xPercent: -50,
          left: "50%",
          scale: 0,
          transformOrigin: "50% 85%",
        });
        gsap.set(label, { y: 0 });
        gsap.set(hoverLabel, { y: h + 8, opacity: 0 });
        const tl = gsap.timeline({ paused: true });
        tl.to(circle, { scale: 1.1, duration: 0.9, ease: "power3.out" }, 0);
        tl.to(label, { y: -(h + 6), duration: 0.9, ease: "power3.out" }, 0);
        tl.to(hoverLabel, { y: 0, opacity: 1, duration: 0.9, ease: "power3.out" }, 0);
        return tl;
      };

      let tl = layout();
      let active: gsap.core.Tween | null = null;
      const onEnter = (): void => {
        active?.kill();
        active = tl.tweenTo(tl.duration(), { duration: 0.28, ease: "power3.out" });
      };
      const onLeave = (): void => {
        active?.kill();
        active = tl.tweenTo(0, { duration: 0.2, ease: "power3.out" });
      };
      const onResize = (): void => {
        tl.kill();
        tl = layout();
      };
      pill.addEventListener("mouseenter", onEnter);
      pill.addEventListener("mouseleave", onLeave);
      window.addEventListener("resize", onResize);
      cleanups.push(() => {
        pill.removeEventListener("mouseenter", onEnter);
        pill.removeEventListener("mouseleave", onLeave);
        window.removeEventListener("resize", onResize);
        active?.kill();
        tl.kill();
        gsap.set([circle, label, hoverLabel], { clearProps: "all" });
      });
    });
    return () => cleanups.forEach((fn) => fn());
  }, [isMobile, options]);

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={label}
      className="flex items-center gap-0.5 rounded-full bg-secondary p-0.5"
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            data-pill={selected ? undefined : ""}
            aria-pressed={selected}
            onClick={() => onChange(opt.value)}
            className={cn(
              "relative h-6 overflow-hidden rounded-full px-2.5 text-[11px] font-medium transition-colors",
              selected
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground",
            )}
          >
            {selected ? (
              opt.label
            ) : (
              <>
                <span
                  className="pill-circle pointer-events-none absolute rounded-full bg-primary"
                  aria-hidden="true"
                />
                <span className="relative inline-block leading-none">
                  <span className="pill-label inline-block leading-none">
                    {opt.label}
                  </span>
                  <span
                    className="pill-label-hover absolute left-0 top-0 inline-block leading-none text-primary-foreground"
                    aria-hidden="true"
                  >
                    {opt.label}
                  </span>
                </span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
