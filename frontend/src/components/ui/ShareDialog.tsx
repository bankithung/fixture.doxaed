import { useState } from "react";
import {
  Check,
  Copy,
  Mail,
  MessageCircle,
  MessageSquare,
  Send,
  Share2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { t } from "@/lib/t";

/* Lucide dropped brand icons; these two glyphs fill the gap, sized and
 * stroked to sit beside the lucide set. */
function FacebookIcon({ className }: { className?: string }): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M13.5 21.5v-7.2h2.5l.4-2.9h-2.9V9.5c0-.85.3-1.4 1.55-1.4h1.45V5.5c-.25-.03-1.15-.1-2.2-.1-2.2 0-3.7 1.35-3.7 3.8v2.2H8.2v2.9h2.4v7.2h2.9Z" />
    </svg>
  );
}
function XBrandIcon({ className }: { className?: string }): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M17.6 3.5h2.7l-6 6.8 7 9.2h-5.5l-4.3-5.6-4.9 5.6H3.9l6.4-7.3-6.7-8.7h5.6l3.9 5.1 4.5-5.1Zm-.9 15.1h1.5L8.1 5h-1.6l10.2 13.6Z" />
    </svg>
  );
}

/** Share-intent URLs for the channels this audience actually forwards links
 * through (WhatsApp-first). Every target opens in a new tab. */
function shareTargets(
  url: string,
  text: string,
): {
  key: string;
  label: string;
  href: string;
  Icon: React.ComponentType<{ className?: string }>;
}[] {
  const u = encodeURIComponent(url);
  const s = encodeURIComponent(text);
  return [
    { key: "whatsapp", label: "WhatsApp", href: `https://wa.me/?text=${s}%20${u}`, Icon: MessageCircle },
    { key: "telegram", label: "Telegram", href: `https://t.me/share/url?url=${u}&text=${s}`, Icon: Send },
    { key: "facebook", label: "Facebook", href: `https://www.facebook.com/sharer/sharer.php?u=${u}`, Icon: FacebookIcon },
    { key: "x", label: "X", href: `https://twitter.com/intent/tweet?url=${u}&text=${s}`, Icon: XBrandIcon },
    { key: "email", label: "Email", href: `mailto:?subject=${s}&body=${s}%0A%0A${u}`, Icon: Mail },
    { key: "sms", label: "SMS", href: `sms:?body=${s}%20${u}`, Icon: MessageSquare },
  ];
}

/**
 * Generic share modal: the link with one-tap copy, a grid of share channels
 * (each opens its share intent in a new tab), and the device's native share
 * sheet when the browser offers one.
 */
export function ShareDialog({
  open,
  onClose,
  url,
  text,
  title,
}: {
  open: boolean;
  onClose: () => void;
  url: string;
  /** Message that travels with the link ("Anpsa Test: register your school"). */
  text: string;
  title?: string;
}): React.ReactElement {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const canNativeShare =
    typeof navigator !== "undefined" && typeof navigator.share === "function";

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.push({ kind: "success", title: t("Link copied") });
    } catch {
      toast.push({ kind: "error", title: t("Could not copy"), description: url });
    }
  };

  const nativeShare = async (): Promise<void> => {
    try {
      await navigator.share({ title: text, text, url });
    } catch {
      // Sheet dismissed: nothing to do.
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      ariaLabel={title ?? t("Share link")}
    >
      <DialogHeader>
        <DialogTitle>{title ?? t("Share link")}</DialogTitle>
        <DialogDescription>
          {t("Send it through any app, or copy the link.")}
        </DialogDescription>
      </DialogHeader>

      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-1.5 pl-3">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={url}>
          {url}
        </span>
        <Button type="button" size="sm" variant="outline" onClick={() => void copy()}>
          {copied ? (
            <Check aria-hidden="true" className="h-4 w-4 text-success" />
          ) : (
            <Copy aria-hidden="true" className="h-4 w-4" />
          )}
          {copied ? t("Copied") : t("Copy")}
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {shareTargets(url, text).map(({ key, label, href, Icon }) => (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="flex flex-col items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-3 text-xs font-medium transition-colors hover:border-primary/40 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon aria-hidden="true" className="h-5 w-5 text-primary" />
            {label}
          </a>
        ))}
      </div>

      {canNativeShare ? (
        <Button type="button" variant="outline" onClick={() => void nativeShare()}>
          <Share2 aria-hidden="true" className="h-4 w-4" />
          {t("More apps on this device")}
        </Button>
      ) : null}
    </Dialog>
  );
}
