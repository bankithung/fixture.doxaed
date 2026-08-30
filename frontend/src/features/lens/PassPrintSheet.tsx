import { Copy, KeyRound, Printer, QrCode } from "lucide-react";
import type { LensCode, LensShareCard } from "@/api/lens";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { printPage } from "@/lib/print";

/** What a school does with the card, in the order it happens. Shown next to
 * the QR so the manager can check the poster says the same thing. */
const STEPS = [
  "Scan the code with any phone camera.",
  "Pick your school and enter your code.",
  "Upload your best photos of the event.",
  "Approved photos join the shared album.",
];

function Steps({ ink }: { ink?: boolean }): React.ReactElement {
  return (
    <ol
      className={cn(
        "list-decimal space-y-1 pl-5 text-left text-sm",
        ink ? "text-muted-foreground print:text-black" : "text-muted-foreground",
      )}
    >
      {STEPS.map((s) => (
        <li key={s}>{t(s)}</li>
      ))}
    </ol>
  );
}

function useCopy(): (value: string, ok: string) => Promise<void> {
  const { push } = useToast();
  return async (value, ok) => {
    try {
      await navigator.clipboard.writeText(value);
      push({ kind: "success", title: ok });
    } catch {
      push({ kind: "error", title: t("Could not copy") });
    }
  };
}

/**
 * The event's ONE card, as a permanent band of the console (owner
 * 2026-08-25): the QR shows ALL THE TIME — minted copies are cached on this
 * device, so there is no one-time reveal and nothing hidden behind a tab.
 *
 * Layout: a compact strip for working with the card (scan it off the screen,
 * copy the link, print, replace), plus a full poster that exists ONLY for
 * print (`hidden print:block` — screen never shows it, paper always does).
 */
export function ShareCardStrip({
  card,
  onMint,
  minting,
  mintedAt,
  tournamentName,
  title,
  tagline,
  consentNote,
}: {
  /** The device-cached or freshly-minted card; null = no readable QR here. */
  card: LensShareCard | null;
  /** Mint or replace. The console confirms first when a card is already out. */
  onMint: () => void;
  minting: boolean;
  /** When the card in use was created; null = none has ever been made. */
  mintedAt: string | null;
  tournamentName: string;
  title: string;
  tagline: string;
  consentNote: string;
}): React.ReactElement {
  const copy = useCopy();

  return (
    <div data-testid="print-sheet" className="border-b border-border">
      {/* ---- The working strip: screen-only. ---- */}
      <div className="flex flex-col gap-3 p-3 print:hidden sm:flex-row sm:items-center">
        {card ? (
          <>
            <img
              src={card.qr_data_uri}
              alt={t("QR code opening the photo upload page")}
              data-testid="share-card"
              className="h-24 w-24 shrink-0 self-center rounded-md border border-border bg-white p-1.5"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{title}</p>
              <p className="truncate text-xs text-muted-foreground">
                {tagline} · {tournamentName}
              </p>
              <p
                className="mt-0.5 truncate font-mono text-[0.6875rem] text-muted-foreground"
                title={card.join_url}
              >
                {card.join_url}
              </p>
            </div>
          </>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div
              aria-hidden="true"
              className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md border border-dashed border-border bg-muted/40 text-muted-foreground"
            >
              <QrCode className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {mintedAt ? t("A card is in use") : t("No card yet")}
                {mintedAt ? (
                  <span
                    data-testid="card-active-since"
                    className="rounded-full bg-success-muted px-2 py-0.5 text-[0.6875rem] font-medium text-success"
                  >
                    {t("Created")}{" "}
                    {new Date(mintedAt).toLocaleDateString([], {
                      dateStyle: "medium",
                    })}
                  </span>
                ) : null}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {mintedAt
                  ? t(
                      "The printed poster keeps working. Replace the card only if it was lost, which stops the old poster.",
                    )
                  : t(
                      "One card for the whole event. Create it, print it, put it where visitors can see it.",
                    )}
              </p>
            </div>
          </div>
        )}

        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:ml-auto">
          {card ? (
            <>
              <Button size="sm" onClick={() => void printPage()} data-testid="print-cards-btn">
                <Printer aria-hidden="true" className="h-4 w-4" />
                {t("Print poster")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void copy(card.join_url, t("Card link copied"))}
                data-testid="copy-share-link"
              >
                <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                {t("Copy link")}
              </Button>
            </>
          ) : null}
          <Button
            size="sm"
            variant={card ? "outline" : "default"}
            onClick={onMint}
            disabled={minting}
            data-testid="mint-share-card-btn"
          >
            <QrCode aria-hidden="true" className="h-4 w-4" />
            {mintedAt ? t("Replace card") : t("Create the card")}
          </Button>
        </div>
      </div>

      {/* ---- Full poster: print-only. Never on screen, always on paper. ---- */}
      {card ? (
        <div aria-hidden="true" className="hidden print:block">
          <div
            className="flex flex-col items-center rounded-lg border border-border bg-card p-6 text-center print:break-after-page print:rounded-none print:border-black print:bg-white print:text-black"
          >
            <p className="text-[0.625rem] font-medium uppercase tracking-[0.16em] text-muted-foreground print:text-black">
              {tournamentName}
            </p>
            <p className="mt-1 text-2xl font-semibold tracking-tight text-primary print:text-black">
              {title}
            </p>
            <p className="text-sm text-muted-foreground print:text-black">
              {tagline}
            </p>
            <img
              src={card.qr_data_uri}
              alt=""
              className="mt-4 h-56 w-56 rounded-md border border-border bg-white p-2 print:border-black"
            />
            <div className="mt-4">
              <Steps ink />
            </div>
            <p className="mt-4 max-w-md text-[0.6875rem] leading-snug text-muted-foreground print:text-black">
              {consentNote}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Code slips: one per school whose code was issued to THIS device, printed
 * under the poster and readable on the Cards tab. Codes are handed out once
 * by the server (hash at rest); showing them again later is this device's
 * own cached copy, dropped automatically when a code is rotated.
 */
export function CodeSlips({ codes }: { codes: LensCode[] }): React.ReactElement | null {
  const copy = useCopy();

  if (codes.length === 0) return null;

  return (
    <div className="border-b border-border">
      <div className="flex items-center gap-2 px-3 py-2 print:hidden">
        <KeyRound aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
        <h4 className="text-sm font-medium">{t("Codes to hand out")}</h4>
        <span className="font-tabular text-xs text-muted-foreground">
          {codes.length}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          data-testid="copy-all-codes"
          onClick={() =>
            void copy(
              codes.map((c) => `${c.institution_name}\t${c.code}`).join("\n"),
              t("All codes copied"),
            )
          }
        >
          <Copy aria-hidden="true" className="h-3.5 w-3.5" />
          {t("Copy all")}
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 print:grid-cols-2 print:gap-0 print:p-0">
        {codes.map((c) => (
          <div
            key={c.pass_id}
            data-testid={`code-slip-${c.pass_id}`}
            className="flex items-center gap-3 rounded-lg border border-border p-3 print:break-inside-avoid print:rounded-none print:border-black print:bg-white print:text-black"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {c.institution_name}
              </p>
            </div>
            <p className="font-tabular text-lg font-semibold tracking-[0.2em]">
              {c.code}
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="print:hidden"
              onClick={() => void copy(c.code, t("Code copied"))}
              data-testid={`copy-slip-${c.pass_id}`}
            >
              <Copy aria-hidden="true" className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
