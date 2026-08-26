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
 *
 * It is RED, everywhere (owner 2026-08-26). Red is what "live" means on every
 * platform this links out to, and it is the one control on a board of results
 * that is offering something happening right now.
 */
export function WatchLiveLink({
  url,
  size = "sm",
  className,
  testid = "watch-live",
  label,
}: {
  /** The resolved watch URL; null/undefined renders nothing. */
  url: string | null | undefined;
  size?: "sm" | "default" | "lg";
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
      className={cn(
        buttonVariants({ size, variant: "outline" }),
        "border-destructive/40 bg-destructive/10 font-semibold text-destructive",
        "hover:border-destructive/60 hover:bg-destructive/20 hover:text-destructive",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="relative flex h-2 w-2 shrink-0"
      >
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75 motion-reduce:animate-none" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive" />
      </span>
      {t("Watch live")}
    </a>
  );
}
