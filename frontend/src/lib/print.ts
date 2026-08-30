/**
 * `window.print()`, once the page's lazy images are actually on the page.
 *
 * Crests are `<img loading="lazy">` — right for a 147-row list on a phone,
 * wrong for paper: the browser has only fetched the ones scrolled into view,
 * so a medal tally printed from the top of the page came out with the crests
 * of the first two schools and a blank ring beside every other (owner
 * 2026-08-30, 67 of 147 loaded). Print is the one moment every row is
 * visible, so every image is wanted now: flip them to eager, give them a
 * bounded moment to arrive, then open the dialog.
 */

const WAIT_CAP_MS = 4000;

/** Turn every lazy image eager and resolve when they have decoded (or failed,
 * or the cap runs out — a slow crest must not block the dialog). `decode()`
 * waits for the fetch too, so it is the one signal that covers an image that
 * has not started loading yet. */
export function loadLazyImages(
  root: ParentNode = document,
  capMs: number = WAIT_CAP_MS,
): Promise<void> {
  const pending: Promise<unknown>[] = [];
  root.querySelectorAll<HTMLImageElement>('img[loading="lazy"]').forEach((img) => {
    img.loading = "eager";
    // A DOM without image decoding (jsdom) has nothing to wait for.
    if (typeof img.decode !== "function") return;
    pending.push(img.decode().catch(() => undefined));
  });
  if (!pending.length) return Promise.resolve();
  return Promise.race([
    Promise.all(pending).then(() => undefined),
    new Promise<void>((resolve) => window.setTimeout(resolve, capMs)),
  ]);
}

/** Print the page with its images present. Safe to call from a click handler;
 * the dialog opens as soon as the images are in (or within the cap). */
export async function printPage(): Promise<void> {
  await loadLazyImages();
  window.print();
}

/** Ctrl+P / the browser menu skip the button: the moment before the dialog is
 * too late to await a fetch, but eager images still arrive while the preview
 * is open, and the next print is complete. */
if (typeof window !== "undefined") {
  window.addEventListener("beforeprint", () => {
    void loadLazyImages();
  });
}
