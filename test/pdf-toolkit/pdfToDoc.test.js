// A203 (2): a PDF's text as a document for the résumé editor ("Open a PDF" / Edit PDF's "Open in the résumé editor").
import test from "node:test";
import assert from "node:assert/strict";
import { blocksOf, docHtmlOf, isCapsHeading } from "../../src/pdf-toolkit/pdfToDoc.js";
import { sectionsFromHtml } from "../../src/editor/sections.js";

const L = (text, y, size = 10) => ({ text, y, size });

test("a203(2) pdfToDoc: a résumé's lines become the editor's header, sections and bullets", () => {
  const pages = [{ lines: [
    L("ADA TESTCASE", 760, 18), L("Boston, MA · ada@example.invalid", 744),
    L("EXPERIENCE", 720, 11), L("Data Engineer, Example Robotics", 706), L("• Built the telemetry pipelines", 692),
    L("that the fleet runs on", 680), L("• Cut costs 30%", 668),
    L("Education", 640, 13), L("MS Computer Science", 626),
  ] }];
  const blocks = blocksOf(pages);
  assert.deepEqual(blocks.map(b => b.kind), ["heading", "para", "heading", "para", "bullet", "bullet", "heading", "para"]);
  assert.equal(blocks[4].text, "Built the telemetry pipelines that the fleet runs on", "a bullet's next line joins it");
  const html = docHtmlOf(blocks, { title: "cv" });
  assert.match(html, /<div class="name">ADA TESTCASE<\/div><div class="contact">Boston, MA · ada@example\.invalid<\/div>/);
  assert.match(html, /<div class="section-title">EXPERIENCE<\/div><div>Data Engineer, Example Robotics<\/div><ul class="bullets"><li>Built/);
  const doc = sectionsFromHtml(html);
  assert.deepEqual(doc.sections.map(s => s.title).slice(0, 1), ["Name and contact"]);
  assert.ok(doc.sections.length >= 3, "the editor reads its sections");
});

test("a203(2) pdfToDoc: caps headings are short capitals, not sentences; text is escaped", () => {
  assert.equal(isCapsHeading("WORK EXPERIENCE"), true);
  assert.equal(isCapsHeading("Work experience"), false);
  assert.equal(isCapsHeading("I LED A TEAM OF FIVE ENGINEERS TO SHIP THE NEW BILLING PLATFORM."), false);
  assert.match(docHtmlOf([{ kind: "para", text: "a <b> & c" }]), /a &lt;b&gt; &amp; c/);
});

test("a203(2) pdfToDoc: a line under the name that is not contact details (a date range, a sentence) is content, not the contact line", () => {
  const blocks = blocksOf([{ lines: [L("ADA TESTCASE", 720, 20), L("Data Engineer at Example Robotics, 2023 - 2026", 690, 11)] }]);
  const html = docHtmlOf(blocks);
  assert.doesNotMatch(html, /class="contact"/);
  assert.match(html, /<div class="section-title">CONTENT<\/div><div>Data Engineer at Example Robotics, 2023 - 2026<\/div>/);
  assert.match(docHtmlOf(blocksOf([{ lines: [L("ADA", 720, 20), L("(617) 555-0142 · Boston", 700)] }])), /class="contact">\(617\) 555-0142/);
});
