// ── PDF toolkit · Edit PDF — the page's own text, edited in place (A203 (2), owner 11-13) ─────────────────────────────
//
// "what i want is to be able to edit a pdf text as inline, so upload pdf and its editable wherever, just live draft, not
// add more text" · "use the entire sandbox styling and formatting and buttons from draft".
//
// The PDF's pages, drawn by pdf.js; over every run of text a box at exactly its place, holding its words. Untouched, the
// box is invisible and the page shows through. Click and type: from the first keystroke the box shows the NEW words, in
// the closest face, size and colour, on the run's own background — live. The toolbar (draft's sandbox: face, size, bold,
// italic, underline, colour, undo, clear) acts on the run being edited. Save writes the changes INTO the PDF
// (core.applyTextEdits): the old words' drawing is removed from the page, the new words are real text.
//
// "Open in the résumé editor" is the other road (pdfToDoc.js): the PDF's text as a document in /editor/ — every option,
// the editor's layout. ⭐ Nothing leaves this browser.

import { linesOf } from "./pdfText.js";
import { blocksOf, docHtmlOf } from "./pdfToDoc.js";

const FACES = [["sans", "Sans (Helvetica)"], ["serif", "Serif (Times)"], ["mono", "Mono (Courier)"]];
const CSS_FACE = { sans: "Helvetica, Arial, sans-serif", serif: "'Times New Roman', Times, serif", mono: "'Courier New', Courier, monospace" };
const SCALE = 1.6;
export const HANDOFF_KEY = "rm-editor:handoff";

/** pdf.js's font object → { family, bold, italic } of the closest standard face. */
export function faceOf(name = "", f = {}) {
  const n = String(name || f.name || "");
  const family = f.isMonospace || /mono|courier|consol/i.test(n) ? "mono"
    : f.isSerifFont || /times|serif|georgia|garamond|cambria|book|minion|palat/i.test(n) && !/sans/i.test(n) ? "serif" : "sans";
  return { family, bold: !!f.bold || /bold|black|heavy|semibold|demi/i.test(n), italic: !!f.italic || /italic|oblique/i.test(n) };
}

/** The run's ink and paper from the drawn page: the paper is the commonest edge colour, the ink the pixel farthest from it. */
export function sampleColors(data, w, h) {
  if (!w || !h) return { ink: [0, 0, 0], bg: [1, 1, 1] };
  const px = (x, y) => { const i = (y * w + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
  // the commonest edge colour (in 16-step buckets), then the true mean of the pixels in that bucket — white stays 255
  const counts = new Map();
  const add = (p) => { const k = p.map(v => v >> 4).join(","); const c = counts.get(k) || { n: 0, sum: [0, 0, 0] }; c.n++; p.forEach((v, i) => { c.sum[i] += v; }); counts.set(k, c); };
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) add(px(x, y));
  for (let y = 0; y < h; y++) for (const x of [0, w - 1]) add(px(x, y));
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  const top = best.sum.map(v => Math.round(v / best.n));
  let ink = top, far = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = px(x, y), d = (p[0] - top[0]) ** 2 + (p[1] - top[1]) ** 2 + (p[2] - top[2]) ** 2;
    if (d > far) { far = d; ink = p; }
  }
  const n = (c) => c.map(v => Math.min(1, Math.max(0, v / 255)));
  return { ink: far < 900 ? [0, 0, 0] : n(ink), bg: n(top) };
}

