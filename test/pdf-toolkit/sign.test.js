// A203 (owner 11-13: "the basic pdf editor … and also the signature one, both initials and vector extractor from upload").
// The signature tracer and the edit writer, under node --test, on synthetic pictures and PDFs only.
import test from "node:test";
import assert from "node:assert/strict";
import * as lib from "@cantoo/pdf-lib";
import { otsu, inkMask, outlines, traceInk, strokesToPath, svgOf } from "../../src/pdf-toolkit/sign.js";
import { applyEdits, displayToPdf, ToolkitError } from "../../src/pdf-toolkit/core.js";

/** A w × h RGBA picture: paper of `paper` grey, ink where `ink(x, y)` is true, in `inkGrey`. */
function picture(w, h, ink, { paper = 236, inkGrey = 40, alpha = 255 } = {}) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * 4, v = ink(x, y) ? inkGrey : paper;
    data[p] = data[p + 1] = data[p + 2] = v; data[p + 3] = ink(x, y) ? 255 : alpha;
  }
  return { width: w, height: h, data };
}
const ring = (cx, cy, r0, r1) => (x, y) => { const d = Math.hypot(x - cx, y - cy); return d >= r0 && d <= r1; };

test("a203 otsu: splits dark ink from light paper", () => {
  const hist = new Array(256).fill(0); hist[40] = 100; hist[236] = 900;
  const t = otsu(hist, 1000);
  assert.ok(t >= 40 && t < 236, `level ${t} between ink and paper`);
});

test("a203 traceInk: an 'o' traces to an outer outline and its hole — filled non-zero, cropped to the ink", () => {
  const img = picture(80, 60, ring(40, 30, 10, 18));
  const t = traceInk(img);
  assert.ok(t, "ink found");
  assert.equal(t.loops, 2, "the outside and the hole");
  assert.match(t.d, /^M[\d.]+ [\d.]+Q/, "smooth curves");
  assert.equal((t.d.match(/Z/g) || []).length, 2);
  assert.ok(Math.abs(t.width - 41) <= 2 && Math.abs(t.height - 41) <= 2, `cropped to the ring: ${t.width}×${t.height}`);
});

test("a203 traceInk: dust is dropped, grey paper and a transparent ground are paper, light-on-dark is inverted", () => {
  const withDust = picture(120, 60, (x, y) => ring(40, 30, 10, 18)(x, y) || (x === 100 && y === 10));
  assert.equal(traceInk(withDust).loops, 2, "a one-pixel speck is not a stroke");
  const greyPaper = picture(80, 60, ring(40, 30, 10, 18), { paper: 190, inkGrey: 70 });
  assert.equal(traceInk(greyPaper).loops, 2, "a photo's grey paper still splits from the ink");
  const transparent = picture(80, 60, ring(40, 30, 10, 18), { paper: 0, alpha: 0 });
  assert.equal(traceInk(transparent).loops, 2, "a transparent PNG's ground is paper, whatever its colour bytes");
  const inverted = picture(80, 60, (x, y) => !ring(40, 30, 10, 18)(x, y), { paper: 236, inkGrey: 20 });
  const m = inkMask(inverted);
  assert.ok(m.inkPixels < 80 * 60 * 0.5, "mostly-dark picture read as light ink on a dark ground");
  assert.equal(traceInk(picture(40, 40, () => false)), null, "a blank page has no signature");
});

test("a203 outlines: two pixels touching only at a corner make two loops that never cross", () => {
  const w = 4, h = 4, mask = new Uint8Array(w * h);
  mask[1 * w + 1] = 1; mask[2 * w + 2] = 1;
  const loops = outlines(mask, w, h);
  assert.equal(loops.length, 2);
  assert.ok(loops.every(l => l.length === 4));
});

test("a203 strokesToPath: drawn strokes become one smooth line path, a tap a dot; svgOf keeps it as a file", () => {
  const s = strokesToPath([[{ x: 10, y: 10 }, { x: 20, y: 14 }, { x: 30, y: 10 }, { x: 40, y: 18 }], [{ x: 50, y: 12 }]], { strokeWidth: 3 });
  assert.equal((s.d.match(/M/g) || []).length, 2);
  assert.match(s.d, /Q/);
  assert.match(s.d, /l0\.01 0/, "a tap is a dot");
  assert.equal(s.width, 46); assert.equal(s.height, 14);
  assert.equal(strokesToPath([]), null);
  const svg = svgOf(s);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 46 14"/);
  assert.match(svg, /stroke-linecap="round"/);
  assert.match(svgOf({ d: "M0 0L1 1Z", width: 2, height: 2 }), /fill="#111111" fill-rule="nonzero"/);
});

