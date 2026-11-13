// ── PDF toolkit · Edit PDF, the tool page's panel (A203 (2)–(4); D189 P2: on the ONE document session, session.js) ──────
//
// "what i want is to be able to edit a pdf text as inline, so upload pdf and its editable wherever, just live draft" ·
// "use the entire sandbox styling and formatting and buttons from draft".
//
// The pages, a field on every line of their text (OCR for text in pictures), draft's sandbox toolbar for the field being
// edited, Save, "Find text in pictures", and "Open in the résumé editor". The editing itself — fields, OCR, the history,
// save — is session.js, the same one the workspace (/workspace/) runs. ⭐ Nothing leaves this browser.

import { linesOf } from "./pdfText.js";
import { blocksOf, docHtmlOf } from "./pdfToDoc.js";
import { createPdfSession, FACES, hex, rgbOf } from "./session.js";
import { svgNode } from "./editor.js";

export { faceOf, sampleColors } from "./session.js";
export const HANDOFF_KEY = "rm-editor:handoff";

/**
 * @param h  the toolkit's helpers: { el, lib, pdfjs, core, status, say, fail, results, download, fileInput, base, readBytes, loadOcr }
 */
export function buildTextEditor(h) {
  const { el, lib, pdfjs, core, say, fail } = h;
  const input = h.fileInput();
  const s = h.status(), out = h.results();
  const session = createPdfSession({ el, lib, pdfjs, core, loadOcr: h.loadOcr, svgNode, linesOf, blocksOf, docHtmlOf });
  session.on("status", (m) => say(s, m));
  let file = null;

  // ── draft's sandbox toolbar, for the field being edited ──
  const active = () => (session.active?.kind === "field" ? session.active : null);
  const sbtn = (label, title, onPress, extra = {}) => el("button", { type: "button", class: "pt-sbx", title, "aria-label": title, ...extra,
    onmousedown: (e) => { e.preventDefault(); onPress(); } }, label);
  const face = el("select", { class: "pt-sbx pt-sbx--sel", "aria-label": "Face", onchange: () => session.setStyle({ family: face.value }) },
    ...FACES.map(([v, l]) => el("option", { value: v }, l)));
  const sizeOut = el("span", { class: "pt-sbx-v", "aria-live": "polite" }, "—");
  const color = el("input", { type: "color", class: "pt-sbx-color", "aria-label": "Text colour", oninput: () => session.setStyle({ color: rgbOf(color.value) }) });
  const note = el("span", { class: "pt-sb-note", "data-font-substituted": "" });
  const toolbar = el("div", { class: "pt-sb-bar", role: "toolbar", "aria-label": "Edit the text", "data-pt-tx-toolbar": true },
    face,
    sbtn("A−", "Smaller text", () => active() && session.setStyle({ size: Math.max(4, active().size - 0.5) })), sizeOut,
    sbtn("A+", "Larger text", () => active() && session.setStyle({ size: Math.min(96, active().size + 0.5) })),
    el("span", { class: "pt-sb-sep", "aria-hidden": "true" }),
    sbtn(el("b", {}, "B"), "Bold", () => active() && session.setStyle({ bold: !active().font.bold }), { "data-cmd": "bold" }),
    sbtn(el("i", {}, "I"), "Italic", () => active() && session.setStyle({ italic: !active().font.italic }), { "data-cmd": "italic" }),
    sbtn(el("u", {}, "U"), "Underline", () => active() && session.setStyle({ underline: !active().underline }), { "data-cmd": "underline" }),
    el("label", { class: "pt-sbx", title: "Text colour" }, "A", color),
    el("span", { class: "pt-sb-sep", "aria-hidden": "true" }),
    sbtn("↶", "Undo this line's change", () => active() && session.revert(active()), { "data-cmd": "undo" }),
    sbtn("T̸", "Back to the original style", () => { const f = active(); if (f) session.setStyle({ ...f.orig.font, size: f.orig.size, color: f.orig.color, underline: false }); }),
    note,
    el("span", { class: "pt-sb-grow" }),
    el("span", { class: "pt-sb-count", "data-pt-tx-count": true }, ""));
  const count = toolbar.querySelector("[data-pt-tx-count]");
  const syncBar = () => {
    const f = active();
    for (const c of toolbar.querySelectorAll("button, select, input")) c.disabled = !f;
    const n = session.changedFields().length;
    count.textContent = n ? `${n} line${n === 1 ? "" : "s"} changed` : "";
    if (!f) { sizeOut.textContent = "—"; note.textContent = ""; return; }
    face.value = f.font.family; sizeOut.textContent = String(Math.round(f.size * 10) / 10);
    color.value = hex(f.color);
    toolbar.querySelector("[data-cmd=bold]").setAttribute("aria-pressed", String(f.font.bold));
    toolbar.querySelector("[data-cmd=italic]").setAttribute("aria-pressed", String(f.font.italic));
    toolbar.querySelector("[data-cmd=underline]").setAttribute("aria-pressed", String(!!f.underline));
    const sub = session.fontNote(f);
    note.textContent = sub ? `Font substituted: ${sub}` : "";   // D188 (4): never silently change how a document looks
  };
  session.on("active", syncBar).on("change", syncBar);

  input.addEventListener("change", async () => {
    file = input.files?.[0]; if (!file) return;
    out.replaceChildren();
    try {
      const r = await session.open(await h.readBytes(file), file.name);
      if (!r.lines) return say(s, h.loadOcr ? "No text was found on these pages, even in their pictures." : "This PDF has no text layer, and the text reader isn't available here.", "bad");
      say(s, `${r.pages} page${r.pages === 1 ? "" : "s"}, ${r.lines} lines of text${r.read ? ` (${r.read} read from pictures — check them, a reader can misread a letter)` : ""}. Every box is editable: click and type.`);
      syncBar();
    } catch (e) { fail(s, e); }
  });

  const findInPictures = el("button", { type: "button", class: "pt-sbx", "data-pt-tx-ocr": true, onclick: async () => {
    if (!session.bytes) return say(s, "Choose a PDF first.", "bad");
    if (!h.loadOcr) return say(s, "The text reader is not available on this page.", "bad");
    findInPictures.disabled = true;
    try {
      const n = await session.findInPictures();
      say(s, n ? `Found ${n} more line${n === 1 ? "" : "s"} of text in the pictures — click any of them to edit. Read them through: a reader can misread a letter.` : "No more text was found in the pictures.", n ? "good" : "");
    } catch (e) { fail(s, e); } finally { findInPictures.disabled = false; }
  } }, "Find text in pictures (OCR)");

  const save = el("button", { type: "button", class: "pt-sbx pt-sbx--p", "data-pt-tx-save": true, onclick: async () => {
    if (!session.bytes) return say(s, "Choose a PDF first.", "bad");
    out.replaceChildren(); save.disabled = true; say(s, "Writing the changes into the PDF…");
    try {
      const r = await session.save();
      h.download(out, r.bytes, `${h.base(file.name)}-edited.pdf`);
      say(s, `${r.lines} line${r.lines === 1 ? "" : "s"} changed in the PDF, the new words real text.`
        + (r.lines - r.fromPics - r.stuck > 0 ? " Their old words are gone from the file." : "")
        + (r.fromPics ? ` ${r.fromPics} ${r.fromPics === 1 ? "was" : "were"} read from a picture, so the picture's words are covered with its own paper colour.` : "")
        + (r.stuck ? ` ${r.stuck} couldn't be taken out of the page, so ${r.stuck === 1 ? "it was" : "they were"} covered the same way.` : ""), "good");
    } catch (e) { fail(s, e); } finally { save.disabled = false; }
  } }, "Save the PDF");

  const toEditor = el("button", { type: "button", class: "pt-sbx", "data-pt-tx-to-editor": true, onclick: async () => {
    if (!session.bytes) return say(s, "Choose a PDF first.", "bad");
    try {
      const html = await session.documentHtml(h.base(file.name));
      sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ html, filename: `${h.base(file.name)}.html` }));
      location.href = "/editor/";
    } catch (e) { fail(s, e); }
  } }, "Open in the résumé editor");

  syncBar();
  return [el("div", { class: "pt-sb", "data-pt-sandbox": true },
    el("p", { class: "pt-sb-note" }, "Click any text on the page and type — it changes where it is. Enter to finish a line, Esc to undo it. ",
      el("a", { href: "/workspace/" }, "Open the full workspace")),
    el("label", { class: "pt-field" }, "PDF", input),
    toolbar, session.pagesEl,
    el("div", { class: "pt-sb-actions" }, save, findInPictures, toEditor,
      el("span", { class: "pt-muted" }, "Open in the résumé editor: the text as a document with every option (sections, lists, margins) — the editor's layout, not the PDF's.")),
    s, out)];
}
