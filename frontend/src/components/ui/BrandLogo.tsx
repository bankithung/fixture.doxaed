import { cn } from "@/lib/tailwind";

/**
 * The app's logo mark, used everywhere the brand appears (sidebar, top bars,
 * public shell, auth + landing). Served from `public/brand-logo.jpg`; size via
 * `className` (default sits in a small rounded square next to the wordmark).
 */
export function BrandLogo({
  className,
  alt = "",
}: {
  className?: string;
  alt?: string;
}): React.ReactElement {
  return (
    <img
      src="/brand-logo.jpg"
      alt={alt}
      aria-hidden={alt ? undefined : "true"}
      className={cn("h-7 w-7 shrink-0 rounded-md object-cover", className)}
    />
  );
}
