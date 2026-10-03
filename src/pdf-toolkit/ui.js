// ── PDF toolkit · the component (A69) ─────────────────────────────────────────────────────
//
// The site's PDF pages call mountPdfToolkit() (public/pdf-tools.js). Framework-free DOM: the site has
// no framework, and the component carries no look of its own beyond structure.
//
// The host passes the libraries in: { lib: the @cantoo/pdf-lib namespace, pdfjs: pdf.js with its
// worker already set }. Theming is CSS variables only (styles.css: --pt-*), so each host keeps its
// own look.
//
// ⭐ Everything here runs in this browser. No request is made with the user's file — that is the
// promise the header states, and the reason this beats an uploader.

import * as core from "./core.js";
import { renderPages, thumbnails, reencodeJpegInBrowser, flattenToImages, ocrPdf } from "./render.js";
import { textFromPdfDocument, linesOf } from "./pdfText.js";
import { paragraphsOf, toDocx, tableOf, toXlsx } from "./office.js";

const TOOLS = [
  { id: "merge", label: "Merge", blurb: "Join PDFs into one, in the order you set." },
  { id: "split", label: "Split", blurb: "One PDF per page, or per range you choose." },
  { id: "organise", label: "Organize", blurb: "Reorder, rotate or delete pages." },
  { id: "compress", label: "Compress", blurb: "Shrink the pictures inside — the text stays readable, for upload limits." },
  { id: "watermark", label: "Watermark", blurb: "Stamp text across every page." },
  { id: "protect", label: "Protect", blurb: "Add a password (AES-256)." },
  { id: "unlock", label: "Unlock", blurb: "Remove a password you know." },
  { id: "images", label: "Images → PDF", blurb: "JPEG or PNG pictures into one PDF." },
  { id: "toimages", label: "PDF → images", blurb: "Each page as a PNG or JPEG." },
  { id: "text", label: "PDF → text", blurb: "The text a PDF carries — no AI, nothing sent." },
  { id: "word", label: "PDF → Word", blurb: "A .docx of the text, in reading order, with headings and paragraphs. Not the exact layout or pictures." },
  { id: "excel", label: "PDF → Excel", blurb: "A .xlsx of the text laid out in columns — tables and statements. One sheet per page; numbers stay numbers." },
  { id: "ocr", label: "OCR", blurb: "Read a scanned PDF: its text, and a searchable copy you can select and search. English; it runs on this computer, a page at a time." },
];

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
const kb = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
const base = (name) => String(name || "document").replace(/\.pdf$/i, "").replace(/[^\w.-]+/g, "-").slice(0, 60) || "document";
const readBytes = async (file) => new Uint8Array(await file.arrayBuffer());

/**
 * @param root  an element to render into (emptied)
 * @param opts  { lib, pdfjs, initial?: tool id, onText?: (text) => void }
 * @returns { destroy }
 */
