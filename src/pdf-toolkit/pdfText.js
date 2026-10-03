// ── PDF → text, deterministic (A70 / O16e) ──────────────────────────────────────────────────────
//
// Reads the TEXT LAYER a PDF already carries — what every résumé exported from Word, Google Docs,
// LaTeX or a browser has — and lays it back out as lines, in reading order. Zero model calls.
//
// ⛔ ENVIRONMENT-NEUTRAL ON PURPOSE: this module takes a pdf.js document and imports nothing, so the
// same file runs on the server (src/parsing/extractPdfText.js) and in the browser (A69's toolkit,
// where the file never leaves the machine). One implementation, two callers — never a copy.
//
// What it does NOT do, and says so rather than guess:
//   · OCR. A scanned PDF has no text layer; it returns needsOcr: true and no text. (Before A70 the
//     site sent every PDF to Sonnet, which reads images — that, and only that, is what was lost.)
//   · Tables, footnotes, text in images, rotated text.
//   · Layouts with more than two columns are read row by row.

/**
 * @param doc  a pdf.js PDFDocumentProxy
 * @returns {{ text: string, chars: number, pages: number, needsOcr: boolean, columns: number[] }}
 *          `columns` is the column count used per page (1 or 2) — reported so a caller can show it.
 */
export async function textFromPdfDocument(doc) {
  const pages = [];
  const columns = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const width = page.view[2] - page.view[0];
    const content = await page.getTextContent();
    const { text, cols } = layoutPage(content.items, width);
    pages.push(text);
    columns.push(cols);
    page.cleanup?.();
  }
  const text = pages.filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  const visible = text.replace(/\s+/g, "").length;
  // A text layer this thin over this many pages is a scan (or an image of a résumé): say so.
  const needsOcr = visible < Math.max(20, 15 * doc.numPages);
  return { text: needsOcr ? "" : text, chars: needsOcr ? 0 : text.length, pages: doc.numPages, needsOcr, columns };
}

/** pdf.js text items → runs ({ s, x, y, w, size }). */
function runsOf(items) {
  return items
    .filter(it => typeof it.str === "string" && it.str.length > 0)
    .map(it => {
      const size = Math.abs(it.transform?.[3] || it.height || 10) || 10;
      return { s: it.str, x: it.transform[4], y: it.transform[5], w: it.width || it.str.length * size * 0.5, size };
    });
}

/**
 * The page as LINES, top to bottom, each with its runs left to right — what PDF → Word and PDF → Excel
 * are built from (office.js), using the same grouping as the text reader so the three agree.
 * Each line: { y, size, text, runs: [{ s, x, w, size }] }.
 */
export function linesOf(items) {
  const runs = runsOf(items);
  if (!runs.length) return [];
  return groupLines(runs).map(line => ({ ...line, text: lineText(line) })).filter(line => line.text);
}

/** Exported for tests: pdf.js text items → the page's text. */
export function layoutPage(items, pageWidth) {
  const runs = runsOf(items);
  if (!runs.length) return { text: "", cols: 1 };

  const lines = groupLines(runs);
  // Two columns: a vertical gutter that most multi-segment lines share.
  const split = findGutter(lines, pageWidth);
  if (split == null) return { text: joinLines(lines), cols: 1 };
  const left = [], right = [];
  for (const line of lines) {
    const l = line.runs.filter(r => r.x < split), rr = line.runs.filter(r => r.x >= split);
    if (l.length) left.push({ ...line, runs: l });
    if (rr.length) right.push({ ...line, runs: rr });
  }
  return { text: [joinLines(left), joinLines(right)].filter(Boolean).join("\n\n"), cols: 2 };
}

function groupLines(runs) {
  const sorted = [...runs].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const r of sorted) {
    const tol = r.size * 0.45;
    const line = lines.find(l => Math.abs(l.y - r.y) <= tol);
    if (line) { line.runs.push(r); line.size = Math.max(line.size, r.size); }
    else lines.push({ y: r.y, size: r.size, runs: [r] });
  }
  for (const l of lines) l.runs.sort((a, b) => a.x - b.x);
  return lines.sort((a, b) => b.y - a.y);
}

function lineText(line) {
  let out = "";
  let end = null;
  for (const r of line.runs) {
    if (end != null) {
      const gap = r.x - end;
      if (gap > r.size * 0.15 && !/\s$/.test(out) && !/^\s/.test(r.s)) out += " ";
    }
    out += r.s;
    end = r.x + r.w;
  }
  return out.replace(/[ \t]+/g, " ").trim();
}

function joinLines(lines) {
  let out = "", prev = null;
  for (const line of lines) {
    const t = lineText(line);
    if (!t) continue;
    if (prev) {
      const gap = prev.y - line.y;
      out += gap > Math.max(prev.size, line.size) * 1.9 ? "\n\n" : "\n";
    }
    out += t;
    prev = line;
  }
  return out;
}

function findGutter(lines, pageWidth) {
  if (!pageWidth || lines.length < 6) return null;
  const minGap = pageWidth * 0.06;
  const candidates = [];
  for (const line of lines) {
    for (let i = 1; i < line.runs.length; i++) {
      const a = line.runs[i - 1], b = line.runs[i];
      const gap = b.x - (a.x + a.w);
      if (gap > minGap && b.x > pageWidth * 0.25 && b.x < pageWidth * 0.75) candidates.push(b.x);
    }
  }
  // Most lines must split, at about the same x, for this to be columns and not a date flushed right.
  if (candidates.length < lines.length * 0.4) return null;
  candidates.sort((a, b) => a - b);
  const median = candidates[Math.floor(candidates.length / 2)];
  const near = candidates.filter(x => Math.abs(x - median) < pageWidth * 0.04).length;
  if (near < candidates.length * 0.7) return null;
  // Dates or locations at a tab stop also split at a consistent x. A real column carries PROSE: require
  // at least half a word of four-plus letters per line on the right of the gutter.
  const rightText = lines.flatMap(l => l.runs.filter(r => r.x >= median - 1)).map(r => r.s).join(" ");
  const words = rightText.split(/\s+/).filter(w => /[A-Za-z]{4,}/.test(w)).length;
  if (words < lines.length * 0.5) return null;
  return median - 1;
}
