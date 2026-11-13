// ── PDF toolkit · the operations (A69) ────────────────────────────────────────────────────
//
// Tier 1 of the owner's "everything SmallPDF provides": the operations that are LIBRARY WORK —
// deterministic, zero model calls, no marginal cost — so they are free and ungated, for the same
// reason ATS scoring is.
//
// ⭐ They run IN THE BROWSER: the file never leaves the user's machine. No upload, no storage, no
// account, nothing to breach. (SmallPDF uploads your file to its servers; this does not.)
//
// ⭐ A Resume Master product in its own right (owner, 10-03): independent, not designed for draft.
//
// ⛔ This module IMPORTS NOTHING. The page passes the pdf-lib namespace in (`lib`), so the same file
// runs in the browser and under node --test, and the server's PDF → text (src/parsing/extractPdfText.js)
// shares pdfText.js with it. The pdf-lib used is the maintained fork @cantoo/pdf-lib, which adds the
// encryption the original lacks (AES-256).
//
// The owner, 10-03: this product offers everything — PDF → Word and Excel (office.js), OCR of scans
// and compress-by-flattening (render.js). An earlier "not offered" list was a constraint of draft's
// contract, never of this product, and is gone. Each tool says what it carries, on the page.

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

// ── A203 (owner 11-13: "the basic pdf editor … and also the signature one") ─────────────────────────────────────────
//
// Edit / Sign: what the person placed on the pages, written INTO the PDF — text, a white-out box, a picture, and a
// signature or initials as a VECTOR path (sign.js). Every item is placed the way the page is SHOWN: `fx, fy, fw, fh`
// are fractions of the displayed page (top-left origin), so a page with /Rotate 90 / 180 / 270 takes each item upright,
// where the person put it. Nothing else on the page changes; a white-out covers, it does not delete the text beneath.

const KINDS = new Set(["text", "whiteout", "image", "svg"]);

/** The displayed page's box → PDF user space, for a page with /Rotate r (its crop box W × H at x0, y0). */
export function displayToPdf({ W, H, x0 = 0, y0 = 0, r = 0 }, dx, dy) {
  const k = ((r % 360) + 360) % 360;
  const [px, py] = k === 90 ? [dy, dx] : k === 180 ? [W - dx, dy] : k === 270 ? [W - dy, H - dx] : [dx, H - dy];
  return { x: x0 + px, y: y0 + py };
}

const clamp01 = (n) => Math.min(1, Math.max(0, Number(n)));
const colorOf = (lib, c, fallback) => {
  const v = Array.isArray(c) && c.length === 3 ? c.map(clamp01) : fallback;
  return lib.rgb(v[0], v[1], v[2]);
};

/**
 * @param items  [{ page (0-based), kind: "text" | "whiteout" | "image" | "svg", fx, fy, fw, fh,
 *                  text?, size? (pt), color? [r,g,b 0–1],           — text
 *                  image? (JPEG / PNG bytes),                       — image
 *                  d?, vbw?, vbh?, strokeWidth? (lines when set)    — svg (a signature / initials)
 *               }]
 */
