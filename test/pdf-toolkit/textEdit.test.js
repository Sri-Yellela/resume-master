// A203 (2) (owner 11-13: "edit a pdf text as inline, so upload pdf and its editable wherever, just live draft, not add more
// text"). The page's own words are changed: their drawing leaves the content stream, the new words are real text, and
// nothing else on the page moves. Synthetic PDFs only.
import test from "node:test";
import assert from "node:assert/strict";
import * as lib from "@cantoo/pdf-lib";
import { tokenize, parseOps, textRuns, stripText, frameOf, runInBox } from "../../src/pdf-toolkit/textEdit.js";
import { applyTextEdits, ToolkitError } from "../../src/pdf-toolkit/core.js";

test("a203(2) tokenize: literal strings with escapes and nesting, hex strings, names, arrays, an inline image kept whole", () => {
  const src = "BT /F1 12 Tf 72 700 Td (a \\(b\\) (c) \\101\\n) Tj [<4142> -120 (C)] TJ ET BI /W 2 /H 2 ID \x00EI\x01 EI Q";
  const t = tokenize(src);
  const strs = t.filter(x => x.t === "str").map(x => x.v);
  assert.deepEqual(strs, ["a (b) (c) A\n", "AB", "C"]);
  assert.ok(t.some(x => x.t === "inline" && src.slice(x.s, x.e).endsWith(" EI")), "BI … EI is one opaque piece, binary 'EI' inside it included");
  const ops = parseOps(t).map(o => o.op);
  assert.deepEqual(ops, ["BT", "Tf", "Td", "Tj", "TJ", "ET", "BI", "Q"]);
});

test("a203(2) textRuns: positions follow the text matrix, the CTM, TJ's adjustments and Tc / Tw / Tz", () => {
  const widths = () => ({ width: () => 500, bytes: 1 });
  const ops = parseOps(tokenize("q 2 0 0 2 10 20 cm BT /F1 10 Tf 5 6 Td (ab) Tj [(c) -1000 (d)] TJ ET Q"));
  const r = textRuns(ops, widths);
  assert.deepEqual(r[0].start, [20, 32], "(5,6) in text space, through the CTM ×2 +(10,20)");
  assert.deepEqual(r[0].end, [40, 32], "2 glyphs × 0.5 em × 10 = 10 text units → 20 in user space");
  assert.deepEqual(r[1].start, [40, 32], "the next show starts where the last ended");
  assert.equal(r[1].advance, 5 + 10 + 5, "c (5) + 1000/1000 × 10 kerned apart + d (5)");
});

test("a203(2) stripText: the removed operator becomes a displacement of the same advance — the words after it don't move", () => {
  const widths = () => ({ width: () => 500, bytes: 1 });
  const src = "BT /F1 10 Tf 100 700 Td (Hello) Tj ( World) Tj ET";
  const before = textRuns(parseOps(tokenize(src)), widths);
  const box = { transform: [10, 0, 0, 10, 100, 700], width: 25, height: 10 };   // "Hello"
  const res = stripText(src, [box], widths);
  assert.deepEqual(res.removed, [1]);
  assert.match(res.content, /\[-2500\] TJ \( World\) Tj/);
  const after = textRuns(parseOps(tokenize(res.content)), widths);
  assert.deepEqual(after[1].start, before[1].start, "' World' starts exactly where it did");
  assert.equal(after[0].text, "", "the edited word's glyphs are gone");
  assert.equal(runInBox(before[1], frameOf(box)), false, "the neighbour is not taken with it");
});

async function textItems(bytes) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) pages.push((await (await doc.getPage(n)).getTextContent()).items.filter(i => i.str.trim()));
  await doc.destroy();
  return pages;
}
async function letter() {
  const doc = await lib.PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(lib.StandardFonts.Helvetica);
  page.drawText("Dear Hiring Manager,", { x: 72, y: 700, size: 12, font });
  page.drawText("I am applying for the Data Engineer role.", { x: 72, y: 680, size: 12, font });
  page.drawText("Sincerely, Ada Testcase", { x: 72, y: 640, size: 12, font });
  return doc.save();
}

