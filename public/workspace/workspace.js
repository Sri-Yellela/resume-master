// D189 P2 · the workspace shell (owner 11-13: "approved, build P2"). One document session (src/pdf-toolkit/session.js) in the
// approved layout: top bar · modes · tool bar · page strip · canvas + navigator · properties. Each mode swaps the tool bar;
// the layout never moves. Everything runs in this browser — the PDF is never uploaded.
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, "");
    else if (v != null && v !== false) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : String(kid));
  return n;
};
// replaceChildren writes "null" for a null child — every optional line goes through put()
const put = (box, ...kids) => box.replaceChildren(...kids.flat().filter(k => k != null && k !== false));
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const baseName = (n) => String(n || "document").replace(/\.pdf$/i, "").replace(/[^\w.-]+/g, "-").slice(0, 60) || "document";

const [lib, pdfjs, core, S, sign, editor, pdfText, pdfToDoc, render, office] = await Promise.all([
  import("/lib/pdf-lib/pdf-lib.esm.min.js"), import("/lib/pdfjs/pdf.min.mjs"), import("/lib/pdf-toolkit/core.js"),
  import("/lib/pdf-toolkit/session.js"), import("/lib/pdf-toolkit/sign.js"), import("/lib/pdf-toolkit/editor.js"),
  import("/lib/pdf-toolkit/pdfText.js"), import("/lib/pdf-toolkit/pdfToDoc.js"), import("/lib/pdf-toolkit/render.js"), import("/lib/pdf-toolkit/office.js")]);
const store = await import("/lib/pdf-toolkit/docstore.js");   // D189 P4: Recent, versions, the hand-off — this browser only
pdfjs.GlobalWorkerOptions.workerSrc = "/lib/pdfjs/pdf.worker.min.mjs";
const loadOcr = async () => {
  const { default: Tesseract } = await import("/lib/tesseract/tesseract.esm.min.js");
  const at = (p) => new URL(p, location.origin).href;
  return { createWorker: Tesseract.createWorker, workerOptions: { workerPath: at("/lib/tesseract/worker.min.js"), corePath: at("/lib/tesseract-core"), langPath: at("/lib/tessdata"), gzip: true } };
};

const session = S.createPdfSession({ el, lib, pdfjs, core, loadOcr, svgNode: editor.svgNode,
  linesOf: pdfText.linesOf, blocksOf: pdfToDoc.blocksOf, docHtmlOf: pdfToDoc.docHtmlOf });
const ws = $("[data-ws]"), zoomBox = $("#ws-zoom");
zoomBox.append(session.pagesEl);
let mode = "edit", zoom = 1, fileSize = 0, dirty = false, docId = null, autosaving = false;
let atsRefresh = null;   // the ATS panel's "where the résumé comes from" line, redrawn as the document changes (D192 (3d))
const sigs = { signature: null, initials: null };

// ── status, save state ──
const say = (m, kind = "") => { const s = $("#ws-status"); s.textContent = m || ""; s.dataset.kind = kind; };
session.on("status", (m) => say(m));
const setSaved = (t) => { $("#ws-saved").textContent = t; };
function sync() {
  $("#ws-undo").disabled = !session.canUndo; $("#ws-redo").disabled = !session.canRedo;
  atsRefresh?.();
  const n = session.changeCount();
  dirty = n > 0;
  setSaved(!session.bytes ? "" : dirty ? `${n} change${n === 1 ? "" : "s"} — not downloaded yet` : "No changes yet");
  const changed = session.changedFields();
  const pics = changed.filter(f => f.ocr).length;
  put($("#ws-changes"), ...(!session.bytes ? [] : [
    el("p", { class: "ws-lbl" }, "Changes"),
    changed.length ? el("p", { class: "ws-ok" }, `${changed.length} line${changed.length === 1 ? "" : "s"} changed${changed.length - pics ? " — the old words leave the file" : ""}`) : el("p", { class: "ws-faint" }, "No text changed"),
    pics ? el("p", { class: "ws-warn" }, `${pics} read from a picture — covered with its paper colour, then written`) : null,
    session.items.filter(i => i.type !== "redact").length ? el("p", { class: "ws-ok" }, `${session.items.filter(i => i.type !== "redact").length} item${session.items.filter(i => i.type !== "redact").length === 1 ? "" : "s"} placed`) : null,
    session.formValues().length ? el("p", { class: "ws-ok" }, `${session.formValues().length} form field${session.formValues().length === 1 ? "" : "s"} filled`) : null,
    redactCount() ? el("p", { class: "ws-warn" }, `${redactCount()} redaction${redactCount() === 1 ? "" : "s"} — the text under ${redactCount() === 1 ? "it" : "them"} leaves the file when you download`) : null,
    redactCount() ? el("label", { class: "ws-row ws-small" }, flattenBox, "Also remove pictures and drawings under them (those pages become pictures — their text is no longer selectable)") : null,
    el("p", { class: "ws-faint ws-small" }, "Solid boxes are the PDF's own text; dashed ones were read from a picture."),
  ]));
}
session.on("change", sync);
const redactCount = () => session.items.filter(i => i.type === "redact").length;
const flattenBox = el("input", { type: "checkbox", onchange: () => { session.flattenRedacted = flattenBox.checked; } });

