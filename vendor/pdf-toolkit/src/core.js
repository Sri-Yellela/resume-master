// ── @draft/pdf-toolkit · the operations (A69) ────────────────────────────────────────────────────
//
// Tier 1 of the owner's "everything SmallPDF provides": the operations that are LIBRARY WORK —
// deterministic, zero model calls, no marginal cost — so they are free and ungated, for the same
// reason ATS scoring is.
//
// ⭐ They run IN THE BROWSER: the file never leaves the user's machine. No upload, no storage, no
// account, nothing to breach. (SmallPDF uploads your file to its servers; this does not.)
//
// ⛔ This module IMPORTS NOTHING. The host passes the pdf-lib namespace in (`lib`), so the same file
// runs under Vite in draft, from plain module imports on the tools service's site, and under node --test — one
// implementation, never a copy (A52's lesson, and StampLogo's before it). The pdf-lib used is the
// maintained fork @cantoo/pdf-lib, which adds the encryption the original lacks (AES-256).
//
// ⛔ NOT OFFERED, said plainly rather than shipped badly: PDF → Word/Excel with real fidelity, OCR
// of scans, and "compress" by turning pages into pictures (it would make a résumé unreadable to the
// very ATS whose upload cap the user is trying to meet). See NOT_OFFERED.

export const NOT_OFFERED = Object.freeze([
  { what: "PDF → Word or Excel", why: "A faithful conversion is a hard problem; a bad one is worse than none." },
  { what: "Reading scanned PDFs (OCR)", why: "A scan has no text layer. Export the document as a PDF instead." },
  { what: "Compressing by turning pages into images", why: "It would make the text unreadable to an ATS — the reason most people compress a résumé." },
]);

export class ToolkitError extends Error {
  constructor(message) { super(message); this.name = "ToolkitError"; }
}

/**
 * "1-3, 5, 8-" → zero-based page indices, in the order written, against a page count.
 * Throws a ToolkitError a person can act on — never silently drops a bad range.
 */
export function parsePageRanges(spec, pageCount) {
  const text = String(spec ?? "").trim();
  if (!text) throw new ToolkitError("Say which pages — for example 1-3, 5.");
  const out = [];
  for (const raw of text.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^(\d+)?\s*(-)?\s*(\d+)?$/);
    if (!m || (!m[1] && !m[3])) throw new ToolkitError(`"${part}" is not a page or a range.`);
    const from = m[1] ? Number(m[1]) : 1;
    const to = m[2] ? (m[3] ? Number(m[3]) : pageCount) : from;
    if (from < 1 || to < 1 || from > pageCount || to > pageCount) {
      throw new ToolkitError(`Page ${Math.max(from, to)} does not exist — this PDF has ${pageCount} page${pageCount === 1 ? "" : "s"}.`);
    }
    if (from > to) throw new ToolkitError(`"${part}" runs backwards.`);
    for (let p = from; p <= to; p++) out.push(p - 1);
  }
  if (!out.length) throw new ToolkitError("Say which pages — for example 1-3, 5.");
  return out;
}

async function open(lib, bytes, password) {
  try {
    return password != null
      ? await lib.PDFDocument.load(bytes, { password })
      : await lib.PDFDocument.load(bytes);
  } catch (e) {
    const msg = String(e?.message || e);
    if (/password/i.test(msg)) {
      throw new ToolkitError(password != null ? "That password is not right for this PDF."
        : "This PDF is password-protected. Unlock it first (the Unlock tool), then try again.");
    }
    if (/encrypt/i.test(msg)) throw new ToolkitError("This PDF is password-protected. Unlock it first, then try again.");
    throw new ToolkitError("This file could not be read as a PDF.");
  }
}

const save = (doc) => doc.save({ useObjectStreams: true });

/** Basic facts, for the UI before any operation. */
export async function info(lib, bytes) {
  const doc = await lib.PDFDocument.load(bytes, { ignoreEncryption: true }).catch(() => null);
  if (!doc) throw new ToolkitError("This file could not be read as a PDF.");
  return { pages: doc.getPageCount(), encrypted: !!doc.isEncrypted, bytes: bytes.byteLength ?? bytes.length };
}

