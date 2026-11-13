// D189 P3 (owner 11-13: "build P3") — Fill out (the PDF's own form fields), a blank page, and a TRUE redaction (D188:
// d188RedactionRemovesText). Synthetic PDFs only.
import test from "node:test";
import assert from "node:assert/strict";
import * as lib from "@cantoo/pdf-lib";
import { fillForm, insertBlankPage, redact, ToolkitError } from "../../src/pdf-toolkit/core.js";
import { stripInRects, tokenize, parseOps, textRuns } from "../../src/pdf-toolkit/textEdit.js";

async function formPdf() {
  const doc = await lib.PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  form.createTextField("full_name").addToPage(page, { x: 72, y: 700, width: 200, height: 20 });
  form.createCheckBox("agree").addToPage(page, { x: 72, y: 660, width: 14, height: 14 });
  const dd = form.createDropdown("state"); dd.addOptions(["MA", "NY", "CA"]); dd.addToPage(page, { x: 72, y: 620, width: 100, height: 20 });
  const rg = form.createRadioGroup("shift"); rg.addOptionToPage("day", page, { x: 72, y: 580, width: 14, height: 14 }); rg.addOptionToPage("night", page, { x: 100, y: 580, width: 14, height: 14 });
  return doc.save();
}
async function texts(bytes) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) out.push((await (await doc.getPage(p)).getTextContent()).items.map(i => i.str).join(" "));
  await doc.destroy();
  return out;
}

test("d189p3 fillForm: text, checkbox, dropdown and radio take their values and stay fillable; an unknown field is reported", async () => {
  const r = await fillForm(lib, await formPdf(), [
    { name: "full_name", kind: "text", value: "Ada Testcase" }, { name: "agree", kind: "checkbox", value: true },
    { name: "state", kind: "dropdown", value: "NY" }, { name: "shift", kind: "radio", value: "night" }, { name: "nope", kind: "text", value: "x" },
  ]);
  assert.equal(r.filled, 4);
  assert.deepEqual(r.skipped, ["nope"]);
  const form = (await lib.PDFDocument.load(r.bytes)).getForm();
  assert.equal(form.getTextField("full_name").getText(), "Ada Testcase");
  assert.equal(form.getCheckBox("agree").isChecked(), true);
  assert.deepEqual(form.getDropdown("state").getSelected(), ["NY"]);
  assert.equal(form.getRadioGroup("shift").getSelected(), "night");
  await assert.rejects(fillForm(lib, await formPdf(), []), (e) => e instanceof ToolkitError);
});

test("d189p3 insertBlankPage: a blank page lands where asked, the size of its neighbour", async () => {
  const doc = await lib.PDFDocument.create(); doc.addPage([400, 600]); doc.addPage([400, 600]);
  const out = await lib.PDFDocument.load(await insertBlankPage(lib, await doc.save(), 1));
  assert.equal(out.getPageCount(), 3);
  assert.deepEqual(out.getPage(1).getSize(), { width: 400, height: 600 });
});

test("d188RedactionRemovesText: the words under the box LEAVE the file; the words beside it stay where they were", async () => {
  const doc = await lib.PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const f = await doc.embedFont(lib.StandardFonts.Helvetica);
  page.drawText("Ada Testcase", { x: 72, y: 720, size: 14, font: f });
  page.drawText("Phone 617 555 0142", { x: 72, y: 700, size: 12, font: f });
  page.drawText("Boston, MA", { x: 72, y: 680, size: 12, font: f });
  const bytes = await doc.save();
  // a box over the phone line: x 66–300, y (from the top) 86–96 pt of 792
  const r = await redact(lib, bytes, [{ page: 0, fx: 66 / 612, fy: (792 - 712) / 792, fw: 240 / 612, fh: 16 / 792 }]);
  assert.ok(r.removed >= 1);
  const [t] = await texts(r.bytes);
  assert.doesNotMatch(t, /617|555|0142|Phone/, "the phone number is not in the file — not merely hidden");
  assert.match(t, /Ada Testcase/); assert.match(t, /Boston, MA/);
  await assert.rejects(redact(lib, bytes, []), /Draw a box/);
});

test("d189p3 stripInRects: a run inside the rectangle becomes a displacement; one outside is untouched", () => {
  const widths = () => ({ width: () => 500, bytes: 1 });
  const src = "BT /F1 10 Tf 100 700 Td (Secret) Tj ( kept) Tj ET BT /F1 10 Tf 100 600 Td (Elsewhere) Tj ET";
  const r = stripInRects(src, [{ x0: 95, y0: 695, x1: 129, y1: 712 }], widths);
  assert.equal(r.removed, 1);
  assert.match(r.content, /\[-3000\] TJ \( kept\) Tj/);
  const runs = textRuns(parseOps(tokenize(r.content)), widths);
  assert.deepEqual(runs.find(x => x.text === " kept").start, [130, 700], "the next words did not move");
  assert.ok(runs.some(x => x.text === "Elsewhere"));
});

test("d189p3 arrangePages: reorder, duplicate and drop pages IN PLACE — the PDF's form survives (selectPages would drop it)", async () => {
  const doc = await lib.PDFDocument.create();
  const f = await doc.embedFont(lib.StandardFonts.Helvetica);
  const p1 = doc.addPage([612, 792]); p1.drawText("one", { x: 72, y: 700, size: 12, font: f });
  doc.addPage([612, 792]).drawText("two", { x: 72, y: 700, size: 12, font: f });
  doc.addPage([612, 792]).drawText("three", { x: 72, y: 700, size: 12, font: f });
  doc.getForm().createTextField("full_name").addToPage(p1, { x: 72, y: 600, width: 200, height: 20 });
  const { arrangePages } = await import("../../src/pdf-toolkit/core.js");
  const out = await arrangePages(lib, await doc.save(), [1, 0, 0]);   // two, one, one (a copy); three dropped
  const t = await texts(out);
  assert.deepEqual(t.map(s => s.trim()), ["two", "one", "one"]);
  const re = await lib.PDFDocument.load(out);
  assert.equal(re.getPageCount(), 3);
  assert.deepEqual(re.getForm().getFields().map(x => x.getName()), ["full_name"], "the form is still there");
  await assert.rejects(arrangePages(lib, out, []), /delete every page/);
});