export async function applyEdits(lib, bytes, items) {
  if (!Array.isArray(items) || !items.length) throw new ToolkitError("Add something to a page first.");
  const doc = await open(lib, bytes);
  const pages = doc.getPages();
  let font = null;
  for (const [n, it] of items.entries()) {
    const page = pages[it?.page];
    if (!page) throw new ToolkitError(`Item ${n + 1} is on a page this PDF does not have.`);
    if (!KINDS.has(it.kind)) throw new ToolkitError(`Item ${n + 1} is not something this tool can place.`);
    const crop = page.getCropBox();
    const geo = { W: crop.width, H: crop.height, x0: crop.x, y0: crop.y, r: page.getRotation().angle };
    const turned = geo.r % 180 !== 0;
    const Dw = turned ? geo.H : geo.W, Dh = turned ? geo.W : geo.H;
    const dx = clamp01(it.fx) * Dw, dy = clamp01(it.fy) * Dh;
    const dw = Math.max(0, Number(it.fw) || 0) * Dw, dh = Math.max(0, Number(it.fh) || 0) * Dh;
    const rotate = lib.degrees(geo.r);
    const bottomLeft = displayToPdf(geo, dx, dy + dh);
    const topLeft = displayToPdf(geo, dx, dy);
    if (it.kind === "whiteout") {
      if (!dw || !dh) continue;
      page.drawRectangle({ ...bottomLeft, width: dw, height: dh, rotate, color: colorOf(lib, it.color, [1, 1, 1]), borderWidth: 0 });
    } else if (it.kind === "image") {
      const kind = it.image && sniffImage(it.image);
      if (!kind) throw new ToolkitError(`Item ${n + 1}: a picture must be a JPEG or PNG.`);
      const img = kind === "jpeg" ? await doc.embedJpg(it.image) : await doc.embedPng(it.image);
      page.drawImage(img, { ...bottomLeft, width: dw || img.width, height: dh || img.height, rotate });
    } else if (it.kind === "text") {
      const text = String(it.text ?? "").replace(/\r/g, "");
      if (!text.trim()) continue;
      font ??= await doc.embedFont(lib.StandardFonts.Helvetica);
      const size = Math.min(144, Math.max(4, Number(it.size) || 12));
      const lineH = size * 1.2;
      // Helvetica speaks WinAnsi: a character it cannot draw becomes "?" rather than failing the whole save
      const safe = (line) => [...line].map(ch => { try { font.encodeText(ch); return ch; } catch { return "?"; } }).join("");
      text.split("\n").forEach((line, i) => {
        const at = displayToPdf(geo, dx, dy + size * 0.93 + i * lineH);   // the baseline, one ascent below the top
        page.drawText(safe(line), { ...at, size, font, color: colorOf(lib, it.color, [0, 0, 0]), rotate });
      });
    } else {
      const d = String(it.d || "");
      const vbw = Number(it.vbw), vbh = Number(it.vbh);
      if (!d || !(vbw > 0) || !(vbh > 0)) throw new ToolkitError(`Item ${n + 1}: the signature is empty.`);
      const scale = Math.min((dw || vbw) / vbw, (dh || vbh) / vbh);
      const color = colorOf(lib, it.color, [0.07, 0.07, 0.12]);
      const common = { ...topLeft, scale, rotate };
      if (it.strokeWidth) {
        page.drawSvgPath(d, { ...common, borderColor: color, borderWidth: Number(it.strokeWidth), borderLineCap: lib.LineCapStyle.Round });
      } else {
        page.drawSvgPath(d, { ...common, color, fillRule: lib.FillRule?.NonZero });
      }
    }
  }
  return save(doc);
}

// ── A203 (2) (owner 11-13: "edit a pdf text as inline … just live draft, not add more text") ─────────────────────────
//
// Change the words a page already shows. Each edit names a text run the way pdf.js reports it (its transform and width in
// user space) and its new words. The run's own drawing is REMOVED from the page's content stream (textEdit.stripText: the
// operator becomes a displacement of the same advance, so nothing after it moves) and the new words are written as real
// text at the same baseline, size, angle and colour, in the closest standard face (Helvetica / Times / Courier, bold and
// italic). A neighbour drawn by the same operator is written back unchanged. When the run's drawing cannot be found (text
// inside a form XObject, say), it is covered with its background colour instead — and the result says how many.

const STD = {
  sans: ["Helvetica", "HelveticaBold", "HelveticaOblique", "HelveticaBoldOblique"],
  serif: ["TimesRoman", "TimesRomanBold", "TimesRomanItalic", "TimesRomanBoldItalic"],
  mono: ["Courier", "CourierBold", "CourierOblique", "CourierBoldOblique"],
};
const stdOf = (f = {}) => (STD[f.family] || STD.sans)[(f.bold ? 1 : 0) + (f.italic ? 2 : 0)];
const STD_BY_BASE = [[/courier/i, "mono"], [/times|roman|serif|georgia|garamond|cambria|book/i, "serif"], [/./, "sans"]];

