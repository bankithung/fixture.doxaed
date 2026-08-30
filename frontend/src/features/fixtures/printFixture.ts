/**
 * Printing a fixture is printing a WIDE thing: nine columns of an order of
 * play, or a knockout tree five rounds across. On portrait A4 either one is
 * either cropped or shrunk to nothing, so the export sets its own paper.
 *
 * `@page` cannot be written as a class-scoped rule (it has no selector), and a
 * landscape rule left permanently in the stylesheet would rotate every other
 * print in the app — the badge cards, a match report. So the rule is injected
 * for the duration of ONE print and removed again on `afterprint`.
 */
import { t } from "@/lib/t";
import { loadLazyImages } from "@/lib/print";

/**
 * Which passes of a fixture go on paper. `teams` is the order of play as the
 * board shows it; `detailed` is the same fixture again with every player named
 * under the team that entered them; `both` prints one after the other.
 *
 * Both was the only option there was, so an organiser who wanted an order of
 * play for the wall threw away half of every export (owner 2026-08-22).
 */
export type PrintPasses = "teams" | "detailed" | "both";

/** What a pass prints under, in its page header and in the saved file's name.
 * Lives here so the menu that picks a pass and the page that prints it cannot
 * word it two different ways. */
export function passLabel(detailed: boolean): string {
  return detailed ? t("With player names") : t("Order of play");
}

const STYLE_ID = "fixture-print-page";

/** A4 landscape with a 10mm margin: 277mm of usable width, which is what the
 * sheet's `min-w-[62rem]` and the bracket's scaled canvas are cut to fit. */
const PAGE_RULE = "@page { size: A4 landscape; margin: 10mm; }";

function drop(): void {
  document.getElementById(STYLE_ID)?.remove();
}

/** Characters no filesystem wants in a name. The browser derives the "Save as
 * PDF" filename from `document.title`, so whatever we put there IS the file
 * name a viewer ends up with. */
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f]+/g;

function clean(title: string): string {
  return title.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
}

/**
 * Print the current page in landscape. The caller has already rendered the
 * print document (`hidden print:block`); this only decides the paper and opens
 * the dialog — "Save as PDF" is a destination of that dialog on every browser,
 * so one control serves both Print and Export PDF.
 *
 * `title` names the SAVED FILE. Every browser takes the PDF's default file
 * name from `document.title`, and the page's own title is the tournament — so
 * without this, every export a viewer saved was called the same thing and the
 * downloads folder was unreadable (owner 2026-08-21). It is restored the
 * moment the dialog closes; the page keeps its own title.
 */
export function printLandscape(title?: string): void {
  drop();
  const wasTitle = document.title;
  const wanted = title ? clean(title) : "";
  if (wanted) document.title = wanted;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.media = "print";
  style.textContent = PAGE_RULE;
  document.head.appendChild(style);

  const cleanup = (): void => {
    window.removeEventListener("afterprint", cleanup);
    drop();
    // Only put it back if nothing else has moved on (a navigation may have
    // set its own title while the dialog was open).
    if (wanted && document.title === wanted) document.title = wasTitle;
  };
  window.addEventListener("afterprint", cleanup);
  // A browser that never fires afterprint (some mobile shells) would otherwise
  // leave every later print landscape.
  window.setTimeout(cleanup, 120_000);

  void loadLazyImages().then(() => window.print());
}