test("a203 displayToPdf: an item placed on the SHOWN page lands there on a page turned 0 / 90 / 180 / 270", () => {
  const g = { W: 600, H: 800 };
  assert.deepEqual(displayToPdf({ ...g, r: 0 }, 0, 0), { x: 0, y: 800 }, "top-left shown = top-left of the page");
  assert.deepEqual(displayToPdf({ ...g, r: 90 }, 0, 0), { x: 0, y: 0 }, "turned clockwise: the shown top-left is the page's bottom-left");
  assert.deepEqual(displayToPdf({ ...g, r: 90 }, 800, 0), { x: 0, y: 800 });
  assert.deepEqual(displayToPdf({ ...g, r: 180 }, 0, 0), { x: 600, y: 0 });
  assert.deepEqual(displayToPdf({ ...g, r: 270 }, 0, 0), { x: 600, y: 800 });
  assert.deepEqual(displayToPdf({ ...g, x0: 10, y0: 20, r: 0 }, 5, 5), { x: 15, y: 815 }, "the crop box's offset");
});

async function pdfOf(n = 1, rotate = 0) {
  const doc = await lib.PDFDocument.create();
  for (let i = 0; i < n; i++) { const p = doc.addPage([600, 800]); if (rotate) p.setRotation(lib.degrees(rotate)); }
  return doc.save();
}
async function textOf(bytes) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) out.push((await (await doc.getPage(p)).getTextContent()).items.map(i => i.str).join(" "));
  await doc.destroy();
  return out;
}
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("a203 applyEdits: text, a white-out, a picture and a signature are written into the PDF — the text is real text", async () => {
  const sig = traceInk(picture(80, 60, ring(40, 30, 10, 18)));
  const drawn = strokesToPath([[{ x: 0, y: 0 }, { x: 20, y: 10 }, { x: 40, y: 0 }]]);
  const out = await applyEdits(lib, await pdfOf(2), [
    { page: 0, kind: "text", fx: 0.1, fy: 0.1, fw: 0.5, fh: 0.05, text: "Ada Testcase\n13 Nov 2026", size: 14 },
    { page: 0, kind: "whiteout", fx: 0.1, fy: 0.5, fw: 0.3, fh: 0.05 },
    { page: 1, kind: "image", fx: 0.2, fy: 0.2, fw: 0.1, fh: 0.1, image: PNG_1PX },
    { page: 1, kind: "svg", fx: 0.5, fy: 0.8, fw: 0.3, fh: 0.1, d: sig.d, vbw: sig.width, vbh: sig.height },
    { page: 1, kind: "svg", fx: 0.1, fy: 0.8, fw: 0.2, fh: 0.05, d: drawn.d, vbw: drawn.width, vbh: drawn.height, strokeWidth: drawn.strokeWidth },
  ]);
  const t = await textOf(out);
  assert.match(t[0], /Ada Testcase/); assert.match(t[0], /13 Nov 2026/);
  const reread = await lib.PDFDocument.load(out);
  assert.equal(reread.getPageCount(), 2, "no page added or lost");
});

test("a203 applyEdits: a turned page takes its items; a character Helvetica can't draw becomes '?'; refusals are plain", async () => {
  const out = await applyEdits(lib, await pdfOf(1, 90), [{ page: 0, kind: "text", fx: 0.1, fy: 0.1, fw: 0.5, fh: 0.05, text: "Signed → today", size: 12 }]);
  assert.match((await textOf(out))[0], /Signed \? today/);
  await assert.rejects(applyEdits(lib, await pdfOf(1), []), (e) => e instanceof ToolkitError && /Add something/.test(e.message));
  await assert.rejects(applyEdits(lib, await pdfOf(1), [{ page: 3, kind: "text", text: "x" }]), /page this PDF does not have/);
  await assert.rejects(applyEdits(lib, await pdfOf(1), [{ page: 0, kind: "svg", d: "", vbw: 1, vbh: 1 }]), /signature is empty/);
  await assert.rejects(applyEdits(lib, await pdfOf(1), [{ page: 0, kind: "image", image: Buffer.from("nope") }]), /JPEG or PNG/);
});
