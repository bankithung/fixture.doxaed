import { useLayoutEffect, useRef } from "react";
import { animate, onScroll, splitText, stagger, utils } from "animejs";
import { motionOff } from "./motionGate";

/**
 * CinemaLine: a film-window statement line that assembles word by word as
 * the viewer scrolls through the beat. Driven by anime.js ScrollObserver
 * with smoothing, so it scrubs forward and backward with the scroll like a
 * trailer title card riding the footage.
 *
 * Skipped under prefers-reduced-motion / jsdom: the plain text renders
 * visible and static. Initial hidden states are applied synchronously
 * (utils.set in useLayoutEffect) so nothing flashes.
 */
/**
 * ScrollFade: content that rides the scroll like a film title — it fades and
 * drifts IN as it enters the viewport, holds through the middle, and fades
 * OUT as it leaves, scrubbing forward and backward with a damped
 * ScrollObserver. Replaces one-shot reveals on the landing page.
 *
 * Static (plain, visible) under prefers-reduced-motion / jsdom.
 */
export function ScrollFade({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || motionOff()) return;

    utils.set(el, { opacity: 0 });

    const anim = animate(el, {
      keyframes: {
        "0%": { opacity: 0, translateY: 56 },
        "22%": { opacity: 1, translateY: 0 },
        "78%": { opacity: 1, translateY: 0 },
        "100%": { opacity: 0, translateY: -56 },
      },
      ease: "linear",
      autoplay: onScroll({
        target: el,
        enter: "bottom top",
        leave: "top bottom",
        sync: true,
      }),
    });

    return () => {
      anim.revert();
    };
  }, []);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

export function CinemaLine({
  text,
  className,
}: {
  text: string;
  className?: string;
}): React.ReactElement {
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || motionOff()) return;

    const split = splitText(el, { words: true });
    utils.set(split.words, { opacity: 0 });

    const anim = animate(split.words, {
      opacity: [0, 1],
      translateY: ["0.5em", "0em"],
      filter: ["blur(8px)", "blur(0px)"],
      duration: 700,
      delay: stagger(140),
      ease: "outQuad",
      autoplay: onScroll({
        target: el,
        enter: "bottom top",
        leave: "center center",
        sync: 0.35,
      }),
    });

    return () => {
      anim.revert();
      split.revert();
    };
  }, [text]);

  return (
    <span ref={ref} className={className}>
      {text}
    </span>
  );
}
