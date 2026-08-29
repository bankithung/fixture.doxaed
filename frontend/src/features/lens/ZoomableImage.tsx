import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/tailwind";

/**
 * A photograph you can get closer to — the way every phone gallery and
 * Instagram behave, so nobody has to learn it (owner 2026-08-29):
 *
 *  - pinch to zoom, one finger to pan once zoomed;
 *  - double-tap (or double-click) to jump in at that point, again to reset;
 *  - mouse wheel zooms around the cursor on a desk, drag pans;
 *  - a horizontal swipe while NOT zoomed pages to the next or previous photo,
 *    so the viewer walks the album with a thumb.
 *
 * Everything is a CSS transform on the image; the box never scrolls, so the
 * page behind stays put. The zoom resets whenever the picture changes.
 */

const MIN = 1;
const MAX = 4;
const TAP_ZOOM = 2.5;
const SWIPE_PX = 48;
const REST: View = { s: 1, x: 0, y: 0 };

type Pt = { x: number; y: number };
type View = { s: number; x: number; y: number };

export function ZoomableImage({
  src,
  alt,
  onSwipe,
  testid = "zoomable-image",
}: {
  src: string;
  alt: string;
  /** A horizontal swipe at scale 1: -1 = previous, +1 = next. */
  onSwipe?: (dir: -1 | 1) => void;
  testid?: string;
}): React.ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<View>(REST);
  /** A finger (or button) is down: the picture follows it with no easing. */
  const [live, setLive] = useState(false);
  // A new picture starts at rest. Derived during render rather than in an
  // effect, so the old zoom never paints on the new photo for a frame.
  const [seenSrc, setSeenSrc] = useState(src);
  if (src !== seenSrc) {
    setSeenSrc(src);
    setView(REST);
  }
  /** Live pointers, outside React: the gesture loop reads and writes them. */
  const pointers = useRef(new Map<number, Pt>());
  const gesture = useRef<{
    start: View;
    startMid: Pt;
    startDist: number;
    moved: boolean;
  } | null>(null);
  const lastTap = useRef<{ at: number; p: Pt } | null>(null);

  /** Keep the picture over the box: when zoomed it may pan only as far as its
   * own edge, and at scale 1 it sits centred. */
  const clamp = useCallback((v: View): View => {
    const s = Math.min(MAX, Math.max(MIN, v.s));
    const b = box.current;
    const i = img.current;
    if (!b || !i) return { s, x: v.x, y: v.y };
    const maxX = Math.max(0, (i.offsetWidth * s - b.clientWidth) / 2);
    const maxY = Math.max(0, (i.offsetHeight * s - b.clientHeight) / 2);
    return {
      s,
      x: Math.min(maxX, Math.max(-maxX, v.x)),
      y: Math.min(maxY, Math.max(-maxY, v.y)),
    };
  }, []);

  /** A point in the box, relative to its centre (the transform origin). */
  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
  };

  /** Zoom to `s` keeping the picture under `p` where it is. */
  const zoomAt = useCallback(
    (from: View, s: number, p: Pt): View => {
      const k = Math.min(MAX, Math.max(MIN, s)) / from.s;
      return clamp({ s: from.s * k, x: p.x - (p.x - from.x) * k, y: p.y - (p.y - from.y) * k });
    },
    [clamp],
  );

  // Attached by hand, NOT via onWheel: React registers wheel listeners as
  // passive, so preventDefault there is ignored and the page behind the
  // viewer would scroll under every notch of zoom.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const p = local(e);
      setView((v) => zoomAt(v, v.s * Math.exp(-e.deltaY * 0.002), p));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const toggleAt = (p: Pt): void => {
    setView((v) => (v.s > 1 ? REST : zoomAt(v, TAP_ZOOM, p)));
  };

  const onPointerDown = (e: React.PointerEvent): void => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setLive(true);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    const mid = midOf(pts);
    gesture.current = {
      start: view,
      startMid: mid,
      startDist: pts.length > 1 ? dist(pts[0], pts[1]) : 0,
      moved: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const pts = [...pointers.current.values()];
    const mid = midOf(pts);
    const dx = mid.x - g.startMid.x;
    const dy = mid.y - g.startMid.y;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) g.moved = true;
    if (pts.length > 1 && g.startDist > 0) {
      // Pinch: scale by the change in finger spread, anchored at the midpoint.
      const k = Math.min(MAX, Math.max(MIN, g.start.s * (dist(pts[0], pts[1]) / g.startDist))) / g.start.s;
      const m0 = local({ clientX: g.startMid.x, clientY: g.startMid.y });
      setView(clamp({
        s: g.start.s * k,
        x: m0.x + dx - (m0.x - g.start.x) * k,
        y: m0.y + dy - (m0.y - g.start.y) * k,
      }));
    } else if (g.start.s > 1) {
      setView(clamp({ s: g.start.s, x: g.start.x + dx, y: g.start.y + dy }));
    }
  };

  const onPointerUp = (e: React.PointerEvent): void => {
    const g = gesture.current;
    const p = pointers.current.get(e.pointerId);
    pointers.current.delete(e.pointerId);
    if (!g || !p) return;
    const wasPinch = g.startDist > 0;
    if (pointers.current.size > 0) {
      // A finger lifted mid-pinch: the rest continue as a fresh gesture.
      const pts = [...pointers.current.values()];
      gesture.current = { start: view, startMid: midOf(pts), startDist: 0, moved: true };
      return;
    }
    gesture.current = null;
    setLive(false);
    if (wasPinch) return;
    const dx = e.clientX - g.startMid.x;
    const dy = e.clientY - g.startMid.y;
    if (g.start.s === 1 && Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
      onSwipe?.(dx < 0 ? 1 : -1);
      return;
    }
    if (g.moved) return;
    // A tap (or click — the mouse comes through here too, so there is no
    // separate dblclick handler to fire a second toggle). Two within a
    // beat, in the same place, is a double-tap.
    const now = performance.now();
    const at = local(e);
    const last = lastTap.current;
    if (last && now - last.at < 320 && Math.hypot(last.p.x - at.x, last.p.y - at.y) < 24) {
      lastTap.current = null;
      toggleAt(at);
    } else {
      lastTap.current = { at: now, p: at };
    }
  };

  const zoomed = view.s > 1;
  return (
    <div
      ref={box}
      data-testid={testid}
      data-scale={view.s.toFixed(2)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={cn(
        "flex h-full w-full touch-none select-none items-center justify-center overflow-hidden overscroll-contain",
        zoomed ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
      )}
    >
      <img
        ref={img}
        src={src}
        alt={alt}
        draggable={false}
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
          transition: live ? "none" : "transform 120ms ease-out",
        }}
        className="max-h-full max-w-full object-contain"
      />
    </div>
  );
}

function midOf(pts: Pt[]): Pt {
  if (pts.length === 0) return { x: 0, y: 0 };
  return {
    x: pts.reduce((n, p) => n + p.x, 0) / pts.length,
    y: pts.reduce((n, p) => n + p.y, 0) / pts.length,
  };
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
