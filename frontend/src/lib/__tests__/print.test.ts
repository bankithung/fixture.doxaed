import { describe, expect, it, vi } from "vitest";
import { loadLazyImages, printPage } from "../print";

/** jsdom has no `decode`; give an image one that settles on demand. */
function lazyImg(): { img: HTMLImageElement; settle: () => void } {
  const img = document.createElement("img");
  img.setAttribute("loading", "lazy");
  let settle = (): void => {};
  Object.defineProperty(img, "decode", {
    value: () =>
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    configurable: true,
  });
  document.body.appendChild(img);
  return { img, settle: () => settle() };
}

describe("loadLazyImages", () => {
  it("turns every lazy image eager and waits for them to decode", async () => {
    document.body.innerHTML = "";
    const a = lazyImg();
    const b = lazyImg();
    let settled = false;
    const p = loadLazyImages(document, 10_000).then(() => {
      settled = true;
    });
    expect(a.img.loading).toBe("eager");
    expect(b.img.loading).toBe("eager");
    a.settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    b.settle();
    await p;
    expect(settled).toBe(true);
  });

  it("does not hold the dialog for a crest that never arrives", async () => {
    document.body.innerHTML = "";
    lazyImg();
    await expect(loadLazyImages(document, 20)).resolves.toBeUndefined();
  });

  it("has nothing to wait for where images cannot decode (jsdom)", async () => {
    document.body.innerHTML = "";
    const img = document.createElement("img");
    img.setAttribute("loading", "lazy");
    document.body.appendChild(img);
    await expect(loadLazyImages(document, 10_000)).resolves.toBeUndefined();
    expect(img.loading).toBe("eager");
  });
});

describe("printPage", () => {
  it("opens the dialog only once the images are in", async () => {
    document.body.innerHTML = "";
    const a = lazyImg();
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    const p = printPage();
    await Promise.resolve();
    expect(print).not.toHaveBeenCalled();
    a.settle();
    await p;
    expect(print).toHaveBeenCalledTimes(1);
    print.mockRestore();
  });
});