/** Merge several PDFs, in the order given. */
export async function merge(lib, files) {
  if (!files?.length || files.length < 2) throw new ToolkitError("Choose at least two PDFs to merge.");
  const out = await lib.PDFDocument.create();
  for (const bytes of files) {
    const src = await open(lib, bytes);
    for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
  }
  return save(out);
}

/** A new PDF of the given pages (zero-based), in the given order — extract, reorder, or split one part. */
export async function selectPages(lib, bytes, indices) {
  const src = await open(lib, bytes);
  const count = src.getPageCount();
  if (!indices?.length) throw new ToolkitError("No pages chosen.");
  for (const i of indices) if (!Number.isInteger(i) || i < 0 || i >= count) throw new ToolkitError(`Page ${i + 1} does not exist.`);
  const out = await lib.PDFDocument.create();
  for (const page of await out.copyPages(src, indices)) out.addPage(page);
  return save(out);
}

/** Split into one PDF per range ("1-2, 3, 4-") — or one per page when ranges is "each". */
export async function split(lib, bytes, ranges = "each") {
  const src = await open(lib, bytes);
  const count = src.getPageCount();
  const groups = ranges === "each"
    ? src.getPageIndices().map(i => [i])
    : String(ranges).split(",").map(r => parsePageRanges(r, count));
  const outs = [];
  for (const g of groups) outs.push({ pages: g.map(i => i + 1), bytes: await selectPages(lib, bytes, g) });
  return outs;
}

/** Delete pages (zero-based). Refuses to delete every page. */
export async function deletePages(lib, bytes, indices) {
  const src = await open(lib, bytes);
  const drop = new Set(indices);
  const keep = src.getPageIndices().filter(i => !drop.has(i));
  if (!keep.length) throw new ToolkitError("That would delete every page.");
  return selectPages(lib, bytes, keep);
}

/** Rotate pages (zero-based; all when omitted) by a multiple of 90°. */
export async function rotate(lib, bytes, degrees, indices = null) {
  if (degrees % 90 !== 0) throw new ToolkitError("Rotate by 90, 180 or 270 degrees.");
  const doc = await open(lib, bytes);
  const pages = doc.getPages();
  for (const i of indices ?? pages.map((_, k) => k)) {
    const page = pages[i];
    if (!page) throw new ToolkitError(`Page ${i + 1} does not exist.`);
    page.setRotation(lib.degrees(((page.getRotation().angle + degrees) % 360 + 360) % 360));
  }
  return save(doc);
}

/** A diagonal text watermark on every page. */
export async function watermark(lib, bytes, text, { opacity = 0.18, size = null } = {}) {
  const label = String(text ?? "").trim();
  if (!label) throw new ToolkitError("Type the watermark text.");
  const doc = await open(lib, bytes);
  const font = await doc.embedFont(lib.StandardFonts.HelveticaBold);
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const s = size ?? Math.max(18, Math.min(72, (Math.hypot(width, height) * 0.75) / Math.max(label.length, 4)));
    const w = font.widthOfTextAtSize(label, s);
    const angle = Math.atan2(height, width);
    page.drawText(label, {
      x: width / 2 - (w / 2) * Math.cos(angle), y: height / 2 - (w / 2) * Math.sin(angle),
      size: s, font, opacity, color: lib.rgb(0.45, 0.45, 0.45), rotate: lib.radians(angle),
    });
  }
  return save(doc);
}

/** Password-protect (AES-256). The user password opens it; owner defaults to the same. */
export async function protect(lib, bytes, userPassword, ownerPassword = null) {
  if (!userPassword) throw new ToolkitError("Choose a password.");
  const doc = await open(lib, bytes);
  doc.encrypt({ userPassword, ownerPassword: ownerPassword || userPassword });
  return doc.save({ useObjectStreams: false });
}

