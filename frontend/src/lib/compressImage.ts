/**
 * Best-effort client-side image compression before upload: downscale to a max
 * dimension and re-encode (JPEG for opaque photos, PNG to keep transparency for
 * logos). Keeps uploads small without a server round-trip. Non-images, tiny
 * files, or any failure pass the original File through unchanged — never throws.
 */
export async function compressImage(
  file: File,
  { maxDim = 1600, quality = 0.82, skipBelow = 600 * 1024 } = {},
): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  // SVG/GIF (animation) don't survive a canvas round-trip well — leave them.
  if (file.type === "image/svg+xml" || file.type === "image/gif") return file;

  try {
    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, maxDim / longest);
    // Already small enough and not oversized → keep the original bytes.
    if (scale >= 1 && file.size <= skipBelow) {
      bitmap.close?.();
      return file;
    }
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const keepAlpha = file.type === "image/png" || file.type === "image/webp";
    const outType = keepAlpha ? "image/png" : "image/jpeg";
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, outType, quality),
    );
    // Don't upsize: if compression didn't help, keep the original.
    if (!blob || blob.size >= file.size) return file;
    const name = file.name.replace(/\.[^.]+$/, keepAlpha ? ".png" : ".jpg");
    return new File([blob], name, { type: outType, lastModified: file.lastModified });
  } catch {
    return file; // createImageBitmap/canvas unsupported (e.g. tests) → original
  }
}
