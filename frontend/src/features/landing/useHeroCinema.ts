import { useLayoutEffect, useRef } from "react";
import {
  animate,
  createTimeline,
  onScroll,
  splitText,
  stagger,
  utils,
} from "animejs";
import { motionOff } from "./motionGate";

/**
 * Anime.js choreography for the landing hero title card. One mount timeline
 * sequences the brand per character, then the gradient word, sub line,
 * sports line, CTAs and the lower-third stat row; a scroll-synced exit
 * drifts the whole card up and away as the film's camera flies on.
 *
 * Targets are located by [data-cine] attributes inside the returned ref's
 * subtree. Skipped entirely under prefers-reduced-motion / jsdom: content
 * renders visible and static. Initial hidden states are applied
 * synchronously (utils.set in useLayoutEffect) so nothing flashes.
 */
export function useHeroCinema(): React.RefObject<HTMLElement | null> {
  const ref = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || motionOff()) return;

    const q = (key: string): HTMLElement | null =>
      root.querySelector<HTMLElement>(`[data-cine="${key}"]`);
    const brand = q("brand");
    const fixture = q("fixture");
    const panel = q("panel");
    const rest = ["sub", "line", "ctas", "stats"]
      .map(q)
      .filter((el): el is HTMLElement => el !== null);
    if (!brand || !fixture || !panel) return;

    const split = splitText(brand, { chars: true });
    const chars = split.chars;

    // Hide everything synchronously before first paint.
    utils.set(chars, { opacity: 0 });
    utils.set([fixture, ...rest], { opacity: 0 });

    const tl = createTimeline({ defaults: { ease: "outExpo" } });
    tl.add(chars, {
      opacity: [0, 1],
      translateY: ["0.55em", "0em"],
      filter: ["blur(10px)", "blur(0px)"],
      duration: 850,
      delay: stagger(34),
    })
      .add(
        fixture,
        {
          opacity: [0, 1],
          translateY: ["0.4em", "0em"],
          scale: [1.06, 1],
          filter: ["blur(14px)", "blur(0px)"],
          duration: 950,
        },
        "-=560",
      )
      .add(
        rest,
        {
          opacity: [0, 1],
          translateY: [16, 0],
          duration: 700,
          delay: stagger(110),
        },
        "-=560",
      );

    // Exit: the title card drifts up and fades as the camera flies on.
    const exit = animate(panel, {
      translateY: -56,
      opacity: 0.25,
      ease: "linear",
      autoplay: onScroll({
        target: root,
        enter: "top top",
        leave: "bottom top",
        sync: true,
      }),
    });

    return () => {
      tl.revert();
      exit.revert();
      split.revert();
    };
  }, []);

  return ref;
}
