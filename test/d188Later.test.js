// ⭐ D188 LATER (draft's WORKLOG, 46m item 4) · ANNOTATE + WORD → PDF in the workspace — in the browser, nothing uploaded.
// The end-to-end walk in real Chrome is draft's scripts/d188LaterWalk.mjs (13 checks).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync, unzipSync, strToU8 } from "fflate";
import * as lib from "@cantoo/pdf-lib";
import { docxBlocks } from "../src/pdf-toolkit/office.js";
import { blocksToPdf, applyEdits } from "../src/pdf-toolkit/core.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const docx = (body) => zipSync({ "[Content_Types].xml": strToU8("<Types/>"),
  "word/document.xml": strToU8(`<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`) });

test("Word → PDF, step 1: a .docx's paragraphs — styles, bold / italic, lists, entities, tabs and breaks", () => {
  const b = docxBlocks(unzipSync, docx(`<w:p/><w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Jordan</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Skills</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:rPr><w:b/><w:i/></w:rPr><w:t>SQL &amp; Python</w:t></w:r><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:tab/><w:t>5 yrs</w:t><w:br/><w:t>next</w:t></w:r></w:p><w:p/>`));
  assert.deepEqual(b.map(x => x.kind), ["title", "h2", "li"], "empty paragraphs at the ends dropped");
  assert.deepEqual(b[2].runs, [{ text: "SQL & Python", bold: true, italic: true }, { text: " 5 yrs\nnext", bold: false, italic: false }]);
  assert.throws(() => docxBlocks(unzipSync, new Uint8Array([1, 2, 3])), /couldn't be opened as a Word document/);
  assert.throws(() => docxBlocks(unzipSync, zipSync({ "a.txt": strToU8("x") })), /no document inside it/);
  assert.throws(() => docxBlocks(unzipSync, docx("<w:p/>")), /no text to lay out/);
});

test("Word → PDF, step 2: laid out on Letter pages, wrapped, paged; a character Helvetica can't draw is counted", async () => {
  const blocks = [{ kind: "title", runs: [{ text: "Jordan Example", bold: false, italic: false }] },
    ...Array.from({ length: 70 }, (_, i) => ({ kind: i % 7 ? "p" : "li", runs: [{ text: `Line ${i} ` + "word ".repeat(30), bold: false, italic: false }] })),
    { kind: "p", runs: [{ text: "名 and — and “quotes”", bold: false, italic: false }] }];
  const r = await blocksToPdf(lib, blocks, { title: "cv" });
  assert.ok(r.pages >= 3, `${r.pages} pages`);
  assert.equal(r.replaced, 1, "the CJK character — the dash and curly quotes are WinAnsi");
  const back = await lib.PDFDocument.load(r.bytes);
  assert.equal(back.getTitle(), "cv");
  assert.equal(back.getPage(0).getSize().width, 612);
  await assert.rejects(blocksToPdf(lib, []), /no text to lay out/);
});

test("Annotate: a highlight is see-through and multiplies; a box is an outline; ink is a stroked path", async () => {
  const d = await lib.PDFDocument.create(); d.addPage([612, 792]);
  const out = await applyEdits(lib, await d.save(), [
    { page: 0, fx: 0.1, fy: 0.1, fw: 0.3, fh: 0.02, kind: "highlight" },
    { page: 0, fx: 0.1, fy: 0.2, fw: 0.3, fh: 0.1, kind: "box" },
    { page: 0, fx: 0.1, fy: 0.4, fw: 0.3, fh: 0.1, kind: "svg", d: "M0 0 L100 50 L200 0", vbw: 200, vbh: 50, strokeWidth: 3, color: [0.85, 0.12, 0.12] }]);
  const back = await lib.PDFDocument.load(out);
  const gs = back.getPage(0).node.Resources().lookup(lib.PDFName.of("ExtGState"));
  const states = gs.entries().map(([, v]) => back.context.lookup(v));
  assert.ok(states.some(s => String(s.get(lib.PDFName.of("BM"))).includes("Multiply")), "multiply");
  assert.ok(states.some(s => Number(String(s.get(lib.PDFName.of("ca")))) < 0.5), "see-through");
});

test("the workspace: an Annotate mode (Highlight · Draw · Box · Note), Word files opened as PDFs from every door", () => {
  const html = read("public/workspace/index.html");
  assert.match(html, /data-mode="annotate"[^>]*>Annotate</);
  assert.match(html, /id="ws-open" accept="application\/pdf,\.pdf,\.docx,/);
  const ws = read("public/workspace/workspace.js");
  // moved on purpose (rm-audit M14, 46y): Annotate also carries Watermark (after a separator); the hand-off also takes pictures / HTML
  assert.match(ws, /annotate: \[\["select", "⌖", "Select"\], \["highlight", "▬", "Highlight"\], \["ink", "✎", "Draw"\], \["box", "▢", "Box"\], \["text", "⊞", "Note"\], \["\|"\], \["watermark", "◪", "Watermark"\]\],/);
  assert.match(ws, /\["fromword", "W→", "From Word"\]/);
  assert.match(ws, /else await openAny\(h\.bytes, h\.name \|\| "document\.pdf"/, "Documents home's hand-off goes through the Word check too");
  assert.match(ws, /are not carried/, "the status says what Word → PDF leaves out");
  assert.match(read("public/index.html"), /id="docs-open" accept="application\/pdf,\.pdf,\.docx,/);
  const s = read("src/pdf-toolkit/session.js");
  assert.match(s, /function placeInk\(page, pts,/);
  assert.match(s, /if \(it\.type === "highlight"\) return \{ \.\.\.at, kind: "highlight" \};/);
  assert.match(s, /record\(\{ undo: \(\) => unplace\(it\), redo:/, "a stroke is undoable like any placed item");
  // no new library: the .docx reader is fflate (already a dependency) + regex; no upload
  assert.doesNotMatch(read("src/pdf-toolkit/office.js"), /fetch\(|mammoth|import .* from "(?!\.)/);
});
