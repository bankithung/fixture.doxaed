import { Copy, KeyRound, Printer, QrCode } from "lucide-react";
import type { LensCode, LensShareCard } from "@/api/lens";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { t } from "@/lib/t";

/**
 * The event's ONE printable card, plus the code slips that go with it.
 *
 * There used to be a card per school, so a 35-school event meant 35 QR codes
 * to print, cut and hand to the right teacher. Now the poster is the same for
 * everyone — print it once, put it where people can see it — and what each
 * school gets is a line of text: its name and its code.
 *
 * The QR and the codes exist ONLY in the response of the call that made them
 * (hash at rest, spec D12), so this sheet renders what is held in React state
 * and says so. On screen it is a preview; `window.print()` turns it into the
 * poster followed by one slip per school. The print side uses fixed ink-safe
 * styles on purpose; the screen side stays on tokens.
 */
export function PassPrintSheet({
  card,
  codes,
  onMint,
  minting,
  hasCard,
  tournamentName,
  title,
  tagline,
  consentNote,
}: {
  /** Held only while the mint response is on screen; null = nothing to print. */
  card: LensShareCard | null;
  /** Codes generated in this session, printed as slips under the poster. */
  codes: LensCode[];
  onMint: () => void;
  minting: boolean;
  /** Whether a card has ever been minted (from the campaign, not the token). */
  hasCard: boolean;
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
          <Button
            size="sm"
            variant={card ? "outline" : "default"}
            onClick={onMint}
            disabled={minting}
            data-testid="mint-share-card-btn"
          >
            <QrCode aria-hidden="true" className="h-4 w-4" />
            {hasCard ? t("New card") : t("Create the card")}
          </Button>
          {card ? (
            <Button size="sm" onClick={() => window.print()} data-testid="print-cards-btn">
              <Printer aria-hidden="true" className="h-4 w-4" />
              {t("Print")}
            </Button>
          ) : null}
        </div>
      </div>

      {!card ? (
        <p className="px-4 py-3 text-sm text-muted-foreground print:hidden">
          {hasCard
            ? t(
                "A card is already in use. Its QR is shown once, so print a new one only if the old poster is lost. Creating a new card stops the old one working.",
              )
            : t(
                "Create the card, print it once, and put it where visitors can see it. Each school signs in on it with its own code.",
              )}
        </p>
      ) : (
        <>
          <p className="border-b border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground print:hidden">
            {t(
              "This QR is shown once. Print or copy it now; creating a new card stops this one working.",
            )}
          </p>

          {/* The poster */}
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
              <ol className="mt-4 list-decimal space-y-1 pl-5 text-left text-sm text-muted-foreground print:text-black">
                <li>{t("Scan the code with any phone camera.")}</li>
                <li>{t("Pick your school and enter your code.")}</li>
                <li>{t("Upload your best photos of the event.")}</li>
                <li>{t("Approved photos join the shared album.")}</li>
              </ol>
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
