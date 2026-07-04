import { Suspense, lazy, useEffect, useState } from "react";
import { useBreakpoint } from "@/lib/useBreakpoint";

/** The app-wide PixelBlast backdrop: fixed behind the shell, brand-colored
 * from the --primary token (re-read on theme flips), pointer-events-none.
 * Renders nothing on mobile, under prefers-reduced-motion, or without
 * matchMedia (jsdom) — and the three.js chunk only loads when it renders. */

const PixelBlast = lazy(() => import("./PixelBlast"));

function readPrimary(): string {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--primary")
    .trim();
  if (!raw) return "#6840dd";
  // Tokens are HSL triplets ("255 70% 56%"); THREE.Color wants commas.
  return `hsl(${raw.replace(/\s+/g, ", ")})`;
}

export function AppBackdrop(): React.ReactElement | null {
  const { isMobile } = useBreakpoint();
  const [color, setColor] = useState<string | null>(null);

  const enabled =
    !isMobile &&
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    if (!enabled) return;
    setColor(readPrimary());
    // Theme flips toggle .dark on <html>; retint without a WebGL re-init.
    const observer = new MutationObserver(() => setColor(readPrimary()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, [enabled]);

  if (!enabled || color === null) return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 opacity-30 dark:opacity-20 print:hidden"
    >
      <Suspense fallback={null}>
        <PixelBlast color={color} />
      </Suspense>
    </div>
  );
}
