import { Share2 } from "lucide-react";
import { t } from "@/lib/t";

/**
 * Native share with copy-link fallback — a WhatsApp-first audience forwards
 * links constantly and had no affordance for it.
 */
export function ShareButton({ title }: { title?: string }): React.ReactElement {
  const share = async (): Promise<void> => {
    const url = window.location.href;
    const data = { title: title ?? document.title, url };
    if (navigator.share) {
      try {
        await navigator.share(data);
        return;
      } catch {
        // Dismissed the sheet: fall through to copy.
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      window.dispatchEvent(
        new CustomEvent("fixture:copied", { detail: { url } }),
      );
    } catch {
      // Clipboard unavailable: nothing sensible left to do.
    }
  };
  return (
    <button
      type="button"
      onClick={() => void share()}
      aria-label={t("Share this page")}
      title={t("Share")}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Share2 aria-hidden="true" className="h-4 w-4" />
    </button>
  );
}
