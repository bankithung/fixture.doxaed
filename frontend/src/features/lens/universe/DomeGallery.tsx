import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { motionOff } from "@/features/landing/motionGate";
import { t } from "@/lib/t";
import { planDome } from "./geometry";
import "./universe.css";

/**
 * The photo sphere — DomeGallery (React Bits) re-cut for this codebase: pure
 * CSS 3D, no `@use-gesture`, no vertical clamp (the owner asked for rotation
 * in *every* direction), and spinning by default.
 *
 * Perf shape, because a sphere of photos is the one place this app can drop
 * frames: rotation never touches React state. Pointer handlers and one rAF
 * loop write `--dome-rx` / `--dome-ry` straight onto the sphere element, the
 * far hemisphere is dropped by `backface-visibility`, tiles carry the small
 * `thumb_url` (the lightbox loads the full frame), and the loop parks itself
 * when the tab is hidden, when a lightbox is open over the top, or when the
 * viewer prefers reduced motion.
 */

export interface DomeItem {
  /** Stable id — the caller's photo reference; handed back to `onOpen`. */
  key: string;
  thumb: string;
  alt: string;
  /** Prize-winner: gets a brand rim on the ball. */
  awarded?: boolean;
}

/** Degrees per second of idle drift. Slow enough to read a photo mid-spin. */
const AUTO_SPEED = 4.5;
/** Degrees of rotation per pixel dragged. */
const DRAG_GAIN = 0.26;
/** Per-frame velocity decay at 60fps — the fling's tail. */
const FLING = 0.935;
/** Idle time before the auto-spin creeps back in after a drag. */
const RESUME_MS = 1500;
/** Pointer travel that still counts as a tap rather than a drag. */
const CLICK_SLOP = 8;

interface Motion {
  rx: number;
  ry: number;
  vx: number;
  vy: number;
  dragging: boolean;
  moved: number;
  lastX: number;
  lastY: number;
  restAt: number;
}

