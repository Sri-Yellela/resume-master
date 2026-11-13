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
const sigs = { signature: null, initials: null };

// ── status, save state ──
const say = (m, kind = "") => { const s = $("#ws-status"); s.textContent = m || ""; s.dataset.kind = kind; };
session.on("status", (m) => say(m));
const setSaved = (t) => { $("#ws-saved").textContent = t; };
function sync() {
  $("#ws-undo").disabled = !session.canUndo; $("#ws-redo").disabled = !session.canRedo;
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
  // ⭐ D189 P3: the page strip's operations, on the current page (the strip / navigator chooses it)
  pages: [["rotl", "⟲", "Rotate left"], ["rotr", "⟳", "Rotate right"], ["dup", "⧉", "Duplicate"], ["del", "✕", "Delete"],
    ["up", "↑", "Move earlier"], ["down", "↓", "Move later"], ["|"], ["blank", "▢", "Blank page"], ["addfiles", "+", "Add files"]],
  // ⭐ D189 P3: the document as something else — each from the CURRENT document (changes included)
  convert: [["compress", "⇲", "Compress"], ["word", "W", "Word"], ["txt", "≡", "Text"], ["jpg", "▣", "Images"], ["searchable", "⌕", "Searchable (OCR)"], ["protect", "⚿", "Protect"]],
};
const addFiles = el("input", { type: "file", accept: "application/pdf,image/jpeg,image/png", multiple: true, hidden: true });
document.body.append(addFiles);
addFiles.addEventListener("change", async () => {
  const files = [...(addFiles.files || [])]; addFiles.value = ""; if (!files.length) return;
  await pageOp("add", { files: await Promise.all(files.map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))) }, `${files.length} file${files.length === 1 ? "" : "s"} added at the end`);
});
async function pageOp(kind, arg, done) {
  try {
    const had = session.changeCount();
    say("Working on the pages…");
    const r = await session.editPages(kind, arg);
    if (docId) await store.addVersion(docId, session.bytes, "Pages changed");
    await drawStrip(); fitWidth(); drawTools(); sync();
    $("#ws-meta").textContent = `${r.pages} page${r.pages === 1 ? "" : "s"} · ${kb(session.bytes.length)}`;
    say(`${done}.${had ? " Your other changes were written first — undo starts again from here." : ""}`, "good");
  } catch (e) { say(e?.message || String(e), "bad"); }
}
const currentBytes = async () => (session.changeCount() ? (await session.save()).bytes : session.bytes);
const nameBase = () => baseName($("#ws-name").textContent);
function downloadAs(bytes, filename, type) {
  const a = el("a", { href: URL.createObjectURL(new Blob([bytes], { type })), download: filename });
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
async function convert(id) {
  try {
    const b = await currentBytes();
    if (id === "compress") {
      const limit = Number(prompt("The form's upload limit, in MB (most accept 2–5 MB):", "2")) || 2;
      say("Compressing…");
      const r = await core.compress(lib, b, { reencodeJpeg: render.reencodeJpegInBrowser, maxDimension: 1600, quality: 0.72 });
      const under = r.after <= limit * 1048576;
      say(`${kb(r.before)} → ${kb(r.after)} — ${under ? `under your ${limit} MB limit` : `still over your ${limit} MB limit (try Compress on the PDF tools page at Maximum)`}. ${r.note}`, under ? "good" : "bad");
      return downloadAs(r.bytes, `${nameBase()}-compressed.pdf`, "application/pdf");
    }
    const pages = [];
    if (id === "word" || id === "txt") {
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
      const pw = prompt("A password for the PDF (it cannot be recovered — keep it safe):");
      if (!pw) return;
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
  for (const b of bar.querySelectorAll("button")) b.disabled = !session.bytes;
}
async function pickTool(id) {
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
  }
  if (mode === "convert") return convert(id);
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
session.on("armed", (a) => { drawTools(); if (a) say(`Click on a page to place the ${a.kind === "whiteout" ? "white-out box" : a.kind}. Esc to stop.`); });
function setMode(m) {
  const b = document.querySelector(`.ws-mode[data-mode="${m}"]`);
  if (b) b.click();
}
for (const b of document.querySelectorAll(".ws-mode")) b.addEventListener("click", () => {
  mode = b.dataset.mode;
  for (const x of document.querySelectorAll(".ws-mode")) x.setAttribute("aria-selected", String(x === b));
  session.arm(null); drawTools();
  if (mode === "sign" && session.formFields.length) say(`This PDF has ${new Set(session.formFields.map(f => f.name)).size} form fields — type straight into them on the page.`);
  if (mode === "pages") say("Choose a page in the strip, then rotate, duplicate, delete, move or add.");
});

// the signature maker (A203's), in a dialog
const dlg = $("#ws-dialog");
const maker = editor.signatureMaker({ el, fileInput: (multiple = false, accept = "application/pdf") => el("input", { type: "file", class: "pt-file", accept, multiple: multiple || null }) },
  (kind, sig) => { sigs[kind] = sig; dlg.hidden = true; session.arm(kind, { sig }); say(`Click on a page to place your ${kind}.`); });
dlg.append(maker.node);
const openMaker = maker.open;
maker.open = (k) => { dlg.hidden = false; openMaker(k); };
new MutationObserver(() => { if (maker.node.hidden) dlg.hidden = true; }).observe(maker.node, { attributes: true, attributeFilter: ["hidden"] });

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
async function openFile(file) {
  $("#ws-err").textContent = "";
  if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) { $("#ws-err").textContent = "That isn't a PDF."; return; }
  return openBytes(new Uint8Array(await file.arrayBuffer()), file.name, {});
}
/** Open bytes in the workspace; remembered in Recent (this browser) with a first version unless it is one already. */
async function openBytes(bytes, fileName, { id = null, note = "Opened", openMode = null } = {}) {
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
    if (fresh || note === "Restored") await store.addVersion(docId, bytes, note);
    $("#ws-history").disabled = false;
    if (openMode) setMode(openMode);
    $("#ws-meta").textContent = `${r.pages} page${r.pages === 1 ? "" : "s"} · ${kb(fileSize)}`;
    $("#ws-kind").hidden = false;
    for (const id of ["#ws-download", "#ws-print", "#ws-to-resume", "#ws-done"]) $(id).disabled = false;
    $("#ws-nav").hidden = false;
    await drawStrip(); fitWidth(); drawTools(); drawText(null); sync();
    say(`${r.lines} lines of text${r.read ? ` (${r.read} read from pictures — check them)` : ""}. Click any text to edit it where it is.`, "good");
  } catch (e) { ws.dataset.state = "empty"; $("#ws-err").textContent = e?.message || String(e); }
}
$("#ws-open").addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) openFile(f); });
canvasEl.addEventListener("dragover", (e) => { e.preventDefault(); ws.dataset.drag = "true"; });
canvasEl.addEventListener("dragleave", () => { delete ws.dataset.drag; });
canvasEl.addEventListener("drop", (e) => { e.preventDefault(); delete ws.dataset.drag; const f = e.dataTransfer?.files?.[0]; if (f) openFile(f); });
$("#ws-name").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } });

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
$("#ws-download").addEventListener("click", download);
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
    if (h?.bytes) await openBytes(h.bytes, h.name || "document.pdf", { openMode: q.get("mode") || h.mode || null });
    history.replaceState(null, "", location.pathname + (q.get("mode") ? `?mode=${q.get("mode")}` : ""));
  } else if (q.get("doc")) {
    const d = await store.getDoc(q.get("doc"));
    const v = d && (await store.listVersions(d.id))[0];
    if (v) await openBytes(v.bytes, d.name, { id: d.id, note: "Reopened", openMode: q.get("mode") });
    else $("#ws-err").textContent = "That document isn't kept in this browser any more.";
  } else if (q.get("mode")) setMode(q.get("mode"));
}
window.__rmWorkspace = session;   // for the walks
