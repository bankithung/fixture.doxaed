import { useBreakpoint } from "@/lib/useBreakpoint";

/**
 * AmbientBackdrop: mobile-only page backdrop of two slow-drifting brand
 * blobs (pure CSS, zero download weight). Desktop's background is the
 * scroll film (CinematicBackdrop); while its frames load, the plain page
 * background shows instead of any placeholder scene (owner decision
 * 2026-07-08, replacing the old stadium SVG fallback).
 */
export function AmbientBackdrop(): React.ReactElement | null {
  const { isMobile } = useBreakpoint();
  if (!isMobile) return null;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-[5] overflow-hidden print:hidden"
    >
      <span className="ambient-blob ambient-blob--a" />
      <span className="ambient-blob ambient-blob--b" />
    </div>
  );
}