// ── modes swap the tool bar (D189: never the layout) ──
const TOOLS = {
  edit: [["select", "⌖", "Select"], ["text", "⊞", "Text box"], ["whiteout", "⌫", "Erase"], ["image", "▣", "Image"], ["signature", "✎", "Sign"],
    ["check", "✓", "Check"], ["cross", "✗", "Cross"], ["date", "▦", "Date"], ["|"], ["redact", "■", "Redact"], ["ocr", "⌕", "Find text in pictures"]],
  sign: [["select", "⌖", "Select"], ["signature", "✎", "Signature"], ["initials", "ab", "Initials"], ["name", "Aa", "Name"], ["date", "▦", "Date"],
    ["text", "⊞", "Text"], ["check", "✓", "Check"], ["cross", "✗", "Cross"]],
  // ⭐ D188 LATER · Annotate: mark a page for review — a highlight over words, a freehand pen, a box, a note
  annotate: [["select", "⌖", "Select"], ["highlight", "▬", "Highlight"], ["ink", "✎", "Draw"], ["box", "▢", "Box"], ["text", "⊞", "Note"], ["|"], ["watermark", "◪", "Watermark"]],
  // ⭐ D189 P3: the page strip's operations, on the current page (the strip / navigator chooses it)
  pages: [["rotl", "⟲", "Rotate left"], ["rotr", "⟳", "Rotate right"], ["dup", "⧉", "Duplicate"], ["del", "✕", "Delete"],
    ["up", "↑", "Move earlier"], ["down", "↓", "Move later"], ["|"], ["blank", "▢", "Blank page"], ["addfiles", "+", "Add files"], ["split", "✂", "Split"]],
  // ⭐ D189 P3: the document as something else — each from the CURRENT document (changes included)
  convert: [["compress", "⇲", "Compress"], ["word", "W", "Word"], ["txt", "≡", "Text"], ["excel", "▦", "Excel"], ["jpg", "▣", "Images"], ["searchable", "⌕", "Searchable (OCR)"], ["protect", "⚿", "Protect"], ["|"],
    ["fromword", "W→", "From Word"], ["fromimages", "▣→", "From pictures"], ["fromhtml", "</>", "From HTML"]],
};
// ⭐ rm-audit M14: the tools that START a document — usable with nothing open (the old toolkit's Images → PDF and HTML → PDF)
const STARTERS = new Set(["fromword", "fromimages", "fromhtml"]);
// a tool page's tool → the workspace tool it opens with, once its file is open (/pdf/<tool>/ hands both over)
const TOOL_OPENS = new Map([["split", "split"], ["watermark", "watermark"], ["compress", "compress"], ["protect", "protect"], ["excel", "excel"]]);
const addFiles = el("input", { type: "file", accept: "application/pdf,image/jpeg,image/png", multiple: true, hidden: true });
document.body.append(addFiles);
addFiles.addEventListener("change", async () => {
  const files = [...(addFiles.files || [])]; addFiles.value = ""; if (!files.length) return;
  await pageOp("add", { files: await Promise.all(files.map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))) }, `${files.length} file${files.length === 1 ? "" : "s"} added at the end`);
});
async function pageOp(kind, arg, done, { rethrow = false } = {}) {
  try {
    const had = session.changeCount();
    say("Working on the pages…");
    const r = await session.editPages(kind, arg);
    if (docId) await store.addVersion(docId, session.bytes, "Pages changed");
    await drawStrip(); fitWidth(); drawTools(); sync();
    $("#ws-meta").textContent = `${r.pages} page${r.pages === 1 ? "" : "s"} · ${kb(session.bytes.length)}`;
    say(`${done}.${had ? " Your other changes were written first — undo starts again from here." : ""}`, "good");
  } catch (e) { say(e?.message || String(e), "bad"); if (rethrow) throw e; }
}
const currentBytes = async () => (session.changeCount() ? (await session.save()).bytes : session.bytes);
const nameBase = () => baseName($("#ws-name").textContent);
function downloadAs(bytes, filename, type) {
  const a = el("a", { href: URL.createObjectURL(new Blob([bytes], { type })), download: filename });
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
async function convert(id, opts = {}) {
  if (id === "fromword") { wordPick.click(); return; }   // D188 LATER: a .docx becomes a PDF, opened here
  try {
    const b = await currentBytes();
    if (id === "compress") {
      // rm-audit M11 (b): the limit is asked in the properties panel, not a native prompt()
      if (!opts.limit) return showOpts("Compress", "The form's upload limit, in MB — most accept 2 to 5.", [["limit", "number", "Upload limit (MB)", "2"]], "Compress", (v) => convert("compress", { limit: Number(v.limit) || 2 }));
      const limit = Number(opts.limit) || 2;
      say("Compressing…");
      const r = opts.flatten ? await render.flattenToImages(lib, pdfjs, b, { scale: 1.5, quality: 0.6 }).then(bytes => ({ bytes, before: b.length, after: bytes.length, note: "Every page is a picture now — its text can no longer be selected." }))
        : await core.compress(lib, b, { reencodeJpeg: render.reencodeJpegInBrowser, maxDimension: 1600, quality: 0.72 });
      const under = r.after <= limit * 1048576;
      // rm-audit M11 (c): still over → the smallest file is offered right here (it sent people to the old toolkit's Maximum)
      say(`${kb(r.before)} → ${kb(r.after)} — ${under ? `under your ${limit} MB limit` : `still over your ${limit} MB limit`}. ${r.note}`, under ? "good" : "bad");
      if (!under && !opts.flatten) showOpts("Still too big", "Make every page a picture: the smallest file, but its text can no longer be selected or read by an ATS.", [], "Make it smallest", () => convert("compress", { limit, flatten: true }));
      else hideOpts();
      return downloadAs(r.bytes, `${nameBase()}-compressed.pdf`, "application/pdf");
    }
    const pages = [];
    if (id === "word" || id === "txt" || id === "excel") {
      const d = await pdfjs.getDocument({ data: b.slice(), isEvalSupported: false }).promise;
      for (let n = 1; n <= d.numPages; n++) { const pg = await d.getPage(n); pages.push({ lines: pdfText.linesOf((await pg.getTextContent()).items) }); pg.cleanup(); }
      await d.destroy();
      if (!pages.some(p => p.lines.length)) return say("This PDF has no text layer — make it searchable (OCR) first.", "bad");
    }
    if (id === "word") {
      const { zipSync } = await import("/lib/fflate/browser.js");
      downloadAs(office.toDocx(zipSync, office.paragraphsOf(pages), { title: nameBase() }), `${nameBase()}.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      return say("Downloaded as Word — the text in reading order; fonts and pictures are not carried over.", "good");
    }
    if (id === "excel") {   // rm-audit M14: PDF → Excel, in the workspace (office.js tableOf / toXlsx, as the old tool)
      const { zipSync } = await import("/lib/fflate/browser.js");
      const sheets = pages.map((p, i) => ({ name: `Page ${i + 1}`, rows: office.tableOf(p.lines) }));
      downloadAs(office.toXlsx(zipSync, sheets), `${nameBase()}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      const rows = sheets.reduce((n, sh) => n + sh.rows.length, 0);
      return say(`Downloaded as Excel: ${rows} rows across ${sheets.length} sheet${sheets.length === 1 ? "" : "s"}. Columns come from how the text is aligned — check them.`, "good");
    }
    if (id === "txt") { downloadAs(new TextEncoder().encode(pages.map(p => p.lines.map(l => l.text).join("\n")).join("\n\n")), `${nameBase()}.txt`, "text/plain"); return say("Downloaded as text.", "good"); }
    if (id === "jpg") {
      let n = 0;
      for await (const img of render.renderPages(pdfjs, b, { type: "image/jpeg", quality: 0.9 })) { n++; downloadAs(new Uint8Array(await img.blob.arrayBuffer()), `${nameBase()}-p${img.page}.jpg`, "image/jpeg"); }
      return say(`${n} page${n === 1 ? "" : "s"} downloaded as pictures.`, "good");
    }
    if (id === "searchable") {
      say("Loading the text reader (once — about 15 MB)…");
      const { createWorker, workerOptions } = await loadOcr();
      const r = await render.ocrPdf(lib, pdfjs, createWorker, workerOptions, b, { onProgress: (n, t) => say(`Reading page ${n} of ${t}…`) });
      downloadAs(r.bytes, `${nameBase()}-searchable.pdf`, "application/pdf");
      return say(`A searchable copy: ${r.words} words read (confidence ${r.confidence}%).`, "good");
    }
    if (id === "protect") {
      if (!opts.password) return showOpts("Protect", "A password for the PDF — it cannot be recovered, keep it safe.", [["password", "password", "Password", ""], ["again", "password", "The same again", ""]], "Protect and download",
        (v) => { if (!v.password) throw new Error("Type a password."); if (v.password !== v.again) throw new Error("The two passwords differ."); return convert("protect", { password: v.password }); });
      const pw = opts.password; hideOpts();
      downloadAs(await core.protect(lib, b, pw), `${nameBase()}-protected.pdf`, "application/pdf");
      return say("Protected with AES-256.", "good");
    }
  } catch (e) { say(e?.message || String(e), "bad"); }
}
const imagePick = el("input", { type: "file", accept: "image/jpeg,image/png", hidden: true });
document.body.append(imagePick);
function drawTools() {
  const bar = $("#ws-tools");
  bar.replaceChildren(...TOOLS[mode].map(([id, ic, label]) => id === "|" ? el("span", { class: "ws-sep" })
    : el("button", { type: "button", class: "ws-tool", "data-tool": id, "aria-pressed": String((session.armed?.kind || "select") === id), title: label,
      onclick: () => pickTool(id) }, el("i", { "aria-hidden": "true" }, ic), label)));
  for (const b of bar.querySelectorAll("button")) b.disabled = !session.bytes && !STARTERS.has(b.dataset.tool);
}
async function pickTool(id) {
  if (id === "fromimages") { picturePick.click(); return; }
  if (id === "fromhtml") return openHtml();
  if (id === "fromword") { wordPick.click(); return; }
  if (!session.bytes) return;
  if (id === "select") { session.arm(null); return drawTools(); }
  if (id === "ocr") {
    say("Reading the text in the pictures…");
    try { const n = await session.findInPictures(); say(n ? `Found ${n} more line${n === 1 ? "" : "s"} in the pictures — they are fields now. A reader can misread a letter: check them.` : "No more text was found in the pictures.", n ? "good" : ""); sync(); }
    catch (e) { say(e.message || String(e), "bad"); }
    return;
  }
  if (id === "signature" || id === "initials") { if (!sigs[id]) return maker.open(id); session.arm(id, { sig: sigs[id] }); return drawTools(); }
  if (id === "image") { imagePick.click(); return; }
  if (mode === "pages") {
    const i = current - 1, n = session.pages.length;
    if (id === "rotl") return pageOp("rotate", { page: i, degrees: 270 }, `Page ${current} turned left`);
    if (id === "rotr") return pageOp("rotate", { page: i, degrees: 90 }, `Page ${current} turned right`);
    if (id === "dup") return pageOp("duplicate", { page: i }, `Page ${current} duplicated`);
    if (id === "del") { if (n < 2) return say("A PDF needs at least one page.", "bad"); return pageOp("delete", { page: i }, `Page ${current} deleted`); }
    if (id === "up") { if (!i) return; current--; return pageOp("move", { page: i, to: i - 1 }, `Page moved to ${current}`); }
    if (id === "down") { if (i >= n - 1) return; current++; return pageOp("move", { page: i, to: i + 1 }, `Page moved to ${current}`); }
    if (id === "blank") return pageOp("blank", { at: current }, `A blank page after page ${current}`);
    if (id === "addfiles") { addFiles.click(); return; }
    // rm-audit M14: Split — the ranges in the properties panel; one part downloads as a PDF, more as one .zip
    if (id === "split") return showOpts("Split", "Leave it blank for a file per page, or type ranges: 1-2, 3, 4-", [["ranges", "text", "Ranges", ""]], "Split and download", async (v) => {
      const parts = await core.split(lib, await currentBytes(), v.ranges.trim() || "each");
      const partName = (pt) => `${nameBase()}-p${pt.pages[0]}${pt.pages.length > 1 ? `-${pt.pages[pt.pages.length - 1]}` : ""}.pdf`;
      if (parts.length === 1) downloadAs(parts[0].bytes, partName(parts[0]), "application/pdf");
      else { const { zipSync } = await import("/lib/fflate/browser.js"); downloadAs(zipSync(Object.fromEntries(parts.map(pt => [partName(pt), pt.bytes]))), `${nameBase()}-split.zip`, "application/zip"); }
      hideOpts(); say(`${parts.length} part${parts.length === 1 ? "" : "s"} downloaded${parts.length > 1 ? " in one .zip" : ""}.`, "good");
    });
  }
  if (mode === "convert") return convert(id);
  // rm-audit M14: Watermark — the text in the properties panel; the result opens here as a new version
  if (id === "watermark") return showOpts("Watermark", "Stamped diagonally across every page.", [["text", "text", "Watermark text", "DRAFT"]], "Add the watermark", async (v) => {
    const b = await core.watermark(lib, await currentBytes(), v.text);
    await openBytes(b, `${nameBase()}.pdf`, { id: docId, note: "Watermarked", keep: true, openMode: mode });
    hideOpts(); say(`Watermarked “${v.text.trim()}” on every page — a version is kept in the history.`, "good");
  });
  session.arm(session.armed?.kind === id ? null : id);
  drawTools();
}
imagePick.addEventListener("change", async () => {
  const f = imagePick.files?.[0]; imagePick.value = ""; if (!f) return;
  const b = new Uint8Array(await f.arrayBuffer());
  if (!core.sniffImage(b)) return say("A picture must be a JPEG or PNG.", "bad");
  const bmp = await createImageBitmap(new Blob([b])).catch(() => null);
  session.arm("image", { bytes: b, url: URL.createObjectURL(new Blob([b])), ratio: bmp ? bmp.height / bmp.width : 1 });
  bmp?.close?.(); drawTools(); say("Click on a page to place the picture.");
});
session.on("armed", (a) => { drawTools(); if (a) say(a.kind === "ink" ? "Draw on a page with the pointer — each stroke is one mark you can move or remove. Esc to stop." : `Click on a page to place the ${a.kind === "whiteout" ? "white-out box" : a.kind}. Esc to stop.`); });
function setMode(m) {
  const b = document.querySelector(`.ws-mode[data-mode="${m}"]`);
  if (b) b.click();
}
// D192 P4 · the structured editor: with a PDF open its text goes over as sections (as "Make this an editable résumé"); empty → the editor
$("#ws-structured").addEventListener("click", () => (session.bytes ? $("#ws-to-resume").click() : (location.href = "/editor/")));
for (const b of document.querySelectorAll(".ws-mode[data-mode]")) b.addEventListener("click", () => {
  mode = b.dataset.mode;
  for (const x of document.querySelectorAll(".ws-mode[data-mode]")) x.setAttribute("aria-selected", String(x === b));
  session.arm(null); drawTools();
  if (mode === "sign" && session.formFields.length) say(`This PDF has ${new Set(session.formFields.map(f => f.name)).size} form fields — type straight into them on the page.`);
  if (mode === "pages") say("Choose a page in the strip, then rotate, duplicate, delete, move or add.");
  if (mode === "annotate") say("Highlight, draw or box anything on the page — the marks are written into the PDF when you download it.");
});

// the signature maker (A203's), in a dialog
const dlg = $("#ws-dialog");
const maker = editor.signatureMaker({ el, fileInput: (multiple = false, accept = "application/pdf") => el("input", { type: "file", class: "pt-file", accept, multiple: multiple || null }) },
  (kind, sig) => { sigs[kind] = sig; dlg.hidden = true; session.arm(kind, { sig }); say(`Click on a page to place your ${kind}.`); });
dlg.append(maker.node);
const openMaker = maker.open;
maker.open = (k) => { dlg.hidden = false; openMaker(k); };
// the signature maker closing closes the dialog — only when the maker IS the dialog (History / shortcuts share the dialog;
// setting `hidden` again on an already-hidden maker is still a mutation, and it closed them as they opened — P4/P5 walk)
new MutationObserver(() => { if (maker.node.hidden && dlg.children.length === 1) dlg.hidden = true; }).observe(maker.node, { attributes: true, attributeFilter: ["hidden"] });

// ── the page strip and the navigator ──
let current = 1;
async function drawStrip() {
  const strip = $("#ws-strip");
  strip.replaceChildren();
  for (const st of session.pages) {
    const img = el("img", { alt: "", src: await session.thumbnail(st.n, 110) });
    strip.append(el("button", { type: "button", class: "ws-thumb", "data-thumb": st.n, "aria-label": `Page ${st.n}`, onclick: () => goTo(st.n) }, img, el("span", {}, String(st.n))));
  }
  markCurrent();
}
function markCurrent() {
  for (const t of document.querySelectorAll(".ws-thumb")) t.setAttribute("aria-current", String(Number(t.dataset.thumb) === current));
  $("#ws-pageno").textContent = `${current} / ${session.pages.length}`;
}
const goTo = (n) => { const st = session.pages[n - 1]; if (!st) return; st.wrap.scrollIntoView({ behavior: "smooth", block: "start" }); current = n; markCurrent(); };
$("#ws-prev").addEventListener("click", () => goTo(Math.max(1, current - 1)));
$("#ws-next").addEventListener("click", () => goTo(Math.min(session.pages.length, current + 1)));
const canvasEl = $("#ws-canvas");
canvasEl.addEventListener("scroll", () => {
  const top = canvasEl.getBoundingClientRect().top + canvasEl.clientHeight * 0.35;
  const hit = session.pages.find(st => { const r = st.wrap.getBoundingClientRect(); return r.top <= top && r.bottom >= top; });
  if (hit && hit.n !== current) { current = hit.n; markCurrent(); }
}, { passive: true });
function setZoom(z) {
  zoom = Math.min(3, Math.max(0.3, z));
  session.pagesEl.style.setProperty("--ws-page-w", `${Math.round(zoom * 816)}px`);   // 816 px = 8.5 in at 96 dpi
  $("#ws-pct").textContent = `${Math.round(zoom * 100)} %`;
}
const fitWidth = () => setZoom((canvasEl.clientWidth - 64) / 816);
const fitPage = () => { const st = session.pages[current - 1]; const ratio = st ? st.size[1] / st.size[0] : 11 / 8.5; setZoom(Math.min((canvasEl.clientWidth - 64) / 816, (canvasEl.clientHeight - 90) / (816 * ratio))); };
$("#ws-in").addEventListener("click", () => setZoom(zoom + 0.1));
$("#ws-out").addEventListener("click", () => setZoom(zoom - 0.1));
$("#ws-fitw").addEventListener("click", fitWidth);
$("#ws-fitp").addEventListener("click", fitPage);

// ── properties ──
for (const t of document.querySelectorAll(".ws-ptab")) t.addEventListener("click", () => {
  for (const x of document.querySelectorAll(".ws-ptab")) x.setAttribute("aria-selected", String(x === t));
  for (const p of document.querySelectorAll(".ws-panel")) p.hidden = p.dataset.panel !== t.dataset.ptab;
});
const pbtn = (label, title, fn, extra = {}) => el("button", { type: "button", class: "ws-b ws-ic", title, "aria-label": title, ...extra, onmousedown: (e) => { e.preventDefault(); fn(); } }, label);
function drawText(target) {
  const box = $("#ws-text");
  if (!target) return put(box, el("p", { class: "ws-faint" }, session.bytes ? "Click any text on the page to edit it — or pick a tool to add something." : "Open a PDF to start."));
  if (target.kind === "item") {
    return put(box, el("p", { class: "ws-lbl" }, `Placed: ${target.type}`),
      el("p", { class: "ws-faint ws-small" }, "Drag it to move, the corner to resize, the arrow keys to nudge."),
      el("button", { type: "button", class: "ws-b", onclick: () => session.removeItem(target) }, "Remove"));
  }
  const f = target;
  const face = el("select", { class: "ws-sel", "aria-label": "Face", onchange: () => session.setStyle({ family: face.value }) }, ...S.FACES.map(([v, l]) => el("option", { value: v }, l)));
  face.value = f.font.family;
  const color = el("input", { type: "color", class: "ws-color", "aria-label": "Text colour", value: S.hex(f.color), oninput: () => session.setStyle({ color: S.rgbOf(color.value) }) });
  const note = session.fontNote(f);
  put(box, 
    el("p", { class: "ws-lbl" }, "Face"), face,
    note ? el("p", { class: "ws-note", "data-font-substituted": "" }, `Font substituted: ${note}`) : null,
    el("p", { class: "ws-lbl" }, "Size · weight · style"),
    el("div", { class: "ws-row" },
      pbtn("−", "Smaller", () => session.setStyle({ size: Math.max(4, f.size - 0.5) })), el("b", { class: "ws-v" }, String(Math.round(f.size * 10) / 10)),
      pbtn("+", "Larger", () => session.setStyle({ size: Math.min(96, f.size + 0.5) })),
      pbtn(el("b", {}, "B"), "Bold", () => session.setStyle({ bold: !f.font.bold }), { "aria-pressed": String(f.font.bold) }),
      pbtn(el("i", {}, "I"), "Italic", () => session.setStyle({ italic: !f.font.italic }), { "aria-pressed": String(f.font.italic) }),
      pbtn(el("u", {}, "U"), "Underline", () => session.setStyle({ underline: !f.underline }), { "aria-pressed": String(!!f.underline) }),
      el("label", { class: "ws-b ws-ic", title: "Text colour" }, "A", color)),
    el("p", { class: "ws-lbl" }, "This line"),
    el("div", { class: "ws-row" },
      el("button", { type: "button", class: "ws-b", onclick: () => session.revert(f) }, "Undo this line"),
      el("button", { type: "button", class: "ws-b", onclick: () => session.setStyle({ ...f.orig.font, size: f.orig.size, color: f.orig.color, underline: false }) }, "Original style")),
    f.ocr ? el("p", { class: "ws-warn ws-small" }, "Read from a picture — check the words.") : null);
}
session.on("active", drawText);
function drawPage() {
  const st = session.pages[current - 1];
  put($("#ws-page"), ...(!st ? [el("p", { class: "ws-faint" }, "No page")] : [
    el("p", { class: "ws-lbl" }, `Page ${st.n} of ${session.pages.length}`),
    el("p", {}, `${(st.size[0] / 72).toFixed(2)} × ${(st.size[1] / 72).toFixed(2)} in`),
    st.rotate ? el("p", { class: "ws-faint" }, `Turned ${st.rotate}°`) : null,
    el("p", { class: "ws-faint ws-small" }, `${session.fields.filter(f => f.page === st.n - 1).length} lines of text on it`)]));
}
document.querySelector('[data-ptab="page"]').addEventListener("click", drawPage);

// ── open a file ──
const isDocx = (name = "", type = "", bytes = null) => /\.docx$/i.test(name) || /wordprocessingml/i.test(type) || (bytes && bytes[0] === 0x50 && bytes[1] === 0x4b && !/\.pdf$/i.test(name));
/** ⭐ D188 LATER · Word → PDF, in this browser: the .docx's paragraphs (office.js docxBlocks) laid out on Letter pages (core.blocksToPdf). */
async function wordToPdf(bytes, name) {
  say("Making a PDF from the Word file…");
  const { unzipSync } = await import("/lib/fflate/browser.js");
  const blocks = office.docxBlocks(unzipSync, bytes);
  const r = await core.blocksToPdf(lib, blocks, { title: baseName(String(name).replace(/\.docx$/i, "")) });
  return { ...r, note: `Made from Word in your browser: ${r.pages} page${r.pages === 1 ? "" : "s"} — the text, headings, bold / italic and lists, set in Helvetica. Pictures, tables' layout and the document's own fonts are not carried${r.replaced ? `; ${r.replaced} character${r.replaced === 1 ? "" : "s"} Helvetica cannot draw became “?”` : ""}.` };
}
async function openAny(bytes, name, opts = {}) {
  if (!isDocx(name, "", bytes)) return openBytes(bytes, name, opts);
  try {
    const r = await wordToPdf(bytes, name);
    await openBytes(r.bytes, `${baseName(String(name).replace(/\.docx$/i, ""))}.pdf`, opts);
    say(r.note, r.replaced ? "bad" : "good");
  } catch (e) { ws.dataset.state = session.bytes ? "open" : "empty"; $("#ws-err").textContent = e?.message || String(e); say(e?.message || String(e), "bad"); }
}
async function openFile(file) {
  $("#ws-err").textContent = "";
  const docx = isDocx(file.name, file.type);
  if (!docx && !/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) { $("#ws-err").textContent = "That isn't a PDF or a Word file (.docx)."; return; }
  return openAny(new Uint8Array(await file.arrayBuffer()), file.name, {});
}
const wordPick = el("input", { type: "file", accept: ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document", hidden: true });
document.body.append(wordPick);
wordPick.addEventListener("change", () => { const f = wordPick.files?.[0]; wordPick.value = ""; if (f) openFile(f); });
/** Open bytes in the workspace; remembered in Recent (this browser) with a first version unless it is one already. */
async function openBytes(bytes, fileName, { id = null, note = "Opened", openMode = null, keep = false } = {}) {
  $("#ws-err").textContent = "";
  try {
    ws.dataset.state = "loading";
    fileSize = bytes.length;
    const r = await session.open(bytes, fileName);
    ws.dataset.state = "open";
    $("#ws-name").textContent = baseName(fileName);
    const fresh = !id;
    docId = id || store.newId();
    await store.putDoc({ id: docId, name: baseName(fileName), kind: "PDF", pages: r.pages, size: fileSize, thumb: await session.thumbnail(1, 160) });
    if (fresh || keep || note === "Restored") await store.addVersion(docId, bytes, note);
    $("#ws-history").disabled = false;
    if (openMode) setMode(openMode);
    $("#ws-meta").textContent = `${r.pages} page${r.pages === 1 ? "" : "s"} · ${kb(fileSize)}`;
    $("#ws-kind").hidden = false;
    for (const id of ["#ws-download", "#ws-print", "#ws-to-resume", "#ws-done"]) $(id).disabled = false;
    $("#ws-nav").hidden = false;
    await drawStrip(); fitWidth(); drawTools(); drawText(null); sync();
    say(`${r.lines} lines of text${r.read ? ` (${r.read} read from pictures — check them)` : ""}. Click any text to edit it where it is.`, "good");
  } catch (e) {
    ws.dataset.state = session.bytes ? "open" : "empty";
    if (/password-protected/i.test(e?.message || "")) return askPassword(bytes, fileName, { id, openMode });   // rm-audit M14: Unlock
    $("#ws-err").textContent = e?.message || String(e);
  }
}
$("#ws-open").addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) openFile(f); });
for (const b of document.querySelectorAll("[data-start]")) b.addEventListener("click", () => pickTool(b.dataset.start));
canvasEl.addEventListener("dragover", (e) => { e.preventDefault(); ws.dataset.drag = "true"; });
canvasEl.addEventListener("dragleave", () => { delete ws.dataset.drag; });
canvasEl.addEventListener("drop", (e) => { e.preventDefault(); delete ws.dataset.drag; const f = e.dataTransfer?.files?.[0]; if (f) openFile(f); });
$("#ws-name").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } });

