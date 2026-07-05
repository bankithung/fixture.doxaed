import { cn } from "@/lib/tailwind";
import "./star-border.css";

/**
 * StarBorder (React Bits), re-cut for the design system: an animated
 * brand-violet comet orbits the rim of whatever card it wraps. The child
 * keeps its own chrome (.panel / bordered card); the orbit shows through a
 * 1px ring. CSS-only; disabled under prefers-reduced-motion.
 */
export function StarBorder({
  as,
  className,
  speed = "6s",
  children,
}: {
  /** Wrapper element, default div. */
  as?: keyof React.JSX.IntrinsicElements;
  className?: string;
  /** Orbit duration ("6s"). */
  speed?: string;
  children: React.ReactNode;
}): React.ReactElement {
  const Comp = (as ?? "div") as React.ElementType;
  return (
    <Comp className={cn("star-border", className)}>
      <span
        aria-hidden="true"
        className="star-border-glow star-border-glow--bottom"
        style={{ animationDuration: speed }}
      />
      <span
        aria-hidden="true"
        className="star-border-glow star-border-glow--top"
        style={{ animationDuration: speed }}
      />
      <div className="star-border-inner">{children}</div>
    </Comp>
  );
}
