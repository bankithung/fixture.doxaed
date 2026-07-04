import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { cn } from "@/lib/tailwind";
import "./bento.css";

/** MagicBento (React Bits), re-cut for the app: token-driven colors, .panel
 * chrome, effects disabled on mobile and under prefers-reduced-motion. */

const SPOTLIGHT_RADIUS = 280;
const PARTICLE_COUNT = 8;

export function motionDisabled(isMobile: boolean): boolean {
  if (isMobile) return true;
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Wraps the dashboard grid: mounts ONE fixed spotlight div that follows the
 * cursor and drives each child .bento-card's border-glow vars by proximity.
 */
export function BentoGrid({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  const gridRef = useRef<HTMLDivElement>(null);
  const { isMobile } = useBreakpoint();

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || motionDisabled(isMobile)) return;

    const spotlight = document.createElement("div");
    spotlight.className = "bento-spotlight";
    document.body.appendChild(spotlight);
    gsap.set(spotlight, { xPercent: -50, yPercent: -50 });

    const proximity = SPOTLIGHT_RADIUS * 0.5;
    const fade = SPOTLIGHT_RADIUS * 0.75;

    const resetCards = (): void => {
      grid
        .querySelectorAll<HTMLElement>(".bento-card")
        .forEach((card) => card.style.setProperty("--glow-intensity", "0"));
    };

    const onMove = (e: MouseEvent): void => {
      const rect = grid.getBoundingClientRect();
      const inside =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
      if (!inside) {
        gsap.to(spotlight, { opacity: 0, duration: 0.4, ease: "power2.out" });
        resetCards();
        return;
      }
      let minDistance = Infinity;
      grid.querySelectorAll<HTMLElement>(".bento-card").forEach((card) => {
        const r = card.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const distance = Math.max(
          0,
          Math.hypot(e.clientX - cx, e.clientY - cy) -
            Math.max(r.width, r.height) / 2,
        );
        minDistance = Math.min(minDistance, distance);
        const glow =
          distance <= proximity
            ? 1
            : distance <= fade
              ? (fade - distance) / (fade - proximity)
              : 0;
        card.style.setProperty(
          "--glow-x",
          `${((e.clientX - r.left) / r.width) * 100}%`,
        );
        card.style.setProperty(
          "--glow-y",
          `${((e.clientY - r.top) / r.height) * 100}%`,
        );
        card.style.setProperty("--glow-intensity", glow.toFixed(3));
      });
      gsap.to(spotlight, {
        x: e.clientX,
        y: e.clientY,
        duration: 0.12,
        ease: "power2.out",
      });
      const target =
        minDistance <= proximity
          ? 0.9
          : minDistance <= fade
            ? ((fade - minDistance) / (fade - proximity)) * 0.9
            : 0;
      gsap.to(spotlight, {
        opacity: target,
        duration: target > 0 ? 0.2 : 0.5,
        ease: "power2.out",
      });
    };

    const onLeave = (): void => {
      gsap.to(spotlight, { opacity: 0, duration: 0.4, ease: "power2.out" });
      resetCards();
    };

    document.addEventListener("mousemove", onMove, { passive: true });
    document.documentElement.addEventListener("mouseleave", onLeave);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.documentElement.removeEventListener("mouseleave", onLeave);
      gsap.killTweensOf(spotlight);
      spotlight.remove();
    };
  }, [isMobile]);

  return (
    <div ref={gridRef} className={className}>
      {children}
    </div>
  );
}

/**
 * A dashboard cell: .panel chrome + the border glow (via BentoGrid) and,
 * optionally, the hover star-particle effect from MagicBento.
 */
export function BentoCard({
  children,
  className,
  particles = false,
  testId,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  particles?: boolean;
  testId?: string;
  style?: React.CSSProperties;
}): React.ReactElement {
  const cardRef = useRef<HTMLDivElement>(null);
  const { isMobile } = useBreakpoint();

  useEffect(() => {
    const el = cardRef.current;
    if (!el || !particles || motionDisabled(isMobile)) return;

    let hovered = false;
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    const spawned: HTMLElement[] = [];

    const clear = (): void => {
      timeouts.forEach(clearTimeout);
      timeouts.length = 0;
      spawned.forEach((p) => {
        gsap.to(p, {
          scale: 0,
          opacity: 0,
          duration: 0.3,
          ease: "back.in(1.7)",
          onComplete: () => p.remove(),
        });
      });
      spawned.length = 0;
    };

    const onEnter = (): void => {
      hovered = true;
      const { width, height } = el.getBoundingClientRect();
      for (let i = 0; i < PARTICLE_COUNT; i += 1) {
        timeouts.push(
          setTimeout(() => {
            if (!hovered) return;
            const p = document.createElement("div");
            p.className = "bento-particle";
            p.style.left = `${Math.random() * width}px`;
            p.style.top = `${Math.random() * height}px`;
            el.appendChild(p);
            spawned.push(p);
            gsap.fromTo(
              p,
              { scale: 0, opacity: 0 },
              { scale: 1, opacity: 1, duration: 0.3, ease: "back.out(1.7)" },
            );
            gsap.to(p, {
              x: (Math.random() - 0.5) * 80,
              y: (Math.random() - 0.5) * 80,
              duration: 2 + Math.random() * 2,
              ease: "none",
              repeat: -1,
              yoyo: true,
            });
            gsap.to(p, {
              opacity: 0.4,
              duration: 1.5,
              ease: "power2.inOut",
              repeat: -1,
              yoyo: true,
            });
          }, i * 110),
        );
      }
    };
    const onLeave = (): void => {
      hovered = false;
      clear();
    };

    el.addEventListener("mouseenter", onEnter);
    el.addEventListener("mouseleave", onLeave);
    return () => {
      hovered = false;
      el.removeEventListener("mouseenter", onEnter);
      el.removeEventListener("mouseleave", onLeave);
      clear();
    };
  }, [particles, isMobile]);

  return (
    <div
      ref={cardRef}
      className={cn("bento-card panel", className)}
      data-testid={testId}
      style={style}
    >
      {children}
    </div>
  );
}
