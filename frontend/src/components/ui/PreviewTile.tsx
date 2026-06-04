import * as React from "react";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * Preview tile used by Phase 1A role landing pages (scorer / referee /
 * team-manager) to advertise capabilities that activate in Phase 1B.
 *
 * Renders as an unactivated card: an icon, a title, a short description,
 * and a small "Phase 1B" badge in the top-right. The whole tile is
 * non-interactive and visually muted to reinforce that it is not a
 * working surface yet.
 *
 * Accessibility: the badge text is a real <span>, not an icon, so screen
 * readers announce it. The tile uses `aria-disabled="true"` to advertise
 * that it isn't actionable.
 */
export interface PreviewTileProps {
  /** lucide-react icon component (or any SVG-rendering component). */
  icon: React.ComponentType<{
    className?: string;
    "aria-hidden"?: boolean | "true" | "false";
  }>;
  title: string;
  description: string;
  /** Optional override for the small status pill (defaults to "Phase 1B"). */
  badgeText?: string;
  className?: string;
}

export function PreviewTile({
  icon: Icon,
  title,
  description,
  badgeText,
  className,
}: PreviewTileProps): React.ReactElement {
  return (
    <div
      role="group"
      aria-disabled="true"
      aria-label={title}
      data-testid="preview-tile"
      className={cn(
        "relative flex flex-col gap-2 rounded-lg border border-dashed bg-muted/30 p-4",
        "text-card-foreground",
        className,
      )}
    >
      <span
        className="absolute right-3 top-3 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-secondary-foreground"
        data-testid="preview-tile-badge"
      >
        {t(badgeText ?? "Phase 1B")}
      </span>
      <div
        aria-hidden="true"
        className="flex h-9 w-9 items-center justify-center rounded-md bg-background text-muted-foreground"
      >
        <Icon aria-hidden="true" className="h-5 w-5" />
      </div>
      <div className="text-sm font-medium leading-none">{title}</div>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}