// ── rm-audit M11 (b) / M14 · a tool's options, in the properties panel (no native prompt()) ──
const optsBox = () => $("#ws-opts");
function hideOpts() { const b = optsBox(); if (b) { b.hidden = true; b.replaceChildren(); } }
/** fields: [[name, type, label, value]] — `run(values)` may throw; its message shows under the button. */
function showOpts(title, lede, fields, action, run) {
  const box = optsBox();
  const inputs = fields.map(([name, type, label, value]) => [name, el("input", { type, name, class: "ws-in", value: value ?? "", "aria-label": label, autocomplete: type === "password" ? "new-password" : "off" }), label]);
  const err = el("p", { class: "ws-warn ws-small", role: "alert", hidden: true });
  const go = el("button", { type: "submit", class: "ws-b ws-p" }, action);
  const form = el("form", { class: "ws-optsform", "data-opts": title, onsubmit: async (e) => {
    e.preventDefault(); err.hidden = true; go.disabled = true;
    try { await run(Object.fromEntries(inputs.map(([n, i]) => [n, i.value]))); }
    catch (x) { err.textContent = x?.message || String(x); err.hidden = false; }
    finally { go.disabled = false; }
  } },
    el("p", { class: "ws-lbl" }, title), lede ? el("p", { class: "ws-faint ws-small" }, lede) : null,
    ...inputs.map(([, i, label]) => el("label", { class: "ws-field" }, label, i)),
    el("div", { class: "ws-row" }, go, el("button", { type: "button", class: "ws-b", onclick: hideOpts }, "Cancel")), err);
  box.replaceChildren(form); box.hidden = false;
  if (phone()) sheet("props", true);
  (inputs[0]?.[1] || go).focus();
}
/** rm-audit M14 · Unlock as a step: a locked PDF asks for its password where it was dropped; it never guesses one. */
function askPassword(bytes, fileName, rest) {
  const pw = el("input", { type: "password", class: "ws-in", autocomplete: "current-password", "aria-label": "The PDF's password" });
  const err = el("p", { class: "ws-empty__err", role: "alert" });
  const go = el("button", { type: "submit", class: "ws-b ws-p" }, "Unlock and open");
  const form = el("form", { class: "ws-unlock", "data-unlock": "", onsubmit: async (e) => {
    e.preventDefault(); go.disabled = true;
    try {
      const open = await core.unlock(lib, bytes, pw.value);
      form.remove(); $("#ws-empty").hidden = false;
      await openBytes(open, fileName, rest);
      say("Unlocked — the copy you download has no password.", "good");
    } catch (x) { err.textContent = x?.message || String(x); go.disabled = false; pw.select(); }
  } }, el("p", { class: "ws-empty__t" }, "This PDF is locked"),
    el("p", { class: "ws-empty__s" }, `Type the password for ${fileName} — it is checked here, in this browser.`),
    el("div", { class: "ws-row ws-center" }, pw, go), err);
  $("#ws-empty").hidden = true;
  canvasEl.append(form); pw.focus();
}
// ── rm-audit M14 · Images → PDF: pictures become a new document here (core.imagesToPdf, as the old tool) ──
const picturePick = el("input", { type: "file", accept: "image/jpeg,image/png", multiple: true, hidden: true });
document.body.append(picturePick);
picturePick.addEventListener("change", async () => {
  const files = [...(picturePick.files || [])]; picturePick.value = ""; if (!files.length) return;
  await openPictures(await Promise.all(files.map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
});
async function openPictures(images) {
  try {
    say("Making a PDF from the pictures…");
    const bytes = await core.imagesToPdf(lib, images);
    await openBytes(bytes, `${baseName(String(images[0]?.name || "pictures").replace(/\.(jpe?g|png)$/i, ""))}.pdf`, {});
    say(`A PDF of ${images.length} picture${images.length === 1 ? "" : "s"}, a page each, in the order chosen.`, "good");
  } catch (e) { say(e?.message || String(e), "bad"); $("#ws-err").textContent = e?.message || String(e); }
}
// ── rm-audit M14 · HTML → PDF: previewed (scripts never run, nothing is fetched), printed by the browser ──
async function openHtml(text = "", fileName = "") {
  const { htmlForPrint, HTML_SANDBOX } = await import("/lib/pdf-toolkit/html.js");
  lastFocus = document.activeElement;
  const file = el("input", { type: "file", accept: ".html,.htm,text/html", class: "pt-file", "aria-label": "An HTML file" });
  const paste = el("textarea", { class: "ws-in ws-html-paste", rows: "6", placeholder: "…or paste HTML here", "aria-label": "HTML" });
  const frame = el("iframe", { class: "ws-html-frame", sandbox: HTML_SANDBOX, title: "Preview", hidden: true });
  const msg = el("p", { class: "ws-faint ws-small", role: "status" }, "Scripts in it never run, and nothing it links to is fetched.");
  let name = fileName ? baseName(String(fileName).replace(/\.html?$/i, "")) : "document";
  const show = async () => {
    const f = file.files?.[0];
    const src = paste.value.trim() ? paste.value : f ? await f.text() : text;
    if (!String(src).trim()) { frame.hidden = true; msg.textContent = "Choose an HTML file or paste HTML first."; return false; }
    if (f && !paste.value.trim()) name = baseName(f.name.replace(/\.html?$/i, ""));
    frame.srcdoc = htmlForPrint(src); frame.hidden = false;
    await new Promise(r => frame.addEventListener("load", r, { once: true }));
    try { frame.contentDocument.title = name; } catch { /* the title names the saved file — a nicety */ }
    msg.textContent = "Preview ready — Print, then choose “Save as PDF”."; return true;
  };
  file.addEventListener("change", () => { paste.value = ""; show(); });
  paste.addEventListener("input", () => { text = ""; });
  const print = el("button", { type: "button", class: "ws-b ws-p", onclick: async () => { if (await show()) frame.contentWindow?.print(); } }, "Print / save as PDF");
  const box = el("div", { class: "ws-hist ws-html", role: "document", "data-html": "" },
    el("p", { class: "ws-hist__t", id: "ws-html-title" }, "HTML to PDF"), file, paste, el("div", { class: "ws-row" }, print, el("button", { type: "button", class: "ws-b", onclick: () => show() }, "Preview"),
      el("button", { type: "button", class: "ws-b", onclick: () => closeDialog() }, "Close")), msg, frame);
  maker.node.hidden = true;
  dlg.setAttribute("aria-labelledby", "ws-html-title");
  dlg.append(box); dlg.hidden = false;
  if (text) await show(); else file.focus();
}
// ── download, print, done, the résumé road ──
async function saved() {
  const r = await session.save();
  return r;
}
function downloadBytes(bytes) {
  const a = el("a", { href: URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })), download: `${baseName($("#ws-name").textContent)}.pdf` });
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
async function download() {
  try {
    say("Writing the changes into the PDF…");
    const r = dirty ? await saved() : { bytes: session.bytes, lines: 0, items: 0, fromPics: 0, stuck: 0 };
    downloadBytes(r.bytes);
    setSaved("Downloaded · just now");
    if (docId && dirty) { await store.addVersion(docId, r.bytes, "Downloaded"); await store.putDoc({ id: docId, name: nameBase(), kind: "PDF", pages: session.pages.length, size: r.bytes.length, thumb: await session.thumbnail(1, 160) }); }
    say(dirty ? `Downloaded with ${r.lines} line${r.lines === 1 ? "" : "s"} changed${r.items ? ` and ${r.items} item${r.items === 1 ? "" : "s"} placed` : ""}.${r.fromPics ? ` ${r.fromPics} read from a picture were covered with its paper colour.` : ""}` : "Downloaded — nothing was changed.", "good");
    return r;
  } catch (e) { say(e?.message || String(e), "bad"); return null; }
}
// ⭐ rm-audit M11 (a) · Download ▾ — PDF · Word · text in one menu (Word and text were only in Convert)
const dlMenu = el("div", { class: "ws-menu", id: "ws-dl-menu", role: "menu", hidden: true },
  ...[["pdf", "PDF"], ["word", "Word (.docx)"], ["txt", "Text (.txt)"]].map(([k, l]) => el("button", { type: "button", role: "menuitem", class: "ws-menu__i", "data-dl": k,
    onclick: () => { dlMenu.hidden = true; $("#ws-download").setAttribute("aria-expanded", "false"); return k === "pdf" ? download() : convert(k); } }, l)));
