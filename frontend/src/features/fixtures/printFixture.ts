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
const STYLE_ID = "fixture-print-page";

/** A4 landscape with a 10mm margin: 277mm of usable width, which is what the
 * sheet's `min-w-[62rem]` and the bracket's scaled canvas are cut to fit. */
const PAGE_RULE = "@page { size: A4 landscape; margin: 10mm; }";

function drop(): void {
  document.getElementById(STYLE_ID)?.remove();
}

/**
 * Print the current page in landscape. The caller has already rendered the
 * print document (`hidden print:block`); this only decides the paper and opens
 * the dialog — "Save as PDF" is a destination of that dialog on every browser,
 * so one control serves both Print and Export PDF.
 */
export function printLandscape(): void {
  drop();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.media = "print";
  style.textContent = PAGE_RULE;
  document.head.appendChild(style);

  const cleanup = (): void => {
    window.removeEventListener("afterprint", cleanup);
    drop();
  };
  window.addEventListener("afterprint", cleanup);
  // A browser that never fires afterprint (some mobile shells) would otherwise
  // leave every later print landscape.
  window.setTimeout(cleanup, 120_000);

  window.print();
}