export function DomeGallery({
  items,
  onOpen,
  spin = true,
  fit = 1,
}: {
  items: DomeItem[];
  onOpen: (key: string) => void;
  /** False while something is layered over the ball (a lightbox). */
  spin?: boolean;
  /** Multiplier on how large one photo wants to be. Bigger = fewer, larger
   *  tiles on screen and a bigger ball. */
  fit?: number;
}): React.ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const sphereRef = useRef<HTMLDivElement>(null);
  const motion = useRef<Motion>({
    rx: -6,
    ry: 0,
    vx: 0,
    vy: 0,
    dragging: false,
    moved: 0,
    lastX: 0,
    lastY: 0,
    restAt: 0,
  });

  const plan = useMemo(() => planDome(items.length), [items.length]);

  // Radius from the measured stage. Solved backwards from how big one photo
  // should look rather than forwards from the container: the column count
  // falls with the album size, so a fixed radius would blow an eight-photo
  // school up to two tiles filling a phone. Clamped so a small album reads as
  // a smaller planet instead of a marble or a wall.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || plan.columns === 0) return;
    const apply = (): void => {
      const w = el.clientWidth || 900;
      const h = el.clientHeight || 560;
      const short = Math.min(w, h);
      // Chord between two equator columns, as a fraction of the radius.
      const chord = 2 * Math.sin(Math.PI / plan.columns) * 1.06;
      // The ball's silhouette measures ~1.375r on screen (perspective is 2.2r,
      // so its far side draws at 0.69). The upper clamp keeps that just inside
      // the stage's short side; the lower one stops a five-photo album from
      // shrinking to a marble.
      const r = Math.round(
        Math.min(
          short * 0.74 * fit,
          Math.max(short * 0.55, (short * 0.22 * fit) / chord),
        ),
      );
      el.style.setProperty("--dome-r", `${r}px`);
      el.style.setProperty("--dome-tile", `${Math.round(r * chord)}px`);
      el.style.setProperty("--dome-persp", `${Math.round(r * 2.2)}px`);
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [plan.columns, fit]);

  const still = motionOff();

  // The single rotation loop. Drag velocity decays into a fling, the fling
  // decays into the idle drift, and the whole thing sleeps when it shouldn't
  // be running at all.
  useEffect(() => {
    const el = sphereRef.current;
    if (!el || typeof requestAnimationFrame !== "function") return;
    const drift = spin && !still;
    let raf = 0;
    let last = performance.now();
    const write = (): void => {
      el.style.setProperty("--dome-rx", `${motion.current.rx.toFixed(2)}deg`);
      el.style.setProperty("--dome-ry", `${motion.current.ry.toFixed(2)}deg`);
    };
    const step = (now: number): void => {
      const dt = Math.min(0.064, (now - last) / 1000);
      last = now;
      const s = motion.current;
      const awake =
        typeof document === "undefined" || document.visibilityState !== "hidden";
      if (awake && !s.dragging) {
        if (Math.abs(s.vx) > 0.5 || Math.abs(s.vy) > 0.5) {
          s.rx += s.vx * dt;
          s.ry += s.vy * dt;
          const decay = Math.pow(FLING, dt * 60);
          s.vx *= decay;
          s.vy *= decay;
          if (Math.abs(s.vx) <= 0.5 && Math.abs(s.vy) <= 0.5) {
            s.vx = 0;
            s.vy = 0;
            s.restAt = now;
          }
          write();
        } else if (drift && now - s.restAt > RESUME_MS) {
          s.ry += AUTO_SPEED * dt;
          write();
        }
      }
      raf = requestAnimationFrame(step);
    };
    write();
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [spin, still]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const s = motion.current;
    s.dragging = true;
    s.moved = 0;
    s.lastX = e.clientX;
    s.lastY = e.clientY;
    s.vx = 0;
    s.vy = 0;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const s = motion.current;
    if (!s.dragging) return;
    const dx = e.clientX - s.lastX;
    const dy = e.clientY - s.lastY;
    s.lastX = e.clientX;
    s.lastY = e.clientY;
    s.moved += Math.abs(dx) + Math.abs(dy);
    s.ry += dx * DRAG_GAIN;
    // Drag down, the top of the ball tips toward you — the direction a hand
    // expects when it grabs a globe.
    s.rx -= dy * DRAG_GAIN;
    // Velocity in deg/sec, for the fling. A frame is ~16ms.
    s.vx = (-dy * DRAG_GAIN) / 0.016;
    s.vy = (dx * DRAG_GAIN) / 0.016;
    const el = sphereRef.current;
    if (el) {
      el.style.setProperty("--dome-rx", `${s.rx.toFixed(2)}deg`);
      el.style.setProperty("--dome-ry", `${s.ry.toFixed(2)}deg`);
    }
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const s = motion.current;
    s.dragging = false;
    s.restAt = performance.now();
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const s = motion.current;
    const step = e.shiftKey ? 24 : 8;
    if (e.key === "ArrowRight") s.ry += step;
    else if (e.key === "ArrowLeft") s.ry -= step;
    else if (e.key === "ArrowUp") s.rx += step;
    else if (e.key === "ArrowDown") s.rx -= step;
    else return;
    e.preventDefault();
    s.restAt = performance.now();
    const el = sphereRef.current;
    if (el) {
      el.style.setProperty("--dome-rx", `${s.rx.toFixed(2)}deg`);
      el.style.setProperty("--dome-ry", `${s.ry.toFixed(2)}deg`);
    }
  }, []);

  return (
    <div
      ref={rootRef}
      data-testid="album-dome"
      className="dome"
      role="group"
      tabIndex={0}
      aria-label={t("Photo sphere. Drag to spin it, or use the arrow keys.")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    >
      <div className="dome__space">
        <div ref={sphereRef} className="dome__sphere">
          {plan.slots.map((slot, i) => {
            const photo = items[slot.photo];
            if (!photo) return null;
            return (
              <button
                key={`${i}-${photo.key}`}
                type="button"
                // One tab stop for the ball, not 126: the grid view is the
                // keyboard/AT route through every photo (WCAG 2.1 AA, an
                // equivalent alternative rather than a tab-trap).
                tabIndex={-1}
                data-testid={`dome-tile-${photo.key}`}
                data-awarded={photo.awarded ? "true" : undefined}
                aria-label={photo.alt}
                className="dome__tile"
                style={
                  {
                    "--lon": `${slot.lon}deg`,
                    "--lat": `${slot.lat}deg`,
                  } as React.CSSProperties
                }
                onClick={() => {
                  if (motion.current.moved > CLICK_SLOP) return;
                  onOpen(photo.key);
                }}
              >
                <img
                  src={photo.thumb}
                  alt=""
                  draggable={false}
                  loading="lazy"
                  decoding="async"
                />
              </button>
            );
          })}
        </div>
      </div>
      <div aria-hidden="true" className="dome__vignette" />
      <div aria-hidden="true" className="dome__fade dome__fade--top" />
      <div aria-hidden="true" className="dome__fade dome__fade--bottom" />
    </div>
  );
}