$("#ws-download").after(dlMenu);
$("#ws-download").addEventListener("click", () => { dlMenu.hidden = !dlMenu.hidden; $("#ws-download").setAttribute("aria-expanded", String(!dlMenu.hidden)); if (!dlMenu.hidden) dlMenu.querySelector("button").focus(); });
document.addEventListener("click", (e) => { if (!dlMenu.hidden && !e.target.closest("#ws-dl-menu, #ws-download")) { dlMenu.hidden = true; $("#ws-download").setAttribute("aria-expanded", "false"); } });
dlMenu.addEventListener("keydown", (e) => { if (e.key === "Escape") { dlMenu.hidden = true; $("#ws-download").focus(); } });
$("#ws-done").addEventListener("click", download);
$("#ws-print").addEventListener("click", async () => {
  try {
    const bytes = dirty ? (await saved()).bytes : session.bytes;
    const f = el("iframe", { style: "position:fixed;width:0;height:0;border:0;visibility:hidden", src: URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })) });
    f.onload = () => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch { downloadBytes(bytes); } };
    document.body.append(f);
  } catch (e) { say(e?.message || String(e), "bad"); }
});
$("#ws-to-resume").addEventListener("click", async () => {
  try {
    const html = await session.documentHtml(baseName($("#ws-name").textContent));
    sessionStorage.setItem("rm-editor:handoff", JSON.stringify({ html, filename: `${baseName($("#ws-name").textContent)}.html` }));
    location.href = "/editor/";
  } catch (e) { say(e?.message || String(e), "bad"); }
});
$("#ws-undo").addEventListener("click", () => session.undo());
$("#ws-redo").addEventListener("click", () => session.redo());