/** The page's content streams, decoded and joined (latin1). */
function pageContent(lib, page) {
  const { PDFArray, PDFRawStream } = lib;
  const raw = page.node.Contents();
  if (!raw) return "";
  const list = raw instanceof PDFArray ? raw.asArray() : [raw];
  let out = "";
  for (const r of list) {
    const s = page.doc.context.lookup(r);
    if (!s) continue;
    const bytes = s instanceof PDFRawStream ? lib.decodePDFRawStream(s).decode() : (s.getContents?.() ?? new Uint8Array());
    let str = ""; for (let i = 0; i < bytes.length; i += 8192) str += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    out += `${str}\n`;
  }
  return out;
}

function resourcesOf(lib, page) {
  const { PDFName, PDFDict } = lib;
  for (let n = page.node; n; n = n.lookupMaybe(PDFName.of("Parent"), PDFDict)) {
    const r = n.lookupMaybe(PDFName.of("Resources"), PDFDict);
    if (r) return r;
  }
  return null;
}

/** name → { width(code) (1/1000 em), bytes } from the page's font dictionaries; a standard font without Widths is measured. */
async function fontWidthsOf(lib, doc, page) {
  const { PDFName, PDFDict, PDFArray, PDFNumber } = lib;
  const fonts = resourcesOf(lib, page)?.lookupMaybe(PDFName.of("Font"), PDFDict);
  const cache = new Map();
  if (!fonts) return () => null;
  const numOf = (v) => (v instanceof PDFNumber ? v.asNumber() : Number(v?.asNumber?.() ?? v) || 0);
  for (const [key, ref] of fonts.entries()) {
    const f = doc.context.lookup(ref);
    if (!(f instanceof PDFDict)) continue;
    const subtype = f.get(PDFName.of("Subtype"))?.toString();
    if (subtype === "/Type0") {
      const desc = doc.context.lookup(f.lookupMaybe(PDFName.of("DescendantFonts"), PDFArray)?.get(0));
      const dw = desc?.get(PDFName.of("DW")) ? numOf(desc.get(PDFName.of("DW"))) : 1000;
      const map = new Map();
      const W = desc?.lookupMaybe(PDFName.of("W"), PDFArray);
      if (W) {
        const a = W.asArray().map(v => doc.context.lookup(v) ?? v);
        for (let i = 0; i < a.length;) {
          const c0 = numOf(a[i]);
          if (a[i + 1] instanceof PDFArray) { a[i + 1].asArray().forEach((w, k) => map.set(c0 + k, numOf(doc.context.lookup(w) ?? w))); i += 2; }
          else { const c1 = numOf(a[i + 1]), w = numOf(a[i + 2]); for (let c = c0; c <= c1; c++) map.set(c, w); i += 3; }
        }
      }
      cache.set(key.decodeText?.() ?? key.toString().slice(1), { width: (c) => map.get(c) ?? dw, bytes: 2 });
      continue;
    }
    const first = f.get(PDFName.of("FirstChar")) ? numOf(f.get(PDFName.of("FirstChar"))) : 0;
    const widths = f.lookupMaybe(PDFName.of("Widths"), PDFArray)?.asArray().map(v => numOf(doc.context.lookup(v) ?? v));
    const missing = numOf(doc.context.lookup(f.get(PDFName.of("FontDescriptor")))?.get?.(PDFName.of("MissingWidth"))) || 0;
    let width;
    if (widths) width = (c) => widths[c - first] ?? missing;
    else {   // a standard-14 font named only by its BaseFont: measure the face pdf-lib carries
      const base = String(f.get(PDFName.of("BaseFont"))?.toString() || "").replace(/^\/([A-Z]{6}\+)?/, "");
      const fam = STD_BY_BASE.find(([re]) => re.test(base))[1];
      const std = await doc.embedFont(lib.StandardFonts[stdOf({ family: fam, bold: /bold/i.test(base), italic: /italic|oblique/i.test(base) })]);
      width = (c) => { try { return std.widthOfTextAtSize(String.fromCharCode(c), 1000); } catch { return 500; } };
    }
    cache.set(key.decodeText?.() ?? key.toString().slice(1), { width, bytes: 1 });
  }
  return (name) => cache.get(name) ?? null;
}

/**
 * @param edits   [{ page (0-based), transform: [a,b,c,d,e,f], width, height, text, original?, font?: { family: "sans" | "serif"
 *                  | "mono", bold, italic }, color?: [r,g,b], bg?: [r,g,b] }] — the runs whose words changed
 * @param others  [{ page, transform, width, height, text, font?, color? }] — every OTHER run on those pages (to write back a
 *                  neighbour that shared an operator with an edited run)
 * @returns { bytes, removed (operators taken out), covered (runs painted over instead), rewritten (neighbours written back) }
 */
