import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/t";

/**
 * The invariant-10 "inputs changed" banner (redesign §6 screen 6 + §9 A1).
 *
 * Two homes:
 * - the hub, on a competition whose draw's stored `inputs_hash` no longer
 *   matches (regenerate via a fresh preview / keep the draw — it stays valid);
 * - the dry-run preview page, when Accept came back 409 `inputs_changed`
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
              "The inputs changed while you were previewing — a registration or config edit landed. Nothing was saved; re-run the preview to continue.",
            )
          : t(
              "Inputs changed since this draw was generated — re-preview to regenerate, or keep the current draw (it stays valid).",
            )}
      </p>
      <span className="flex shrink-0 items-center gap-1.5">
        <Button size="sm" data-testid="re-preview" onClick={onRePreview}>
          {t("Re-preview")}
        </Button>
        {onKeep ? (
          <Button size="sm" variant="ghost" data-testid="keep-draw" onClick={onKeep}>
            {t("Keep")}
          </Button>
        ) : null}
      </span>
    </div>
  );
}