/** Remove the password — the user must know it. Never cracks one. */
export async function unlock(lib, bytes, password) {
  if (password == null || password === "") throw new ToolkitError("Type the PDF's password.");
  const doc = await open(lib, bytes, password);
  return doc.save({ useObjectStreams: false });
}

/** JPEG/PNG images → one PDF, one image per page, each page the image's own size. */
export async function imagesToPdf(lib, images) {
  if (!images?.length) throw new ToolkitError("Choose at least one image.");
  const doc = await lib.PDFDocument.create();
  for (const img of images) {
    const bytes = img.bytes ?? img;
    const kind = sniffImage(bytes);
    if (!kind) throw new ToolkitError(`${img.name ?? "An image"} is not a JPEG or PNG.`);
    const embedded = kind === "jpeg" ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    const page = doc.addPage([embedded.width, embedded.height]);
    page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
  }
  return save(doc);
}

function isRgb(lib, doc, cs) {
  const { PDFName, PDFArray, PDFRef } = lib;
  const v = cs instanceof PDFRef ? doc.context.lookup(cs) : cs;
  if (v === PDFName.of("DeviceRGB")) return true;
  if (v instanceof PDFArray && v.get(0) === PDFName.of("ICCBased")) {
    const profile = doc.context.lookup(v.get(1));
    return profile?.dict?.get(PDFName.of("N"))?.asNumber?.() === 3;
  }
  return false;
}

export function sniffImage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  return null;
}

/**
 * Compress WITHOUT touching the text: re-encode the JPEG pictures inside the PDF smaller, and
 * rewrite the file with object streams. `reencodeJpeg(bytes, { maxDimension, quality })` is the
 * host's (a canvas in the browser); it returns { bytes, width, height } or null to leave one alone.
 *
 * Honest by construction: it reports what it did and how much it saved, and keeps the original
 * when the result is not smaller. A PDF that is mostly fonts and text will barely shrink — the
 * report says so instead of pretending.
 */
export async function compress(lib, bytes, { reencodeJpeg, maxDimension = 1600, quality = 0.72 } = {}) {
  const doc = await open(lib, bytes);
  const { PDFName, PDFRawStream, PDFNumber } = lib;
  let images = 0, recompressed = 0;
  if (reencodeJpeg) {
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;
      const dict = obj.dict;
      if (dict.get(PDFName.of("Subtype")) !== PDFName.of("Image")) continue;
      images++;
      const filter = dict.get(PDFName.of("Filter"));
      const isJpeg = filter === PDFName.of("DCTDecode")
        || (filter?.asArray && filter.asArray().length === 1 && filter.asArray()[0] === PDFName.of("DCTDecode"));
      if (!isJpeg) continue;
      // A canvas re-encodes to an RGB JPEG. Only an RGB picture can take one back: a CMYK or grey
      // one would come out the wrong colour or broken, so it is left exactly as it is.
      if (!isRgb(lib, doc, dict.get(PDFName.of("ColorSpace")))) continue;
      if (dict.get(PDFName.of("Decode"))) continue;
      const smaller = await reencodeJpeg(obj.contents, { maxDimension, quality });
      if (!smaller || smaller.bytes.length >= obj.contents.length) continue;
      obj.contents = smaller.bytes;
      dict.set(PDFName.of("Length"), PDFNumber.of(smaller.bytes.length));
      dict.set(PDFName.of("Width"), PDFNumber.of(smaller.width));
      dict.set(PDFName.of("Height"), PDFNumber.of(smaller.height));
      recompressed++;
    }
  }
  const out = await save(doc);
  const before = bytes.byteLength ?? bytes.length;
  const kept = out.length >= before;
  return {
    bytes: kept ? bytes : out, before, after: kept ? before : out.length, images, recompressed, keptOriginal: kept,
    note: kept ? "This PDF could not be made smaller without changing its text — the original is unchanged."
      : images === 0 ? "No pictures inside — the saving is from tidying the file. Text is untouched."
      : `${recompressed} of ${images} picture${images === 1 ? "" : "s"} made smaller. Text is untouched and still selectable.`,
  };
}
