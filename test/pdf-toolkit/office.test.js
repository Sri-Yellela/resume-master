// PDF → Word and PDF → Excel (A69 tier 2, owner 10-03): built from the PDF's own text layer, on real
// PDFs, and the Office files they produce, unzipped and read back.
import test from "node:test";
import assert from "node:assert/strict";
import { zipSync, unzipSync, strFromU8 } from "fflate";
import * as lib from "@cantoo/pdf-lib";
import { linesOf } from "../../src/pdf-toolkit/pdfText.js";
import { paragraphsOf, toDocx, tableOf, toXlsx } from "../../src/pdf-toolkit/office.js";

async function pagesFrom(draw, count = 1) {
  const doc = await lib.PDFDocument.create();
  const font = await doc.embedFont(lib.StandardFonts.Helvetica);
  for (let i = 0; i < count; i++) draw(doc.addPage([612, 792]), font, i);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const d = await pdfjs.getDocument({ data: new Uint8Array(await doc.save()), verbosity: 0 }).promise;
  const pages = [];
  for (let n = 1; n <= d.numPages; n++) pages.push({ lines: linesOf((await (await d.getPage(n)).getTextContent()).items) });
  await d.destroy();
  return pages;
}

test("Word: headings from larger type, paragraphs from line spacing, a page break per page", async () => {
  const pages = await pagesFrom((p, f, i) => {
    p.drawText(`Report part ${i + 1}`, { x: 50, y: 720, size: 22, font: f });
    p.drawText("The first paragraph runs across", { x: 50, y: 680, size: 11, font: f });
    p.drawText("two lines of the page.", { x: 50, y: 666, size: 11, font: f });
    p.drawText("A second paragraph after a gap.", { x: 50, y: 620, size: 11, font: f });
  }, 2);
  const blocks = paragraphsOf(pages);
  assert.deepEqual(blocks.map(b => b.kind), ["heading", "para", "para", "pagebreak", "heading", "para", "para"]);
  assert.equal(blocks[1].text, "The first paragraph runs across two lines of the page.");
  const files = unzipSync(toDocx(zipSync, blocks, { title: "t" }));
  for (const part of ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "word/_rels/document.xml.rels"]) {
    assert.ok(files[part], `${part} is in the .docx`);
  }
  const doc = strFromU8(files["word/document.xml"]);
  assert.match(doc, /<w:pStyle w:val="Heading1"\/><\/w:pPr><w:r><w:t xml:space="preserve">Report part 1<\/w:t>/);
  assert.match(doc, /<w:br w:type="page"\/>/);
});

test("Excel: columns from aligned text, numbers kept as numbers, one sheet per page", async () => {
  const pages = await pagesFrom((p, f) => {
    const rows = [["Date", "Description", "Amount"], ["2026-09-01", "Coffee beans", "12.50"], ["2026-09-02", "Rent", "1,450.00"], ["2026-09-03", "Train ticket", "6.40"]];
    rows.forEach((r, i) => { p.drawText(r[0], { x: 50, y: 700 - i * 18, size: 11, font: f }); p.drawText(r[1], { x: 160, y: 700 - i * 18, size: 11, font: f }); p.drawText(r[2], { x: 400, y: 700 - i * 18, size: 11, font: f }); });
  });
  const rows = tableOf(pages[0].lines);
  assert.deepEqual(rows, [["Date", "Description", "Amount"], ["2026-09-01", "Coffee beans", "12.50"], ["2026-09-02", "Rent", "1,450.00"], ["2026-09-03", "Train ticket", "6.40"]]);
  const files = unzipSync(toXlsx(zipSync, [{ name: "Page 1", rows }, { name: "Page/2?", rows: [["x"]] }]));
  const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]);
  assert.match(sheet, /<c r="C3"><v>1450.00<\/v><\/c>/, "a number is a number, thousands separator dropped");
  assert.match(sheet, /<c r="B2" t="inlineStr"><is><t xml:space="preserve">Coffee beans<\/t><\/is><\/c>/);
  assert.match(strFromU8(files["xl/workbook.xml"]), /<sheet name="Page 2 " sheetId="2"/, "a sheet name loses the characters Excel forbids");
});

test("Office files survive characters XML forbids", () => {
  const doc = strFromU8(unzipSync(toDocx(zipSync, [{ kind: "para", text: "A & B < C\u0001 \"q\"" }]))["word/document.xml"]);
  assert.match(doc, /A &amp; B &lt; C &quot;q&quot;/);
  assert.doesNotMatch(doc, /\u0001/);
});
