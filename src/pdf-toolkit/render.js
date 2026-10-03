// ── PDF toolkit · the browser-only half (A69) ─────────────────────────────────────────────
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

async function renderToCanvas(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}
const jpegOf = async (canvas, quality) =>
  new Uint8Array(await (await new Promise(r => canvas.toBlob(r, "image/jpeg", quality))).arrayBuffer());

/**
 * Compress → Maximum (owner, 10-03): every page becomes a picture. The biggest saving — and the text
 * is no longer selectable or readable by software (an ATS, a screen reader, search). Said on the page.
 * Pages keep their size in points.
 */
export async function flattenToImages(lib, pdfjs, bytes, { scale = 1.5, quality = 0.6 } = {}) {
  const src = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
  const out = await lib.PDFDocument.create();
  try {
    for (let n = 1; n <= src.numPages; n++) {
      const page = await src.getPage(n);
      const { width, height } = page.getViewport({ scale: 1 });
      const img = await out.embedJpg(await jpegOf(await renderToCanvas(page, scale), quality));
      out.addPage([width, height]).drawImage(img, { x: 0, y: 0, width, height });
      page.cleanup();
    }
  } finally { await src.destroy(); }
  return out.save({ useObjectStreams: true });
}

/**
 * OCR (owner, 10-03): read a scanned PDF with Tesseract, in this browser, and return its text and a
 * SEARCHABLE PDF — each page's image with the recognised words laid over it as invisible text at
 * their positions, so the words can be selected, searched and read by software.
 * `createWorker` and `workerOptions` come from the page (tesseract.js, self-hosted).
 */
export async function ocrPdf(lib, pdfjs, createWorker, workerOptions, bytes, { scale = 2, lang = "eng", onProgress = null } = {}) {
  const src = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
  const worker = await createWorker(lang, 1, workerOptions);
  const out = await lib.PDFDocument.create();
  const font = await out.embedFont(lib.StandardFonts.Helvetica);
  const safe = (s) => [...s].filter(ch => { try { font.encodeText(ch); return true; } catch { return false; } }).join("");
  const texts = [];
  let words = 0, confSum = 0;
  try {
    for (let n = 1; n <= src.numPages; n++) {
      onProgress?.(n, src.numPages);
      const page = await src.getPage(n);
      const { width, height } = page.getViewport({ scale: 1 });
      const canvas = await renderToCanvas(page, scale);
      const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
      texts.push((data.text || "").trim());
      const pdfPage = out.addPage([width, height]);
      pdfPage.drawImage(await out.embedJpg(await jpegOf(canvas, 0.8)), { x: 0, y: 0, width, height });
      for (const block of data.blocks || []) for (const para of block.paragraphs || []) for (const line of para.lines || []) {
        for (const w of line.words || []) {
          const text = safe(w.text || "");
          if (!text.trim()) continue;
          const { x0, y0, x1, y1 } = w.bbox;
          const size = Math.max(4, ((y1 - y0) / scale) * 0.9);
          pdfPage.drawText(text, { x: x0 / scale, y: height - y1 / scale + size * 0.15, size, font, opacity: 0 });
          words++; confSum += w.confidence || 0;
        }
      }
      page.cleanup();
    }
  } finally {
    await worker.terminate();
    await src.destroy();
  }
  return { bytes: await out.save({ useObjectStreams: true }), text: texts.join("\n\n"), pages: texts.length,
           words, confidence: words ? Math.round(confSum / words) : 0 };
}
