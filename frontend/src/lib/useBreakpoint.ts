import { useSyncExternalStore } from "react";

/**
 * Global screen-size detector. A single source of truth for the current
 * viewport width + breakpoint, usable from any component. Backed by
 * useSyncExternalStore so there's exactly one resize listener regardless of
 * how many components read it, and it stays correct across concurrent renders.
 *
 * Breakpoints mirror Tailwind's defaults so JS decisions and CSS utilities agree.
 */
export type Breakpoint = "xs" | "sm" | "md" | "lg" | "xl" | "2xl";

const SSR_WIDTH = 1280;

function currentWidth(): number {
  return typeof window === "undefined" ? SSR_WIDTH : window.innerWidth;
}

function toBreakpoint(w: number): Breakpoint {
  if (w >= 1536) return "2xl";
  if (w >= 1280) return "xl";
  if (w >= 1024) return "lg";
  if (w >= 768) return "md";
  if (w >= 640) return "sm";
  return "xs";
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("resize", onChange, { passive: true });
  window.addEventListener("orientationchange", onChange, { passive: true });
  return () => {
    window.removeEventListener("resize", onChange);
    window.removeEventListener("orientationchange", onChange);
  };
}

/** Reactive viewport width (px). */
export function useScreenWidth(): number {
  return useSyncExternalStore(subscribe, currentWidth, () => SSR_WIDTH);
}

export interface ScreenInfo {
  width: number;
  breakpoint: Breakpoint;
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  /** True at or above the given breakpoint (e.g. `up("lg")`). */
  up: (bp: Breakpoint) => boolean;
}

const MIN: Record<Breakpoint, number> = {
  xs: 0,
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
};

/** The global screen-size detector hook. */
export function useBreakpoint(): ScreenInfo {
  const width = useScreenWidth();
  return {
    width,
    breakpoint: toBreakpoint(width),
    isMobile: width < 768,
    isTablet: width >= 768 && width < 1024,
    isDesktop: width >= 1024,
    up: (bp) => width >= MIN[bp],
  };
}
