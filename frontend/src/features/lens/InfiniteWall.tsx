import { useCallback, useEffect, useRef, useState } from "react";
import { Award, Pause, Play } from "lucide-react";
import type { PublicAlbumPhoto } from "@/api/lens";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * The album's endless wall: photographs drift upward on their own and wrap
 * seamlessly, so the event reads as something still happening rather than a
 * page you have reached the bottom of (owner 2026-08-13). React Bits'
 * InfiniteScroll re-cut token-native and **dependency-free** — no GSAP, no
 * `@use-gesture` — same treatment `DomeGallery` and `StarBorder` got.
 *
 * The rules that make it survivable:
 *
 * - **Drift never touches React state.** One rAF loop writes `translate3d`
 *   onto each column. State changes here would re-render the whole album 60
 *   times a second.
 * - **The loop is two copies of the same column.** Offset wraps modulo the
 *   height of one copy, measured after layout, so there is no jump to hide.
 *   The second copy is `aria-hidden` and untabbable: it is scenery, and the
 *   first copy is the real list every keyboard and screen reader walks.
 * - **It stops for everyone who needs it to.** `prefers-reduced-motion` makes
 *   it a still wall, and so does hover, focus-within, an open lightbox, or the
 *   pause button. Motion no one asked for must always be stoppable.
 * - **A drag is not a click.** Pointer drag scrubs the wall; the tile only
 *   opens if the pointer barely moved, or every attempt to scrub opens a photo.
 */

