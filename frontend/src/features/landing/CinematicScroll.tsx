import { useEffect, useRef, useState } from "react";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { t } from "@/lib/t";

/**
 * CinematicScroll: an Apple-product-page style scroll-scrubbed film band.
 * A tall (300vh) region pins a full-viewport canvas; scrolling through the
 * region scrubs a pre-rendered frame sequence (WebP stills extracted from a
 * generated stadium flythrough), so the scroll wheel becomes the playhead.
 * Three caption lines crossfade over the film as it plays.
 *
 * Assets live in /cinematic/: manifest.json {count,width,height} plus
 * frame_0001.webp … frame_NNNN.webp. The section renders NOTHING until the
 * manifest exists, and never on mobile / reduced motion / jsdom — so it can
 * ship ahead of the frames and simply light up when they land.
 */

const DPR_CAP = 1.5;
const PRELOAD_CONCURRENCY = 6;

interface Manifest {
  count: number;
  width: number;
  height: number;
}

function cinematicOff(isMobile: boolean): boolean {
  return (
    isMobile ||
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

const frameUrl = (i: number): string =>
  `/cinematic/frame_${String(i + 1).padStart(4, "0")}.webp`;

/** Caption thirds: [start, end] progress windows with full opacity between. */
const CAPTIONS: readonly { from: number; to: number }[] = [
  { from: 0.02, to: 0.3 },
  { from: 0.36, to: 0.62 },
  { from: 0.68, to: 0.96 },
];

function captionOpacity(p: number, from: number, to: number): number {
  const fade = 0.07;
  if (p <= from || p >= to) return 0;
  if (p < from + fade) return (p - from) / fade;
  if (p > to - fade) return (to - p) / fade;
  return 1;
}

export function CinematicScroll(): React.ReactElement | null {
  const { isMobile } = useBreakpoint();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const captionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const enabled = !cinematicOff(isMobile);

  // Discover the frame sequence; stay hidden when it isn't deployed yet.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch("/cinematic/manifest.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((m: Manifest | null) => {
        if (cancelled || !m || typeof m.count !== "number" || m.count < 2) {
          return;
        }
        setManifest(m);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  // Load frames + scrub on scroll.
  useEffect(() => {
    const canvas = canvasRef.current;
    const section = sectionRef.current;
    if (!manifest || !canvas || !section) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const frames: (HTMLImageElement | null)[] = Array.from(
      { length: manifest.count },
      () => null,
    );
    let disposed = false;
    let raf = 0;
    let lastDrawn = -1;
    let current = 0;

    const draw = (index: number): void => {
      // Nearest loaded frame at or before the target, else the first loaded.
      let img: HTMLImageElement | null = null;
      for (let i = index; i >= 0; i -= 1) {
        const f = frames[i];
        if (f) {
          img = f;
          break;
        }
      }
      if (!img) {
        for (let i = index + 1; i < frames.length; i += 1) {
          const f = frames[i];
          if (f) {
            img = f;
            break;
          }
        }
      }
      if (!img) return;
      // Cover-fit.
      const cw = canvas.width;
      const ch = canvas.height;
      const scale = Math.max(cw / img.width, ch / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
      lastDrawn = index;
    };

    const resize = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      lastDrawn = -1;
      draw(current);
    };

    const progress = (): number => {
      const rect = section.getBoundingClientRect();
      const total = rect.height - window.innerHeight;
      if (total <= 0) return 0;
      return Math.min(1, Math.max(0, -rect.top / total));
    };

    const update = (): void => {
      raf = 0;
      const p = progress();
      current = Math.round(p * (manifest.count - 1));
      if (current !== lastDrawn) draw(current);
      CAPTIONS.forEach((c, i) => {
        const el = captionRefs.current[i];
        if (el) el.style.opacity = String(captionOpacity(p, c.from, c.to));
      });
    };

    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(update);
    };

    // Progressive preload with a small concurrency pool; redraw whenever the
    // frame under the playhead arrives.
    let next = 0;
    const pump = (): void => {
      if (disposed || next >= manifest.count) return;
      const i = next;
      next += 1;
      const img = new Image();
      img.decoding = "async";
      img.onload = () => {
        if (disposed) return;
        frames[i] = img;
        if (i === current || lastDrawn === -1) draw(current);
        pump();
      };
      img.onerror = () => {
        if (!disposed) pump();
      };
      img.src = frameUrl(i);
    };
    for (let k = 0; k < PRELOAD_CONCURRENCY; k += 1) pump();

    resize();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", resize);
    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", resize);
    };
  }, [manifest]);

  if (!enabled || !manifest) return null;

  return (
    <section
      ref={sectionRef}
      aria-label={t("Matchday, scrubbed by your scroll")}
      className="relative h-[300vh] border-b border-border/60"
    >
      <div className="sticky top-0 h-screen w-full overflow-hidden bg-background">
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="absolute inset-0 h-full w-full"
        />
        {/* Scrim so captions stay readable over any frame */}
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-background/60"
        />
        {[t("Every ground."), t("Every match."), t("Every moment, live.")].map(
          (line, i) => (
            <div
              key={line}
              ref={(el) => {
                captionRefs.current[i] = el;
              }}
              className="pointer-events-none absolute inset-x-0 bottom-[18vh] text-center opacity-0"
            >
              <p className="text-3xl font-semibold tracking-tight text-foreground sm:text-5xl">
                {line}
              </p>
            </div>
          ),
        )}
      </div>
    </section>
  );
}
