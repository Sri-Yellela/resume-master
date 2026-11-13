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
    runs.length = 0; pagesBox.replaceChildren(); out.replaceChildren(); active = null; syncBar(); syncCount();
    say(s, "Reading pages…");
    try {
      bytes = await h.readBytes(file);
      await core.info(lib, bytes);
      if (doc) await doc.destroy();
      doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise
        .catch(e => { throw new core.ToolkitError(e?.name === "PasswordException" ? "This PDF is password-protected. Unlock it first." : "This file could not be read as a PDF."); });
      for (let n = 1; n <= doc.numPages; n++) await drawPage(n);
      if (!runs.length) return say(s, "This PDF has no text to edit — it looks like a scan. OCR can make it searchable first.", "bad");
      say(s, `${doc.numPages} page${doc.numPages === 1 ? "" : "s"}, ${runs.length} lines of text. Click any text and type — it changes in place.`);
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
    for (const it of content.items) {
      if (!it.str || !it.str.trim()) continue;
      const m = pdfjs.Util.transform(v1.transform, it.transform);     // shown page, y down, scale 1
      const hgt = Math.hypot(m[2], m[3]) || it.height || 10;
      const angle = Math.atan2(m[1], m[0]);
      const len = (it.width || 0) * (Math.hypot(v1.transform[0], v1.transform[1]) || 1);
      let fontObj = {};
      try { fontObj = page.commonObjs.has(it.fontName) ? page.commonObjs.get(it.fontName) : {}; } catch { fontObj = {}; }
      // colours from the drawn pixels under this run
      const cx = Math.max(0, Math.floor(m[4] * SCALE)), cy = Math.max(0, Math.floor((m[5] - hgt) * SCALE));
      const cw = Math.max(1, Math.min(canvas.width - cx, Math.ceil(len * SCALE) || 1)), ch = Math.max(1, Math.min(canvas.height - cy, Math.ceil(hgt * 1.25 * SCALE)));
      let colors = { ink: [0, 0, 0], bg: [1, 1, 1] };
      try { colors = sampleColors(ctx.getImageData(cx, cy, cw, ch).data, cw, ch); } catch { /* a tainted or empty area */ }
      const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;   // in PDF points
      const r = {
        page: n - 1, transform: it.transform, width: it.width, height: it.height || size,
        k: hgt / size, size, text: it.str, font: faceOf(fontObj.name || it.fontName, fontObj), color: colors.ink, bg: colors.bg, underline: false, changed: false,
      };
      r.orig = { text: r.text, font: { ...r.font }, size: r.size, color: r.color };
      const box = el("span", { class: "pt-tx", contenteditable: "plaintext-only", spellcheck: "false", role: "textbox", "aria-label": `Text: ${it.str.slice(0, 40)}`, "data-run": runs.length });
      box.textContent = it.str;
      Object.assign(box.style, { left: `${(m[4] / v1.width) * 100}%`, top: `${((m[5] - hgt * 0.88) / v1.height) * 100}%`,
        minWidth: `${(len / v1.width) * 100}%`, transform: angle ? `rotate(${angle}rad)` : "", transformOrigin: "0 88%" });
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
    }
    page.cleanup();
    pagesBox.append(wrap);
  }

  // ── save: the changes written into the PDF ──
  const save = el("button", { type: "button", class: "pt-sbx pt-sbx--p", "data-pt-tx-save": true, onclick: async () => {
    if (!bytes) return say(s, "Choose a PDF first.", "bad");
    const changed = changedRuns();
    if (!changed.length) return say(s, "Nothing changed yet — click any text on the page and type.", "bad");
    out.replaceChildren(); save.disabled = true; say(s, "Writing the changes into the PDF…");
    try {
      const pick = (r) => ({ page: r.page, transform: r.transform, width: r.width, height: r.height, text: r.text, font: r.font, color: r.color, bg: r.bg,
        size: r.size, underline: r.underline });
      const pagesTouched = new Set(changed.map(r => r.page));
      const others = runs.filter(r => !r.changed && pagesTouched.has(r.page)).map(r => ({ ...pick(r), text: r.orig.text }));
      const res = await core.applyTextEdits(lib, bytes, changed.map(pick), others);
      h.download(out, res.bytes, `${h.base(file.name)}-edited.pdf`);
      say(s, `${changed.length} line${changed.length === 1 ? "" : "s"} changed in the PDF${res.covered ? ` — ${res.covered} of them were drawn in a way that can't be taken out, so they were covered with their background and rewritten` : " — the old words are gone, the new ones are real text"}.`, "good");
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
    el("div", { class: "pt-sb-actions" }, save, toEditor,
      el("span", { class: "pt-muted" }, "Open in the résumé editor: the text as a document with every option (sections, lists, margins) — the editor's layout, not the PDF's.")),
    s, out)];
}
