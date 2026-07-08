/** True when animation must not run: no window/matchMedia (jsdom) or the
 * user prefers reduced motion. Shared gate for every landing effect. */
export function motionOff(): boolean {
  return (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
