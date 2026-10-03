// ── @draft/pdf-toolkit · the browser-only half (A69) ─────────────────────────────────────────────
//
// What needs a canvas: PDF → images, page thumbnails, and compress's JPEG re-encoder. Imports
// nothing — the host passes pdf.js in (`pdfjs`), already configured with its worker.

/** Render pages to images. Yields { page, blob, width, height } — PNG, or JPEG when quality is given. */
export async function* renderPages(pdfjs, bytes, { scale = 2, type = "image/png", quality = 0.9, pages = null } = {}) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
  try {
    for (const n of pages ?? Array.from({ length: doc.numPages }, (_, i) => i + 1)) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (type === "image/jpeg") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await new Promise(r => canvas.toBlob(r, type, quality));
      yield { page: n, blob, width: canvas.width, height: canvas.height };
      page.cleanup();
    }
  } finally { await doc.destroy(); }
}

/** A small thumbnail data URL per page, for the organise view. */
export async function thumbnails(pdfjs, bytes, { width = 120 } = {}) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
  const out = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / base.width });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      out.push(canvas.toDataURL("image/jpeg", 0.7));
      page.cleanup();
    }
  } finally { await doc.destroy(); }
  return out;
}

/**
 * compress()'s re-encoder: decode a JPEG the browser understands, scale its long side down to
 * maxDimension, encode at `quality`. Returns null when the browser cannot decode it (CMYK JPEGs,
 * for one) — compress then leaves that picture alone rather than corrupting it.
 */
export async function reencodeJpegInBrowser(bytes, { maxDimension = 1600, quality = 0.72 } = {}) {
  let bitmap;
  try { bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" })); }
  catch { return null; }
  const k = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * k)), height = Math.max(1, Math.round(bitmap.height * k));
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", quality));
  if (!blob) return null;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
}
