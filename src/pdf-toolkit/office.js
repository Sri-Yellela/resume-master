// ── PDF toolkit · PDF → Word and PDF → Excel (A69, owner 10-03) ──────────────────────────────────
//
// The owner, 10-03: Resume Master offers these (the "not offered" lines were a constraint of draft's
// contract, not of this product). Built from the PDF's own text layer (pdfText.js linesOf), in the
// browser — the file never leaves the machine.
//
// What each one carries, said on the page rather than oversold:
//   · Word: the text, in reading order, as paragraphs; larger type becomes headings; a page break per
//     page. Not the exact layout, fonts or pictures.
//   · Excel: rows and columns from text that is aligned in columns — tables, statements, lists. One
//     sheet per page; numbers stay numbers.
//
// ⛔ IMPORTS NOTHING: the page passes `zipSync` (fflate). Office files are zip archives of XML; the
// minimal parts written here are what Word, Excel, LibreOffice and Google Docs require.

const xml = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
  // XML 1.0 forbids most control characters; a PDF's text layer can carry them.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
const enc = (s) => new TextEncoder().encode(s);

// ── Word ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Pages of lines → paragraphs. A paragraph ends at a vertical gap larger than the line spacing, or
 * where the type size changes; a line clearly larger than the page's body size is a heading.
 * @param pages [{ lines: [{ y, size, text }] }]  (linesOf, per page)
 * @returns [{ kind: "heading"|"para"|"pagebreak", level?, text }]
 */
export function paragraphsOf(pages) {
  const out = [];
  pages.forEach((page, i) => {
    if (i > 0) out.push({ kind: "pagebreak" });
    const lines = page.lines || [];
    if (!lines.length) return;
    const sizes = lines.map(l => l.size).sort((a, b) => a - b);
    const body = sizes[Math.floor(sizes.length / 2)];
    let cur = null, prev = null;
    for (const line of lines) {
      const heading = line.size >= body * 1.25;
      const gap = prev ? prev.y - line.y : 0;
      const breaks = !cur || heading || cur.kind === "heading"
        || Math.abs(line.size - prev.size) > 0.5 || gap > Math.max(prev.size, line.size) * 1.6;
      if (breaks) {
        cur = heading ? { kind: "heading", level: line.size >= body * 1.7 ? 1 : 2, text: line.text } : { kind: "para", text: line.text };
        out.push(cur);
      } else {
        cur.text += (/-$/.test(cur.text) ? "" : " ") + line.text;
      }
      prev = line;
    }
  });
  return out;
}

export function toDocx(zipSync, blocks, { title = "Document" } = {}) {
  const body = blocks.map(b => {
    if (b.kind === "pagebreak") return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
    const style = b.kind === "heading" ? `<w:pPr><w:pStyle w:val="Heading${b.level}"/></w:pPr>` : "";
    return `<w:p>${style}<w:r><w:t xml:space="preserve">${xml(b.text)}</w:t></w:r></w:p>`;
  }).join("");
  const files = {
    "[Content_Types].xml": enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`),
    "_rels/.rels": enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`),
    "docProps/core.xml": enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xml(title)}</dc:title></cp:coreProperties>`),
    "word/_rels/document.xml.rels": enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    "word/styles.xml": enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="200"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style></w:styles>`),
    "word/document.xml": enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`),
  };
  return zipSync(files, { level: 6 });
}

// ── Excel ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Lines → a grid. Column starts are the x positions where runs begin, clustered across the page (a
 * start shared by several lines is a column); each run lands in the column whose start is nearest to
 * its left of it. Runs closer together than a word gap are joined into one cell first.
 * @returns string[][] rows
 */
export function tableOf(lines) {
  if (!lines?.length) return [];
  const cellsOf = (line) => {
    const cells = [];
    // pdf.js fills a gap between words with a whitespace item as wide as the gap; it carries no
    // content, and counting it would join every column into one cell.
    for (const r of line.runs.filter(run => run.s.trim())) {
      const last = cells[cells.length - 1];
      if (last && r.x - (last.x + last.w) < r.size * 0.9) { last.s += (/\s$/.test(last.s) || /^\s/.test(r.s) ? "" : " ") + r.s; last.w = r.x + r.w - last.x; }
      else cells.push({ x: r.x, w: r.w, s: r.s, size: r.size });
    }
    return cells.map(c => ({ ...c, s: c.s.replace(/\s+/g, " ").trim() })).filter(c => c.s);
  };
  const rows = lines.map(cellsOf);
  const starts = rows.flat().map(c => c.x).sort((a, b) => a - b);
  const tol = 6;
  const clusters = [];
  for (const x of starts) {
    const c = clusters[clusters.length - 1];
    if (c && x - c.max <= tol) { c.max = x; c.n++; c.sum += x; } else clusters.push({ min: x, max: x, n: 1, sum: x });
  }
  const minShare = Math.max(2, Math.ceil(rows.length * 0.15));
  const cols = clusters.filter((c, i) => i === 0 || c.n >= minShare).map(c => c.min - tol / 2);
  return rows.map(cells => {
    const row = new Array(cols.length).fill("");
    for (const cell of cells) {
      let k = 0;
      for (let i = 0; i < cols.length; i++) if (cell.x >= cols[i]) k = i;
      row[k] = row[k] ? `${row[k]} ${cell.s}` : cell.s;
    }
    while (row.length && row[row.length - 1] === "") row.pop();
    return row;
  }).filter(r => r.length);
}

const colName = (i) => { let s = ""; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
const NUMBER = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;

export function toXlsx(zipSync, sheets) {
  const list = sheets.length ? sheets : [{ name: "Sheet1", rows: [] }];
  const sheetXml = (rows) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${
    rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => {
      if (v === "") return "";
      const ref = `${colName(c)}${r + 1}`;
      return NUMBER.test(v) ? `<c r="${ref}"><v>${v.replace(/,/g, "")}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
    }).join("")}</row>`).join("")
  }</sheetData></worksheet>`;
  const files = {
    "[Content_Types].xml": enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${
      list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`),
    "_rels/.rels": enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
      list.map((s, i) => `<sheet name="${xml(String(s.name).replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || `Sheet${i + 1}`)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
      list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`),
  };
  list.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = enc(sheetXml(s.rows)); });
  return zipSync(files, { level: 6 });
}
