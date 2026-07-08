import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useBreakpoint } from "@/lib/useBreakpoint";

/**
 * CinematicBackdrop: a fixed, full-viewport film that plays behind the WHOLE
 * landing page. Total page scroll is the playhead — scrolling the page scrubs
 * a pre-extracted WebP frame sequence (generated stadium/grounds flythroughs),
 * so the background quietly plays as content rides over it. A gradient scrim
 * keeps text readable over any frame.
 *
 * The film is a PLAYLIST: by default v1 (aerial approach over the hills)
 * plays through the first half of the scroll, then cuts to v2 (inside the
 * bowl under the floodlights) for the second half. `?film=v1|v2|v3` previews
 * a single sequence live without a redeploy.
 *
 * Assets live in /cinematic/<film>/: manifest.json {count,width,height} plus
 * frame_0001.webp … frame_NNNN.webp.
 *
 * Renders NOTHING on mobile / reduced motion / jsdom (AmbientBackdrop covers
 * mobile; elsewhere the plain page background shows), and nothing until
 * every listed manifest is deployed.
 */

const FILMS = ["v1", "v2", "v3"] as const;
type Film = (typeof FILMS)[number];
const DEFAULT_PLAYLIST: readonly Film[] = ["v1", "v2"];

const DPR_CAP = 1.5;
const PRELOAD_CONCURRENCY = 6;

interface Manifest {
  count: number;
  width: number;
  height: number;
}

/** One playlist entry with its frame count resolved from its manifest. */
interface Reel {
  film: Film;
  count: number;
}

function cinematicOff(isMobile: boolean): boolean {
  return (
    isMobile ||
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function resolvePlaylist(raw: string | null): readonly Film[] {
  return (FILMS as readonly string[]).includes(raw ?? "")
    ? [raw as Film]
    : DEFAULT_PLAYLIST;
}

const frameUrl = (film: Film, i: number): string =>
  `/cinematic/${film}/frame_${String(i + 1).padStart(4, "0")}.webp`;

/** Map a global frame index to its reel + local index. */
function locate(reels: readonly Reel[], index: number): [Film, number] {
  let rest = index;
  for (const reel of reels) {
    if (rest < reel.count) return [reel.film, rest];
    rest -= reel.count;
  }
  const last = reels[reels.length - 1];
  return [last.film, last.count - 1];
}

export function CinematicBackdrop(): React.ReactElement | null {
  const { isMobile } = useBreakpoint();
  const [params] = useSearchParams();
  const playlist = resolvePlaylist(params.get("film"));
  const playlistKey = playlist.join("+");
  // Keyed by playlist so stale reels from a previous ?film= are ignored at
  // render instead of needing a synchronous reset inside the effect.
  const [loaded, setLoaded] = useState<{
    key: string;
    reels: Reel[];
  } | null>(null);
  const reels = loaded?.key === playlistKey ? loaded.reels : null;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const enabled = !cinematicOff(isMobile);

  // Discover every listed film's frame sequence; stay hidden until all are
  // deployed.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const films = playlistKey.split("+") as Film[];
    Promise.all(
      films.map((film) =>
        fetch(`/cinematic/${film}/manifest.json`)
          .then((r) => (r.ok ? r.json() : null))
          .then((m: Manifest | null) =>
            m && typeof m.count === "number" && m.count >= 2
              ? { film, count: m.count }
              : null,
          )
          .catch(() => null),
      ),
    ).then((results) => {
      if (cancelled || results.some((r) => r === null)) return;
      setLoaded({ key: playlistKey, reels: results as Reel[] });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, playlistKey]);

  // Load frames + scrub on whole-page scroll.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!reels || !canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const total = reels.reduce((n, r) => n + r.count, 0);
    const frames: (HTMLImageElement | null)[] = Array.from(
      { length: total },
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
      const scrollable =
        document.documentElement.scrollHeight - window.innerHeight;
      if (scrollable <= 0) return 0;
      return Math.min(1, Math.max(0, window.scrollY / scrollable));
    };

    const update = (): void => {
      raf = 0;
      current = Math.round(progress() * (total - 1));
      if (current !== lastDrawn) draw(current);
    };

    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(update);
    };

    // Progressive preload with a small concurrency pool; redraw whenever the
    // frame under the playhead arrives.
    let next = 0;
    const pump = (): void => {
      if (disposed || next >= total) return;
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
      const [film, local] = locate(reels, i);
      img.src = frameUrl(film, local);
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
  }, [reels]);

  if (!enabled || !reels) return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-[4] overflow-hidden print:hidden"
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {/* Readability scrim: light enough that the film reads through the
          whole page; sections and cards carry their own glass washes. */}
      <div className="absolute inset-0 bg-gradient-to-b from-background/35 via-background/45 to-background/65" />
    </div>
  );
}
