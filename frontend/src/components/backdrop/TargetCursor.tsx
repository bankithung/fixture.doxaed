import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import "./target-cursor.css";

/** TargetCursor (React Bits), a lean TS re-cut: a spinning bracket cursor
 * that locks its four corners onto `.cursor-target` elements. Scoped mounts
 * only (the sports pick step) — never app-wide over data surfaces. Skips
 * touch devices, jsdom, and reduced motion; restores the native cursor on
 * unmount. Parallax ticker from the source is dropped for simplicity. */

const CORNER = 12;
const BORDER = 3;

function enabled(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  const touch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  return !(touch && window.innerWidth <= 768);
}

export function TargetCursor({
  targetSelector = ".cursor-target",
  spinDuration = 2,
}: {
  targetSelector?: string;
  spinDuration?: number;
}): React.ReactElement | null {
  const cursorRef = useRef<HTMLDivElement>(null);
  const active = enabled();

  useEffect(() => {
    const cursor = cursorRef.current;
    if (!cursor || !active) return;

    const corners = Array.from(
      cursor.querySelectorAll<HTMLElement>(".target-cursor-corner"),
    );
    const originalCursor = document.body.style.cursor;
    document.body.style.cursor = "none";

    gsap.set(cursor, {
      xPercent: -50,
      yPercent: -50,
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });

    let spin: gsap.core.Timeline | null = gsap
      .timeline({ repeat: -1 })
      .to(cursor, { rotation: "+=360", duration: spinDuration, ease: "none" });

    const restPositions = [
      { x: -CORNER * 1.5, y: -CORNER * 1.5 },
      { x: CORNER * 0.5, y: -CORNER * 1.5 },
      { x: CORNER * 0.5, y: CORNER * 0.5 },
      { x: -CORNER * 1.5, y: CORNER * 0.5 },
    ];

    let activeTarget: Element | null = null;

    const onMove = (e: MouseEvent): void => {
      gsap.to(cursor, { x: e.clientX, y: e.clientY, duration: 0.1, ease: "power3.out" });
      if (activeTarget) {
        // Re-aim the corners as the pointer travels across the target.
        lockTo(activeTarget);
      }
    };

    const lockTo = (target: Element): void => {
      const rect = target.getBoundingClientRect();
      const cx = Number(gsap.getProperty(cursor, "x"));
      const cy = Number(gsap.getProperty(cursor, "y"));
      const spots = [
        { x: rect.left - BORDER, y: rect.top - BORDER },
        { x: rect.right + BORDER - CORNER, y: rect.top - BORDER },
        { x: rect.right + BORDER - CORNER, y: rect.bottom + BORDER - CORNER },
        { x: rect.left - BORDER, y: rect.bottom + BORDER - CORNER },
      ];
      corners.forEach((corner, i) => {
        gsap.to(corner, {
          x: spots[i].x - cx,
          y: spots[i].y - cy,
          duration: 0.2,
          ease: "power2.out",
          overwrite: "auto",
        });
      });
    };

    const release = (): void => {
      activeTarget = null;
      corners.forEach((corner, i) => {
        gsap.to(corner, {
          x: restPositions[i].x,
          y: restPositions[i].y,
          duration: 0.3,
          ease: "power3.out",
          overwrite: "auto",
        });
      });
      spin?.resume();
    };

    const onOver = (e: MouseEvent): void => {
      const target = (e.target as Element | null)?.closest?.(targetSelector);
      if (!target || target === activeTarget) return;
      activeTarget = target;
      spin?.pause();
      gsap.set(cursor, { rotation: 0 });
      lockTo(target);
      target.addEventListener(
        "mouseleave",
        () => {
          if (activeTarget === target) release();
        },
        { once: true },
      );
    };

    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("mouseover", onOver, { passive: true });

    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseover", onOver);
      spin?.kill();
      spin = null;
      gsap.killTweensOf([cursor, ...corners]);
      document.body.style.cursor = originalCursor;
    };
  }, [active, targetSelector, spinDuration]);

  if (!active) return null;

  return (
    <div ref={cursorRef} className="target-cursor-wrapper" aria-hidden="true">
      <div className="target-cursor-dot" />
      <div className="target-cursor-corner corner-tl" />
      <div className="target-cursor-corner corner-tr" />
      <div className="target-cursor-corner corner-br" />
      <div className="target-cursor-corner corner-bl" />
    </div>
  );
}
