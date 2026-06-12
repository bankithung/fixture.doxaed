import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/t";

/**
 * The invariant-10 "things changed" banner (clarity rebuild §7.6).
 *
 * Two homes:
 * - the hub, on a competition whose draw's stored `inputs_hash` no longer
 *   matches (preview again for a fresh draw / keep the draw — it stays valid);
 * - the preview page, when Publish came back 409 `inputs_changed`
 *   (nothing was saved; the only way forward is a fresh preview).
 */
export function InputsChangedBanner({
  context,
  onRePreview,
  onKeep,
}: {
  /** "draw" = an existing draw went stale; "accept" = the 409 guard fired. */
  context: "draw" | "accept";
  onRePreview: () => void;
  /** Dismiss ("keep the current draw") — hub context only. */
  onKeep?: () => void;
}): React.ReactElement {
  return (
    <div
      role="alert"
      data-testid="inputs-changed-banner"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning-muted px-3 py-2"
    >
      <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 text-warning" />
      <p className="min-w-0 flex-1 text-sm text-warning-foreground">
        {context === "accept"
          ? t(
              "Something changed while you were looking (a team or a setting). Nothing was saved. Run the preview again to continue.",
            )
          : t(
              "Things changed since this draw was made (a team or a setting). The current schedule is still valid. Preview again to see a fresh draw, or keep what you have.",
            )}
      </p>
      <span className="flex shrink-0 items-center gap-1.5">
        <Button size="sm" data-testid="re-preview" onClick={onRePreview}>
          {t("Preview again")}
        </Button>
        {onKeep ? (
          <Button size="sm" variant="ghost" data-testid="keep-draw" onClick={onKeep}>
            {t("Keep this draw")}
          </Button>
        ) : null}
      </span>
    </div>
  );
}
