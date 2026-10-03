// The PDF toolkit — the text reader on real PDFs, and the "nothing leaves the browser" promise.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as lib from "@cantoo/pdf-lib";
import { textFromPdfDocument } from "../../src/pdf-toolkit/pdfText.js";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "pdf-toolkit");

async function read(draw) {
  const doc = await lib.PDFDocument.create();
  const font = await doc.embedFont(lib.StandardFonts.Helvetica);
  draw(doc.addPage([612, 792]), font);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const d = await pdfjs.getDocument({ data: new Uint8Array(await doc.save()), verbosity: 0 }).promise;
  try { return await textFromPdfDocument(d); } finally { await d.destroy(); }
}

test("the text reader: one column in order, two columns left then right, a scan flagged", async () => {
  const one = await read((p, f) => {
    ["Jane Roe", "EXPERIENCE", "Acme — Engineer", "Built the ledger.", "Initech — Analyst", "Wrote reports.", "EDUCATION", "B.S. Mathematics"]
      .forEach((s, i) => p.drawText(s, { x: 50, y: 720 - i * 20, size: 11, font: f }));
    p.drawText("2020 – 2024", { x: 500, y: 680, size: 11, font: f });
  });
  assert.deepEqual(one.columns, [1]);
  assert.match(one.text, /Acme — Engineer 2020 – 2024\nBuilt the ledger\./);

  const two = await read((p, f) => {
    ["SKILLS", "Go", "SQL", "Kafka", "Terraform", "Python", "EDUCATION", "B.S. Mathematics"].forEach((s, i) => p.drawText(s, { x: 50, y: 700 - i * 18, size: 11, font: f }));
    ["EXPERIENCE", "Acme — Senior Engineer", "Built the payment ledger service.", "Led the migration to services.",
     "Initech — Engineer", "Wrote the reporting pipeline.", "Owned the on-call rotation.", "Mentored two engineers."]
      .forEach((s, i) => p.drawText(s, { x: 240, y: 700 - i * 18, size: 11, font: f }));
  });
  assert.deepEqual(two.columns, [2]);
  assert.ok(two.text.indexOf("B.S. Mathematics") < two.text.indexOf("EXPERIENCE"));

  const scan = await read((p) => p.drawRectangle({ x: 10, y: 10, width: 500, height: 700 }));
  assert.equal(scan.needsOcr, true);
  assert.equal(scan.text, "");
});

test("⛔ nothing in the package can send a file anywhere — the promise on the page depends on it", () => {
  for (const f of fs.readdirSync(SRC)) {
    const src = fs.readFileSync(path.join(SRC, f), "utf8");
    assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|new WebSocket|EventSource\(|\bimport\s*\(\s*["'`]https?:/,
      `${f} must make no network request`);
  }
  assert.match(fs.readFileSync(path.join(SRC, "ui.js"), "utf8"), /Your files never leave this browser/);
});

test("⛔ the operations import nothing — the host passes the libraries in", () => {
  for (const f of ["core.js", "pdfText.js", "render.js", "office.js"]) {
    const src = fs.readFileSync(path.join(SRC, f), "utf8");
    assert.doesNotMatch(src, /^\s*import\s/m, `${f} must not import (one file, three hosts)`);
  }
});
