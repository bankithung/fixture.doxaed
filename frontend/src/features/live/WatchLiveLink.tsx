import { Play } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * The public "Watch live" control.
 *
 * Renders NOTHING when no URL resolved — the resolver returns null rather than
 * a dead page, so an absent link must be an absent button, never a disabled one
 * (owner decision 2026-08-04: the link opens YouTube in a new tab, the stream is
 * not embedded).
 *
 * It is an anchor, not a button-with-onClick: middle-click, long-press and
 * "open in new tab" all have to work, and it leaves the page it sits on alive —
 * the live score behind it keeps ticking over its own SSE stream.
 */
export function WatchLiveLink({
  url,
  size = "sm",
  variant = "outline",
  className,
  testid = "watch-live",
  label,
}: {
  /** The resolved watch URL; null/undefined renders nothing. */
  url: string | null | undefined;
  size?: "sm" | "default" | "lg";
  variant?: "default" | "outline" | "secondary" | "ghost";
  className?: string;
  testid?: string;
  /** Accessible name when the surrounding context needs naming ("Watch Court
   * 2 live"); defaults to the visible text. */
  label?: string;
}): React.ReactElement | null {
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={testid}
      aria-label={label}
      className={cn(buttonVariants({ size, variant }), className)}
    >
      <Play aria-hidden="true" className="h-3.5 w-3.5" />
      {t("Watch live")}
    </a>
  );
}