// ── keyboard ──
document.addEventListener("keydown", (e) => {
  const typing = e.target.closest?.("[contenteditable], textarea, input, select");
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === "Escape" && session.armed) { session.arm(null); drawTools(); say(""); }
  if (mod && e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); e.shiftKey ? session.redo() : session.undo(); }
  if (mod && e.key.toLowerCase() === "y" && !typing) { e.preventDefault(); session.redo(); }
  if (mod && e.key.toLowerCase() === "s" && session.bytes) { e.preventDefault(); download(); }
  if (!typing && !mod && (e.key === "+" || e.key === "=")) setZoom(zoom + 0.1);
  if (!typing && !mod && e.key === "-") setZoom(zoom - 0.1);
  if (!typing && e.key === "PageDown") goTo(Math.min(session.pages.length, current + 1));
  if (!typing && e.key === "PageUp") goTo(Math.max(1, current - 1));
});
window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

drawTools(); drawText(null); setZoom(1);

// ── D189 P5 · PHONES: the strip and the properties are bottom sheets (the canvas keeps the full width) ──
const phone = () => matchMedia("(max-width: 820px)").matches;
function sheet(which, open) {
  const el2 = which === "pages" ? $("#ws-strip") : $("#ws-props");
  const btn = which === "pages" ? $("#ws-show-pages") : $("#ws-show-props");
  const other = which === "pages" ? "props" : "pages";
  const want = open ?? !el2.classList.contains("ws-sheet--open");
  if (want) sheet(other, false);
  el2.classList.toggle("ws-sheet--open", want);
  btn.setAttribute("aria-expanded", String(want));
}
$("#ws-show-pages").addEventListener("click", () => sheet("pages"));
$("#ws-show-props").addEventListener("click", () => sheet("props"));
session.on("active", (t) => { if (phone() && t) sheet("props", true); });
$("#ws-strip").addEventListener("click", (e) => { if (phone() && e.target.closest(".ws-thumb")) sheet("pages", false); });

