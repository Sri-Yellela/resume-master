// ── PDF toolkit · ONE document session (D189 P2, owner 11-13: "approved, build P2") ─────────────────────────────────────
//
// Everything a PDF needs while it is being worked on, in one place, used by the workspace (src/workspace/) AND by the
// toolkit's Edit tab (textEditor.js) — built once:
//   · the pages, drawn by pdf.js into `pagesEl` (one <figure> per page: the drawn canvas + a layer for fields and items)
//   · FIELDS — every line of the page's own text, editable in place (A203 (2)); pdf.js's pieces of a line joined into one
//     field (A203 (4)); lines inside pictures read by OCR (Tesseract, in the browser) and made fields too; each field knows
//     the PDF's own font name, so the closest standard face can be DISCLOSED ("Times for Garamond" — D188 (4))
//   · ITEMS — what the person places on a page (Fill & sign): signature / initials (vector, sign.js), a text box, the date,
//     ✓, ✗, a white-out box, a picture — dragged, resized, removed
//   · ONE HISTORY — undo / redo across fields and items
//   · save() — the text edits first (core.applyTextEdits: the old words leave the stream; OCR lines are covered), then the
//     items (core.applyEdits) — one PDF.
// Events: on("active", field | item | null) · on("change") · on("status", message, kind) · on("pages").
// ⭐ Nothing leaves this browser.

export const FACES = [["sans", "Sans (Helvetica)"], ["serif", "Serif (Times)"], ["mono", "Mono (Courier)"]];
export const CSS_FACE = { sans: "Helvetica, Arial, sans-serif", serif: "'Times New Roman', Times, serif", mono: "'Courier New', Courier, monospace" };
const STD_NAME = { sans: "Helvetica", serif: "Times", mono: "Courier" };
const SCALE = 1.6, OCR_SCALE = 2.5;

/** pdf.js's font object → { family, bold, italic } of the closest standard face. */
export function faceOf(name = "", f = {}) {
  const n = String(name || f.name || "");
  const family = f.isMonospace || /mono|courier|consol/i.test(n) ? "mono"
    : f.isSerifFont || /times|serif|georgia|garamond|cambria|book|minion|palat/i.test(n) && !/sans/i.test(n) ? "serif" : "sans";
  return { family, bold: !!f.bold || /bold|black|heavy|semibold|demi/i.test(n), italic: !!f.italic || /italic|oblique/i.test(n) };
}
/** A PDF font name as a person reads it: "ABCDEF+Calibri-Bold" → "Calibri Bold". */
export function readableFont(name = "") {
  return String(name || "").replace(/^[A-Z]{6}\+/, "").replace(/[-_,]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\b(MT|PS|Std|Pro)\b/g, "").replace(/\s+/g, " ").trim();
}
/** "Times for Garamond" — the standard face drawn in place of the PDF's own; null when they are the same family. */
export function substitution(font, pdfFont) {
  if (!pdfFont || /^g_d\d|^f\d+$/i.test(String(pdfFont))) return null;   // pdf.js's internal id, not a font name
  const orig = readableFont(pdfFont);
  if (!orig) return null;
  const std = STD_NAME[font.family];
  if (new RegExp(`^${std}`, "i").test(orig) || (std === "Times" && /^Times/i.test(orig)) || (std === "Helvetica" && /^(Helvetica|Arial)/i.test(orig))) return null;
  return `${std} for ${orig}`;
}