test("a203(2) applyTextEdits: the edited line's old words are GONE from the file, the new words are text, the rest is untouched", async () => {
  const bytes = await letter();
  const [items] = await textItems(bytes);
  const target = items.find(i => /Data Engineer/.test(i.str));
  const others = items.filter(i => i !== target).map(i => ({ page: 0, transform: i.transform, width: i.width, height: i.height, text: i.str }));
  const r = await applyTextEdits(lib, bytes, [{ page: 0, transform: target.transform, width: target.width, height: target.height,
    text: "I am applying for the Analytics Engineer role.", font: { family: "sans" } }], others);
  assert.equal(r.covered, 0, "found in the stream, not painted over");
  assert.ok(r.removed >= 1);
  const [after] = await textItems(r.bytes);
  const all = after.map(i => i.str).join(" | ");
  assert.match(all, /Analytics Engineer role/);
  assert.doesNotMatch(all, /Data Engineer/, "the old words are not hidden under a box — they are gone");
  const same = (s) => after.find(i => i.str === s)?.transform.slice(4).map(Math.round);
  assert.deepEqual(same("Dear Hiring Manager,"), [72, 700], "the line above did not move");
  assert.deepEqual(same("Sincerely, Ada Testcase"), [72, 640], "the line below did not move");
  const edited = after.find(i => /Analytics/.test(i.str));
  assert.deepEqual(edited.transform.slice(4).map(Math.round), [72, 680], "the new words sit on the old baseline");
});

test("a203(2) applyTextEdits: a word inside a longer line — the operator's neighbours are written back; refusals are plain", async () => {
  const doc = await lib.PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(lib.StandardFonts.Helvetica);
  page.drawText("Total due: 1,200 USD", { x: 72, y: 700, size: 14, font });
  const bytes = await doc.save();
  const [items] = await textItems(bytes);
  // the person changed only the amount, but the PDF drew the whole line with one operator: pdf.js gives one item here, so
  // the edit names that item's full text with the new amount
  const it = items[0];
  const r = await applyTextEdits(lib, bytes, [{ page: 0, transform: it.transform, width: it.width, height: it.height, text: "Total due: 1,450 USD" }]);
  const [after] = await textItems(r.bytes);
  assert.equal(after.map(i => i.str).join(""), "Total due: 1,450 USD");
  await assert.rejects(applyTextEdits(lib, bytes, []), (e) => e instanceof ToolkitError && /Change some text/.test(e.message));
  await assert.rejects(applyTextEdits(lib, bytes, [{ page: 4, transform: it.transform, text: "x" }]), /page this PDF does not have/);
});

test("a203(2) applyTextEdits: text the stream can't account for is covered with its background and rewritten — and counted", async () => {
  const bytes = await letter();
  const r = await applyTextEdits(lib, bytes, [{ page: 0, transform: [12, 0, 0, 12, 300, 300], width: 50, height: 12, text: "New", bg: [1, 1, 1] }]);
  assert.equal(r.covered, 1);
  const [after] = await textItems(r.bytes);
  assert.ok(after.some(i => i.str === "New"));
});

test("a203(4) applyTextEdits: a line read by OCR (cover) is painted over and rewritten — the stream's real text is never stripped for it", async () => {
  const bytes = await letter();
  const [items] = await textItems(bytes);
  const real = items.find(i => /Dear Hiring/.test(i.str));
  // an OCR field that happens to sit on a real line: covering must not take the real words out of the stream
  const r = await applyTextEdits(lib, bytes, [{ page: 0, transform: real.transform, width: real.width, height: real.height, text: "Hello", cover: true }]);
  assert.equal(r.removed, 0, "nothing stripped for a covered field");
  assert.equal(r.covered, 1);
  const [after] = await textItems(r.bytes);
  assert.ok(after.some(i => /Dear Hiring Manager/.test(i.str)), "the real words stay in the file (under the cover)");
  assert.ok(after.some(i => i.str === "Hello"));
});
