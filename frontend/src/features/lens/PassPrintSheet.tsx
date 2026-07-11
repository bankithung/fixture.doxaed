import { Copy, Printer } from "lucide-react";
import type { LensCard } from "@/api/lens";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { t } from "@/lib/t";

/**
 * The printable QR pass-card sheet. Rendered ONLY while a mint/rotate response
 * is held in React state — the plaintext links exist nowhere else (hash-at-rest,
 * spec D12). On screen it is a preview grid; `window.print()` turns it into
 * A6-ish cards, 4 per A4 page (`print:break-inside-avoid`). The print side uses
 * fixed ink-safe styles on purpose; the screen side stays on tokens.
 */
export function PassPrintSheet({
  cards,
  tournamentName,
  tagline,
  consentNote,
}: {
  cards: LensCard[];
  tournamentName: string;
  tagline: string;
  consentNote: string;
}): React.ReactElement {
  const { push } = useToast();

  const copyLink = async (card: LensCard): Promise<void> => {
    try {
      await navigator.clipboard.writeText(card.upload_url);
      push({ kind: "success", title: t("Upload link copied") });
    } catch {
      push({ kind: "error", title: t("Could not copy the link") });
    }
  };

  return (
    <section className="panel" data-testid="print-sheet">
      <div className="panel-header justify-between print:hidden">
        <h3 className="panel-title">{t("Cards ready to print")}</h3>
        <Button size="sm" onClick={() => window.print()} data-testid="print-cards-btn">
          <Printer aria-hidden="true" className="h-4 w-4" />
          {t("Print cards")}
        </Button>
      </div>
      <p className="border-b border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground print:hidden">
        {t(
          "These links are shown once. Print or copy them now; regenerating a card replaces its link.",
        )}
      </p>
      <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 print:grid-cols-2 print:gap-0 print:p-0">
        {cards.map((card) => (
          <div
            key={card.pass_id}
            data-testid={`pass-card-${card.pass_id}`}
            className="flex flex-col rounded-lg border border-border bg-card p-4 print:break-inside-avoid print:rounded-none print:border-black print:bg-white print:text-black"
          >
            <p className="text-[0.625rem] font-medium uppercase tracking-[0.16em] text-muted-foreground print:text-black">
              {tournamentName}
            </p>
            <p className="mt-0.5 text-base font-semibold tracking-tight text-primary print:text-black">
              {tagline}
            </p>
            <p className="mt-2 text-sm font-semibold">{card.institution_name}</p>
            <div className="mt-3 flex items-start gap-4">
              <img
                src={card.qr_data_uri}
                alt={t("QR code opening the photo upload page for") + ` ${card.institution_name}`}
                className="h-32 w-32 shrink-0 rounded-md border border-border bg-white p-1 print:border-black"
              />
              <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground print:text-black">
                <li>{t("Scan the code with any phone camera.")}</li>
                <li>{t("Upload your best photos of the event.")}</li>
                <li>{t("Approved photos join the shared album.")}</li>
              </ol>
            </div>
            <p className="mt-3 text-[0.6875rem] leading-snug text-muted-foreground print:text-black">
              {consentNote}
            </p>
            <div className="mt-3 print:hidden">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void copyLink(card)}
                data-testid={`copy-link-${card.pass_id}`}
              >
                <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                {t("Copy link")}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
