import { Fragment, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import "./landing.css";

/**
 * Landing-page motion kit (React Bits, re-cut for the design system):
 * BlurText, ShinyText, RotatingText, SportsMarquee (LogoLoop) and Reveal
 * (ScrollReveal). No new dependencies: IntersectionObserver + the CSS
 * keyframes in landing.css. Every component is static under
 * prefers-reduced-motion and in environments without matchMedia (jsdom),
 * so tests see final, visible content.
 */

function motionOff(): boolean {
  return (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** First-intersection flag; resolves to true immediately when motion is off
 * or IntersectionObserver is unavailable. */
function useInView<T extends HTMLElement>(
  threshold = 0.15,
): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (motionOff() || typeof IntersectionObserver === "undefined" || !el) {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);

  return [ref, inView];
}

/** BlurText: words blur+drop into place, staggered left to right. */
export function BlurText({
  text,
  className,
  delayMs = 70,
  baseDelayMs = 0,
}: {
  text: string;
  className?: string;
  /** Stagger between words. */
  delayMs?: number;
  /** Delay before the first word starts (for multi-line headlines). */
  baseDelayMs?: number;
}): React.ReactElement {
  const [ref, inView] = useInView<HTMLSpanElement>();
  const words = text.split(" ");
  return (
    <span ref={ref} className={cn("blur-text", inView && "is-inview", className)}>
      {words.map((word, i) => (
        <Fragment key={`${String(i)}-${word}`}>
          <span
            className="blur-text-word"
            style={{ transitionDelay: `${baseDelayMs + i * delayMs}ms` }}
          >
            {word}
          </span>
          {/* Real space between the inline-block words: trailing spaces
              inside inline-blocks collapse, which would glue words together
              visually and in the accessible name. */}
          {i < words.length - 1 ? " " : null}
        </Fragment>
      ))}
    </span>
  );
}

/** BlurLine: a whole line blurs+drops in as ONE element, so gradient
 * bg-clip-text headlines keep their clip (per-word spans would break it). */
export function BlurLine({
  text,
  className,
  delayMs = 0,
}: {
  text: string;
  className?: string;
  delayMs?: number;
}): React.ReactElement {
  const [ref, inView] = useInView<HTMLSpanElement>();
  return (
    <span
      ref={ref}
      className={cn("blur-line", inView && "is-inview", className)}
      style={delayMs > 0 ? { transitionDelay: `${delayMs}ms` } : undefined}
    >
      {text}
    </span>
  );
}

/** ShinyText: a highlight sweeps across gradient-clipped text. */
export function ShinyText({
  text,
  className,
}: {
  text: string;
  className?: string;
}): React.ReactElement {
  return <span className={cn("shiny-text", className)}>{text}</span>;
}

/** RotatingText: cycles through words; the incoming word rises in. The full
 * list stays available to screen readers, the swap itself is aria-hidden. */
export function RotatingText({
  words,
  intervalMs = 2200,
  className,
}: {
  words: readonly string[];
  intervalMs?: number;
  className?: string;
}): React.ReactElement {
  const [index, setIndex] = useState(0);
  const animate = !motionOff();

  useEffect(() => {
    if (!animate || words.length < 2) return;
    const id = setInterval(
      () => setIndex((i) => (i + 1) % words.length),
      intervalMs,
    );
    return () => clearInterval(id);
  }, [animate, words.length, intervalMs]);

  return (
    <span className={className}>
      <span className="sr-only">{words.join(", ")}</span>
      <span aria-hidden="true" key={index} className={cn(animate && "rotating-word")}>
        {words[index] ?? words[0] ?? ""}
      </span>
    </span>
  );
}

/** Reveal (ScrollReveal): children fade up on first scroll into view. */
export function Reveal({
  children,
  className,
  delayMs = 0,
}: {
  children: React.ReactNode;
  className?: string;
  /** Extra delay for staggering sibling reveals. */
  delayMs?: number;
}): React.ReactElement {
  const [ref, inView] = useInView<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={cn("reveal", inView && "is-inview", className)}
      style={delayMs > 0 ? { transitionDelay: `${delayMs}ms` } : undefined}
    >
      {children}
    </div>
  );
}

const SPORTS: readonly string[] = [
  "Football",
  "Sepak Takraw",
  "Table Tennis",
  "Volleyball",
  "Basketball",
  "Badminton",
  "Athletics",
  "Archery",
  "Chess",
  "Cricket",
];

/** The sports this platform is built to run, exported for the hero rotator. */
export const SPORT_NAMES = SPORTS;

/** SportsMarquee (LogoLoop): an endless strip of the sports the chassis
 * covers. Static wrapped row when motion is off. */
export function SportsMarquee({
  className,
}: {
  className?: string;
}): React.ReactElement {
  const animate = !motionOff();

  const row = (ariaHidden: boolean): React.ReactElement => (
    <div
      aria-hidden={ariaHidden || undefined}
      className="flex shrink-0 items-center gap-4 pr-4 sm:gap-8 sm:pr-8"
    >
      {SPORTS.map((name) => (
        <span
          key={name}
          className="inline-flex items-center gap-4 whitespace-nowrap text-sm font-medium text-muted-foreground sm:gap-8"
        >
          {name}
          <span aria-hidden="true" className="h-1 w-1 rounded-full bg-primary/50" />
        </span>
      ))}
    </div>
  );

  if (!animate) {
    return (
      <div
        className={cn("flex flex-wrap items-center justify-center gap-3", className)}
        aria-label={t("Sports covered")}
      >
        {row(false)}
      </div>
    );
  }

  return (
    <div className={cn("sports-marquee", className)} aria-label={t("Sports covered")}>
      <div className="sports-marquee-track">
        {row(false)}
        {row(true)}
      </div>
    </div>
  );
}
