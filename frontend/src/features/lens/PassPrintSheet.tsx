import { Copy, KeyRound, Lock, Printer, QrCode } from "lucide-react";
import type { LensCode, LensShareCard } from "@/api/lens";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

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

/**
 * The event's ONE printable card, plus the code slips that go with it.
 *
 * There used to be a card per school, so a 35-school event meant 35 QR codes
 * to print, cut and hand to the right teacher. Now the poster is the same for
 * everyone — print it once, put it where people can see it — and what each
 * school gets is a line of text: its name and its code.
 *
 * Three states, because the QR exists only in the response that created it
 * (hash at rest, spec D12) and the panel has to be honest about which one it
 * is in: nothing minted yet, a card in use whose QR is gone, and the one
 * moment the QR is on screen and printable. `window.print()` gives the poster
 * followed by one slip per school; the print side uses fixed ink-safe styles
 * on purpose while the screen side stays on tokens.
 */
export function PassPrintSheet({
  card,
  codes,
  onMint,
  minting,
  mintedAt,
  tournamentName,
  title,
  tagline,
  consentNote,
}: {
  /** Held only while the mint response is on screen; null = QR not available. */
  card: LensShareCard | null;
  /** Codes generated in this session, printed as slips under the poster. */
  codes: LensCode[];
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
  const { push } = useToast();

  const copy = async (value: string, ok: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      push({ kind: "success", title: ok });
    } catch {
      push({ kind: "error", title: t("Could not copy") });
    }
  };

  return (
    <section className="panel" data-testid="print-sheet">
      <div className="panel-header justify-between print:hidden">
        <h3 className="panel-title">{t("The card everyone scans")}</h3>
        <div className="flex items-center gap-2">
          {card ? (
            <Button size="sm" onClick={() => window.print()} data-testid="print-cards-btn">
              <Printer aria-hidden="true" className="h-4 w-4" />
              {t("Print")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={mintedAt ? "outline" : "default"}
            onClick={onMint}
            disabled={minting}
            data-testid="mint-share-card-btn"
          >
            <QrCode aria-hidden="true" className="h-4 w-4" />
            {mintedAt ? t("Replace card") : t("Create the card")}
          </Button>
        </div>
      </div>

      {card ? (
        /* The one moment the QR exists. Say so, then get out of the way. */
        <>
          <p className="border-b border-border bg-warning-muted px-4 py-2 text-xs font-medium text-warning print:hidden">
            {t(
              "This is the only time the QR is shown. Print it now, or copy the link and keep it somewhere safe.",
            )}
          </p>
          <div className="p-3 print:p-0">
            <div
              data-testid="share-card"
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
                alt={t("QR code opening the photo upload page")}
                className="mt-4 h-56 w-56 rounded-md border border-border bg-white p-2 print:border-black"
              />
              <div className="mt-4">
                <Steps ink />
              </div>
              <p className="mt-4 max-w-md text-[0.6875rem] leading-snug text-muted-foreground print:text-black">
                {consentNote}
              </p>
            </div>
            <div className="mt-3 print:hidden">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void copy(card.join_url, t("Card link copied"))}
                data-testid="copy-share-link"
              >
                <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                {t("Copy link")}
              </Button>
            </div>
          </div>
        </>
      ) : (
        /* No QR in hand: a state to read at a glance, not a paragraph. The
           placeholder keeps the panel the same shape either way. */
        <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start print:hidden">
          <div
            aria-hidden="true"
            className="flex h-40 w-40 shrink-0 flex-col items-center justify-center gap-2 self-center rounded-lg border border-dashed border-border bg-muted/40 text-muted-foreground sm:self-start"
          >
            {mintedAt ? (
              <>
                <Lock className="h-6 w-6" />
                <span className="px-3 text-center text-[0.6875rem] leading-snug">
                  {t("QR shown once")}
                </span>
              </>
            ) : (
              <QrCode className="h-8 w-8" />
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">
                {mintedAt ? t("A card is in use") : t("No card yet")}
              </p>
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
            </div>
            <p className="text-sm text-muted-foreground">
              {mintedAt
                ? t(
                    "The printed poster keeps working. Replace the card only if it was lost, which stops the old poster.",
                  )
                : t(
                    "One card for the whole event. Print it once and put it where visitors can see it.",
                  )}
            </p>
            <Steps />
          </div>
        </div>
      )}

      {/* The slips: one per school, handed out with the poster on the wall. */}
      {codes.length > 0 ? (
        <div className="border-t border-border">
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
                  codes
                    .map((c) => `${c.institution_name}\t${c.code}`)
                    .join("\n"),
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
                  <p className="text-[0.6875rem] text-muted-foreground print:text-black">
                    {tagline}
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
      ) : null}
    </section>
  );
}