/** The run's ink and paper from the drawn page: the paper is the commonest edge colour, the ink the pixel farthest from it. */
export function sampleColors(data, w, h) {
  if (!w || !h) return { ink: [0, 0, 0], bg: [1, 1, 1] };
  const px = (x, y) => { const i = (y * w + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
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
export const hex = (c) => `#${c.map(v => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
export const rgbOf = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const snap = (f) => ({ text: f.text, font: { ...f.font }, size: f.size, color: f.color.slice(), underline: !!f.underline });

/**
 * @param o  { el, lib, pdfjs, core, loadOcr?, linesOf, blocksOf, docHtmlOf, svgNode? }
 */
export function createPdfSession(o) {
  const { el, lib, pdfjs, core } = o;
  const pagesEl = el("div", { class: "pt-ed-pages pt-tx-pages", "data-pt-tx-pages": true });
  const fields = [], items = [], pages = [], ocrQueue = [];
  const handlers = {};
  const emit = (ev, ...a) => (handlers[ev] || []).forEach(fn => fn(...a));
  const undoStack = [], redoStack = [];
  let bytes = null, name = "document.pdf", doc = null, active = null, nextId = 1, armed = null;

  const record = (op) => { undoStack.push(op); redoStack.length = 0; emit("change"); };

  // ── fields: the page's own text ──
  function paint(f) {
    const b = f.node;
    b.classList.toggle("pt-tx--changed", !!f.changed);
    b.style.fontFamily = CSS_FACE[f.font.family];
    b.style.fontWeight = f.font.bold ? "700" : "400";
    b.style.fontStyle = f.font.italic ? "italic" : "normal";
    b.style.textDecoration = f.underline ? "underline" : "none";
    b.style.fontSize = `calc(var(--pt-k, 1) * ${f.size * f.k}px)`;
    b.style.color = f.changed ? hex(f.color) : "transparent";
    b.style.background = f.changed ? hex(f.bg) : "transparent";
    if (b.textContent !== f.text && document.activeElement !== b) b.textContent = f.text;
  }
  const isChanged = (f) => f.text !== f.orig.text || f.size !== f.orig.size || !!f.underline || hex(f.color) !== hex(f.orig.color)
    || ["family", "bold", "italic"].some(k => f.font[k] !== f.orig.font[k]);
  function restore(f, st) { Object.assign(f, { text: st.text, font: { ...st.font }, size: st.size, color: st.color.slice(), underline: st.underline }); f.changed = isChanged(f); f.node.textContent = f.text; paint(f); }
  function setStyle(p) {
    const f = active; if (!f || f.kind !== "field") return;
    const before = snap(f);
    if (p.family != null) f.font = { ...f.font, family: p.family };
    if (p.bold != null) f.font = { ...f.font, bold: p.bold };
    if (p.italic != null) f.font = { ...f.font, italic: p.italic };
    if (p.size != null) f.size = p.size;
    if (p.color) f.color = p.color;
    if (p.underline != null) f.underline = p.underline;
    f.changed = isChanged(f); paint(f);
    record({ undo: () => restore(f, before), redo: () => restore(f, snap(f)) && 0, field: f, after: snap(f) });
    emit("active", f);
  }
  function revert(f) { const before = snap(f); restore(f, f.orig); record({ undo: () => restore(f, before), redo: () => restore(f, f.orig) }); emit("active", f); }

  function makeField(state, spec) {
    const { canvas, ctx, v1, layer, n } = state;
    const cx = Math.max(0, Math.floor(spec.x * SCALE)), cy = Math.max(0, Math.floor((spec.baseline - spec.hgt) * SCALE));
    const cw = Math.max(1, Math.min(canvas.width - cx, Math.ceil(spec.len * SCALE) || 1)), ch = Math.max(1, Math.min(canvas.height - cy, Math.ceil(spec.hgt * 1.25 * SCALE)));
    let colors = { ink: [0, 0, 0], bg: [1, 1, 1] };
    try { colors = sampleColors(ctx.getImageData(cx, cy, cw, ch).data, cw, ch); } catch { /* a tainted or empty area */ }
    const f = {
      kind: "field", id: nextId++, page: n - 1, transform: spec.transform, width: spec.width, height: spec.height, k: spec.hgt / spec.size, size: spec.size,
      text: spec.text, font: spec.font, pdfFont: spec.pdfFont || null, color: colors.ink, bg: colors.bg, underline: false, changed: false, ocr: !!spec.ocr,
      box: { x: spec.x, top: spec.baseline - spec.hgt, w: spec.len, h: spec.hgt },
    };
    f.orig = snap(f);
    const box = el("span", { class: `pt-tx${f.ocr ? " pt-tx--ocr" : ""}`, contenteditable: "plaintext-only", spellcheck: "false", role: "textbox",
      "aria-label": `${f.ocr ? "Text read from the picture" : "Text"}: ${spec.text.slice(0, 40)}`, "data-run": fields.length, "data-ocr": f.ocr ? "true" : null });
    box.textContent = spec.text;
    Object.assign(box.style, { left: `${(spec.x / v1.width) * 100}%`, top: `${((spec.baseline - spec.hgt * 0.88) / v1.height) * 100}%`,
      minWidth: `${(spec.len / v1.width) * 100}%`, transform: spec.angle ? `rotate(${spec.angle}rad)` : "", transformOrigin: "0 88%" });
    let atFocus = null;
    box.addEventListener("focus", () => { active = f; atFocus = snap(f); emit("active", f); });
    box.addEventListener("input", () => { f.text = box.textContent.replace(/\n/g, " "); f.changed = isChanged(f); paint(f); emit("change"); });
    box.addEventListener("blur", () => {
      if (atFocus && atFocus.text !== f.text) { const before = atFocus, after = snap(f); undoStack.push({ undo: () => restore(f, before), redo: () => restore(f, after) }); redoStack.length = 0; emit("change"); }
      atFocus = null;
    });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); box.blur(); }
      if (e.key === "Escape") { e.preventDefault(); revert(f); box.blur(); }
    });
    f.node = box;
    paint(f);
    fields.push(f);
    layer.append(box);
    return f;
  }

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
    const state = { canvas, ctx, v1, layer, wrap, n, ocrDone: false, rotate: page.rotate || 0, size: [v1.width, v1.height] };
    pages.push(state);
    layer.addEventListener("click", (e) => {
      if (!armed || e.target !== layer) return;
      const r = layer.getBoundingClientRect();
      place(armed.kind, n - 1, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, armed.payload);
    });
    const vs = Math.hypot(v1.transform[0], v1.transform[1]) || 1;
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
      const size = Math.hypot(first.it.transform[2], first.it.transform[3]) || first.it.height || 10;
      makeField(state, {
        x: first.m[4], baseline: first.m[5], hgt: first.hgt, angle: first.angle, len: lastP.m[4] + lastP.len - first.m[4],
        transform: first.it.transform, width: (lastP.m[4] + lastP.len - first.m[4]) / vs, height: first.it.height || size, size,
        text, font: faceOf(fontObj.name || first.it.fontName, fontObj), pdfFont: fontObj.name || null,
      });
    }
    page.cleanup();
    pagesEl.append(wrap);
    if (!lines.length && o.loadOcr) ocrQueue.push(state);
  }

  // ── OCR: text that is part of a picture ──
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
      g.font = `${bold ? "700" : "400"} 100px ${CSS_FACE[family]}`;
      const natural = g.measureText(text).width || 1;
      const px = (lineW * 100) / natural;
      if (px < box.hgt * S * 0.45 || px > box.hgt * S * 2) continue;
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
    return { font: { family: best.family, bold: best.bold, italic: false }, size: best.px / S };
  }
  async function ocrPages(states, { skipCovered = true } = {}) {
    if (!o.loadOcr || !states.length) return 0;
    emit("status", "Loading the text reader (once — about 15 MB)…");
    const { createWorker, workerOptions } = await o.loadOcr();
    const worker = await createWorker("eng", 1, workerOptions);
    let found = 0;
    try {
      for (const [i, st] of states.entries()) {
        st.ocrDone = true;
        emit("status", `Reading the text in page ${st.n}'s pictures (${i + 1} of ${states.length})…`);
        const page = await doc.getPage(st.n);
        const vp = page.getViewport({ scale: OCR_SCALE });
        const c = el("canvas", { width: Math.ceil(vp.width), height: Math.ceil(vp.height) });
        const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: g, viewport: vp }).promise;
        page.cleanup();
        const { data } = await worker.recognize(c, {}, { blocks: true });
        const taken = fields.filter(f => f.page === st.n - 1).map(f => f.box);
        for (const block of data.blocks || []) for (const para of block.paragraphs || []) for (const line of para.lines || []) {
          const words = (line.words || []).filter(w => (w.text || "").trim() && (w.confidence ?? 100) >= 35);
          if (!words.length) continue;
          const text = words.map(w => w.text).join(" ");
          const x0 = Math.min(...words.map(w => w.bbox.x0)) / OCR_SCALE, x1 = Math.max(...words.map(w => w.bbox.x1)) / OCR_SCALE;
          const y0 = Math.min(...words.map(w => w.bbox.y0)) / OCR_SCALE, y1 = Math.max(...words.map(w => w.bbox.y1)) / OCR_SCALE;
          const ra = line.rowAttributes || {};
          const rowH = Number(ra.row_height) > 0 ? ra.row_height / OCR_SCALE : (y1 - y0) / 0.75;
          const baseline = line.baseline && Number.isFinite(line.baseline.y0) ? ((line.baseline.y0 + line.baseline.y1) / 2) / OCR_SCALE : y1 - (y1 - y0) * 0.12;
          const hgt = Math.max(4, rowH * 0.95);
          if (skipCovered && taken.some(b => Math.min(b.x + b.w, x1) - Math.max(b.x, x0) > (x1 - x0) * 0.5 && Math.min(b.top + b.h, y1) - Math.max(b.top, y0) > (y1 - y0) * 0.5)) continue;
          const [ax, ay] = st.v1.convertToPdfPoint(x0, baseline), [bx, by] = st.v1.convertToPdfPoint(x1, baseline);
          const ul = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / ul, uy = (by - ay) / ul;
          const guess = guessFace(c, text, { x0, x1, y0, y1, baseline, hgt });
          const shown = guess.size || hgt, k = Math.hypot(st.v1.transform[0], st.v1.transform[1]) || 1, size = shown / k;
          makeField(st, { x: x0, baseline, hgt: shown, angle: 0, len: x1 - x0, transform: [size * ux, size * uy, -size * uy, size * ux, ax, ay],
            width: ul, height: size, size, text, font: guess.font, ocr: true });
          found++;
        }
      }
    } finally { await worker.terminate(); }
    return found;
  }

  // ── items: what the person places (Fill & sign) ──
  const ITEM_SIZE = { signature: [160, null], initials: [60, null], text: [180, 18], date: [130, 18], name: [180, 18], check: [14, 14], cross: [14, 14], whiteout: [120, 18], image: [140, null] };
  function place(kind, page, fx, fy, payload = {}) {
    const st = pages[page]; if (!st) return null;
    const [W, H] = st.size;
    let [wPts, hPts] = ITEM_SIZE[kind] || [120, 18];
    if (kind === "signature" || kind === "initials") hPts = wPts * payload.sig.height / payload.sig.width;
    if (kind === "image") hPts = wPts * (payload.ratio || 1);
    const it = { kind: "item", type: kind, id: nextId++, page, fw: Math.min(0.9, wPts / W), fh: Math.min(0.9, hPts / H), payload,
      text: kind === "date" ? new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : "", size: 12 };
    it.fx = clamp(fx - it.fw / 2, 0, 1 - it.fw); it.fy = clamp(fy - it.fh / 2, 0, 1 - it.fh);
    drawItem(it);
    record({ undo: () => unplace(it), redo: () => { items.push(it); st.layer.append(it.node); } });
    if (kind === "image") armed = null;
    return it;
  }
  function unplace(it) { const i = items.indexOf(it); if (i >= 0) items.splice(i, 1); it.node?.remove(); if (active === it) { active = null; emit("active", null); } emit("change"); }
  function removeItem(it) { unplace(it); const layer = pages[it.page].layer; undoStack.push({ undo: () => { items.push(it); layer.append(it.node); emit("change"); }, redo: () => unplace(it) }); redoStack.length = 0; }
  function drawItem(it) {
    const layer = pages[it.page].layer;
    const box = el("div", { class: `pt-ed-item pt-ed-item--${it.type}`, tabindex: "0", "data-item": it.id, "aria-label": `${it.type} — drag to move, Delete to remove` });
    const pos = () => Object.assign(box.style, { left: `${it.fx * 100}%`, top: `${it.fy * 100}%`, width: `${it.fw * 100}%`, height: `${it.fh * 100}%` });
    pos(); it.pos = pos;
    if (it.type === "signature" || it.type === "initials") box.append(o.svgNode(it.payload.sig, "pt-ed-sig"));
    else if (it.type === "image") box.append(el("img", { src: it.payload.url, alt: "" }));
    else if (it.type === "check" || it.type === "cross") box.append(el("span", { class: "pt-ed-mark" }, it.type === "check" ? "✓" : "✗"));
    else if (it.type !== "whiteout") {
      const ta = el("textarea", { class: "pt-ed-text", rows: "1", placeholder: it.type === "name" ? "Your name" : "Type here", "aria-label": "Text on the page" });
      ta.value = it.text;
      ta.style.fontSize = `calc(var(--pt-k, 1) * ${it.size}px)`;
      ta.addEventListener("input", () => { it.text = ta.value; emit("change"); });
      box.append(ta);
      if (!it.text) setTimeout(() => ta.focus(), 0);
    }
    box.append(el("button", { type: "button", class: "pt-ed-x", "aria-label": "Remove", onclick: () => removeItem(it) }, "✕"),
      el("span", { class: "pt-ed-resize", "aria-hidden": "true" }));
    box.addEventListener("focusin", () => { active = it; emit("active", it); });
    box.addEventListener("keydown", (e) => {
      if (e.target !== box) return;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeItem(it); }
      const step = e.shiftKey ? 0.02 : 0.004;
      const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (mv) { e.preventDefault(); it.fx = clamp(it.fx + mv[0], 0, 1 - it.fw); it.fy = clamp(it.fy + mv[1], 0, 1 - it.fh); pos(); emit("change"); }
    });
    box.addEventListener("pointerdown", (e) => {
      if (e.target.closest("textarea, button")) return;
      e.preventDefault(); box.focus();
      const resizing = e.target.classList.contains("pt-ed-resize");
      const r = layer.getBoundingClientRect();
      const start = { x: e.clientX, y: e.clientY, fx: it.fx, fy: it.fy, fw: it.fw, fh: it.fh };
      const keep = ["signature", "initials", "image", "check", "cross"].includes(it.type);
      box.setPointerCapture(e.pointerId);
      const move = (m) => {
        const dx = (m.clientX - start.x) / r.width, dy = (m.clientY - start.y) / r.height;
        if (resizing) {
          it.fw = clamp(start.fw + dx, 0.015, 1 - it.fx);
          it.fh = keep ? Math.min(1 - it.fy, it.fw * (start.fh / start.fw)) : clamp(start.fh + dy, 0.01, 1 - it.fy);
          if (keep) it.fw = it.fh * (start.fw / start.fh);
        } else { it.fx = clamp(start.fx + dx, 0, 1 - it.fw); it.fy = clamp(start.fy + dy, 0, 1 - it.fh); }
        pos();
      };
      const up = () => {
        box.removeEventListener("pointermove", move); box.removeEventListener("pointerup", up); box.removeEventListener("pointercancel", up);
        const after = { fx: it.fx, fy: it.fy, fw: it.fw, fh: it.fh };
        if (after.fx !== start.fx || after.fy !== start.fy || after.fw !== start.fw || after.fh !== start.fh) {
          const before = { fx: start.fx, fy: start.fy, fw: start.fw, fh: start.fh };
          record({ undo: () => { Object.assign(it, before); pos(); }, redo: () => { Object.assign(it, after); pos(); } });
        }
      };
      box.addEventListener("pointermove", move); box.addEventListener("pointerup", up); box.addEventListener("pointercancel", up);
    });
    it.node = box;
    items.push(it);
    layer.append(box);
  }

  // ── the session's surface ──
  const api = {
    pagesEl, fields, items, pages,
    get bytes() { return bytes; }, get name() { return name; }, set name(v) { name = String(v || name); },
    get active() { return active; }, get armed() { return armed; },
    get canUndo() { return undoStack.length > 0; }, get canRedo() { return redoStack.length > 0; },
    on(ev, fn) { (handlers[ev] ||= []).push(fn); return api; },
    async open(data, fileName = "document.pdf") {
      fields.length = 0; items.length = 0; pages.length = 0; ocrQueue.length = 0; undoStack.length = 0; redoStack.length = 0;
      pagesEl.replaceChildren(); active = null; armed = null; name = fileName;
      emit("status", "Reading pages…");
      bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      await core.info(lib, bytes);
      if (doc) await doc.destroy();
      doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise
        .catch(e => { throw new core.ToolkitError(e?.name === "PasswordException" ? "This PDF is password-protected. Unlock it first." : "This file could not be read as a PDF."); });
      for (let n = 1; n <= doc.numPages; n++) await drawPage(n);
      emit("pages", pages);
      let read = 0;
      if (ocrQueue.length) read = await ocrPages(ocrQueue.splice(0), { skipCovered: false });
      emit("change");
      return { pages: doc.numPages, lines: fields.length, read };
    },
    async thumbnail(n, width = 120) {
      const st = pages[n - 1]; if (!st) return null;
      const c = el("canvas", { width, height: Math.round(width * st.canvas.height / st.canvas.width) });
      c.getContext("2d").drawImage(st.canvas, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.75);
    },
    setStyle, revert,
    revertActive() { if (active?.kind === "field") revert(active); },
    arm(kind, payload) { armed = kind ? { kind, payload } : null; emit("armed", armed); },
    place, removeItem,
    undo() { const op = undoStack.pop(); if (!op) return; op.undo(); redoStack.push(op); emit("change"); if (active) emit("active", active); },
    redo() { const op = redoStack.pop(); if (!op) return; op.redo(); undoStack.push(op); emit("change"); if (active) emit("active", active); },
    async findInPictures() { return ocrPages(pages.filter(st => !st.ocrDone)); },
    changedFields() { return fields.filter(f => f.changed); },
    changeCount() { return fields.filter(f => f.changed).length + items.length; },
    /** Write every change into a new PDF: text edits first, then the placed items. */
    async save() {
      if (!bytes) throw new core.ToolkitError("Open a PDF first.");
      const changed = fields.filter(f => f.changed);
      const placed = items.filter(it => it.type !== "text" && it.type !== "name" && it.type !== "date" || String(it.text).trim());
      if (!changed.length && !placed.length) throw new core.ToolkitError("Nothing changed yet — click any text on the page, or place something from the tool bar.");
      let out = bytes, res = { removed: 0, covered: 0 };
      if (changed.length) {
        const pick = (f) => ({ page: f.page, transform: f.transform, width: f.width, height: f.height, text: f.text, font: f.font, color: f.color, bg: f.bg,
          size: f.size, underline: f.underline, cover: f.ocr });
        const touched = new Set(changed.map(f => f.page));
        const others = fields.filter(f => !f.changed && !f.ocr && touched.has(f.page)).map(f => ({ ...pick(f), text: f.orig.text }));
        res = await core.applyTextEdits(lib, out, changed.map(pick), others);
        out = res.bytes;
      }
      if (placed.length) {
        out = await core.applyEdits(lib, out, placed.map(it => {
          const at = { page: it.page, fx: it.fx, fy: it.fy, fw: it.fw, fh: it.fh };
          if (it.type === "signature" || it.type === "initials") return { ...at, kind: "svg", d: it.payload.sig.d, vbw: it.payload.sig.width, vbh: it.payload.sig.height, strokeWidth: it.payload.sig.strokeWidth || null, color: it.payload.sig.color };
          if (it.type === "image") return { ...at, kind: "image", image: it.payload.bytes };
          if (it.type === "whiteout") return { ...at, kind: "whiteout" };
          // ✓ / ✗ as vector strokes (the standard fonts carry no check mark)
          if (it.type === "check" || it.type === "cross") return { ...at, kind: "svg", d: it.type === "check" ? "M2.5 8.5L6.5 12.5L13.5 3.5" : "M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5", vbw: 16, vbh: 16, strokeWidth: 2.2 };
          return { ...at, kind: "text", text: it.text, size: it.size };
        }));
      }
      const fromPics = changed.filter(f => f.ocr).length;
      return { bytes: out, lines: changed.length, items: placed.length, fromPics, stuck: Math.max(0, res.covered - fromPics) };
    },
    /** The text as a document for the structured résumé editor ("Make this an editable résumé"). */
    async documentHtml(title) {
      const pgs = [];
      for (let n = 1; n <= doc.numPages; n++) { const pg = await doc.getPage(n); pgs.push({ lines: o.linesOf((await pg.getTextContent()).items) }); pg.cleanup(); }
      if (!pgs.some(p => p.lines.length)) fields.forEach(f => { (pgs[f.page] ||= { lines: [] }).lines.push({ text: f.text, size: f.size, y: -f.box.top }); });
      pgs.forEach(p => p.lines.sort((a, b) => b.y - a.y));
      return o.docHtmlOf(o.blocksOf(pgs), { title });
    },
    fontNote(f) { return f?.kind === "field" ? substitution(f.font, f.pdfFont) : null; },
  };
  return api;
}
