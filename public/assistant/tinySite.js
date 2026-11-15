// public/assistant/tinySite.js — ⭐ D190 · what Tiny knows about the PDF-tools site itself, as PURE data and functions (no
// DOM, no imports, no request), so node's tests import the very code the browser runs (test/d190Tiny.test.js).
// tiny.js imports these; the FAQ entries themselves are public/assistant/faq-rm.json.

/** Where "open X" goes on this site. Every value is a real page or route (test/d190Tiny.test.js checks). */
export const PLACES = Object.freeze({
  home: "/", documents: "/", "my documents": "/", workspace: "/workspace/", "the workspace": "/workspace/", editor: "/editor/", "résumé editor": "/editor/", "resume editor": "/editor/",
  tools: "/pdf/", "pdf tools": "/pdf/", privacy: "/privacy",
  compress: "/pdf/compress-pdf/", merge: "/pdf/merge-pdf/", split: "/pdf/split-pdf/", ocr: "/pdf/ocr-pdf/", edit: "/pdf/edit-pdf/", "edit pdf": "/pdf/edit-pdf/",
  sign: "/pdf/sign-pdf/", "sign pdf": "/pdf/sign-pdf/", organize: "/pdf/organize-pdf/", organise: "/pdf/organize-pdf/", watermark: "/pdf/watermark-pdf/",
  protect: "/pdf/protect-pdf/", unlock: "/pdf/unlock-pdf/", "pdf to word": "/pdf/pdf-to-word/", "pdf to text": "/pdf/pdf-to-text/", "pdf to excel": "/pdf/pdf-to-excel/",
  "pdf to jpg": "/pdf/pdf-to-jpg/", "jpg to pdf": "/pdf/jpg-to-pdf/", "html to pdf": "/pdf/html-to-pdf/", annotate: "/workspace/?mode=annotate", convert: "/workspace/?mode=convert",
});

/** The words a person used for a place ("the compress tool", "my documents") → { key, href }, or null. Pure. */
export function placeHref(place) {
  const key = String(place || "").toLowerCase().replace(/^(my|the|a) /, "").replace(/ (tool|page|pdf tool)$/, "").trim();
  const href = PLACES[key] || PLACES[key.replace(/ pdf$/, "")] || null;
  return href ? { key, href } : null;
}

/** A question → the best FAQ entry by keyword hits (T2, no model), or null. Pure. */
export function faqAnswer(entries, text) {
  const q = ` ${String(text || "").toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ")} `;
  let best = null, score = 0;
  for (const e of entries || []) {
    const s = (e.keywords || []).reduce((n, k) => n + (q.includes(` ${String(k).toLowerCase()} `) || (k.length > 4 && q.includes(String(k).toLowerCase())) ? 1 : 0), 0);
    if (s > score) { best = e; score = s; }
  }
  return best;
}