const hex = (c) => `#${c.map(v => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
const rgbOf = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);

/**
 * @param h  the toolkit's helpers: { el, lib, pdfjs, core, status, say, fail, results, download, fileInput, base, readBytes }
 */
export function buildTextEditor(h) {
  const { el, lib, pdfjs, core, say, fail } = h;
  const input = h.fileInput();
  const s = h.status(), out = h.results();
  const pagesBox = el("div", { class: "pt-ed-pages pt-tx-pages", "data-pt-tx-pages": true });
  const runs = [];               // every text run on every page
  const pageStates = [];         // each drawn page: its canvas, viewport and layer (OCR adds fields to it later)
  let bytes = null, file = null, doc = null, active = null;

  // ── draft's sandbox toolbar, for the run being edited ──
  const sbtn = (label, title, onPress, extra = {}) => el("button", { type: "button", class: "pt-sbx", title, "aria-label": title, ...extra,
    onmousedown: (e) => { e.preventDefault(); onPress(); } }, label);
  const face = el("select", { class: "pt-sbx pt-sbx--sel", "aria-label": "Face", onchange: () => setStyle({ family: face.value }) },
    ...FACES.map(([v, l]) => el("option", { value: v }, l)));
  const sizeOut = el("span", { class: "pt-sbx-v", "aria-live": "polite" }, "—");
  const color = el("input", { type: "color", class: "pt-sbx-color", "aria-label": "Text colour", oninput: () => setStyle({ color: rgbOf(color.value) }) });
  const toolbar = el("div", { class: "pt-sb-bar", role: "toolbar", "aria-label": "Edit the text", "data-pt-tx-toolbar": true },
    face,
    sbtn("A−", "Smaller text", () => setStyle({ size: Math.max(4, (active?.size || 10) - 0.5) })), sizeOut,
    sbtn("A+", "Larger text", () => setStyle({ size: Math.min(96, (active?.size || 10) + 0.5) })),
    el("span", { class: "pt-sb-sep", "aria-hidden": "true" }),
    sbtn(el("b", {}, "B"), "Bold", () => setStyle({ bold: !active?.font.bold }), { "data-cmd": "bold" }),
    sbtn(el("i", {}, "I"), "Italic", () => setStyle({ italic: !active?.font.italic }), { "data-cmd": "italic" }),
    sbtn(el("u", {}, "U"), "Underline", () => setStyle({ underline: !active?.underline }), { "data-cmd": "underline" }),
    el("label", { class: "pt-sbx", title: "Text colour" }, "A", color),
    el("span", { class: "pt-sb-sep", "aria-hidden": "true" }),
    sbtn("↶", "Undo this line's change", () => active && revert(active), { "data-cmd": "undo" }),
    sbtn("T̸", "Back to the original style", () => active && setStyle({ ...active.orig.font, size: active.orig.size, color: active.orig.color, underline: false })),
    el("span", { class: "pt-sb-grow" }),
    el("span", { class: "pt-sb-count", "data-pt-tx-count": true }, ""));
  const count = toolbar.querySelector("[data-pt-tx-count]");
  const syncBar = () => {
    const r = active;
    for (const c of toolbar.querySelectorAll("button, select, input")) c.disabled = !r;
    if (!r) { sizeOut.textContent = "—"; return; }
    face.value = r.font.family; sizeOut.textContent = String(Math.round(r.size * 10) / 10);
    color.value = hex(r.color);
    toolbar.querySelector("[data-cmd=bold]").setAttribute("aria-pressed", String(r.font.bold));
    toolbar.querySelector("[data-cmd=italic]").setAttribute("aria-pressed", String(r.font.italic));
    toolbar.querySelector("[data-cmd=underline]").setAttribute("aria-pressed", String(!!r.underline));
  };
  const changedRuns = () => runs.filter(r => r.changed);
  const syncCount = () => { const n = changedRuns().length; count.textContent = n ? `${n} line${n === 1 ? "" : "s"} changed` : ""; };

  function paint(r) {
    const b = r.node;
    b.classList.toggle("pt-tx--changed", !!r.changed);
    b.style.fontFamily = CSS_FACE[r.font.family];
    b.style.fontWeight = r.font.bold ? "700" : "400";
    b.style.fontStyle = r.font.italic ? "italic" : "normal";
    b.style.textDecoration = r.underline ? "underline" : "none";
    b.style.fontSize = `calc(var(--pt-k, 1) * ${r.size * r.k}px)`;
    b.style.color = r.changed ? hex(r.color) : "transparent";
    b.style.background = r.changed ? hex(r.bg) : "transparent";
  }
  function setStyle(p) {
    const r = active; if (!r) return;
    if (p.family != null) r.font = { ...r.font, family: p.family };
    if (p.bold != null) r.font = { ...r.font, bold: p.bold };
    if (p.italic != null) r.font = { ...r.font, italic: p.italic };
    if (p.size != null) r.size = p.size;
    if (p.color) r.color = p.color;
    if (p.underline != null) r.underline = p.underline;
    r.changed = r.text !== r.orig.text || r.size !== r.orig.size || r.underline || hex(r.color) !== hex(r.orig.color)
      || ["family", "bold", "italic"].some(k => r.font[k] !== r.orig.font[k]);
    paint(r); syncBar(); syncCount();
  }
  function revert(r) {
    Object.assign(r, { text: r.orig.text, font: { ...r.orig.font }, size: r.orig.size, color: r.orig.color, underline: false, changed: false });
    r.node.textContent = r.text;
    paint(r); syncBar(); syncCount();
  }

  input.addEventListener("change", async () => {
    file = input.files?.[0]; if (!file) return;
    runs.length = 0; pageStates.length = 0; ocrQueue.length = 0; pagesBox.replaceChildren(); out.replaceChildren(); active = null; syncBar(); syncCount();
    say(s, "Reading pages…");
    try {
      bytes = await h.readBytes(file);
      await core.info(lib, bytes);
      if (doc) await doc.destroy();
      doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise
        .catch(e => { throw new core.ToolkitError(e?.name === "PasswordException" ? "This PDF is password-protected. Unlock it first." : "This file could not be read as a PDF."); });
      for (let n = 1; n <= doc.numPages; n++) await drawPage(n);
      // pages that are pictures of text are read now, so every line is a field like any other
      let read = 0;
      if (ocrQueue.length) read = await ocrPages(ocrQueue.splice(0).map(st => { st.ocrDone = true; return st; }), { skipCovered: false });
      if (!runs.length) return say(s, h.loadOcr ? "No text was found on these pages, even in their pictures." : "This PDF has no text layer, and the text reader isn't available here.", "bad");
      say(s, `${doc.numPages} page${doc.numPages === 1 ? "" : "s"}, ${runs.length} lines of text${read ? ` (${read} read from pictures — check them, a reader can misread a letter)` : ""}. Every box is editable: click and type.`);
    } catch (e) { doc = null; fail(s, e); }
  });

  async function drawPage(n) {
    const page = await doc.getPage(n);
    const v1 = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: SCALE });
    const canvas = el("canvas", { class: "pt-ed-canvas", width: Math.ceil(vp.width), height: Math.ceil(vp.height), "aria-hidden": "true" });
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const content = await page.getTextContent();
    const layer = el("div", { class: "pt-ed-layer pt-tx-layer", "data-page": n - 1 });
    const wrap = el("figure", { class: "pt-ed-page", "data-pt-ed-page": n, style: `aspect-ratio: ${v1.width} / ${v1.height}` },
      canvas, layer, el("figcaption", { class: "pt-muted" }, `Page ${n}`));
    new ResizeObserver(() => layer.style.setProperty("--pt-k", String(layer.clientWidth / v1.width))).observe(layer);
    const state = { canvas, ctx, v1, layer, n, ocrDone: false };
    pageStates.push(state);
    const vs = Math.hypot(v1.transform[0], v1.transform[1]) || 1;   // shown points per PDF unit
    // ⭐ A203 (4) (owner 11-13: "as i upload a pdf, it recognises the text and makes fields around the text blocks indicating
    // editable" — PDFfiller): pdf.js's pieces of one line are joined into ONE field (same baseline, same size, close
    // together), so a line edits as a line.
    const pieces = [];
    for (const it of content.items) {
      if (!it.str || !it.str.trim()) continue;
      const m = pdfjs.Util.transform(v1.transform, it.transform);
      pieces.push({ it, m, hgt: Math.hypot(m[2], m[3]) || it.height || 10, angle: Math.atan2(m[1], m[0]), len: (it.width || 0) * vs });
    }
    pieces.sort((a, b) => (Math.abs(a.m[5] - b.m[5]) < Math.min(a.hgt, b.hgt) * 0.3 ? a.m[4] - b.m[4] : a.m[5] - b.m[5]));
    const lines = [];
    for (const p of pieces) {
      const cur = lines[lines.length - 1];
      const last = cur?.parts[cur.parts.length - 1];
      const joins = cur && !p.angle && !last.angle && Math.abs(p.m[5] - last.m[5]) < Math.min(p.hgt, last.hgt) * 0.3
        && Math.abs(p.hgt - last.hgt) < Math.max(p.hgt, last.hgt) * 0.15 && p.m[4] - (last.m[4] + last.len) < p.hgt * 1.2 && p.m[4] >= last.m[4];
      if (joins) cur.parts.push(p); else lines.push({ parts: [p] });
    }
    for (const line of lines) {
      const first = line.parts[0], lastP = line.parts[line.parts.length - 1];
      let text = "";
      line.parts.forEach((p, i) => {
        if (i) { const prev = line.parts[i - 1]; if (p.m[4] - (prev.m[4] + prev.len) > p.hgt * 0.18 && !/\s$/.test(text) && !/^\s/.test(p.it.str)) text += " "; }
        text += p.it.str;
      });
      let fontObj = {};
      try { fontObj = page.commonObjs.has(first.it.fontName) ? page.commonObjs.get(first.it.fontName) : {}; } catch { fontObj = {}; }
      const size = Math.hypot(first.it.transform[2], first.it.transform[3]) || first.it.height || 10;   // PDF points
      makeRun(state, {
        x: first.m[4], baseline: first.m[5], hgt: first.hgt, angle: first.angle, len: lastP.m[4] + lastP.len - first.m[4],
        transform: first.it.transform, width: (lastP.m[4] + lastP.len - first.m[4]) / vs, height: first.it.height || size, size,
        text, font: faceOf(fontObj.name || first.it.fontName, fontObj),
      });
    }
    page.cleanup();
    pagesBox.append(wrap);
    // a page with no text layer is a picture of text (a scan, a flattened export): read it now (OCR), in this browser
    if (!lines.length && h.loadOcr) ocrQueue.push(state);
  }

  /** One editable field: its box over the page, its state, its colours from the drawn pixels under it. */
  function makeRun(state, spec) {
    const { canvas, ctx, v1, layer, n } = state;
    const cx = Math.max(0, Math.floor(spec.x * SCALE)), cy = Math.max(0, Math.floor((spec.baseline - spec.hgt) * SCALE));
    const cw = Math.max(1, Math.min(canvas.width - cx, Math.ceil(spec.len * SCALE) || 1)), ch = Math.max(1, Math.min(canvas.height - cy, Math.ceil(spec.hgt * 1.25 * SCALE)));
    let colors = { ink: [0, 0, 0], bg: [1, 1, 1] };
    try { colors = sampleColors(ctx.getImageData(cx, cy, cw, ch).data, cw, ch); } catch { /* a tainted or empty area */ }
    const r = {
      page: n - 1, transform: spec.transform, width: spec.width, height: spec.height, k: spec.hgt / spec.size, size: spec.size,
      text: spec.text, font: spec.font, color: colors.ink, bg: colors.bg, underline: false, changed: false, ocr: !!spec.ocr,
      box: { x: spec.x, top: spec.baseline - spec.hgt, w: spec.len, h: spec.hgt },
    };
    r.orig = { text: r.text, font: { ...r.font }, size: r.size, color: r.color };
    const box = el("span", { class: `pt-tx${r.ocr ? " pt-tx--ocr" : ""}`, contenteditable: "plaintext-only", spellcheck: "false", role: "textbox",
      "aria-label": `${r.ocr ? "Text read from the picture" : "Text"}: ${spec.text.slice(0, 40)}`, "data-run": runs.length, "data-ocr": r.ocr ? "true" : null });
    box.textContent = spec.text;
    Object.assign(box.style, { left: `${(spec.x / v1.width) * 100}%`, top: `${((spec.baseline - spec.hgt * 0.88) / v1.height) * 100}%`,
      minWidth: `${(spec.len / v1.width) * 100}%`, transform: spec.angle ? `rotate(${spec.angle}rad)` : "", transformOrigin: "0 88%" });
    box.addEventListener("focus", () => { active = r; syncBar(); });
    box.addEventListener("input", () => {
      r.text = box.textContent.replace(/\n/g, " ");
      r.changed = r.changed || r.text !== r.orig.text;
      if (r.text === r.orig.text && !r.underline && r.size === r.orig.size) setStyle({});
      paint(r); syncCount();
    });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); box.blur(); }
      if (e.key === "Escape") { e.preventDefault(); revert(r); box.blur(); }
    });
    r.node = box;
    paint(r);
    runs.push(r);
    layer.append(box);
    return r;
  }

  // ── OCR in the loop (A203 (4), owner 11-13: "add ocr into the loop to make it possible"): text that is part of a picture ──
  const ocrQueue = [];
  const OCR_SCALE = 2.5;
  async function ocrPages(states, { skipCovered = true } = {}) {
    if (!h.loadOcr || !states.length) return 0;
    say(s, "Loading the text reader (once — about 15 MB)…");
    const { createWorker, workerOptions } = await h.loadOcr();
    const worker = await createWorker("eng", 1, workerOptions);
    let found = 0;
    try {
      for (const [i, st] of states.entries()) {
        say(s, `Reading the text in page ${st.n}'s pictures (${i + 1} of ${states.length})…`);
        const page = await doc.getPage(st.n);
        const vp = page.getViewport({ scale: OCR_SCALE });
        const c = el("canvas", { width: Math.ceil(vp.width), height: Math.ceil(vp.height) });
        const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: g, viewport: vp }).promise;
        page.cleanup();
        const { data } = await worker.recognize(c, {}, { blocks: true });
        const taken = runs.filter(r => r.page === st.n - 1).map(r => r.box);
        for (const block of data.blocks || []) for (const para of block.paragraphs || []) for (const line of para.lines || []) {
          const words = (line.words || []).filter(w => (w.text || "").trim() && (w.confidence ?? 100) >= 35);
          if (!words.length) continue;
          const text = words.map(w => w.text).join(" ");
          const x0 = Math.min(...words.map(w => w.bbox.x0)) / OCR_SCALE, x1 = Math.max(...words.map(w => w.bbox.x1)) / OCR_SCALE;
          const y0 = Math.min(...words.map(w => w.bbox.y0)) / OCR_SCALE, y1 = Math.max(...words.map(w => w.bbox.y1)) / OCR_SCALE;
          // Tesseract's own baseline and row height for the line (word boxes miss the ascender / descender room)
          const ra = line.rowAttributes || {};
          const rowH = Number(ra.row_height) > 0 ? ra.row_height / OCR_SCALE : (y1 - y0) / 0.75;
          const bl = line.baseline && Number.isFinite(line.baseline.y0) ? ((line.baseline.y0 + line.baseline.y1) / 2) / OCR_SCALE : y1 - (y1 - y0) * 0.12;
          const hgt = Math.max(4, rowH * 0.95), baseline = bl;
          // a line the PDF already carries as text (found again in a picture-and-text page) keeps its real field
          if (skipCovered && taken.some(b => Math.min(b.x + b.w, x1) - Math.max(b.x, x0) > (x1 - x0) * 0.5 && Math.min(b.top + b.h, y1) - Math.max(b.top, y0) > (y1 - y0) * 0.5)) continue;
          // its place in PDF user space: the baseline's two ends on the SHOWN page, converted back
          const [ax, ay] = st.v1.convertToPdfPoint(x0, baseline), [bx, by] = st.v1.convertToPdfPoint(x1, baseline);
          const ul = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / ul, uy = (by - ay) / ul;
          const size = hgt / (Math.hypot(st.v1.transform[0], st.v1.transform[1]) || 1);
          // the face, and its size fitted from the line's width (more exact than the row height)
          const guess = guessFace(c, text, { x0, x1, y0, y1, baseline, hgt });
          const shownSize = guess.size || hgt, k = Math.hypot(st.v1.transform[0], st.v1.transform[1]) || 1;
          const fitted = shownSize / k;
          makeRun(st, { x: x0, baseline, hgt: shownSize, angle: 0, len: x1 - x0, transform: [fitted * ux, fitted * uy, -fitted * uy, fitted * ux, ax, ay],
            width: ul, height: fitted, size: fitted, text, font: guess.font, ocr: true });
          found++;
        }
      }
    } finally { await worker.terminate(); }
    return found;
  }
  /**
   * The closest standard face for a line read from a picture: the line is drawn in each candidate (sans / serif / mono,
   * regular and bold), stretched to the line's width, and the one whose ink overlaps the picture's ink most is chosen.
   */
  function guessFace(c, text, box) {
    const S = OCR_SCALE, fallback = { font: { family: "sans", bold: false, italic: false }, size: null };
    const x = Math.max(0, Math.floor(box.x0 * S) - 3), w = Math.max(4, Math.ceil((box.x1 - box.x0) * S) + 6);
    const top = Math.max(0, Math.floor((box.baseline - box.hgt * 1.15) * S)), h = Math.max(4, Math.ceil(box.hgt * 1.5 * S));
    let crop;
    try { crop = c.getContext("2d").getImageData(x, top, w, h).data; } catch { return fallback; }
    let sum = 0; for (let i = 0; i < crop.length; i += 4) sum += crop[i] + crop[i + 1] + crop[i + 2];
    const mean = sum / (crop.length / 4) / 3;
    const ink = new Uint8Array(w * h); let inkN = 0;
    for (let i = 0, k = 0; i < crop.length; i += 4, k++) if ((crop[i] + crop[i + 1] + crop[i + 2]) / 3 < mean * 0.7) { ink[k] = 1; inkN++; }
    if (!inkN) return fallback;
    const t = el("canvas", { width: w, height: h }); const g = t.getContext("2d", { willReadFrequently: true });
    const lineW = (box.x1 - box.x0) * S;
    let best = null;
    for (const family of ["sans", "serif", "mono"]) for (const bold of [false, true]) {
      const face = `${bold ? "700" : "400"} 100px ${CSS_FACE[family]}`;
      g.font = face;
      const natural = g.measureText(text).width || 1;
      const px = (lineW * 100) / natural;                       // the size at which THIS face is as wide as the line
      if (px < box.hgt * S * 0.45 || px > box.hgt * S * 2) continue;   // not a plausible size for this line
      g.clearRect(0, 0, w, h);
      g.font = `${bold ? "700" : "400"} ${px}px ${CSS_FACE[family]}`;
      g.fillStyle = "#000"; g.textBaseline = "alphabetic";
      g.fillText(text, box.x0 * S - x, box.baseline * S - top);
      const d = g.getImageData(0, 0, w, h).data;
      let both = 0, any = 0;
      for (let k = 0; k < w * h; k++) { const a = d[k * 4 + 3] > 110 ? 1 : 0; if (a && ink[k]) both++; if (a || ink[k]) any++; }
      const score = any ? both / any : 0;
      if (!best || score > best.score) best = { family, bold, score, px };
    }
    if (!best) return fallback;
    return { font: { family: best.family, bold: best.bold, italic: false }, size: best.px / S };   // shown points
  }

  const findInPictures = el("button", { type: "button", class: "pt-sbx", "data-pt-tx-ocr": true, onclick: async () => {
    if (!doc) return say(s, "Choose a PDF first.", "bad");
    if (!h.loadOcr) return say(s, "The text reader is not available on this page.", "bad");
    findInPictures.disabled = true;
    try {
      const n = await ocrPages(pageStates.filter(st => !st.ocrDone).map(st => { st.ocrDone = true; return st; }));
      say(s, n ? `Found ${n} more line${n === 1 ? "" : "s"} of text in the pictures — click any of them to edit. Read them through: a reader can misread a letter.` : "No more text was found in the pictures.", n ? "good" : "");
    } catch (e) { fail(s, e); } finally { findInPictures.disabled = false; }
  } }, "Find text in pictures (OCR)");

  // ── save: the changes written into the PDF ──
  const save = el("button", { type: "button", class: "pt-sbx pt-sbx--p", "data-pt-tx-save": true, onclick: async () => {
    if (!bytes) return say(s, "Choose a PDF first.", "bad");
    const changed = changedRuns();
    if (!changed.length) return say(s, "Nothing changed yet — click any text on the page and type.", "bad");
    out.replaceChildren(); save.disabled = true; say(s, "Writing the changes into the PDF…");
    try {
      const pick = (r) => ({ page: r.page, transform: r.transform, width: r.width, height: r.height, text: r.text, font: r.font, color: r.color, bg: r.bg,
        size: r.size, underline: r.underline, cover: r.ocr });
      const pagesTouched = new Set(changed.map(r => r.page));
      const others = runs.filter(r => !r.changed && !r.ocr && pagesTouched.has(r.page)).map(r => ({ ...pick(r), text: r.orig.text }));
      const res = await core.applyTextEdits(lib, bytes, changed.map(pick), others);
      h.download(out, res.bytes, `${h.base(file.name)}-edited.pdf`);
      const fromPics = changed.filter(r => r.ocr).length, stuck = Math.max(0, res.covered - fromPics);
      say(s, `${changed.length} line${changed.length === 1 ? "" : "s"} changed in the PDF, the new words real text.`
        + (changed.length - fromPics - stuck > 0 ? " Their old words are gone from the file." : "")
        + (fromPics ? ` ${fromPics} ${fromPics === 1 ? "was" : "were"} read from a picture, so the picture's words are covered with its own paper colour.` : "")
        + (stuck ? ` ${stuck} couldn't be taken out of the page, so ${stuck === 1 ? "it was" : "they were"} covered the same way.` : ""), "good");
    } catch (e) { fail(s, e); } finally { save.disabled = false; }
  } }, "Save the PDF");

  // ── the other road: the text as a document in the résumé editor ──
  const toEditor = el("button", { type: "button", class: "pt-sbx", "data-pt-tx-to-editor": true, onclick: async () => {
    if (!doc) return say(s, "Choose a PDF first.", "bad");
    try {
      const pages = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const pg = await doc.getPage(n);
        pages.push({ lines: linesOf((await pg.getTextContent()).items) });
        pg.cleanup();
      }
      // a scan has no text layer: its lines read by OCR are the document's text instead
      if (!pages.some(p => p.lines.length)) runs.forEach(r => { (pages[r.page] ||= { lines: [] }).lines.push({ text: r.text, size: r.size, y: -r.box.top }); });
      pages.forEach(p => p.lines.sort((a, b) => b.y - a.y));
      const html = docHtmlOf(blocksOf(pages), { title: h.base(file.name) });
      sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ html, filename: `${h.base(file.name)}.html` }));
      location.href = "/editor/";
    } catch (e) { fail(s, e); }
  } }, "Open in the résumé editor");

  syncBar();
  return [el("div", { class: "pt-sb", "data-pt-sandbox": true },
    el("p", { class: "pt-sb-note" }, "Click any text on the page and type — it changes where it is. Enter to finish a line, Esc to undo it."),
    el("label", { class: "pt-field" }, "PDF", input),
    toolbar, pagesBox,
    el("div", { class: "pt-sb-actions" }, save, findInPictures, toEditor,
      el("span", { class: "pt-muted" }, "Open in the résumé editor: the text as a document with every option (sections, lists, margins) — the editor's layout, not the PDF's.")),
    s, out)];
}