// ── D189 P5 · the tool bar is ONE tab stop; the arrow keys move along it (Home / End to its ends) ──
$("#ws-tools").addEventListener("keydown", (e) => {
  const tools = [...$("#ws-tools").querySelectorAll("button:not(:disabled)")];
  const i = tools.indexOf(document.activeElement);
  if (i < 0) return;
  const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tools.length - 1 }[e.key];
  if (to == null) return;
  e.preventDefault();
  const t = tools[(to + tools.length) % tools.length];
  tools.forEach(b => b.tabIndex = -1); t.tabIndex = 0; t.focus();
});
new MutationObserver(() => { const tools = [...$("#ws-tools").querySelectorAll("button")]; tools.forEach((b, k) => { b.tabIndex = (b.getAttribute("aria-pressed") === "true" || (!tools.some(x => x.getAttribute("aria-pressed") === "true") && k === 0)) ? 0 : -1; }); })
  .observe($("#ws-tools"), { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-pressed"] });

// ── D189 P5 · KEYBOARD SHORTCUTS (? opens the list) ──
const SHORTCUTS = [
  ["Ctrl + Z", "Undo"], ["Ctrl + Shift + Z  ·  Ctrl + Y", "Redo"], ["Ctrl + S", "Download the PDF (a version is kept)"], ["Ctrl + P", "Print"],
  ["+  /  −", "Zoom in / out"], ["Page Up  /  Page Down", "Previous / next page"], ["Home  /  End", "First / last page"],
  ["Enter", "Finish editing a line"], ["Esc", "Undo a line being edited · put a tool down · close a dialog"],
  ["Arrow keys (on a placed item)", "Nudge it (Shift = further)"], ["Delete (on a placed item)", "Remove it"],
  ["Tab  ·  ← →  in the tool bar", "Reach the tools · move between them"], ["?", "This list"],
];
let lastFocus = null;
function openKeys() {
  lastFocus = document.activeElement;
  const close = el("button", { type: "button", class: "ws-b", onclick: () => closeDialog() }, "Close");
  const box = el("div", { class: "ws-hist", role: "document", "data-shortcuts": "" },
    el("p", { class: "ws-hist__t", id: "ws-keys-title" }, "Keyboard shortcuts"),
    el("dl", { class: "ws-keys" }, ...SHORTCUTS.flatMap(([k, what]) => [el("dt", {}, k), el("dd", {}, what)])),
    close);
  maker.node.hidden = true;
  dlg.setAttribute("aria-labelledby", "ws-keys-title");
  dlg.append(box); dlg.hidden = false; close.focus();
}
function closeDialog() {
  dlg.hidden = true;
  for (const c of [...dlg.children]) if (c !== maker.node) c.remove();
  maker.node.hidden = true;
  dlg.setAttribute("aria-label", "Your signature"); dlg.removeAttribute("aria-labelledby");
  lastFocus?.focus?.();
}
$("#ws-keys").addEventListener("click", openKeys);
// ⭐ rm-audit M20 / M17 · SETTINGS (the top bar's ⚙): Appearance — draft's four themes — and the account (public/settings-panel.js)
async function openSettings() {
  lastFocus = document.activeElement;
  const [{ appearanceNode }, { accountNode }] = await Promise.all([import("/settings-panel.js"), import("/account-panel.js")]);
  const close = el("button", { type: "button", class: "ws-b", onclick: () => closeDialog() }, "Close");
  const box = el("div", { class: "ws-hist", role: "document", "data-settings": "" },
    el("p", { class: "ws-hist__t", id: "ws-settings-title" }, "Settings"), appearanceNode(el), accountNode(el), close);
  maker.node.hidden = true;
  dlg.setAttribute("aria-labelledby", "ws-settings-title");
  dlg.append(box); dlg.hidden = false; close.focus();
}
$("#ws-settings").addEventListener("click", openSettings);
document.addEventListener("keydown", (e) => {
  const typing = e.target.closest?.("[contenteditable], textarea, input, select");
  if (e.key === "Escape" && !dlg.hidden) { e.preventDefault(); closeDialog(); return; }
  if (typing) return;
  if (e.key === "?" ) { e.preventDefault(); openKeys(); }
  if (e.key === "Home" && session.pages.length && !e.target.closest("#ws-tools")) goTo(1);
  if (e.key === "End" && session.pages.length && !e.target.closest("#ws-tools")) goTo(session.pages.length);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p" && session.bytes) { e.preventDefault(); $("#ws-print").click(); }
});
// a dialog keeps the focus inside it (Tab wraps)
dlg.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const f = [...dlg.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter(x => !x.disabled && x.offsetParent);
  if (!f.length) return;
  if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
  else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
});

// ── D189 P4 · AUTOSAVE: while there are changes, a version every minute (this browser only) ──
setInterval(async () => {
  if (!dirty || !docId || autosaving || !session.bytes) return;
  autosaving = true;
  try { const r = await session.save(); await store.addVersion(docId, r.bytes, "Autosaved"); setSaved(`Autosaved on this device · ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`); }
  catch { /* nothing to save yet, or storage is blocked */ } finally { autosaving = false; }
}, 60000);

// ── D189 P4 · VERSION HISTORY: every version kept for this document; Restore opens it ──
$("#ws-history").addEventListener("click", async () => {
  if (!docId) return;
  const vs = await store.listVersions(docId);
  const box = el("div", { class: "ws-hist", role: "document" },
    el("p", { class: "ws-hist__t" }, "Version history"),
    el("p", { class: "ws-faint ws-small" }, "Kept in this browser only — nothing is uploaded."),
    vs.length ? el("ol", { class: "ws-hist__list" }, ...vs.map((v, i) => el("li", {},
      el("span", {}, el("b", {}, v.note), ` · ${new Date(v.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · ${kb(v.bytes.length)}${i === 0 ? " · newest" : ""}`),
      el("button", { type: "button", class: "ws-b", "data-restore": v.id, onclick: async () => {
        dlg.hidden = true; box.remove();
        await openBytes(v.bytes, nameBase(), { id: docId, note: "Restored" });
        say(`Restored the version from ${new Date(v.at).toLocaleString()}. The one you had is kept in the history too.`, "good");
      } }, "Restore")))) : el("p", { class: "ws-faint" }, "No versions yet."),
    el("button", { type: "button", class: "ws-b", onclick: () => { dlg.hidden = true; box.remove(); maker.node.hidden = true; } }, "Close"));
  maker.node.hidden = true;
  dlg.append(box); dlg.hidden = false;
});

// ── D189 P4 · arriving with a file (Documents home, a tool page) or a recent document (?doc=) ──
{
  const q = new URLSearchParams(location.search);
  if (q.has("open")) {
    const h = await store.takeHandoff();
    if (h?.bytes) {
      if (core.sniffImage(h.bytes)) await openPictures([{ name: h.name, bytes: h.bytes }]);
      else if (/[.]html?$/i.test(h.name || "")) await openHtml(new TextDecoder().decode(h.bytes), h.name);
      else await openAny(h.bytes, h.name || "document.pdf", { openMode: q.get("mode") || h.mode || null });
      if (h.tool && TOOL_OPENS.has(h.tool) && session.bytes) pickTool(TOOL_OPENS.get(h.tool));
    }
    history.replaceState(null, "", location.pathname + (q.get("mode") ? `?mode=${q.get("mode")}` : ""));
  } else if (q.get("doc")) {
    const d = await store.getDoc(q.get("doc"));
    const v = d && (await store.listVersions(d.id))[0];
    if (v) await openBytes(v.bytes, d.name, { id: d.id, note: "Reopened", openMode: q.get("mode") });
    else $("#ws-err").textContent = "That document isn't kept in this browser any more.";
  } else if (q.get("mode")) setMode(q.get("mode"));
  if (q.get("tool") && STARTERS.has(q.get("tool")) && !session.bytes) pickTool(q.get("tool"));
}
/** The page's text as visual lines (runs sharing a baseline band), top to bottom, each line's runs left to right. */
function linesOn(pageIdx) {
  const fs = session.fields.filter(f => f.page === pageIdx).slice().sort((a, b) => a.box.top - b.box.top || a.box.x - b.box.x);
  const groups = [];
  for (const f of fs) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g.top - f.box.top) <= Math.max(1.5, Math.min(g.h, f.box.h) * 0.5)) g.fields.push(f);
    else groups.push({ top: f.box.top, h: f.box.h, fields: [f] });
  }
  for (const g of groups) { g.fields.sort((a, b) => a.box.x - b.box.x); g.text = g.fields.map(f => f.text).join(" "); }
  return groups;
}
/** The open document's text, as it reads now (the edits included), a line per visual line, pages in order. */
const documentText = () => (session.bytes ? session.pages.map(st => linesOn(st.n - 1).map(g => g.text).join("\n")).join("\n\n").trim() : "");

