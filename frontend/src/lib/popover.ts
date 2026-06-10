/**
 * Viewport-aware placement for fixed-position dropdowns (the portaled Select
 * listbox and the row-action kebab menus). Menus historically always opened
 * DOWNWARD, so a trigger near the bottom of the screen pushed its menu off
 * the viewport. This flips the menu above the anchor when the space below
 * can't fit it and the space above is larger, and clamps the height so the
 * open side never overflows.
 */
export interface FlipPlacement {
  /** Set when the menu opens downward (CSS `top`). */
  top?: number;
  /** Set when the menu opens upward (CSS `bottom`, measured from the viewport bottom). */
  bottom?: number;
  /** Available height on the chosen side, capped at the menu's natural height. */
  maxHeight: number;
}

/** Breathing room kept between the menu edge and the viewport edge. */
const VIEWPORT_MARGIN = 8;

export function flipPlacement(
  anchor: DOMRect,
  /** The menu's natural (unclamped) height in px — estimate is fine. */
  naturalHeight: number,
  gap = 6,
): FlipPlacement {
  const below = window.innerHeight - anchor.bottom - gap - VIEWPORT_MARGIN;
  const above = anchor.top - gap - VIEWPORT_MARGIN;
  const openUp = naturalHeight > below && above > below;
  const room = Math.max(96, openUp ? above : below);
  return {
    ...(openUp
      ? { bottom: window.innerHeight - anchor.top + gap }
      : { top: anchor.bottom + gap }),
    maxHeight: Math.min(naturalHeight, room),
  };
}
