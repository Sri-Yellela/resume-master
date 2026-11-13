// ── PDF toolkit · a PDF's text as an editable document (A203 (2), owner 11-13: "both, chosen per file") ──────────────────
//
// Edit PDF edits a PDF exactly, in place. This is the other road: the PDF's TEXT turned into a document the résumé editor
// (/editor/ — the same editor draft embeds) opens with every option — sections, fonts, lists, margins. Layout is the
// editor's, not the PDF's: a designed PDF loses its look, a text PDF (a résumé, a letter) reads as it did.
//
//   · the lines before the first heading → the header (the first line the name, the rest the contact line)
//   · a heading → larger than the body (×1.2), or a short line in capitals ("EXPERIENCE", "Work History" is not)
//   · a line that starts with • ▪ ◦ ‣ – - * → a bullet; the lines that follow it, until a gap or a new bullet, join it
//   · other lines join into paragraphs; a gap of ~1.6 lines, or a size change, starts a new one
//
// ⛔ Imports nothing. Input: [{ lines: [{ text, size, y }] }] per page (pdfText.js linesOf, top to bottom).

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const BULLET = /^\s*[•▪◦‣●○■□–\-*·]\s+/;

export function isCapsHeading(text) {
  const t = String(text).trim();
  const letters = t.replace(/[^A-Za-zÀ-ÿ]/g, "");
  return t.length <= 48 && letters.length >= 3 && letters === letters.toUpperCase() && !/[.:;]$/.test(t) && t.split(/\s+/).length <= 6;
}

/** Pages of lines → blocks: { kind: "heading" | "para" | "bullet", text } (a page break joins the next page's text). */
export function blocksOf(pages) {
  const all = pages.flatMap(p => p.lines || []);
  const sizes = all.map(l => l.size).filter(Number.isFinite).sort((a, b) => a - b);
  const body = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 10;
  const out = [];
  for (const page of pages) {
    let cur = null, prev = null;
    for (const line of page.lines || []) {
      const text = String(line.text || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      const gap = prev ? Math.abs(prev.y - line.y) : 0;
      const bigGap = prev && gap > Math.max(prev.size, line.size) * 1.6;
      if (line.size >= body * 1.2 || isCapsHeading(text)) {
        out.push(cur = { kind: "heading", text }); prev = line; cur = null; continue;
      }
      if (BULLET.test(text)) { out.push(cur = { kind: "bullet", text: text.replace(BULLET, "") }); prev = line; continue; }
      if (!cur || bigGap || cur.kind === "heading" || Math.abs(line.size - (prev?.size ?? line.size)) > 0.5) {
        out.push(cur = { kind: "para", text });
      } else {
        cur.text += (/-$/.test(cur.text) ? "" : " ") + text;
      }
      prev = line;
    }
  }
  return out;
}

/** Blocks → the résumé editor's HTML (its sectionsFromHtml reads .header / .name / .contact, .section-title, ul.bullets). */
export function docHtmlOf(blocks, { title = "Document" } = {}) {
  // a document that OPENS with a heading opens with its name (a résumé's name is often in capitals): that line is the name,
  // and the short lines straight after it (up to two, before the next heading) are the contact line
  let head, rest;
  if (blocks[0]?.kind === "heading") {
    let k = 1;
    // a phone has a phone's shape (a date range "2023 - 2026" is not one); an address line has a separator or a link
    const contactish = (t) => t.length <= 160 && (/@|·|\||https?:|www\.|linkedin|github/i.test(t) || /(\+\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]\d{4}/.test(t));
    while (k < blocks.length && k <= 2 && blocks[k].kind === "para" && contactish(blocks[k].text)) k++;
    head = blocks.slice(0, k); rest = blocks.slice(k);
  } else {
    const first = blocks.findIndex(b => b.kind === "heading");
    head = (first < 0 ? blocks.slice(0, 2) : blocks.slice(0, first));
    rest = first < 0 ? blocks.slice(head.length) : blocks.slice(first);
  }
  const name = head[0]?.text || title;
  const contact = head.slice(1).map(b => b.text).join(" · ");
  let html = `<html><head><meta charset="utf-8"></head><body>`
    + `<div class="header"><div class="name">${esc(name)}</div>${contact ? `<div class="contact">${esc(contact)}</div>` : ""}</div>`;
  let list = false;
  const close = () => { if (list) { html += "</ul>"; list = false; } };
  if (rest.length && rest[0].kind !== "heading") html += `<div class="section-title">${esc("CONTENT")}</div>`;
  for (const b of rest) {
    if (b.kind === "bullet") { if (!list) { html += `<ul class="bullets">`; list = true; } html += `<li>${esc(b.text)}</li>`; continue; }
    close();
    html += b.kind === "heading" ? `<div class="section-title">${esc(b.text.toUpperCase())}</div>` : `<div>${esc(b.text)}</div>`;
  }
  close();
  return `${html}</body></html>`;
}