// ── ⭐ draft D192 (3d) · THE ATS PANEL — the properties panel's Résumé tab: this document against a job, the ATS card and the
// plausibility flags (public/ats-panel.js; the site's check moved inside the document, rm-audit M5). No model (D190).
{
  const { mountAtsPanel } = await import("/ats-panel.js");
  const atsPanel = mountAtsPanel($("#ws-resume"), {
    resumeText: documentText,
    resumeLabel: () => { const n = session.fields.length; return `Scored from this document's text — ${n} line${n === 1 ? "" : "s"}, your edits included.`; },
  });
  atsRefresh = atsPanel.refresh;
  if (new URLSearchParams(location.search).get("panel") === "resume") $("#ws-ptab-resume").click();
  window.__rmAtsPanel = atsPanel;   // for the walks
}
// ── ⭐ D190 · TINY — the chat that acts on this document (public/assistant/tiny.js; the engine is draft's, mirrored) ──
// Every handler calls what the tool bar / navigator / properties call. Nothing here makes a request: the owner's rule
// (11-14) — nothing within the site's own data or functions calls a model.
{
  const need = () => { if (!session.bytes) throw new Error("Open a PDF first — drop it on the page, or press Open a PDF."); };
  const statusText = (fallback) => $("#ws-status").textContent || fallback;
  const lineNoOf = (f) => linesOn(f.page).findIndex(g => g.fields.includes(f)) + 1;
  const where = (f) => `page ${f.page + 1}, line ${lineNoOf(f)}`;
  const q = (s) => `“${s}”`;
  function pageIndex(page) {
    const n = session.pages.length;
    const p = page == null ? current : page;
    if (p < 1 || p > n) throw new Error(`There ${n === 1 ? "is 1 page" : `are ${n} pages`} — page ${p} isn't one of them.`);
    return p - 1;
  }
  function lineGroup(line, page) {
    const pi = pageIndex(page);
    const gs = linesOn(pi);
    if (line < 1 || line > gs.length) throw new Error(`Page ${pi + 1} has ${gs.length} line${gs.length === 1 ? "" : "s"} of text — line ${line} isn't one of them.`);
    return { pi, g: gs[line - 1] };
  }
  /** "line 3 [on page 2]" · "the header / title / name" · "the first line" · any words on the page. */
  function targetFields(target) {
    const t = String(target || "").trim();
    let m = /^line (\d{1,4})(?: (?:on|of) page (\d{1,4}))?$/i.exec(t);
    if (m) return { fields: lineGroup(Number(m[1]), m[2] ? Number(m[2]) : null).g.fields, what: `line ${m[1]}${m[2] ? ` on page ${m[2]}` : ""}` };
    if (/^(the )?(first|top) line$/i.test(t)) return { fields: lineGroup(1, null).g.fields, what: "the first line" };
    if (/^(the )?(header|heading|title|name|my name|headline)$/i.test(t)) {
      const on1 = session.fields.filter(f => f.page === 0);
      if (!on1.length) throw new Error("Page 1 has no text to style.");
      const big = Math.max(...on1.map(f => f.size));
      const hits = on1.filter(f => f.size >= big - 0.01);
      return { fields: hits, what: `the header (${q(hits.map(f => f.text).join(" ").slice(0, 40))})` };
    }
    const lower = t.toLowerCase();
    const hits = session.fields.filter(f => f.text.toLowerCase().includes(lower));
    if (!hits.length) throw new Error(`I couldn't find ${q(t)} in the document's text.`);
    if (hits.length > 1) return { ask: `${q(t)} is in ${hits.length} places (${hits.slice(0, 4).map(where).join("; ")}${hits.length > 4 ? "; …" : ""}). Say which — e.g. “make line ${lineNoOf(hits[0])} bold”.` };
    return { fields: hits, what: q(t) };
  }
  const styleOf = (f) => ({ family: f.font.family, bold: f.font.bold, italic: f.font.italic, size: f.size, color: f.color.slice(), underline: !!f.underline });
  function restyle(target, patchFor, verb) {
    need();
    const r = targetFields(target);
    if (r.ask) return { ask: r.ask };
    const before = r.fields.map(f => [f, styleOf(f)]);
    for (const f of r.fields) session.styleField(f, patchFor(f));
    sync();
    return { text: `${verb} ${r.what}.`, undo: () => { for (const [f, st] of before) session.styleField(f, st); sync(); return { text: `${r.what[0].toUpperCase()}${r.what.slice(1)} is back as it was.` }; } };
  }
  async function reopen(bytes) {
    await session.open(bytes, session.name);
    if (docId) await store.addVersion(docId, session.bytes, "Undone (assistant)");
    await drawStrip(); fitWidth(); drawTools(); sync();
    $("#ws-meta").textContent = `${session.pages.length} page${session.pages.length === 1 ? "" : "s"} · ${kb(session.bytes.length)}`;
  }
  async function pages(kind, arg, done) {
    need();
    const before = await currentBytes();
    await pageOp(kind, arg, done, { rethrow: true });
    return { text: `${done}.`, undo: async () => { await reopen(before); return { text: "The pages are back as they were." }; } };
  }
  const handlers = {
    help: () => ({ text: "I act on this document without AI: replace words (“replace 2023 with 2024 on line 3”), bold / italic / underline / size (“make the header bold”), delete, duplicate, rotate or move pages, compress, download as PDF, Word, text or pictures, print, go to a page, zoom, undo and redo — and I can read you what's on a page, find a word, or check it for what an ATS may trip on." }),
    undo: () => { if (!session.canUndo) return { text: "There's nothing to undo." }; session.undo(); sync(); return { text: "Undone — the last change is taken back." }; },
    redo: () => { if (!session.canRedo) return { text: "There's nothing to redo." }; session.redo(); sync(); return { text: "Redone." }; },
    replaceText: (a) => {
      need();
      let pool = session.fields, scope = "";
      if (a.line != null) { const { pi, g } = lineGroup(a.line, a.page); pool = g.fields; scope = ` on page ${pi + 1}, line ${a.line}`; }
      else if (a.page != null) { const pi = pageIndex(a.page); pool = pool.filter(f => f.page === pi); scope = ` on page ${pi + 1}`; }
      if (a.old == null) {   // "replace line 3 with …" — the whole line, only when the line is one run
        if (pool.length > 1) return { ask: `Line ${a.line} has ${pool.length} parts (${pool.map(f => q(f.text)).join(", ")}). Say which words to change — e.g. “replace ${pool[0].text.split(" ")[0]} with … on line ${a.line}”.` };
        const f = pool[0], was = f.text;
        session.setText(f, a.new); sync();
        return { text: `Line ${a.line}${scope.replace(/, line \d+$/, "")} now reads ${q(a.new)} (was ${q(was)}).`, undo: () => { session.setText(f, was); sync(); return { text: `Line ${a.line} reads ${q(was)} again.` }; } };
      }
      let hits = pool.filter(f => f.text.includes(a.old));
      if (!hits.length) hits = pool.filter(f => f.text.toLowerCase().includes(a.old.toLowerCase()));
      if (!hits.length) throw new Error(`I couldn't find ${q(a.old)}${scope} in the document's text${session.fields.some(f => f.ocr) ? "" : " (if it's in a picture, use Find text in pictures first)"}.`);
      if (hits.length > 1) return { ask: `${q(a.old)} is in ${hits.length} places${scope} (${hits.slice(0, 4).map(where).join("; ")}${hits.length > 4 ? "; …" : ""}). Say which line — e.g. “replace ${a.old} with ${a.new} on line ${lineNoOf(hits[0])}${a.page == null && hits[0].page ? ` of page ${hits[0].page + 1}` : ""}”.` };
      const f = hits[0], was = f.text;
      const at = was.includes(a.old) ? was.indexOf(a.old) : was.toLowerCase().indexOf(a.old.toLowerCase());
      session.setText(f, was.slice(0, at) + a.new + was.slice(at + a.old.length)); sync();
      return { text: `Replaced ${q(a.old)} with ${q(a.new)} on ${where(f)}.`, undo: () => { session.setText(f, was); sync(); return { text: `${q(a.old)} is back on ${where(f)}.` }; } };
    },
    deletePage: (a) => { need(); const i = pageIndex(a.page); if (session.pages.length < 2) throw new Error("A PDF needs at least one page."); current = i + 1; return pages("delete", { page: i }, `Page ${i + 1} deleted`); },
    deleteAllPages: async () => {
      need();
      const n = session.pages.length; if (n < 2) return { text: "There's only one page — a PDF needs at least one." };
      const before = await currentBytes();
      for (let k = n - 1; k >= 1; k--) await session.editPages("delete", { page: k });
      current = 1; await drawStrip(); fitWidth(); drawTools(); sync();
      if (docId) await store.addVersion(docId, session.bytes, "Pages changed");
      return { text: `Deleted pages 2–${n}; page 1 is kept.`, undo: async () => { await reopen(before); return { text: "All the pages are back." }; } };
    },
    duplicatePage: (a) => { const i = pageIndex(a.page); return pages("duplicate", { page: i }, `Page ${i + 1} duplicated`); },
    rotatePage: (a) => {
      const i = pageIndex(a.page), d = String(a.dir || "right").toLowerCase();
      const deg = /left|anti|counter/.test(d) ? 270 : /upside|around|180/.test(d) ? 180 : /right|clockwise|90/.test(d) ? 90 : null;
      if (deg == null) return { ask: `Which way — left, right or upside down?` };
      return pages("rotate", { page: i, degrees: deg }, `Page ${i + 1} turned ${deg === 270 ? "left" : deg === 90 ? "right" : "upside down"}`);
    },
    movePage: (a, ctx) => {
      need();
      const i = pageIndex(a.page), n = session.pages.length;
      const to = a.to != null ? a.to : /start|front|beginning/i.test(ctx.said) ? 1 : /end/i.test(ctx.said) ? n : null;
      if (to == null || to < 1 || to > n) return { ask: `Move page ${i + 1} to which position (1–${n})?` };
      if (to - 1 === i) return { text: `Page ${i + 1} is already there.` };
      current = to; return pages("move", { page: i, to: to - 1 }, `Page ${i + 1} moved to position ${to}`);
    },
    boldText: (a, ctx) => { const off = /\b(not bold|unbold)\b/i.test(ctx.said); return restyle(a.target, () => ({ bold: !off }), off ? "Took the bold off" : "Made bold:"); },
    italicText: (a) => restyle(a.target, () => ({ italic: true }), "Made italic:"),
    underlineText: (a) => restyle(a.target, () => ({ underline: true }), "Underlined"),
    sizeText: (a, ctx) => {
      const n = Number(String(a.size || "").replace(/[^\d.]/g, ""));
      const step = /bigger|larger/i.test(ctx.said) ? 2 : /smaller/i.test(ctx.said) ? -2 : 0;
      if (!step && !(n >= 4 && n <= 96)) return { ask: "What size, in points? (4 to 96 — body text is usually 10 to 12)" };
      return restyle(a.target, (f) => ({ size: step ? Math.min(96, Math.max(4, f.size + step)) : n }), step ? (step > 0 ? "Made bigger:" : "Made smaller:") : `Set to ${n} pt:`);
    },
    convert: async (a) => {
      need();
      const f = String(a.format || "").toLowerCase().replace(/^(a|an)\s+/, "").replace(/\s+(file|document|doc)$/, "");
      const id = /^(word|docx|doc|ms word|microsoft word)$/.test(f) ? "word" : /^(text|txt|plain text)$/.test(f) ? "txt"
        : /^(images?|pictures?|jpe?gs?|photos?)$/.test(f) ? "jpg" : /^(searchable|ocr|searchable pdf)$/.test(f) ? "searchable" : /^pdf$/.test(f) ? "pdf" : null;
      if (!id) return { ask: `I can make it Word, text, pictures (JPG) or a searchable PDF — which one?` };
      if (id === "pdf") { await download(); return { text: statusText("Downloaded.") }; }
      say(""); await convert(id); return { text: statusText("Done.") };
    },
    compress: async (a) => { need(); say(""); await convert("compress", { limit: Number(a.limit) || 2 }); return { text: statusText("Compressed.") }; },
    download: async () => { need(); say(""); await download(); return { text: statusText("Downloaded.") }; },
    print: () => { need(); $("#ws-print").click(); return { text: "Opened the print dialog." }; },
    goToPage: (a, ctx) => { need(); const n = session.pages.length; const p = a.page != null ? a.page : /last/i.test(ctx.said) ? n : 1; pageIndex(p); goTo(p); return { text: `Page ${p} of ${n}.` }; },
    nextPage: () => { need(); if (current >= session.pages.length) return { text: "This is the last page." }; goTo(current + 1); return { text: `Page ${current} of ${session.pages.length}.` }; },
    previousPage: () => { need(); if (current <= 1) return { text: "This is the first page." }; goTo(current - 1); return { text: `Page ${current} of ${session.pages.length}.` }; },
    zoom: (a) => {
      need();
      const h = String(a.how || "").toLowerCase().trim(), was = zoom;
      const pct = /(\d{2,3})\s*(%|percent)?$/.exec(h);
      if (/^in$/.test(h)) setZoom(zoom + 0.1); else if (/^out$/.test(h)) setZoom(zoom - 0.1);
      else if (/(fit|to fit)?\s*(the )?page$/.test(h) && /page/.test(h)) fitPage();
      else if (/fit|width/.test(h)) fitWidth();
      else if (pct) setZoom(Number(pct[1]) / 100);
      else return { ask: "Zoom how — in, out, fit width, fit page, or a percentage like 125%?" };
      return { text: `Zoom ${Math.round(zoom * 100)} %.`, undo: () => { setZoom(was); return { text: `Zoom ${Math.round(was * 100)} % again.` }; } };
    },
    // T2 — read from the document itself (its text layer), still no model
    pageText: (a) => {
      need();
      if (a.line != null) { const { pi, g } = lineGroup(a.line, a.page); return { text: `Page ${pi + 1}, line ${a.line}: ${q(g.text)}` }; }
      const pi = pageIndex(a.page), gs = linesOn(pi);
      if (!gs.length) return { text: `Page ${pi + 1} has no text layer${session.pages[pi] ? " — try Find text in pictures" : ""}.` };
      const body = gs.map((g, k) => `${k + 1}. ${g.text}`).join("\n");
      return { text: `Page ${pi + 1} (${gs.length} line${gs.length === 1 ? "" : "s"}):\n${body.length > 1200 ? `${body.slice(0, 1200)}…` : body}` };
    },
    docFacts: () => { need(); const n = session.changeCount(); return { text: `${session.pages.length} page${session.pages.length === 1 ? "" : "s"} · ${session.fields.length} lines of text · ${kb(session.bytes.length)} · ${n} change${n === 1 ? "" : "s"} not downloaded yet.` }; },
    findText: (a) => {
      need();
      const hits = session.fields.filter(f => f.text.toLowerCase().includes(String(a.text).toLowerCase()));
      if (!hits.length) return { text: `${q(a.text)} isn't in the document's text.` };
      goTo(hits[0].page + 1);
      return { text: `${q(a.text)} is on ${hits.slice(0, 6).map(where).join("; ")}${hits.length > 6 ? ` and ${hits.length - 6} more` : ""}.` };
    },
    // D190 P2 · what an applicant-tracking system may trip on, read from this document itself (still no model, no request)
    atsWarnings: () => {
      need();
      const out = [], n = session.pages.length, size = session.bytes.length;
      if (!session.fields.length) out.push("there is no text layer — an ATS reads nothing; use Convert → Searchable (OCR) first");
      const pics = session.fields.filter(f => f.ocr).length;
      if (pics) out.push(`${pics} line${pics === 1 ? " was" : "s were"} read from a picture — an ATS may not see ${pics === 1 ? "it" : "them"}`);
      if (n > 2) out.push(`${n} pages — most résumés are one or two`);
      if (size > 2 * 1048576) out.push(`${kb(size)} — many application forms cap uploads at 2 MB (say “compress it under 2 MB”)`);
      const fonts = new Set(session.fields.map(f => f.pdfFont || `${f.font.family}${f.font.bold ? "-b" : ""}${f.font.italic ? "-i" : ""}`));
      if (fonts.size > 4) out.push(`${fonts.size} different fonts — simpler is safer`);
      // two columns: on a page, many lines with two runs far apart (an ATS may read straight across them)
      for (const st of session.pages) {
        const gs = linesOn(st.n - 1), w = st.size?.[0] || 612;
        const split = gs.filter(g => g.fields.length > 1 && g.fields.some((f, k) => k && f.box.x - (g.fields[k - 1].box.x + g.fields[k - 1].box.w) > w * 0.12)).length;
        if (gs.length >= 6 && split / gs.length > 0.35) { out.push(`page ${st.n} looks like two columns — some ATS read straight across them`); break; }
      }
      return { text: out.length ? `What an ATS may trip on: ${out.join("; ")}.` : `Nothing obvious: ${n} page${n === 1 ? "" : "s"}, a text layer, ${fonts.size} font${fonts.size === 1 ? "" : "s"}, ${kb(size)}. (An ATS score needs a job — score it against one in draft.)` };
    },
    // T3 — new writing. Not switched on in Tiny yet; nothing is sent anywhere (the routing stub, D190 P1).
    t3: () => ({ ask: "Writing new words needs the assistant, which isn't switched on here yet. Everything already in this document I can do without it — say “help” for the list." }),
  };
  // ⭐ 46n (owner 11-15): Tiny is a FLOATING bot — the fox bubble at the bottom-right, its card over the page (no column)
  const tiny = await import("/assistant/tiny.js").then(m => m.mountTiny({ handlers, onDocument: true }));
  window.__rmTiny = tiny;   // for the walks
}

window.__rmWorkspace = session;   // for the walks
