import { Pin, RefreshCw } from "lucide-react";
import type { PreviewPin } from "@/api/tournaments";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * Why the fixture on screen is the one on screen (owner 2026-08-20: "it
 * should be generated once and saved and not change until I press try another
 * draw", and "fresh draw need to be automatic").
 *
 * The previewed draw is pinned server-side, so a revisit replays it rather
 * than drawing again. That promise is worth nothing if the screen stays
 * silent about it: an organizer who comes back to a DIFFERENT fixture needs
 * to be told it was redrawn and why, and one who comes back to the same
 * fixture needs to know it is the saved one and not a coincidence.
 *
 * A deliberate re-draw says the quiet thing (you just pressed the button); a
 * re-draw the system had to do says the loud one.
 */
export function PreviewPinNote({
  pin,
}: {
  pin: PreviewPin | undefined;
}): React.ReactElement | null {
  if (!pin?.pinned) return null;

  // Only a re-draw nobody asked for needs explaining.
  const forced =
    pin.reason === "inputs_changed" || pin.reason === "unplaceable";
  const label = !pin.redrawn
    ? t("Saved draw")
    : forced
      ? pin.reason === "inputs_changed"
        ? t("Teams or rules changed, so this is a new draw")
        : t("The saved draw no longer fits the days, so this is a new draw")
      : t("New draw, saved");

  const when = pin.created_at
    ? new Date(pin.created_at).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

  const Icon = pin.redrawn ? RefreshCw : Pin;
  return (
    <span
      data-testid="preview-pin-note"
      data-reason={pin.reason ?? "saved"}
      title={
        when
          ? t(`Drawn ${when}. It stays this way until you try another draw.`)
          : undefined
      }
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[0.6875rem] font-medium",
        forced
          ? "border-warning/50 bg-warning-muted text-warning"
          : "border-border bg-secondary text-muted-foreground",
      )}
    >
      <Icon aria-hidden="true" className="h-3 w-3" />
      {label}
    </span>
  );
}