export async function applyTextEdits(lib, bytes, edits, others = []) {
  if (!Array.isArray(edits) || !edits.length) throw new ToolkitError("Change some text first.");
  const doc = await open(lib, bytes);
  const pages = doc.getPages();
  const { stripText, frameOf, runTouches } = await import("./textEdit.js");
  const faces = new Map();
  const face = async (f) => { const k = stdOf(f); if (!faces.has(k)) faces.set(k, await doc.embedFont(lib.StandardFonts[k])); return faces.get(k); };
  let removed = 0, covered = 0, rewritten = 0;
  const byPage = new Map();
  for (const e of edits) {
    if (!pages[e?.page]) throw new ToolkitError("An edit is on a page this PDF does not have.");
    if (!Array.isArray(e.transform) || e.transform.length !== 6) throw new ToolkitError("An edit does not say where its text is.");
    (byPage.get(e.page) || byPage.set(e.page, []).get(e.page)).push(e);
  }
  for (const [n, list] of byPage) {
    const page = pages[n];
    const widths = await fontWidthsOf(lib, doc, page);
    const src = pageContent(lib, page);
    const res = stripText(src, list, widths);
    if (res.touched.size) {
      const enc = new Uint8Array(res.content.length);
      for (let i = 0; i < res.content.length; i++) enc[i] = res.content.charCodeAt(i) & 255;
      page.node.set(lib.PDFName.of("Contents"), doc.context.register(doc.context.flateStream(enc)));
      removed += res.touched.size;
    }
    // neighbours an operator we took out also drew — write them back as they were
    const back = others.filter(o => o.page === n && !list.includes(o) && String(o.text || "").trim()
      && res.dropped.some(r => runTouches(r, frameOf(o))));
    const draw = async (e, text) => {
      const [a, b, c, d, x, y] = e.transform;
      const size = Number(e.size) > 0 ? Number(e.size) : (Math.hypot(c, d) || Number(e.height) || 10);   // a size the person changed wins
      const font = await face(e.font);
      const safe = [...String(text)].map(ch => { try { font.encodeText(ch); return ch; } catch { return "?"; } }).join("");
      const col = Array.isArray(e.color) && e.color.length === 3 ? e.color : [0, 0, 0];
      page.drawText(safe, { x, y, size, font, color: lib.rgb(col[0], col[1], col[2]), rotate: lib.degrees((Math.atan2(b, a) * 180) / Math.PI) });
      if (e.underline) {   // a line under the words, along their baseline
        const len = font.widthOfTextAtSize(safe, size), ux = Math.cos(Math.atan2(b, a)), uy = Math.sin(Math.atan2(b, a));
        const off = size * 0.12;
        page.drawLine({ start: { x: x + uy * off, y: y - ux * off }, end: { x: x + ux * len + uy * off, y: y + uy * len - ux * off },
          thickness: Math.max(0.5, size / 16), color: lib.rgb(col[0], col[1], col[2]) });
      }
    };
    for (const [i, e] of list.entries()) {
      if (!res.removed[i]) {   // its drawing was not found in this page's stream: cover it with its background
        const fr = frameOf(e);
        const bg = Array.isArray(e.bg) && e.bg.length === 3 ? e.bg : [1, 1, 1];
        const [x, y] = [fr.o[0] - fr.v[0] * fr.h * 0.25, fr.o[1] - fr.v[1] * fr.h * 0.25];
        page.drawRectangle({ x, y, width: fr.len + 1, height: fr.h * 1.3, color: lib.rgb(bg[0], bg[1], bg[2]), borderWidth: 0,
          rotate: lib.degrees((Math.atan2(fr.u[1], fr.u[0]) * 180) / Math.PI) });
        covered++;
      }
      if (String(e.text || "").trim()) await draw(e, String(e.text).replace(/\s*\n\s*/g, " "));
    }
    for (const o of back) { await draw(o, o.text); rewritten++; }
  }
  return { bytes: await save(doc), removed, covered, rewritten };
}
