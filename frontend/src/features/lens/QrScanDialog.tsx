import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
 DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/t";

/**
 * Scan the poster's QR code FROM the album page. Uses the phone's native
 * BarcodeDetector when the browser has one (Chrome/Android, Safari 17+) —
 * dependency-free, no camera library. Where it doesn't (older iPhones,
 * desktops without a camera), it falls back to typing the join link or just
 * the token, which is the same door the QR opens.
 *
 * The token extracted here is exactly what minting put on the poster: we
 * never invent one, so a re-minted card simply means "scan the new poster".
 */

const TOKEN_RE = /[0-9a-zA-Z]{16,}/; // share tokens are long random strings

function extractToken(text: string): string | null {
  const m = text.match(/\/lens\/join\/([^/?#\s]+)/);
  if (m) return m[1];
  const bare = text.trim();
  return TOKEN_RE.test(bare) ? bare : null;
}

export function QrScanDialog({
  open,
  onOpenChange,
  onToken,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onToken: (token: string) => void;
}): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  // Derived once per mount: whether this browser can scan at all.
  const canScan =
    typeof window !== "undefined" &&
    "BarcodeDetector" in window &&
    !!navigator.mediaDevices?.getUserMedia;
  const [manual, setManual] = useState("");
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (!open) return;
    let stream: MediaStream | null = null;
    let raf = 0;
    let cancelled = false;

    const Detector = (
      window as unknown as {
        BarcodeDetector?: new (opts?: {
          formats?: string[];
        }) => { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };
      }
    ).BarcodeDetector;

    if (!Detector || !navigator.mediaDevices?.getUserMedia) {
      return; // no detector -> `scanning` stays false, manual path shows
    }

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (cancelled) {
          stream.getTracks().forEach((tr) => tr.stop());
          return;
        }
        setScanning(true);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        const detector = new Detector({ formats: ["qr_code"] });
        const tick = async () => {
          if (cancelled) return;
          if (videoRef.current && videoRef.current.readyState >= 2) {
            try {
              const codes = await detector.detect(videoRef.current);
              const hit = codes.find((c) => extractToken(c.rawValue));
              if (hit) {
                const tok = extractToken(hit.rawValue);
                if (tok) {
                  cancelled = true;
                  stream?.getTracks().forEach((tr) => tr.stop());
                  onToken(tok);
                  return;
                }
              }
            } catch {
              /* a bad frame — keep scanning */
            }
          }
          raf = requestAnimationFrame(() => void tick());
        };
        void tick();
      } catch {
        setError(t("Camera unavailable — type the link on the poster below."));
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((tr) => tr.stop());
      setScanning(false);
    };
  }, [open, onToken]);

  const submitManual = (): void => {
    const tok = extractToken(manual);
    if (tok) onToken(tok);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} ariaLabel={t("Scan & upload")}>
      <DialogHeader>
        <DialogTitle>{t("Scan the poster's QR code")}</DialogTitle>
        <DialogDescription>
          {t(
            "Point your camera at the event poster. You'll pick your school and enter its team code next.",
          )}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3 py-1">
        <div className="overflow-hidden rounded-lg border border-border bg-black">
          <video
            ref={videoRef}
            muted
            playsInline
            className="aspect-square w-full object-cover"
            data-testid="qr-video"
          />
          {!scanning ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              {error ||
                (canScan ? t("Starting camera…") : t(
                  "This browser can't scan. Type the link on the poster below.",
                ))}
            </p>
          ) : null}
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground" htmlFor="join-token">
            {t("Or paste the poster's link")}
          </label>
          <div className="mt-1 flex gap-2">
            <Input
              id="join-token"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="https://…/lens/join/…"
              onKeyDown={(e) => {
                if (e.key === "Enter") submitManual();
              }}
            />
            <Button
              variant="outline"
              disabled={!extractToken(manual)}
              onClick={submitManual}
              data-testid="submit-join-token"
            >
              {t("Open")}
            </Button>
          </div>
        </div>
      </div>
      <Button variant="outline" onClick={() => onOpenChange(false)}>
        {t("Cancel")}
      </Button>
    </Dialog>
  );
}