/** Pixels per second. Slow enough to look at a photograph while it moves. */
const SPEED = 26;
/** Past this much pointer travel it was a scrub, not a tap. */
const DRAG_SLOP = 6;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function useColumnCount(): number {
  const [n, setN] = useState(() =>
    typeof window === "undefined" ? 3 : window.innerWidth >= 1024 ? 4 : window.innerWidth >= 640 ? 3 : 2,
  );
  useEffect(() => {
    const onResize = (): void => {
      setN(window.innerWidth >= 1024 ? 4 : window.innerWidth >= 640 ? 3 : 2);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return n;
}

function Tile({
  photo,
  awarded,
  onOpen,
  decorative,
}: {
  photo: PublicAlbumPhoto;
  awarded: boolean;
  onOpen: () => void;
  /** The looped copy: visible, but not a second entry in the album. */
  decorative?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      tabIndex={decorative ? -1 : undefined}
      aria-hidden={decorative || undefined}
      data-testid={decorative ? undefined : `album-photo-${photo.upload_ref}`}
      onClick={onOpen}
      className="group relative block w-full overflow-hidden rounded-lg border border-border bg-card shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <img
        src={photo.thumb_url}
        alt={photo.caption || photo.institution_name}
        loading="lazy"
        draggable={false}
        className="w-full select-none object-cover transition-transform duration-200 group-hover:scale-[1.02]"
      />
      {awarded ? (
        <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[0.625rem] font-medium text-primary-foreground">
          <Award aria-hidden="true" className="h-3 w-3" />
          {photo.award_category}
        </span>
      ) : null}
      <span className="absolute inset-x-0 bottom-0 flex flex-col gap-0.5 bg-gradient-to-t from-black/75 to-transparent px-2 pb-1.5 pt-6 text-left">
        <span className="truncate text-[0.6875rem] font-medium text-white">
          {photo.institution_name}
        </span>
        {/* The category rides the tile, so a wall that is not grouped by
            category can still be read category-wise. */}
        {photo.category ? (
          <span className="truncate text-[0.625rem] text-white/75">
            {photo.category}
          </span>
        ) : null}
      </span>
    </button>
  );
}

export function InfiniteWall({
  photos,
  isAwarded,
  onOpen,
  paused,
}: {
  photos: PublicAlbumPhoto[];
  isAwarded: (p: PublicAlbumPhoto) => boolean;
  onOpen: (uploadRef: string) => void;
  /** The lightbox is open: nothing should move behind it. */
  paused: boolean;
}): React.ReactElement {
  const columnCount = useColumnCount();
  const [stopped, setStopped] = useState(prefersReducedMotion);
  const [hovering, setHovering] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);
  const colRefs = useRef<(HTMLDivElement | null)[]>([]);
  const copyRefs = useRef<(HTMLDivElement | null)[]>([]);
  /** Live offsets, deliberately outside React: the loop writes them. */
  const offsets = useRef<number[]>([]);
  const drag = useRef<{ y: number; moved: number } | null>(null);

  const columns: PublicAlbumPhoto[][] = Array.from(
    { length: columnCount },
    () => [],
  );
  photos.forEach((p, i) => columns[i % columnCount].push(p));

  const running = !stopped && !paused && !hovering && photos.length > 0;

  useEffect(() => {
    offsets.current = Array.from({ length: columnCount }, () => 0);
  }, [columnCount, photos.length]);

  const paint = useCallback(() => {
    for (let i = 0; i < colRefs.current.length; i += 1) {
      const el = colRefs.current[i];
      if (el) {
        el.style.transform = `translate3d(0, ${offsets.current[i] ?? 0}px, 0)`;
      }
    }
  }, []);

  // Wrap on the measured height of ONE copy, so the seam never lands mid-tile.
  const wrap = useCallback((i: number) => {
    const h = copyRefs.current[i]?.offsetHeight ?? 0;
    if (h <= 0) return;
    let y = offsets.current[i] ?? 0;
    while (y <= -h) y += h;
    while (y > 0) y -= h;
    offsets.current[i] = y;
  }, []);

  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let last = 0;
    const step = (ts: number): void => {
      if (last === 0) last = ts;
      const dt = Math.min(64, ts - last) / 1000;
      last = ts;
      for (let i = 0; i < columns.length; i += 1) {
        offsets.current[i] = (offsets.current[i] ?? 0) - SPEED * dt;
        wrap(i);
      }
      paint();
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [running, columns.length, paint, wrap]);

  const onPointerDown = (e: React.PointerEvent): void => {
    drag.current = { y: e.clientY, moved: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current;
    if (!d) return;
    const dy = e.clientY - d.y;
    d.y = e.clientY;
    d.moved += Math.abs(dy);
    for (let i = 0; i < columns.length; i += 1) {
      offsets.current[i] = (offsets.current[i] ?? 0) + dy;
      wrap(i);
    }
    paint();
  };
  const endDrag = (): void => {
    drag.current = null;
  };
  /** Swallow the click that ends a scrub; a tap still opens the photo. */
  const openIfTap = (uploadRef: string) => (): void => {
    if ((drag.current?.moved ?? 0) > DRAG_SLOP) return;
    onOpen(uploadRef);
  };

  return (
    <div className="relative">
      <div className="flex items-center gap-2 px-4 pb-2 sm:px-5">
        <button
          type="button"
          data-testid="wall-motion-toggle"
          aria-pressed={!stopped}
          onClick={() => setStopped((s) => !s)}
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {stopped ? (
            <Play aria-hidden="true" className="h-3.5 w-3.5" />
          ) : (
            <Pause aria-hidden="true" className="h-3.5 w-3.5" />
          )}
          {stopped ? t("Play") : t("Pause")}
        </button>
        <p className="text-xs text-muted-foreground">
          {stopped ? t("Scroll the wall yourself") : t("Drag to scrub")}
        </p>
      </div>

      <div
        ref={wrapRef}
        data-testid="album-wall"
        data-running={running ? "true" : "false"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        onFocus={() => setHovering(true)}
        onBlur={() => setHovering(false)}
        className={cn(
          "flex gap-3 px-4 sm:px-5",
          // The window the loop runs inside. Tall enough to be the page's
          // subject, and it clips the copy that is riding above the fold.
          "h-[70vh] min-h-[420px] touch-pan-y overflow-hidden",
          running && "cursor-grab active:cursor-grabbing",
        )}
      >
        {columns.map((col, i) => (
          <div key={i} className="min-w-0 flex-1">
            <div
              ref={(el) => {
                colRefs.current[i] = el;
              }}
              className="will-change-transform"
            >
              {[0, 1].map((copy) => (
                <div
                  key={copy}
                  ref={
                    copy === 0
                      ? (el) => {
                          copyRefs.current[i] = el;
                        }
                      : undefined
                  }
                  className="flex flex-col gap-3 pb-3"
                >
                  {col.map((p) => (
                    <Tile
                      key={`${copy}-${p.upload_ref}`}
                      photo={p}
                      awarded={isAwarded(p)}
                      decorative={copy === 1}
                      onOpen={openIfTap(p.upload_ref)}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* The wall runs behind the page's own edges rather than stopping dead. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-8 h-10 bg-gradient-to-b from-card to-transparent"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent"
      />
    </div>
  );
}
