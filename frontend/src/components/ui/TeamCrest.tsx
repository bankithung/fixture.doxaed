import { useState } from "react";
import { cn } from "@/lib/tailwind";

/**
 * A team's badge, wherever the team appears.
 *
 * Fixtures, brackets, scoreboards, the public match centre and the printed
 * sheets all name teams, and a school's crest is how a parent in a hall finds
 * their child's match without reading every row. So this is ONE component: the
 * badge is the same size, shape and fallback in all of them, and a surface that
 * shows a team name has no reason to invent its own.
 *
 * **It never renders a broken image.** Most teams have no crest at all, and an
 * upload can 404 after a form is cleaned up — both fall back to the team's
 * initials on a token tint, which is a legible badge in its own right rather
 * than a gap in the row.
 *
 * **It is decorative.** The team name is always beside it, so `alt=""` keeps a
 * screen reader from reading the same team twice.
 */

const SIZES = {
  xs: "h-4 w-4 text-[0.5rem]",
  sm: "h-5 w-5 text-[0.5625rem]",
  md: "h-7 w-7 text-[0.6875rem]",
  lg: "h-10 w-10 text-sm",
  xl: "h-14 w-14 text-lg",
} as const;

export type CrestSize = keyof typeof SIZES;

/** Up to two initials from a team name, skipping the noise words a school
 * name is full of ("St. Mary's Higher Secondary School" → "SM"). */
export function crestInitials(name: string): string {
  const words = (name || "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !/^(the|of|and|school|college|higher|secondary|hr|sec)$/i.test(w));
  const use = words.length ? words : (name || "").split(/\s+/).filter(Boolean);
  return use
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export function TeamCrest({
  src,
  name,
  size = "sm",
  className,
}: {
  /** Signed crest URL, or "" / null / undefined when the team has none. */
  src?: string | null;
  /** The team name — its initials are the fallback badge. */
  name: string;
  size?: CrestSize;
  className?: string;
}): React.ReactElement {
  const [failed, setFailed] = useState(false);
  const box = cn(
    "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full",
    SIZES[size],
    className,
  );
  if (!src || failed) {
    return (
      <span
        aria-hidden="true"
        data-testid="team-crest-fallback"
        title={name || undefined}
        className={cn(box, "bg-muted font-semibold text-muted-foreground")}
      >
        {crestInitials(name)}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      data-testid="team-crest"
      title={name || undefined}
      onError={() => setFailed(true)}
      className={cn(box, "border border-border bg-card object-cover")}
    />
  );
}
