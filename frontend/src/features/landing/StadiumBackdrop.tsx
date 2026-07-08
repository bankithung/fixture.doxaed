import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { cn } from "@/lib/tailwind";
import "./landing.css";

/**
 * StadiumBackdrop: a fixed, hand-drawn SVG "grounds view" behind the landing
 * page — stadium bowl, top-down pitch, floodlights, a ball, and a trophy —
 * scroll-scrubbed with gsap ScrollTrigger (already in the installed gsap
 * package, no new deps). As the visitor scrolls: layers parallax at
 * different depths, the ball rolls down the pitch, floodlight beams come on
 * mid-page, and the trophy fades in near the closing CTA.
 *
 * Everything is stroked in primary-token alphas so it works in light + dark.
 * On mobile / reduced motion / no-matchMedia (jsdom) the scene renders
 * static (beams + trophy shown faintly, no scroll listeners, no gsap).
 */
/** True when the scroll scrub must stay off: mobile, reduced motion, or no
 * matchMedia at all (jsdom) — unlike BentoCard.motionDisabled, a missing
 * matchMedia counts as OFF here because ScrollTrigger itself requires it. */
function scrubOff(isMobile: boolean): boolean {
  return (
    isMobile ||
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function StadiumBackdrop(): React.ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const { isMobile } = useBreakpoint();
  const animate = !scrubOff(isMobile);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || scrubOff(isMobile)) return;

    // Registered here, NOT at module scope: ScrollTrigger touches
    // window.matchMedia on registration, which jsdom lacks; the scrubOff
    // gate above guarantees a real browser at this point.
    gsap.registerPlugin(ScrollTrigger);

    const ctx = gsap.context(() => {
      const tl = gsap.timeline({
        scrollTrigger: { start: 0, end: "max", scrub: 0.7 },
        defaults: { ease: "none" },
      });
      // Parallax drift, slow to fast by depth.
      tl.to('[data-l="bowl"]', { y: -50, duration: 1 }, 0)
        .to('[data-l="pitch"]', { y: -120, duration: 1 }, 0)
        .to('[data-l="lights"]', { y: -170, duration: 1 }, 0)
        // The ball rolls the length of the pitch across the whole page.
        .to('[data-l="ball"]', { y: 430, duration: 1 }, 0)
        // Floodlights come on over the mid sections.
        .to('[data-l="beam"]', { opacity: 0.9, duration: 0.35 }, 0.25)
        // The trophy appears as the visitor reaches the closing CTA.
        .to('[data-l="trophy"]', { opacity: 1, y: -14, duration: 0.25 }, 0.75);
    }, root);

    return () => ctx.revert();
  }, [isMobile]);

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      className={cn(
        "pointer-events-none fixed inset-0 -z-[5] overflow-hidden print:hidden",
        !animate && "stadium-static",
      )}
    >
      <svg
        className="h-full w-full"
        viewBox="0 0 1200 900"
        preserveAspectRatio="xMidYMid slice"
        role="presentation"
        focusable="false"
      >
        {/* Stadium bowl arcs (slowest layer) */}
        <g data-l="bowl">
          <ellipse className="stadium-line" cx="600" cy="-90" rx="700" ry="310" />
          <ellipse className="stadium-line" cx="600" cy="-110" rx="560" ry="240" />
        </g>

        {/* Top-down pitch */}
        <g data-l="pitch">
          <rect
            className="stadium-line stadium-line--strong"
            x="430"
            y="170"
            width="340"
            height="560"
            rx="6"
          />
          {/* halfway line + center circle */}
          <line className="stadium-line" x1="430" y1="450" x2="770" y2="450" />
          <circle className="stadium-line" cx="600" cy="450" r="64" />
          <circle className="stadium-dot" cx="600" cy="450" r="3.5" />
          {/* penalty boxes */}
          <rect className="stadium-line" x="505" y="170" width="190" height="88" />
          <rect className="stadium-line" x="505" y="642" width="190" height="88" />
          {/* goal boxes */}
          <rect className="stadium-line" x="557" y="170" width="86" height="36" />
          <rect className="stadium-line" x="557" y="694" width="86" height="36" />
          {/* penalty spots */}
          <circle className="stadium-dot" cx="600" cy="238" r="2.5" />
          <circle className="stadium-dot" cx="600" cy="662" r="2.5" />
        </g>

        {/* Floodlights + beams */}
        <g data-l="lights">
          {(
            [
              { x: 330, y: 120, tx: 500, ty: 320 },
              { x: 870, y: 120, tx: 700, ty: 320 },
              { x: 330, y: 780, tx: 500, ty: 580 },
              { x: 870, y: 780, tx: 700, ty: 580 },
            ] as const
          ).map((m) => (
            <g key={`${m.x}-${m.y}`}>
              <polygon
                data-l="beam"
                className="stadium-beam"
                opacity="0"
                points={`${m.x},${m.y} ${m.tx},${m.ty} ${m.tx - 60},${m.ty + 30}`}
              />
              <line
                className="stadium-line stadium-line--strong"
                x1={m.x - 10}
                y1={m.y + 12}
                x2={m.x + 10}
                y2={m.y - 12}
              />
              <circle className="stadium-head" cx={m.x} cy={m.y} r="9" />
            </g>
          ))}
        </g>

        {/* The ball, rolling down the halfway axis with scroll */}
        <circle data-l="ball" className="stadium-ball" cx="600" cy="192" r="8" />

        {/* Trophy silhouette, revealed at the end of the page */}
        <g data-l="trophy" opacity="0" transform="translate(600 802)">
          <path
            className="stadium-trophy"
            d="M -30 -74 C -30 -32 -12 -14 0 -14 C 12 -14 30 -32 30 -74 Z"
          />
          {/* handles */}
          <path className="stadium-trophy" d="M -30 -66 C -48 -62 -48 -40 -28 -38" />
          <path className="stadium-trophy" d="M 30 -66 C 48 -62 48 -40 28 -38" />
          {/* stem + base */}
          <rect className="stadium-trophy" x="-6" y="-14" width="12" height="26" rx="2" />
          <rect className="stadium-trophy" x="-24" y="12" width="48" height="11" rx="3" />
        </g>
      </svg>
    </div>
  );
}