export function mountPdfToolkit(root, { lib, pdfjs, zipSync = null, loadOcr = null, initial = "merge", onText = null } = {}) {
  if (!lib || !pdfjs) throw new Error("mountPdfToolkit needs { lib, pdfjs }");
  const urls = new Set();
  const blobUrl = (bytes, type = "application/pdf") => { const u = URL.createObjectURL(new Blob([bytes], { type })); urls.add(u); return u; };
  const clearUrls = () => { for (const u of urls) URL.revokeObjectURL(u); urls.clear(); };

  root.replaceChildren();
  root.classList.add("pt-root");
  const tabs = el("div", { class: "pt-tabs", role: "tablist", "aria-label": "PDF tools" });
  const panel = el("div", { class: "pt-panel" });
  root.append(
    el("p", { class: "pt-promise", "data-pt-promise": true },
      "Your files never leave this browser — nothing is uploaded, stored or seen by anyone. Free, no account."),
    tabs, panel,
  );

  let current = null;
  const open = (id) => {
    current = id;
    clearUrls();
    for (const b of tabs.children) b.setAttribute("aria-selected", String(b.dataset.tool === id));
    const tool = TOOLS.find(t => t.id === id);
    panel.replaceChildren(el("p", { class: "pt-blurb" }, tool.blurb), ...BUILD[id]());
  };
  for (const t of TOOLS) {
    tabs.append(el("button", { type: "button", role: "tab", class: "pt-tab", "data-tool": t.id, onclick: () => open(t.id) }, t.label));
  }

  // ── shared pieces ──
  const status = () => el("div", { class: "pt-status", role: "status", "aria-live": "polite" });
  const say = (box, msg, kind = "") => { box.className = `pt-status ${kind ? `pt-${kind}` : ""}`; box.textContent = msg; };
  const fail = (box, e) => say(box, e instanceof core.ToolkitError ? e.message : `Something went wrong: ${e?.message || e}`, "bad");
  const results = () => el("div", { class: "pt-results" });
  const download = (box, bytes, filename, note = null, type = "application/pdf") => {
    box.append(el("div", { class: "pt-result" },
      el("a", { class: "pt-btn pt-primary", href: blobUrl(bytes, type), download: filename }, `Download ${filename}`),
      el("span", { class: "pt-muted" }, ` ${kb(bytes.byteLength ?? bytes.length)}${note ? ` — ${note}` : ""}`)));
  };
  const fileInput = (multiple = false, accept = "application/pdf") =>
    el("input", { type: "file", class: "pt-file", accept, multiple: multiple || null });
  const run = (label, fn) => {
    const s = status(), out = results();
    const btn = el("button", { type: "button", class: "pt-btn pt-primary" }, label);
    btn.addEventListener("click", async () => {
      out.replaceChildren(); clearUrls(); btn.disabled = true; say(s, "Working…");
      try { await fn(s, out); } catch (e) { fail(s, e); } finally { btn.disabled = false; }
    });
    return { btn, s, out };
  };
  const one = (input, s) => { const f = input.files?.[0]; if (!f) { say(s, "Choose a PDF first.", "bad"); return null; } return f; };

  const BUILD = {
    merge() {
      const input = fileInput(true);
      const list = el("ol", { class: "pt-list" });
      let files = [];
      const draw = () => {
        list.replaceChildren(...files.map((f, i) => el("li", {},
          el("span", { class: "pt-name" }, f.name), " ",
          el("button", { type: "button", class: "pt-mini", "aria-label": `Move ${f.name} up`, disabled: i === 0 || null,
            onclick: () => { [files[i - 1], files[i]] = [files[i], files[i - 1]]; draw(); } }, "↑"),
          el("button", { type: "button", class: "pt-mini", "aria-label": `Move ${f.name} down`, disabled: i === files.length - 1 || null,
            onclick: () => { [files[i + 1], files[i]] = [files[i], files[i + 1]]; draw(); } }, "↓"),
          el("button", { type: "button", class: "pt-mini", "aria-label": `Remove ${f.name}`,
            onclick: () => { files.splice(i, 1); draw(); } }, "✕"))));
      };
      input.addEventListener("change", () => { files = files.concat([...input.files]); input.value = ""; draw(); });
      const { btn, s, out } = run("Merge", async (s, out) => {
        const bytes = await core.merge(lib, await Promise.all(files.map(readBytes)));
        say(s, `Merged ${files.length} files.`, "good"); download(out, bytes, "merged.pdf");
      });
      return [el("label", { class: "pt-field" }, "PDFs (add as many as you like)", input), list, btn, s, out];
    },
    split() {
      const input = fileInput();
      const ranges = el("input", { type: "text", class: "pt-text", placeholder: "Blank = every page on its own. Or: 1-2, 3, 4-" });
      const { btn, s, out } = run("Split", async (s, out) => {
        const f = one(input, s); if (!f) return;
        const parts = await core.split(lib, await readBytes(f), ranges.value.trim() || "each");
        say(s, `${parts.length} file${parts.length === 1 ? "" : "s"}.`, "good");
        for (const p of parts) download(out, p.bytes, `${base(f.name)}-p${p.pages.length > 1 ? `${p.pages[0]}-${p.pages.at(-1)}` : p.pages[0]}.pdf`);
      });
      return [el("label", { class: "pt-field" }, "PDF", input), el("label", { class: "pt-field" }, "Ranges", ranges), btn, s, out];
    },
    organise() {
      const input = fileInput();
      const grid = el("div", { class: "pt-grid" });
      const s = status(), out = results();
      let bytes = null, file = null, pages = [];
      const draw = () => {
        grid.replaceChildren(...pages.map((p, i) => el("figure", { class: "pt-page", "data-pt-page": p.n },
          el("img", { src: p.thumb, alt: `Page ${p.n}`, style: `transform: rotate(${p.rot}deg)` }),
          el("figcaption", {}, `Page ${p.n}`),
          el("div", { class: "pt-row" },
            el("button", { type: "button", class: "pt-mini", "aria-label": `Move page ${p.n} earlier`, disabled: i === 0 || null,
              onclick: () => { [pages[i - 1], pages[i]] = [pages[i], pages[i - 1]]; draw(); } }, "←"),
            el("button", { type: "button", class: "pt-mini", "aria-label": `Rotate page ${p.n}`, onclick: () => { p.rot = (p.rot + 90) % 360; draw(); } }, "⟳"),
            el("button", { type: "button", class: "pt-mini", "aria-label": `Delete page ${p.n}`, onclick: () => { pages.splice(i, 1); draw(); } }, "✕"),
            el("button", { type: "button", class: "pt-mini", "aria-label": `Move page ${p.n} later`, disabled: i === pages.length - 1 || null,
              onclick: () => { [pages[i + 1], pages[i]] = [pages[i], pages[i + 1]]; draw(); } }, "→")))));
      };
      input.addEventListener("change", async () => {
        file = input.files?.[0]; if (!file) return;
        say(s, "Reading pages…");
        try {
          bytes = await readBytes(file);
          const thumbs = await thumbnails(pdfjs, bytes);
          pages = thumbs.map((thumb, i) => ({ n: i + 1, thumb, rot: 0 }));
          draw(); say(s, `${pages.length} pages. Arrange them, then save.`);
        } catch (e) { fail(s, e); }
      });
      const save = el("button", { type: "button", class: "pt-btn pt-primary", onclick: async () => {
        if (!bytes) return say(s, "Choose a PDF first.", "bad");
        out.replaceChildren(); clearUrls();
        try {
          if (!pages.length) throw new core.ToolkitError("That would delete every page.");
          let result = await core.selectPages(lib, bytes, pages.map(p => p.n - 1));
          for (const [i, p] of pages.entries()) if (p.rot) result = await core.rotate(lib, result, p.rot, [i]);
          say(s, "Saved.", "good"); download(out, result, `${base(file.name)}-organised.pdf`);
        } catch (e) { fail(s, e); }
      } }, "Save");
      return [el("label", { class: "pt-field" }, "PDF", input), grid, save, s, out];
    },
    compress() {
      const input = fileInput();
      const level = el("select", { class: "pt-text" },
        el("option", { value: "1600|0.72" }, "Balanced — pictures up to 1600 px"),
        el("option", { value: "1100|0.6" }, "Smaller — pictures up to 1100 px"),
        el("option", { value: "2400|0.82" }, "Light — pictures up to 2400 px"),
        el("option", { value: "flatten" }, "Maximum — every page becomes a picture (text no longer selectable)"));
      const warn = el("p", { class: "pt-muted", hidden: true },
        "Maximum turns every page into a picture: the smallest file, but its text can no longer be selected, searched, or read by software — including the systems employers use to read a résumé.");
      level.addEventListener("change", () => { warn.hidden = level.value !== "flatten"; });
      const { btn, s, out } = run("Compress", async (s, out) => {
        const f = one(input, s); if (!f) return;
        if (level.value === "flatten") {
          const before = f.size, bytes = await flattenToImages(lib, pdfjs, await readBytes(f));
          if (bytes.length >= before) return say(s, `${kb(before)} — flattening would not make this one smaller; the original is unchanged.`);
          say(s, `${kb(before)} → ${kb(bytes.length)} (${Math.round((1 - bytes.length / before) * 100)}% smaller). Every page is now a picture — its text is no longer selectable.`, "good");
          return download(out, bytes, `${base(f.name)}-compressed-max.pdf`);
        }
        const [maxDimension, quality] = level.value.split("|").map(Number);
        const r = await core.compress(lib, await readBytes(f), { reencodeJpeg: reencodeJpegInBrowser, maxDimension, quality });
        const pct = Math.round((1 - r.after / r.before) * 100);
        say(s, `${kb(r.before)} → ${kb(r.after)}${r.keptOriginal ? "" : ` (${pct}% smaller)`}. ${r.note}`, r.keptOriginal ? "" : "good");
        if (!r.keptOriginal) download(out, r.bytes, `${base(f.name)}-compressed.pdf`);
      });
      return [el("label", { class: "pt-field" }, "PDF", input), el("label", { class: "pt-field" }, "How much", level), warn, btn, s, out];
    },
    watermark() {
      const input = fileInput();
      const text = el("input", { type: "text", class: "pt-text", value: "CONFIDENTIAL", maxlength: "60" });
      const { btn, s, out } = run("Add watermark", async (s, out) => {
        const f = one(input, s); if (!f) return;
        download(out, await core.watermark(lib, await readBytes(f), text.value), `${base(f.name)}-watermarked.pdf`);
        say(s, "Done.", "good");
      });
      return [el("label", { class: "pt-field" }, "PDF", input), el("label", { class: "pt-field" }, "Text", text), btn, s, out];
    },
    protect() {
      const input = fileInput();
      const pw = el("input", { type: "password", class: "pt-text", autocomplete: "new-password" });
      const pw2 = el("input", { type: "password", class: "pt-text", autocomplete: "new-password" });
      const { btn, s, out } = run("Protect", async (s, out) => {
        const f = one(input, s); if (!f) return;
        if (pw.value !== pw2.value) throw new core.ToolkitError("The two passwords differ.");
        download(out, await core.protect(lib, await readBytes(f), pw.value), `${base(f.name)}-protected.pdf`,
          "keep the password safe: it cannot be recovered");
        say(s, "Protected with AES-256.", "good");
      });
      return [el("label", { class: "pt-field" }, "PDF", input), el("label", { class: "pt-field" }, "Password", pw),
        el("label", { class: "pt-field" }, "Password again", pw2), btn, s, out];
    },
    unlock() {
      const input = fileInput();
      const pw = el("input", { type: "password", class: "pt-text", autocomplete: "current-password" });
      const { btn, s, out } = run("Unlock", async (s, out) => {
        const f = one(input, s); if (!f) return;
        download(out, await core.unlock(lib, await readBytes(f), pw.value), `${base(f.name)}-unlocked.pdf`);
        say(s, "Unlocked. This needs the password — it never guesses one.", "good");
      });
      return [el("label", { class: "pt-field" }, "PDF", input), el("label", { class: "pt-field" }, "Its password", pw), btn, s, out];
    },
    images() {
      const input = fileInput(true, "image/jpeg,image/png");
      const { btn, s, out } = run("Make PDF", async (s, out) => {
        const files = [...(input.files || [])];
        if (!files.length) throw new core.ToolkitError("Choose at least one image.");
        const bytes = await core.imagesToPdf(lib, await Promise.all(files.map(async f => ({ name: f.name, bytes: await readBytes(f) }))));
        download(out, bytes, "images.pdf"); say(s, `${files.length} page${files.length === 1 ? "" : "s"}, in the order chosen.`, "good");
      });
      return [el("label", { class: "pt-field" }, "JPEG or PNG images", input), btn, s, out];
    },
    toimages() {
      const input = fileInput();
      const fmt = el("select", { class: "pt-text" }, el("option", { value: "image/png" }, "PNG"), el("option", { value: "image/jpeg" }, "JPEG"));
      const { btn, s, out } = run("Make images", async (s, out) => {
        const f = one(input, s); if (!f) return;
        let n = 0;
        for await (const img of renderPages(pdfjs, await readBytes(f), { type: fmt.value })) {
          n++; const ext = fmt.value === "image/png" ? "png" : "jpg";
          download(out, new Uint8Array(await img.blob.arrayBuffer()), `${base(f.name)}-p${img.page}.${ext}`, `${img.width}×${img.height}`, fmt.value);
          say(s, `Page ${n}…`);
        }
        say(s, `${n} image${n === 1 ? "" : "s"}.`, "good");
      });
      return [el("label", { class: "pt-field" }, "PDF", input), el("label", { class: "pt-field" }, "Format", fmt), btn, s, out];
    },
    text() {
      const input = fileInput();
      const { btn, s, out } = run("Read text", async (s, out) => {
        const f = one(input, s); if (!f) return;
        const doc = await pdfjs.getDocument({ data: await readBytes(f), isEvalSupported: false }).promise
          .catch(e => { throw new core.ToolkitError(e?.name === "PasswordException" ? "This PDF is password-protected. Unlock it first." : "This file could not be read as a PDF."); });
        try {
          const r = await textFromPdfDocument(doc);
          if (r.needsOcr) {
            say(s, "This PDF has no text layer — it looks like a scan. OCR can read it.", "bad");
            if (loadOcr) out.append(el("button", { type: "button", class: "pt-btn pt-primary", onclick: () => open("ocr") }, "Read it with OCR"));
            return;
          }
          say(s, `${r.chars} characters from ${r.pages} page${r.pages === 1 ? "" : "s"}.${r.columns.some(c => c > 1) ? " Two columns were read left, then right — check the order." : ""}`, "good");
          const area = el("textarea", { class: "pt-textout", readonly: true, rows: "14" }); area.value = r.text;
          out.append(area);
          download(out, new TextEncoder().encode(r.text), `${base(f.name)}.txt`, null, "text/plain");
          if (onText) out.append(el("button", { type: "button", class: "pt-btn", onclick: () => onText(r.text) }, "Use this text"));
        } finally { await doc.destroy(); }
      });
      return [el("label", { class: "pt-field" }, "PDF", input), btn, s, out];
    },
    word() {
      const input = fileInput();
      const { btn, s, out } = run("Make a Word file", async (s, out) => {
        const f = one(input, s); if (!f) return;
        if (!zipSync) throw new core.ToolkitError("This page cannot make Office files.");
        const pages = await pagesOf(f);
        if (!pages.some(p => p.lines.length)) return say(s, "This PDF has no text layer — it looks like a scan. Use OCR first.", "bad");
        const blocks = paragraphsOf(pages);
        download(out, toDocx(zipSync, blocks, { title: base(f.name) }), `${base(f.name)}.docx`, null,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        say(s, `${blocks.filter(b => b.kind !== "pagebreak").length} paragraphs and headings from ${pages.length} page${pages.length === 1 ? "" : "s"}. Check the layout — fonts and pictures are not carried over.`, "good");
      });
      return [el("label", { class: "pt-field" }, "PDF", input), btn, s, out];
    },
    excel() {
      const input = fileInput();
      const { btn, s, out } = run("Make an Excel file", async (s, out) => {
        const f = one(input, s); if (!f) return;
        if (!zipSync) throw new core.ToolkitError("This page cannot make Office files.");
        const pages = await pagesOf(f);
        if (!pages.some(p => p.lines.length)) return say(s, "This PDF has no text layer — it looks like a scan. Use OCR first.", "bad");
        const sheets = pages.map((p, i) => ({ name: `Page ${i + 1}`, rows: tableOf(p.lines) }));
        download(out, toXlsx(zipSync, sheets), `${base(f.name)}.xlsx`, null,
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        const rows = sheets.reduce((n, sh) => n + sh.rows.length, 0), cols = Math.max(0, ...sheets.flatMap(sh => sh.rows.map(r => r.length)));
        say(s, `${rows} rows, up to ${cols} columns, across ${sheets.length} sheet${sheets.length === 1 ? "" : "s"}. Columns come from how the text is aligned — check them.`, "good");
      });
      return [el("label", { class: "pt-field" }, "PDF", input), btn, s, out];
    },
    ocr() {
      const input = fileInput();
      const { btn, s, out } = run("Read it", async (s, out) => {
        const f = one(input, s); if (!f) return;
        if (!loadOcr) throw new core.ToolkitError("OCR is not available on this page.");
        say(s, "Loading the reader (once — about 15 MB)…");
        const { createWorker, workerOptions } = await loadOcr();
        const r = await ocrPdf(lib, pdfjs, createWorker, workerOptions, await readBytes(f),
          { onProgress: (n, total) => say(s, `Reading page ${n} of ${total}…`) });
        if (!r.words) return say(s, "No text was found on these pages.", "bad");
        say(s, `${r.words} words from ${r.pages} page${r.pages === 1 ? "" : "s"} (average confidence ${r.confidence}%). Read it through — OCR misreads some characters.`, "good");
        const area = el("textarea", { class: "pt-textout", readonly: true, rows: "12" }); area.value = r.text;
        out.append(area);
        download(out, r.bytes, `${base(f.name)}-searchable.pdf`, "a searchable copy");
        download(out, new TextEncoder().encode(r.text), `${base(f.name)}-ocr.txt`, null, "text/plain");
        if (onText) out.append(el("button", { type: "button", class: "pt-btn", onclick: () => onText(r.text) }, "Use this text"));
      });
      return [el("label", { class: "pt-field" }, "Scanned PDF", input), btn, s, out];
    },
  };

  async function pagesOf(file) {
    const doc = await pdfjs.getDocument({ data: await readBytes(file), isEvalSupported: false }).promise
      .catch(e => { throw new core.ToolkitError(e?.name === "PasswordException" ? "This PDF is password-protected. Unlock it first." : "This file could not be read as a PDF."); });
    try {
      const pages = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        pages.push({ lines: linesOf((await page.getTextContent()).items) });
        page.cleanup();
      }
      return pages;
    } finally { await doc.destroy(); }
  }

  open(TOOLS.some(t => t.id === initial) ? initial : "merge");
  return { open, destroy: () => { clearUrls(); root.replaceChildren(); root.classList.remove("pt-root"); }, get current() { return current; } };
}

export { TOOLS };
